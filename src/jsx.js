import { children } from "./parse.js"
import { REACT_HELPERS, convertBody, insideComponent, reactName, unsupported } from "./react.js"
import { routerElement } from "./router.js"

const DOM_ATTRIBUTES = {
    className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", maxLength: "maxlength", minLength: "minlength",
    autoComplete: "autocomplete", autoFocus: "autofocus", colSpan: "colspan", rowSpan: "rowspan", srcSet: "srcset", crossOrigin: "crossorigin",
    contentEditable: "contenteditable", spellCheck: "spellcheck", noValidate: "novalidate", acceptCharset: "accept-charset", httpEquiv: "http-equiv",
    defaultValue: "value", defaultChecked: "checked", strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin",
    strokeDasharray: "stroke-dasharray", strokeOpacity: "stroke-opacity", fillRule: "fill-rule", fillOpacity: "fill-opacity", clipRule: "clip-rule",
    clipPath: "clip-path", stopColor: "stop-color", textAnchor: "text-anchor", fontSize: "font-size", fontFamily: "font-family",
    onDoubleClick: "onDblClick"
}

const UNITLESS = new Set([
    "animationIterationCount", "aspectRatio", "columnCount", "columns", "fillOpacity", "flex", "flexGrow", "flexShrink", "fontWeight", "gridColumn",
    "gridRow", "lineClamp", "lineHeight", "opacity", "order", "orphans", "scale", "strokeOpacity", "tabSize", "widows", "zIndex", "zoom"
])

const CHECKED_INPUTS = new Set(["checkbox", "radio", "file"])

export const STYLE_HELPER = `const UNITLESS_STYLES = new Set(${JSON.stringify([...UNITLESS])})
const styleText = style => Object.entries(style ?? {})
    .filter(([, value]) => value != null && typeof value != "boolean" && value !== "")
    .map(([name, value]) => {
        const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase())
        return property + ": " + (typeof value == "number" && value != 0 && !UNITLESS_STYLES.has(name) && !name.startsWith("--") ? value + "px" : value)
    })
    .join("; ")`

function containsJsx(node) {
    if (node.type === "JSXElement" || node.type === "JSXFragment") return true
    return children(node).some(([child]) => containsJsx(child))
}

function usesReact(converter, node) {
    if (node.type === "CallExpression" && reactName(converter, node.callee) !== null) return true
    return children(node).some(([child]) => usesReact(converter, child))
}

export const PROVIDER_HELPER = `component ContextProvider({ context, value, children }) {
    provide(context, value)
    return children
}`

export function defaultComponent(converter, node, scope) {
    const fn = memoized(converter, node.declaration)
    const isFunction = fn?.type === "ArrowFunctionExpression" || fn?.type === "FunctionExpression" || (fn?.type === "FunctionDeclaration" && !fn.id)
    if (!isFunction || fn.async || (!containsJsx(fn.body) && !usesReact(converter, fn.body))) return false
    const base = /([^/\\]+?)(?:\.[^./\\]+)?$/.exec(converter.file)?.[1].replace(/[^A-Za-z0-9_$]/g, "") ?? ""
    const name = fn.id?.name ?? `${base[0]?.toUpperCase() ?? "A"}${base.slice(1) || "pp"}`
    convertComponent(converter, { kind: "function", node: node.declaration, name, fn, parent: node }, scope)
    return true
}

function memoized(converter, fn) {
    let inner = fn
    if (inner?.type === "CallExpression" && reactName(converter, inner.callee) === "memo") inner = inner.arguments[0]
    if (inner?.type === "CallExpression" && reactName(converter, inner.callee) === "forwardRef") {
        const typed = !!inner.typeParameters || !!inner.typeArguments
        inner = inner.arguments[0]
        if (/Function/.test(inner?.type ?? "")) {
            inner.forwarded = true
            inner.forwardedProps = typed
        }
    }
    return inner
}

export function componentOf(converter, node, declaration, parent) {
    if (parent.type === "ExportDefaultDeclaration" && node.type === "FunctionDeclaration" && !node.id) return null
    if (node.type === "FunctionDeclaration") {
        if (!node.id || !/^[A-Z]/.test(node.id.name) || node.generator || node.async) return null
        if (!containsJsx(node.body) && !usesReact(converter, node.body)) return null
        return { kind: "function", node, name: node.id.name, fn: node, parent }
    }
    const fn = memoized(converter, node.init)
    if (node.id.type !== "Identifier" || !/^[A-Z]/.test(node.id.name) || declaration.declarations.length !== 1) return null
    if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") return null
    if (fn.async || (!containsJsx(fn.body) && !usesReact(converter, fn.body))) return null
    return { kind: "variable", node: declaration, name: node.id.name, fn, parent, typed: node.id.typeAnnotation }
}

function propsType(component, converter, scope) {
    const reference = component.typed?.typeAnnotation
    const args = reference?.typeParameters?.params ?? reference?.typeArguments?.params
    return args?.length ? `: ${converter.print(args[0], scope)}` : ""
}

const plainProps = pattern => pattern.properties.every(property => {
    if (property.type !== "ObjectProperty" || property.computed) return false
    const value = property.value.type === "AssignmentPattern" ? property.value.left : property.value
    return value.type === "Identifier" && value.name === property.key.name
})

function refParameter(converter, fn) {
    if (!fn.forwarded || fn.params.length < 2) return null
    const [, ref] = fn.params
    if (ref.type === "Identifier") return ref.name
    converter.report("error", "component-parameters", "the ref of forwardRef has to be a plain parameter, like (props, ref)", ref)
    return null
}

function withRef(pattern) {
    const rest = pattern.slice(1).trimStart()
    return rest.startsWith("}") ? "{ ref }" : `{ ref, ${rest}`
}

const refLine = (indent, ref, from) => from === ref ? "" : `\n${indent}    const ${ref} = ${from}`

function componentParameters(converter, component, scope) {
    const { fn } = component
    const limit = fn.forwarded ? 2 : 1
    if (fn.params.length > limit) {
        converter.report("error", "component-parameters", "a component takes one props object: this second parameter has no Slim form", fn.params[limit])
    }
    const ref = refParameter(converter, fn)
    const indent = converter.lineIndent(fn.start, { start: -1 })
    const [props] = fn.params
    if (!props) return "()"
    const target = props.type === "AssignmentPattern" ? props.left : props
    if (target.type === "ObjectPattern") {
        const annotation = target.typeAnnotation
        if (annotation) converter.report("note", "props-type", "the type of destructured props was dropped: Slim can't annotate the pattern", props)
        delete target.typeAnnotation
        const pattern = converter.textOfRange(target, target.start, annotation ? annotation.start : target.end, scope)
        if (plainProps(target)) {
            if (ref) fn.propsPattern = refLine(indent, ref, "ref")
            return `(${ref ? withRef(pattern) : pattern})`
        }
        fn.propsPattern = `\n${indent}    const ${pattern} = props${ref ? refLine(indent, ref, "props.ref") : ""}`
        return "(props)"
    }
    if (ref) {
        fn.propsPattern = `${fn.propsPattern ?? ""}${refLine(indent, ref, `${target.name}.ref`)}`
        if (target.typeAnnotation || fn.forwardedProps) {
            converter.report("note", "props-type", "the type of the props of a forwardRef component was dropped: Slim checks each prop, and ref isn't one of them", props)
        }
        return `(${target.name})`
    }
    const type = target.typeAnnotation ? `: ${converter.print(target.typeAnnotation, { ...scope, hint: "Props" })}` : propsType(component, converter, scope)
    return `(${target.name}${target.optional ? "?" : ""}${type})`
}

export function convertComponent(converter, component, scope) {
    const { fn, name, node, parent } = component
    const { edits } = converter
    const inner = converter.functionScope(fn, scope)
    const parameters = componentParameters(converter, component, inner)
    const bodyStart = fn.body.extra?.parenStart ?? fn.body.start
    edits.replace(node.start, bodyStart, `component ${name}${parameters} `)
    if (fn.body.type === "BlockStatement") {
        convertBody(converter, fn, inner)
        if (component.kind === "variable") edits.remove(fn.body.end, node.end)
    } else {
        const body = insideComponent(converter, fn, () => converter.textOf(fn.body, inner))
        edits.replace(bodyStart, node.end, fn.propsPattern ? `{${fn.propsPattern}\n    return ${body}\n}` : `{ return ${body} }`)
    }
    if (parent.type === "ExportDefaultDeclaration") {
        edits.remove(parent.start, node.start)
        edits.insert(node.end, `\nexport default ${name}`)
    }
}

function tagName(element) {
    const name = element.openingElement.name
    if (name.type === "JSXIdentifier") return name.name
    if (name.type === "JSXMemberExpression") return `${name.object.name}.${name.property.name}`
    return null
}

const isDomTag = name => /^[a-z]/.test(name ?? "")

function attributeNamed(element, name) {
    return element.openingElement.attributes.find(item => item.type === "JSXAttribute" && item.name.name === name)
}

function domName(tag, name, type) {
    if (name !== "onChange") return DOM_ATTRIBUTES[name] ?? name
    if (tag === "textarea") return "onInput"
    if (tag !== "input") return name
    if (type?.type === "StringLiteral" && CHECKED_INPUTS.has(type.value)) return name
    return "onInput"
}

const eventName = (element, name) => domName(tagName(element), name, attributeNamed(element, "type")?.value)

function staticStyle(object) {
    const parts = []
    for (const property of object.properties) {
        if (property.type !== "ObjectProperty" || property.computed) return null
        const key = property.key.name ?? property.key.value
        const { value } = property
        if (value.type !== "StringLiteral" && value.type !== "NumericLiteral") return null
        const name = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
        const needsUnit = value.type === "NumericLiteral" && value.value !== 0 && !UNITLESS.has(key)
        parts.push(`${name}: ${value.value}${needsUnit ? "px" : ""}`)
    }
    return parts.join("; ")
}

function styleAttribute(converter, node, scope) {
    const container = node.value
    if (container?.type !== "JSXExpressionContainer") return false
    const value = container.expression
    const text = value.type === "ObjectExpression" ? staticStyle(value) : null
    if (text !== null) {
        converter.edits.replace(container.start, container.end, JSON.stringify(text))
        return true
    }
    converter.needsStyleHelper = true
    converter.edits.replace(container.start, value.start, "${styleText(")
    converter.visit(value, node, scope)
    converter.edits.replace(value.end, container.end, ")}")
    return true
}

function refAttribute(converter, node, scope) {
    const container = node.value
    if (container?.type !== "JSXExpressionContainer") return false
    const value = container.expression
    const isKnownRef = value.type === "Identifier" && converter.react?.refs.has(value.name)
    if (isKnownRef) {
        converter.edits.replace(container.start, container.end, `\${element => { ${value.name}.current = element }}`)
        return true
    }
    if (value.type !== "ArrowFunctionExpression" && value.type !== "FunctionExpression") {
        const text = converter.textOf(value, scope)
        converter.useHelper("setRef", REACT_HELPERS.setRef)
        converter.edits.replace(container.start, container.end, `\${element => setRef(${text}, element)}`)
        return true
    }
    return false
}

export function attribute(converter, element, node, scope) {
    if (node.type === "JSXSpreadAttribute") {
        converter.edits.replace(node.start, node.argument.start, "${")
        converter.visit(node.argument, node, scope)
        return
    }
    const name = node.name.name
    const onDom = isDomTag(tagName(element))
    if (name === "dangerouslySetInnerHTML") {
        innerHtml(converter, element, node, scope)
        return
    }
    if (onDom && name === "style" && styleAttribute(converter, node, scope)) return
    if (name === "ref" && refAttribute(converter, node, scope)) return
    if (onDom && typeof name === "string") {
        const renamed = eventName(element, name)
        if (renamed !== name) converter.edits.replace(node.name.start, node.name.end, renamed)
    }
    if (!node.value) return
    if (node.value.type === "JSXExpressionContainer") {
        converter.edits.replace(node.value.start, node.value.start + 1, "${")
        converter.visit(node.value.expression, node, scope)
    } else if (node.value.type === "JSXElement" || node.value.type === "JSXFragment") {
        convertJsx(converter, node.value, scope)
    }
}

function innerHtml(converter, element, node, scope) {
    const value = node.value?.expression
    const html = value?.type === "ObjectExpression" ? value.properties.find(property => (property.key?.name ?? property.key?.value) === "__html") : null
    if (!html) {
        converter.report("error", "react-html", "dangerouslySetInnerHTML needs { __html: ... } here", node)
        return
    }
    const text = converter.textOf(html.value, scope)
    const opening = element.openingElement
    converter.edits.remove(node.start - (converter.code[node.start - 1] === " " ? 1 : 0), node.end)
    if (opening.selfClosing) {
        let close = opening.end - 2
        while (close > node.end && /\s/.test(converter.code[close - 1])) close--
        converter.edits.replace(close, opening.end, `>\${raw(${text})}</${tagName(element)}>`)
    } else {
        converter.edits.insert(opening.end, `\${raw(${text})}`)
    }
}

function group(converter, node, open, close, content) {
    if (content.length === 1 && (content[0].type === "JSXElement" || content[0].type === "JSXFragment")) {
        converter.edits.remove(open.start, content[0].start)
        converter.edits.remove(content[0].end, close.end)
        return
    }
    converter.report("note", "fragment", "Slim has no fragments: this one became a <div> with display: contents", node)
    converter.edits.replace(open.start, open.end, `<div style="display: contents">`)
    converter.edits.replace(close.start, close.end, "</div>")
}

const visible = node => node.children.filter(child => child.type !== "JSXText" || child.value.trim() !== "")

function reactTag(converter, name) {
    if (name === null) return null
    const [owner, member] = name.split(".")
    const imported = converter.imports.get(owner)
    if (imported?.source !== "react") return null
    return member ?? imported.imported
}

const TRANSPARENT = new Set(["Fragment", "StrictMode", "Profiler"])

const isTransparent = (converter, name) => TRANSPARENT.has(reactTag(converter, name))

function consumer(converter, element, name, scope, inChildren) {
    const content = visible(element)
    const fn = content.length === 1 && content[0].type === "JSXExpressionContainer" ? content[0].expression : null
    if (!fn || fn.type === "JSXEmptyExpression") {
        converter.report("error", "react-context", "a context consumer needs one function as its content: read the context with useContext", element)
        return false
    }
    const read = /^(?:Identifier|MemberExpression)$/.test(fn.type) ? converter.textOf(fn, scope) : `(${converter.textOf(fn, scope)})`
    const text = `${read}(inject(${name.replace(/\.Consumer$/, "")}))`
    converter.edits.replace(element.start, element.end, inChildren ? `\${${text}}` : text)
    return true
}

function provider(converter, element, name, scope) {
    const value = attributeNamed(element, "value")?.value
    if (!converter.react || !value) {
        converter.report("error", "react-context", "a context provider needs a value and has to be inside a component", element)
        return
    }
    const context = name.replace(/\.Provider$/, "")
    const text = value.type === "StringLiteral" ? JSON.stringify(value.value) : converter.textOf(value.expression, scope)
    if (converter.rootElement === element) {
        converter.provides.push({ context, value: text })
        const content = visible(element)
        if (content.length === 1) converter.rootElement = content[0]
        group(converter, element, element.openingElement, element.closingElement, content)
        return
    }
    converter.needsProvider = true
    converter.edits.replace(element.openingElement.start, element.openingElement.end, `<ContextProvider context=\${${context}} value=\${${text}}>`)
    converter.edits.replace(element.closingElement.start, element.closingElement.end, "</ContextProvider>")
}

function keyedOutsideList(child) {
    return child.type === "JSXElement" && attributeNamed(child, "key")?.value
}

export function convertJsx(converter, node, scope, inChildren = false) {
    if (node.type === "JSXFragment") {
        group(converter, node, node.openingFragment, node.closingFragment, visible(node))
    } else {
        const name = tagName(node)
        const routed = routerElement(converter, node, name, scope)
        if (routed === "replaced") return
        if (name?.endsWith(".Consumer") && consumer(converter, node, name, scope, inChildren)) return
        if (name?.endsWith(".Provider")) {
            provider(converter, node, name, scope)
        } else if (isTransparent(converter, name) || routed === "transparent") {
            if (node.closingElement) group(converter, node, node.openingElement, node.closingElement, visible(node))
        } else if (reactTag(converter, name) === "Suspense") {
            converter.report("note", "suspense", "Suspense became its content: its fallback isn't shown, and a lazy component shows nothing until its module loads", node)
            if (node.closingElement) group(converter, node, node.openingElement, node.closingElement, visible(node))
        } else if (routed !== "attributes") {
            for (const item of node.openingElement.attributes) attribute(converter, node, item, scope)
        }
    }
    for (const child of node.children) {
        const key = keyedOutsideList(child)
        if (key) {
            const text = key.type === "StringLiteral" ? JSON.stringify(key.value) : converter.textOf(key.expression, scope)
            converter.edits.insert(child.start, `\${[${text}].map(() => `)
            convertJsx(converter, child, scope)
            converter.edits.insert(child.end, ")}")
        } else if (child.type === "JSXElement" || child.type === "JSXFragment") {
            convertJsx(converter, child, scope, true)
        } else if (child.type === "JSXExpressionContainer") {
            if (child.expression.type === "JSXEmptyExpression") converter.edits.removeStatement(child)
            else {
                converter.edits.replace(child.start, child.start + 1, "${")
                converter.visit(child.expression, child, scope)
            }
        } else if (child.type === "JSXSpreadChild") {
            converter.report("error", "jsx-spread-child", "a spread child has no Slim form", child)
        }
    }
}

const MARKUP_TEXT = /^[^<>&{}$`\\]*$/

function elementTag(type) {
    if (type?.type === "StringLiteral" && /^[a-z][a-z0-9-]*$/i.test(type.value)) return type.value
    if (type?.type === "Identifier" && /^[A-Z]/.test(type.name)) return type.name
    if (type?.type === "MemberExpression" && !type.computed && type.object.type === "Identifier" && /^[A-Z]/.test(type.property.name)) {
        return `${type.object.name}.${type.property.name}`
    }
    return null
}

function elementProps(converter, tag, props, scope) {
    if (!props || props.type === "NullLiteral" || props.type === "Identifier" && props.name === "undefined") return { attributes: [], children: null }
    if (props.type === "Identifier") return { attributes: [`\${...${props.name}}`], children: null }
    if (props.type !== "ObjectExpression") return null
    const dom = isDomTag(tag)
    const type = props.properties.find(property => property.type === "ObjectProperty" && !property.computed && (property.key.name ?? property.key.value) === "type")?.value
    const attributes = []
    let children = null
    for (const property of props.properties) {
        if (property.type === "SpreadElement") {
            attributes.push(`\${...${converter.textOf(property.argument, scope)}}`)
            continue
        }
        if (property.type !== "ObjectProperty" || property.computed) return null
        const key = property.key.name ?? property.key.value
        const { value } = property
        const text = () => converter.textOf(value, scope)
        if (key === "dangerouslySetInnerHTML") return null
        if (key === "children") children = value
        else if (key === "ref") {
            converter.useHelper("setRef", REACT_HELPERS.setRef)
            attributes.push(`ref=\${element => setRef(${text()}, element)}`)
        } else if (dom && key === "style") {
            const fixed = value.type === "ObjectExpression" ? staticStyle(value) : null
            if (fixed !== null) attributes.push(`style=${JSON.stringify(fixed)}`)
            else {
                converter.needsStyleHelper = true
                attributes.push(`style=\${styleText(${text()})}`)
            }
        } else {
            const name = dom ? domName(tag, key, type) : key
            if (value.type === "BooleanLiteral" && value.value) attributes.push(name)
            else if (value.type === "StringLiteral" && MARKUP_TEXT.test(value.value) && !value.value.includes("\"")) attributes.push(`${name}="${value.value}"`)
            else attributes.push(`${name}=\${${text()}}`)
        }
    }
    return { attributes, children }
}

function elementChild(converter, child, scope) {
    if (child.type === "StringLiteral" && MARKUP_TEXT.test(child.value) && child.value.trim() === child.value) return child.value
    if (child.type === "JSXElement") return converter.textOf(child, scope)
    const value = child.type === "SpreadElement" ? child.argument : child
    return `\${${converter.textOf(value, scope)}}`
}

export function elementCall(converter, node, scope) {
    const [type, props, ...rest] = node.arguments
    const tag = elementTag(type)
    const parts = tag && type?.type !== "SpreadElement" && props?.type !== "SpreadElement" ? elementProps(converter, tag, props, scope) : null
    if (!parts || isTransparent(converter, tag)) {
        unsupported(converter, "createElement", node)
        return false
    }
    const content = rest.length ? rest : parts.children ? [parts.children] : []
    const open = `<${tag}${parts.attributes.map(item => ` ${item}`).join("")}`
    const text = content.length ? `${open}>${content.map(child => elementChild(converter, child, scope)).join("")}</${tag}>` : `${open} />`
    converter.edits.replace(node.start, node.end, text)
    return true
}
