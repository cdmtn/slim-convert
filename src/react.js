import { children, isTypeNode } from "./parse.js"
import { typeArguments } from "./types.js"
import { elementCall } from "./jsx.js"
import { routerCall } from "./router.js"

const REACT_MODULES = new Set(["react", "react-dom", "react-dom/client"])
const EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"])
const HINTS = {
    useOptimistic: "keep the shown value in a state and set it before the request starts (a resource takes an optimistic value too: assign its value)",
    useActionState: "keep the result and a pending flag in states, and set them in the submit handler",
    useFormStatus: "keep a pending flag in a state of the form and pass it down as a prop",
    useSyncExternalStore: "declare it at the top of the component, as const value = useSyncExternalStore(subscribe, getSnapshot)",
    useImperativeHandle: "call it at the top of the component, with the ref it receives",
    lazy: "declare it on its own, as const Page = lazy(() => import(\"./Page\"))",
    forwardRef: "wrap a function in it, as forwardRef((props, ref) => ...)",
    createPortal: "give it the content and the element to show it in",
    cloneElement: "pass the extra props to the component instead: in Slim an element is already a DOM node",
    isValidElement: "test value instanceof Node: in Slim an element is a DOM node",
    Children: "use children directly: it is what was passed, a node or a list of them",
    createElement: "write it as JSX: only a tag name or a component known where it is written can be converted"
}

export const REACT_HELPERS = {
    nextId: `let lastId = 0
const nextId = () => ":r" + (lastId++).toString(32) + ":"`,
    setRef: `const setRef = (ref, value) => {
    if (typeof ref == "function") ref(value)
    else if (ref) ref.current = value
}`
}

export const unsupported = (converter, name, node, code = "react-api") =>
    converter.report("error", code, `"${name}" has no Slim form${HINTS[name] ? `: ${HINTS[name]}` : ": rewrite this by hand"}`, node)

export const isReactModule = source => REACT_MODULES.has(source)

export function reactName(converter, callee) {
    if (callee.type === "Identifier") {
        const imported = converter.imports.get(callee.name)
        return imported && isReactModule(imported.source) ? imported.imported : null
    }
    if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier") {
        const imported = converter.imports.get(callee.object.name)
        if (imported && isReactModule(imported.source)) return callee.property.name
    }
    return null
}

const isHookName = name => /^use[A-Z]/.test(name)

const isHookCall = node => node?.type === "CallExpression" && node.callee.type === "Identifier" && isHookName(node.callee.name)

export function isHookDeclaration(name, fn) {
    return isHookName(name ?? "") && /Function/.test(fn?.type ?? "")
}

function knownHook(converter, name) {
    const imported = converter.imports.get(name)
    return converter.hooks.has(name) || !!imported?.relative
}

const isCall = (converter, node, ...names) => node?.type === "CallExpression" && names.includes(reactName(converter, node.callee))

function walk(node, visit, parent = null, key = null) {
    if (visit(node, parent, key) === false) return
    for (const [child, childKey] of children(node)) if (!isTypeNode(child)) walk(child, visit, node, childKey)
}

function isReference(node, parent, key) {
    if (node.type !== "Identifier") return false
    if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && key === "property" && !parent.computed) return false
    if (parent?.type === "ObjectProperty" && key === "key" && !parent.computed) return false
    if ((parent?.type === "ObjectMethod" || parent?.type === "ClassMethod") && key === "key" && !parent.computed) return false
    return true
}

function namesIn(node, wanted) {
    const found = new Set()
    walk(node, (item, parent, key) => {
        if (isReference(item, parent, key) && wanted.has(item.name)) found.add(item.name)
    })
    return found
}

function patternNames(pattern, names = new Set()) {
    if (!pattern) return names
    if (pattern.type === "Identifier") names.add(pattern.name)
    else if (pattern.type === "ObjectPattern") pattern.properties.forEach(property => patternNames(property.value ?? property.argument, names))
    else if (pattern.type === "ArrayPattern") pattern.elements.forEach(element => patternNames(element, names))
    else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, names)
    else if (pattern.type === "RestElement") patternNames(pattern.argument, names)
    return names
}

function stateNameOf(setter) {
    return `${setter[3].toLowerCase()}${setter.slice(4)}`
}

function collect(converter, fn) {
    const react = { states: new Map(), setters: new Map(), stable: new Set(), refs: new Set(), reactive: new Set(), results: new Map(), fn }
    fn.params.forEach(param => patternNames(param).forEach(name => react.reactive.add(name)))
    if (fn.body.type !== "BlockStatement") return react

    for (const statement of fn.body.body) {
        if (statement.type !== "VariableDeclaration") continue
        for (const { id, init } of statement.declarations) {
            if (isCall(converter, init, "useState")) {
                if (id.type !== "ArrayPattern") {
                    converter.report("error", "react-state", "useState needs [value, setValue] here: its result can't be kept in one variable", statement)
                    continue
                }
                const [value, setter] = id.elements
                const name = value?.name ?? (setter ? stateNameOf(setter.name) : "unused")
                react.states.set(name, setter?.name ?? null)
                react.reactive.add(name)
                if (setter) {
                    react.setters.set(setter.name, name)
                    react.stable.add(setter.name)
                }
            } else if (isCall(converter, init, "useReducer") && id.type === "ArrayPattern") {
                const [value, dispatch] = id.elements
                react.states.set(value.name, null)
                react.reactive.add(value.name)
                if (dispatch) react.stable.add(dispatch.name)
            } else if (isCall(converter, init, "useRef") && id.type === "Identifier") {
                react.refs.add(id.name)
                react.stable.add(id.name)
            } else if (isHookCall(init)) {
                patternNames(id).forEach(name => react.reactive.add(name))
            } else if (init && [...namesIn(init, react.reactive)].length > 0) {
                patternNames(id).forEach(name => react.reactive.add(name))
            } else if (isCall(converter, init, "useContext")) {
                patternNames(id).forEach(name => react.reactive.add(name))
            }
        }
    }
    return react
}

function renameShadows(converter, react) {
    walk(react.fn.body, (node, parent) => {
        if (!/Function/.test(node.type)) return
        const bound = new Set()
        node.params.forEach(param => patternNames(param, bound))
        for (const name of bound) {
            const setter = react.states.get(name)
            if (!setter) continue
            const writes = new Set()
            walk(node.body, item => {
                if (item.type === "CallExpression" && item.callee.type === "Identifier" && item.callee.name === setter) writes.add(item)
            })
            const isUpdater = parent?.type === "CallExpression" && parent.callee.name === setter
            if (writes.size === 0 || isUpdater) continue
            const local = `${name}Value`
            converter.replacements ??= new Map()
            walk(node, (item, owner, key) => {
                if (!isReference(item, owner, key) || item.name !== name) return
                converter.replacements.set(item, owner?.type === "ObjectProperty" && owner.shorthand ? `${name}: ${local}` : local)
            })
        }
    })
}

function keepStaleReads(converter, react) {
    const check = fn => {
        if (!fn.body) return
        const writes = new Map()
        const stale = new Map()
        walk(fn.body, (node, parent, key) => {
            if (node !== fn.body && /Function/.test(node.type)) return false
            if (node.type === "CallExpression" && node.callee.type === "Identifier" && react.setters.has(node.callee.name)) {
                const state = react.setters.get(node.callee.name)
                if (!writes.has(state)) writes.set(state, node.end)
                return
            }
            if (isReference(node, parent, key) && writes.has(node.name) && node.start > writes.get(node.name)) {
                if (!stale.has(node.name)) stale.set(node.name, [])
                stale.get(node.name).push({ node, shorthand: parent?.type === "ObjectProperty" && parent.shorthand })
            }
        })
        if (stale.size === 0) return
        if (fn.body.type !== "BlockStatement") {
            for (const [name, reads] of stale) {
                converter.report("warning", "react-stale-read", `"${name}" is read after its setter: in React it still has the old value here, in Slim the new one`, reads[0].node)
            }
            return
        }
        const [first] = fn.body.body
        const inline = !first || !converter.code.slice(fn.body.start, first.start).includes("\n")
        const indent = first ? converter.lineIndent(first.start, { start: -1 }) : ""
        converter.replacements ??= new Map()
        converter.prefixes ??= new Map()
        for (const [name, reads] of stale) {
            const old = freeName(converter, `old${name[0].toUpperCase()}${name.slice(1)}`)
            const line = inline ? ` const ${old} = ${name};` : `\n${indent}const ${old} = ${name}`
            converter.prefixes.set(fn.body, `${converter.prefixes.get(fn.body) ?? ""}${line}`)
            for (const { node, shorthand } of reads) converter.replacements.set(node, shorthand ? `${name}: ${old}` : old)
            converter.report("note", "react-stale-read", `"${name}" is read after its setter: "${old}" keeps the value it had before, as in React`, reads[0].node)
        }
    }
    walk(react.fn.body, node => {
        if (/Function/.test(node.type)) check(node)
    })
}

const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"])

function rootName(node) {
    while (node && /MemberExpression$/.test(node.type)) node = node.object
    return node?.type === "Identifier" ? node.name : null
}

function componentLocals(fn) {
    const names = new Set()
    fn.params.forEach(param => patternNames(param, names))
    if (fn.body.type !== "BlockStatement") return names
    for (const statement of fn.body.body) {
        if (statement.type === "VariableDeclaration") statement.declarations.forEach(({ id }) => patternNames(id, names))
        if (statement.type === "FunctionDeclaration" && statement.id) names.add(statement.id.name)
    }
    return names
}

function runsInEffect(react, statement) {
    const locals = componentLocals(react.fn)
    const owned = name => locals.has(name) && !react.refs.has(name) && !react.states.has(name)
    let safe = !hasReturn(statement)
    walk(statement, node => {
        if (!safe) return false
        if (node.type === "AwaitExpression" || node.type === "YieldExpression") safe = false
        if (node.type === "VariableDeclaration" && node.kind === "var") safe = false
        if (node.type === "AssignmentExpression" && owned(rootName(node.left))) safe = false
        if (node.type === "UpdateExpression" && owned(rootName(node.argument))) safe = false
        if (node.type === "CallExpression") {
            const { callee } = node
            if (/MemberExpression$/.test(callee.type) && !callee.computed && MUTATORS.has(callee.property.name)) {
                const root = rootName(callee.object)
                if (owned(root) || react.states.has(root)) safe = false
            }
            if (callee.type === "Identifier" && owned(callee.name) && !react.stable.has(callee.name)) safe = false
        }
    })
    return safe
}

function hasMultilineTemplate(statement) {
    let found = false
    walk(statement, node => {
        if (node.type === "TemplateLiteral" && node.quasis.some(quasi => quasi.value.raw.includes("\n"))) found = true
    })
    return found
}

function renderCode(converter, react, statement, scope) {
    if (!runsInEffect(react, statement)) {
        converter.visit(statement, react.fn.body, scope)
        converter.report("warning", "react-render-code", "this code ran on every render in React and runs once in Slim: move it into an effect if it has to repeat", statement)
        return
    }
    const text = converter.textOf(statement, scope)
    const indent = converter.lineIndent(statement.start, { start: -1 })
    const wrapped = !text.includes("\n") ? `effect(() => { ${text} })`
        : hasMultilineTemplate(statement) ? `effect(() => {\n${indent}    ${text}\n${indent}})`
        : `effect(() => {\n${indent}    ${text.replace(/\n/g, "\n    ")}\n${indent}})`
    converter.edits.replace(statement.start, statement.end, wrapped)
    converter.report("note", "react-render-code", "this code ran on every render in React: it runs in an effect now, again whenever what it reads changes", statement)
}

function spliceCall(converter, node, inner, scope) {
    const open = inner.extra?.parenthesized ? inner.extra.parenStart : inner.start
    converter.edits.remove(node.start, open)
    converter.visit(inner, node, scope)
    let end = inner.end
    if (inner.extra?.parenthesized) end = converter.code.indexOf(")", end) + 1
    converter.edits.remove(end, node.end)
}

function setterCall(converter, node, state, scope) {
    const [value] = node.arguments
    if (!value) {
        converter.edits.replace(node.start, node.end, `${state} = undefined`)
        return
    }
    const isUpdater = value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression"
    if (!isUpdater) {
        converter.edits.remove(node.start, value.start)
        converter.edits.insert(value.start, `${state} = `)
        converter.visit(value, node, scope)
        converter.edits.remove(value.end, node.end)
        return
    }
    const [param] = value.params
    if (value.body.type !== "BlockStatement" && (!param || param.type === "Identifier")) {
        const body = value.body
        const open = body.extra?.parenthesized ? body.extra.parenStart : body.start
        const close = body.extra?.parenthesized ? converter.code.indexOf(")", body.end) + 1 : body.end
        converter.edits.replace(node.start, open, `${state} = `)
        if (param && param.name !== state) {
            walk(body, (item, parent, key) => {
                if (isReference(item, parent, key) && item.name === param.name) converter.edits.replace(item.start, item.end, state)
            })
        }
        converter.visit(body, value, scope)
        converter.edits.remove(close, node.end)
        return
    }
    converter.edits.replace(node.start, value.start, `${state} = (`)
    converter.visit(value, node, scope)
    converter.edits.replace(value.end, node.end, `)(${state})`)
}

function keepCleanupValues(converter, fn) {
    if (fn.body?.type !== "BlockStatement") return
    for (const statement of fn.body.body) {
        const cleanup = statement.type === "ReturnStatement" ? statement.argument : null
        if (cleanup?.type !== "ArrowFunctionExpression" && cleanup?.type !== "FunctionExpression") continue
        const names = [...namesIn(cleanup, converter.react.reactive)].join(", ")
        if (!names) continue
        converter.edits.insert(cleanup.start, `((${names}) => `)
        converter.edits.insert(cleanup.end, `)(${names})`)
    }
}

function effectCall(converter, node, scope) {
    const react = converter.react
    const [fn, deps] = node.arguments
    const indent = converter.lineIndent(node.start, { start: -1 })
    const reads = namesIn(fn, react.reactive)
    const close = (before, after) => {
        converter.edits.replace(node.start, fn.start, before)
        keepCleanupValues(converter, fn)
        converter.visit(fn, node, scope)
        converter.edits.replace(fn.end, node.end, after)
    }

    if (!deps) {
        converter.report("note", "react-effect", "an effect without dependencies runs again only when what it reads changes, not on every render", node)
        close("effect(", ")")
        return
    }
    if (deps.type !== "ArrayExpression") {
        converter.report("error", "react-effect", "the dependencies of this effect are not a list", deps)
        close("effect(", ")")
        return
    }
    const wanted = new Set()
    const tracked = []
    for (const element of deps.elements) {
        const roots = namesIn(element, react.reactive)
        if (roots.size === 0) continue
        roots.forEach(name => wanted.add(name))
        tracked.push(converter.textOf(element, scope))
    }
    const same = wanted.size === reads.size && [...reads].every(name => wanted.has(name))
    if (same) close("effect(", ")")
    else if (tracked.length === 0) close("effect(() => untrack(", "))")
    else close(`effect(() => {\n${indent}    void [${tracked.join(", ")}]\n${indent}    return untrack(`, `)\n${indent}})`)
}

function refCall(converter, node, scope) {
    const [value] = node.arguments
    if (!value) {
        converter.edits.replace(node.start, node.end, "{ current: undefined }")
        return
    }
    const live = namesIn(value, converter.react.reactive).size > 0
    converter.edits.replace(node.start, value.start, live ? "untrack(() => ({ current: " : "{ current: ")
    converter.visit(value, node, scope)
    converter.edits.replace(value.end, node.end, live ? " }))" : " }")
}

const PACKAGE_HOOK_HINTS = {
    "react-redux": "keep the store's data in a state at the top of a module, or subscribe to the store in an effect",
    "@tanstack/react-query": "load the data with resource(), which reloads when what the loader reads changes",
    "react-query": "load the data with resource(), which reloads when what the loader reads changes",
    swr: "load the data with resource(), which reloads when what the loader reads changes"
}

function packageHook(converter, node) {
    const name = node.callee.name
    const source = converter.imports.get(name)?.source
    const hint = PACKAGE_HOOK_HINTS[source] ?? "write it with state and effect, or move it into a use... function of the project"
    converter.report("error", "custom-hook", `"${name}" ${source ? `comes from "${source}"` : "isn't declared in this project"}: ${hint}`, node)
}

const callable = (converter, node, scope) => {
    const text = converter.textOf(node, scope)
    return /^(?:Identifier|MemberExpression)$/.test(node.type) ? text : `(${text})`
}

const unwrapped = text => /^\(.*\)$/s.test(text) ? text.slice(1, -1) : text

function immediateCall(converter, node, scope, parent) {
    const [fn] = node.arguments
    if (!fn) {
        converter.edits.replace(node.start, node.end, "undefined")
        return true
    }
    if (fn.type === "ArrowFunctionExpression" && fn.params.length === 0 && fn.body.type !== "BlockStatement") {
        const text = converter.textOf(fn.body, scope)
        converter.edits.replace(node.start, node.end, parent?.type === "ExpressionStatement" ? unwrapped(text) : `(${unwrapped(text)})`)
        return true
    }
    converter.edits.replace(node.start, node.end, `${callable(converter, fn, scope)}()`)
    return true
}

function portalCall(converter, node, scope) {
    const [content, target] = node.arguments
    if (!content || !target || content.type === "SpreadElement") {
        unsupported(converter, "createPortal", node)
        return false
    }
    const shown = /^JSX/.test(content.type) ? converter.textOf(content, scope) : `\${${converter.textOf(content, scope)}}`
    converter.edits.replace(node.start, node.end, `<Portal to=\${${converter.textOf(target, scope)}}>${shown}</Portal>`)
    return true
}

function handleCall(converter, node, scope) {
    const [ref, create] = node.arguments
    if (!ref || !create) {
        unsupported(converter, "useImperativeHandle", node)
        return false
    }
    converter.useHelper("setRef", REACT_HELPERS.setRef)
    const value = create.type === "ArrowFunctionExpression" && create.params.length === 0 && create.body.type !== "BlockStatement"
        ? unwrapped(converter.textOf(create.body, scope))
        : `${callable(converter, create, scope)}()`
    converter.edits.replace(node.start, node.end, `setRef(${converter.textOf(ref, scope)}, ${value})`)
    return true
}

function effectEvent(converter, node, scope) {
    const [fn] = node.arguments
    if (!fn) return false
    converter.edits.replace(node.start, node.end, `(...args) => untrack(() => ${callable(converter, fn, scope)}(...args))`)
    return true
}

export function reactCall(converter, node, scope, parent) {
    const name = reactName(converter, node.callee)
    const react = converter.react
    if (!react && name !== null && /^use[A-Z]/.test(name)) {
        converter.report("error", "custom-hook", `"${name}" is called outside a component: call it in a component, or in a function whose name starts with "use"`, node)
        return false
    }
    if (name === null) {
        if (routerCall(converter, node, scope)) return true
        if (react && node.callee.type === "Identifier" && react.setters.has(node.callee.name)) {
            setterCall(converter, node, react.setters.get(node.callee.name), scope)
            return true
        }
        if (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.name === "render") return rootRender(converter, node)
        if (isHookCall(node) && react) {
            if (!knownHook(converter, node.callee.name)) {
                packageHook(converter, node)
                return false
            }
            converter.edits.replace(node.start, node.end, parent?.type === "ExpressionStatement" ? hookCallText(converter, node, scope) : `${hookCallText(converter, node, scope)}.value`)
            return true
        }
        return false
    }
    if (name === "createRoot") return false
    switch (name) {
        case "useTransition":
            converter.edits.replace(node.start, node.end, "[false, fn => fn()]")
            return true
        case "startTransition":
            return immediateCall(converter, node, scope, parent)
        case "flushSync":
            converter.report("note", "flush-sync", "flushSync became a plain call: inside an event handler, Slim updates the page when the handler ends", node)
            return immediateCall(converter, node, scope, parent)
        case "useId":
            converter.useHelper("nextId", REACT_HELPERS.nextId)
            converter.edits.replace(node.start, node.end, "nextId()")
            return true
        case "useImperativeHandle":
            return handleCall(converter, node, scope)
        case "useEffectEvent":
            return effectEvent(converter, node, scope)
        case "createPortal":
            return portalCall(converter, node, scope)
        case "createElement":
            return elementCall(converter, node, scope)
        case "memo":
            spliceCall(converter, node, node.arguments[0], scope)
            return true
        case "useCallback":
        case "useDeferredValue":
            spliceCall(converter, node, node.arguments[0], scope)
            return true
        case "useMemo": {
            const [fn] = node.arguments
            if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") {
                spliceCall(converter, { ...node, end: node.end }, fn.body, scope)
                return true
            }
            converter.edits.replace(node.start, fn.start, "(")
            converter.visit(fn, node, scope)
            converter.edits.replace(fn.end, node.end, ")()")
            return true
        }
        case "useRef":
            refCall(converter, node, scope)
            return true
        case "useContext":
            converter.edits.replace(node.callee.start, node.callee.end, "inject")
            node.arguments.forEach(argument => converter.visit(argument, node, scope))
            return true
        case "createContext":
            converter.edits.replace(node.callee.start, node.callee.end, "createContext")
            node.arguments.forEach(argument => converter.visit(argument, node, scope))
            return true
        case "useDebugValue":
            converter.edits.replace(node.start, node.end, "void 0")
            return true
    }
    if (EFFECTS.has(name)) {
        if (!react) return false
        effectCall(converter, node, scope)
        return true
    }
    if (name in HINTS || /^use[A-Z]/.test(name)) unsupported(converter, name, node)
    return false
}

export function lazyDeclaration(converter, node, declarator, scope) {
    if (!isCall(converter, declarator.init, "lazy")) return false
    const [loader] = declarator.init.arguments
    if (node.declarations.length !== 1 || declarator.id.type !== "Identifier" || !loader || loader.type === "SpreadElement") return false
    const indent = converter.lineIndent(node.start, { start: -1 })
    const lines = [
        `component ${declarator.id.name}(props) {`,
        `    const loaded = resource(${converter.textOf(loader, scope)})`,
        "    return ${loaded.value ? loaded.value.default(props) : null}",
        "}"
    ]
    converter.edits.replace(node.start, node.end, lines.join(`\n${indent}`))
    return true
}

function storeDeclaration(converter, statement, declarator, scope) {
    const { id, init } = declarator
    const [subscribe, snapshot] = init.arguments
    if (!subscribe || !snapshot) {
        unsupported(converter, "useSyncExternalStore", init)
        return
    }
    const indent = converter.lineIndent(statement.start, { start: -1 })
    const name = id.type === "Identifier" ? id.name : freeName(converter, "store")
    const type = id.typeAnnotation ? `: ${converter.print(id.typeAnnotation, { ...scope, hint: name })}` : ""
    const lines = []
    let read = converter.textOf(snapshot, scope)
    if (!/^(?:Identifier|MemberExpression)$/.test(snapshot.type)) {
        lines.push(`const ${name}Snapshot = ${read}`)
        read = `${name}Snapshot`
    }
    lines.push(`state ${name}${type} = ${read}()`)
    if (id.type !== "Identifier") {
        const end = id.typeAnnotation?.start ?? id.end
        delete id.typeAnnotation
        lines.push(`const ${converter.textOfRange(id, id.start, end, scope).trimEnd()} = ${name}`)
    }
    lines.push(`effect(() => ${callable(converter, subscribe, scope)}(() => { ${name} = ${read}() }))`)
    converter.edits.replace(statement.start, statement.end, lines.join(`\n${indent}`))
}

function freeName(converter, base) {
    const taken = name => converter.valueNames.has(name) || converter.imports.has(name) || converter.react?.reactive.has(name)
    let name = base
    for (let index = 2; taken(name); index++) name = `${base}${index}`
    converter.valueNames.add(name)
    return name
}

export function setterValue(converter, node, parent, key) {
    const react = converter.react
    if (!react?.setters.has(node.name) || !isReference(node, parent, key)) return false
    const state = react.setters.get(node.name)
    const text = `(value => { ${state} = typeof value === "function" ? value(${state}) : value })`
    if (parent.type === "ObjectProperty" && parent.shorthand) converter.edits.replace(node.start, node.end, `${node.name}: ${text}`)
    else converter.edits.replace(node.start, node.end, text)
    return true
}

function hookCallText(converter, node, scope) {
    const args = node.arguments.map(argument => {
        if (argument.type === "SpreadElement") converter.report("error", "custom-hook", "a spread in the arguments of a hook has no Slim form", argument)
        const text = converter.textOf(argument, scope)
        return argument.type === "ObjectExpression" ? `() => (${text})` : `() => ${text}`
    })
    return `${node.callee.name}(${args.join(", ")})`
}

function hookResult(converter, statement, declarator, scope) {
    const { id, init } = declarator
    const hook = init.callee.name
    const base = `${hook[3].toLowerCase()}${hook.slice(4)}Result`
    const used = converter.react.results
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    const name = count === 1 ? base : `${base}${count}`
    const indent = converter.lineIndent(statement.start, { start: -1 })
    delete id.typeAnnotation
    const pattern = converter.code.slice(id.start, id.end).replace(/:\s*[^,}\]]+$/, "")
    const target = id.type === "Identifier" ? id.name : pattern
    converter.edits.replace(statement.start, statement.end, `const ${name} = ${hookCallText(converter, init, scope)}\n${indent}const ${target} = ${name}.value`)
}

function hookParameter(converter, fn, parameter, index, scope, reads) {
    const target = parameter.type === "AssignmentPattern" ? parameter.left : parameter
    const initial = parameter.type === "AssignmentPattern" ? converter.textOf(parameter.right, scope) : null
    const fallback = initial === null ? "" : ` = () => ${parameter.right.type === "ObjectExpression" ? `(${initial})` : initial}`
    if (target.type === "Identifier") {
        reads.add(target.name)
        converter.edits.replace(parameter.start, parameter.end, `${target.name}${fallback}`)
        return
    }
    const name = index === 0 ? "options" : `options${index + 1}`
    const end = target.typeAnnotation?.start ?? target.end
    const indent = converter.lineIndent(fn.start, { start: -1 })
    fn.propsPattern = `${fn.propsPattern ?? ""}\n${indent}    const ${converter.code.slice(target.start, end).trimEnd()} = ${name}()`
    converter.edits.replace(parameter.start, parameter.end, `${name}${fallback}`)
}

export function convertHook(converter, fn, scope) {
    const inner = converter.functionScope(fn, scope)
    if (fn.typeParameters) converter.typeChild(fn.typeParameters, fn, inner)
    if (fn.returnType) converter.edits.remove(fn.returnType.start, fn.returnType.end)
    insideComponent(converter, fn, react => {
        react.hook = true
        const reads = new Set()
        fn.params.forEach((parameter, index) => hookParameter(converter, fn, parameter, index, inner, reads))
        converter.replacements ??= new Map()
        walk(fn.body, (item, owner, key) => {
            if (!isReference(item, owner, key) || !reads.has(item.name)) return
            converter.replacements.set(item, owner?.type === "ObjectProperty" && owner.shorthand ? `${item.name}: ${item.name}()` : `${item.name}()`)
        })
        if (fn.body.type === "BlockStatement") {
            convertStatements(converter, react, fn, inner)
            return
        }
        const text = converter.textOf(fn.body, inner)
        converter.edits.replace(fn.body.extra?.parenStart ?? fn.body.start, fn.end, `({ get value() { return ${text} } })`)
    })
}

function stateDeclaration(converter, statement, declarator, scope) {
    const { id, init } = declarator
    const [value, setter] = id.elements
    const name = value?.name ?? stateNameOf(setter.name)
    const args = typeArguments(init)
    const type = args?.length ? `: ${converter.print(args[0], { ...scope, hint: name })}` : ""
    const [first] = init.arguments
    const head = `state ${name}${type} = `
    if (!first) {
        converter.edits.replace(statement.start, statement.end, `${head}undefined`)
        return
    }
    if (first.type === "ArrowFunctionExpression" && first.body.type !== "BlockStatement") {
        converter.edits.replace(statement.start, statement.end, `${head}${converter.textOf(first.body, scope)}`)
        return
    }
    if (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") {
        converter.edits.replace(statement.start, first.start, `${head}(`)
        converter.visit(first, init, scope)
        converter.edits.replace(first.end, statement.end, ")()")
        return
    }
    converter.edits.replace(statement.start, first.start, head)
    converter.visit(first, init, scope)
    converter.edits.remove(first.end, statement.end)
}

function reducerDeclaration(converter, statement, declarator, scope) {
    const { id, init } = declarator
    const [value, dispatch] = id.elements
    const name = value.name
    const [reducer, initial, starter] = init.arguments
    const indent = converter.lineIndent(statement.start, { start: -1 })
    const reducerText = converter.textOf(reducer, scope)
    const start = converter.textOf(initial, scope)
    const lines = []
    let call = reducerText
    if (reducer.type !== "Identifier") {
        call = `${name}Reducer`
        lines.push(`const ${call} = ${reducerText}`)
    }
    lines.push(`state ${name} = ${starter ? `${converter.textOf(starter, scope)}(${start})` : start}`)
    if (dispatch) lines.push(`const ${dispatch.name} = action => { ${name} = ${call}(${name}, action) }`)
    converter.edits.replace(statement.start, statement.end, lines.join(`\n${indent}`))
}

const simpleGuard = statement => {
    if (statement.type !== "IfStatement" || statement.alternate) return null
    const { consequent } = statement
    if (consequent.type === "ReturnStatement") return consequent
    if (consequent.type === "BlockStatement" && consequent.body.length === 1 && consequent.body[0].type === "ReturnStatement") return consequent.body[0]
    return null
}

function switchReturns(statement) {
    if (statement?.type !== "SwitchStatement" || !/^(?:Identifier|MemberExpression|OptionalMemberExpression)$/.test(statement.discriminant.type)) return null
    const groups = []
    let tests = []
    let fallback = null
    for (const item of statement.cases) {
        const body = item.consequent.length === 1 && item.consequent[0].type === "BlockStatement" ? item.consequent[0].body : item.consequent
        if (body.length > 1 || (body.length === 1 && body[0].type !== "ReturnStatement")) return null
        if (item.test === null) {
            if (body.length === 0 || tests.length) return null
            fallback = body[0]
            continue
        }
        tests.push(item.test)
        if (body.length === 0) continue
        groups.push({ tests, value: body[0] })
        tests = []
    }
    return tests.length || !groups.length ? null : { discriminant: statement.discriminant, groups, fallback }
}

const hasReturn = statement => {
    let found = false
    walk(statement, node => {
        if (/Function/.test(node.type)) return false
        if (node.type === "ReturnStatement") found = true
    })
    return found
}

function writesTo(statement, name) {
    let found = false
    walk(statement, node => {
        if (/Function/.test(node.type)) return false
        if (node.type === "AssignmentExpression" && node.left.type === "Identifier" && node.left.name === name) found = true
        if (node.type === "UpdateExpression" && node.argument.type === "Identifier" && node.argument.name === name) found = true
    })
    return found
}

function writtenInClosure(statements, name) {
    let found = false
    for (const statement of statements) {
        walk(statement, node => {
            if (!/Function/.test(node.type)) return
            walk(node, inner => {
                if (inner.type === "AssignmentExpression" && inner.left.type === "Identifier" && inner.left.name === name) found = true
                if (inner.type === "UpdateExpression" && inner.argument.type === "Identifier" && inner.argument.name === name) found = true
            })
        })
    }
    return found
}

function renderedLet(converter, statements, index, handled) {
    const statement = statements[index]
    if (statement.type !== "VariableDeclaration" || statement.kind === "const" || statement.declarations.length !== 1) return
    const [{ id }] = statement.declarations
    if (id.type !== "Identifier") return
    const { name } = id
    const rest = statements.slice(index + 1)
    if (writtenInClosure(statements, name)) return
    let last = -1
    rest.forEach((item, offset) => {
        if (writesTo(item, name)) last = offset
    })
    if (last < 0) {
        const keyword = statement.kind.length
        converter.edits.replace(statement.start, statement.start + keyword, "const")
        return
    }
    const group = rest.slice(0, last + 1)
    const declared = group.flatMap(item => item.type === "VariableDeclaration" ? item.declarations.flatMap(({ id: bound }) => [...patternNames(bound)]) : [])
    const after = rest.slice(last + 1)
    const leaking = declared.some(item => after.some(other => namesIn(other, new Set([item])).size > 0))
    if (leaking || group.some(hasReturn)) {
        converter.report("warning", "react-render-code", `"${name}" is worked out with statements that run once in Slim, not on every render: make it a const`, statement)
        return
    }
    const indent = converter.lineIndent(statement.start, { start: -1 })
    converter.edits.insert(statement.start, `const ${name} = (() => {\n${indent}    `)
    converter.edits.insert(group.at(-1).end, `\n${indent}    return ${name}\n${indent}})()`)
    handled.add(index)
    for (let offset = 1; offset <= last + 1; offset++) handled.add(index + offset)
}

function isHookStatement(converter, statement) {
    return statement.type === "ExpressionStatement" && statement.expression.type === "CallExpression" && reactName(converter, statement.expression.callee) !== null
}

function wrapped(converter, node, scope) {
    const text = converter.textOf(node, scope)
    return /^(?:ConditionalExpression|AssignmentExpression|SequenceExpression|ArrowFunctionExpression)$/.test(node.type) ? `(${text})` : text
}

function returnValue(converter, statement, scope) {
    return statement.argument ? converter.textOf(statement.argument, scope) : "null"
}

export function insideComponent(converter, fn, run) {
    const outer = converter.react
    converter.react = collect(converter, fn)
    const result = run(converter.react)
    converter.react = outer
    return result
}

export function convertBody(converter, fn, scope) {
    insideComponent(converter, fn, react => convertStatements(converter, react, fn, scope))
}

function convertStatements(converter, react, fn, scope) {
    converter.provides = []
    renameShadows(converter, react)
    keepStaleReads(converter, react)

    const statements = fn.body.body
    if (fn.propsPattern) {
        const onOneLine = !converter.code.slice(fn.body.start, statements[0]?.start ?? fn.body.end).includes("\n")
        const indent = converter.lineIndent(fn.start, { start: -1 })
        converter.edits.insert(fn.body.start + 1, `${fn.propsPattern}${onOneLine ? `\n${indent}   ` : ""}`)
    }
    const lastReturn = statements.findLastIndex(statement => statement.type === "ReturnStatement")
    const switched = lastReturn < statements.length - 1 ? switchReturns(statements.at(-1)) : null
    const finalReturn = switched ? statements.length - 1 : lastReturn
    const grouped = new Set()
    const guards = []
    statements.forEach((_, index) => {
        if (!grouped.has(index)) renderedLet(converter, statements, index, grouped)
    })

    statements.forEach((statement, index) => {
        const guard = simpleGuard(statement)
        if (guard && index < finalReturn) {
            guards.push({ test: statement.test, value: guard })
            converter.edits.removeStatement(statement)
            return
        }
        if (index === finalReturn) {
            if (switched) {
                const subject = converter.textOf(switched.discriminant, scope)
                for (const group of switched.groups) {
                    guards.push({ text: group.tests.map(item => `${subject} === ${wrapped(converter, item, scope)}`).join(" || "), value: group.value })
                }
            }
            const choices = guards.map(item => `${item.text ?? wrapped(converter, item.test, scope)} ? ${returnValue(converter, item.value, scope)} : `).join("")
            converter.rootElement = switched ? null : statement.argument
            const value = switched ? (switched.fallback ? returnValue(converter, switched.fallback, scope) : "null") : statement.argument ? converter.textOf(statement.argument, scope) : "null"
            const indent = converter.lineIndent(statement.start, { start: -1 })
            const provided = converter.provides.map(item => `provide(${item.context}, ${item.value})\n${indent}`).join("")
            const head = provided
            const shown = guards.length ? `\${${choices}${value}}` : value
            const text = react.hook ? `return { get value() { return ${choices}${value} } }` : `return ${shown}`
            converter.edits.replace(statement.start, statement.end, `${head}${text}`)
            return
        }
        if (statement.type === "VariableDeclaration" && statement.declarations.length === 1) {
            const [declarator] = statement.declarations
            if (isCall(converter, declarator.init, "useState") && declarator.id.type === "ArrayPattern") return stateDeclaration(converter, statement, declarator, scope)
            if (isCall(converter, declarator.init, "useReducer") && declarator.id.type === "ArrayPattern") return reducerDeclaration(converter, statement, declarator, scope)
            if (isCall(converter, declarator.init, "useSyncExternalStore")) return storeDeclaration(converter, statement, declarator, scope)
            if (isHookCall(declarator.init) && knownHook(converter, declarator.init.callee.name)) return hookResult(converter, statement, declarator, scope)
        }
        const isRender = !grouped.has(index) && !isHookStatement(converter, statement) &&
            /^(?:ExpressionStatement|IfStatement|ForStatement|ForOfStatement|ForInStatement|WhileStatement|DoWhileStatement|SwitchStatement|TryStatement)$/.test(statement.type)
        if (isRender && namesIn(statement, react.reactive).size > 0) renderCode(converter, react, statement, scope)
        else converter.visit(statement, fn.body, scope)
    })
}

function jsxCall(converter, element, scope) {
    const tag = element.openingElement.name
    const name = tag.type === "JSXIdentifier" ? tag.name : converter.code.slice(tag.start, tag.end)
    if (name === "StrictMode" || name === "React.StrictMode" || name === "Fragment" || name === "React.Fragment") {
        const [only] = element.children.filter(child => child.type === "JSXElement")
        return only ? jsxCall(converter, only, scope) : ""
    }
    const fields = element.openingElement.attributes.map(attribute => {
        if (attribute.type === "JSXSpreadAttribute") return `...${converter.code.slice(attribute.argument.start, attribute.argument.end)}`
        const key = attribute.name.name
        if (!attribute.value) return `${key}: true`
        if (attribute.value.type === "StringLiteral") return `${key}: ${JSON.stringify(attribute.value.value)}`
        return `${key}: ${converter.code.slice(attribute.value.expression.start, attribute.value.expression.end)}`
    })
    return `${name}(${fields.length ? `{ ${fields.join(", ")} }` : ""})`
}

function rootRender(converter, node) {
    const callee = node.callee
    const [element, container] = node.arguments
    if (element?.type !== "JSXElement") return false
    const owner = callee.object
    const code = (from, to) => converter.code.slice(from, to)
    if (reactName(converter, callee) === "render" && container) {
        converter.edits.replace(node.start, node.end, `${code(container.start, container.end)}.replaceChildren(${jsxCall(converter, element, null)})`)
        return true
    }
    if (isCall(converter, owner, "createRoot")) {
        const [target] = owner.arguments
        converter.edits.replace(node.start, node.end, `${code(target.start, target.end)}.replaceChildren(${jsxCall(converter, element, null)})`)
        return true
    }
    if (owner.type === "Identifier" && converter.reactRoots?.has(owner.name)) {
        converter.edits.replace(node.start, node.end, `${owner.name}.replaceChildren(${jsxCall(converter, element, null)})`)
        return true
    }
    return false
}

export function rootDeclaration(converter, declarator) {
    if (!isCall(converter, declarator.init, "createRoot") || declarator.id.type !== "Identifier") return false
    const [target] = declarator.init.arguments
    converter.reactRoots ??= new Set()
    converter.reactRoots.add(declarator.id.name)
    converter.edits.replace(declarator.init.start, declarator.init.end, converter.code.slice(target.start, target.end))
    return true
}

export function classComponentHint(node) {
    const names = new Set(node.body.body.map(member => member.key?.name))
    if (names.has("componentDidCatch") || names.has("getDerivedStateFromError")) {
        return "it is an error boundary: show its content with catchError(() => content, (error, reset) => fallback) instead"
    }
    return "rewrite it as a function first: this.state becomes useState, componentDidMount and componentWillUnmount become useEffect"
}

export function isClassComponent(converter, node) {
    const parent = node.superClass
    if (!parent) return false
    const name = reactName(converter, parent)
    return name === "Component" || name === "PureComponent"
}
