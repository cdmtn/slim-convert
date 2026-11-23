const KEYWORDS = {
    TSAnyKeyword: "any",
    TSUnknownKeyword: "any",
    TSStringKeyword: "string",
    TSNumberKeyword: "number",
    TSBooleanKeyword: "bool",
    TSNullKeyword: "null",
    TSUndefinedKeyword: "undefined",
    TSVoidKeyword: "void",
    TSObjectKeyword: "any",
    TSBigIntKeyword: "bigint",
    TSSymbolKeyword: "symbol",
    TSNeverKeyword: "never",
    TSIntrinsicKeyword: "any"
}

const ERASED_WRAPPERS = new Set(["Readonly"])

const UTILITY_TYPES = new Set([
    "Partial", "Required", "Pick", "Omit", "Exclude", "Extract", "NonNullable", "Parameters", "ConstructorParameters",
    "ReturnType", "InstanceType", "ThisParameterType", "OmitThisParameter", "ThisType", "Awaited",
    "Uppercase", "Lowercase", "Capitalize", "Uncapitalize"
])

const GLOBAL_TYPES = new Set([
    "Array", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Date", "RegExp", "Promise", "Error", "Record",
    "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError",
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
    "URL", "URLSearchParams", "AbortController", "AbortSignal", "Blob", "File", "FormData", "Headers", "Request", "Response",
    "TextDecoder", "TextEncoder", "ReadableStream", "WritableStream", "TransformStream", "Buffer", "Event", "EventTarget",
    "Node", "Element", "Document", "Window", "Text"
])

const BROWSER_TYPE = /^(?:HTML|SVG|DOM|CSS|RTC|WebGL|IDB)|(?:Event|Element|Observer)$/

const unwrapped = node => node.type === "TSParenthesizedType" ? unwrapped(node.typeAnnotation) : node

export function entityName(node) {
    if (node.type === "Identifier") return node.name
    if (node.type === "ThisExpression") return "this"
    if (node.type === "TSQualifiedName") return `${entityName(node.left)}.${node.right.name}`
    if (node.type === "MemberExpression" && !node.computed) return `${entityName(node.object)}.${node.property.name}`
    return null
}

export function typeArguments(node) {
    return (node.typeParameters ?? node.typeArguments)?.params ?? null
}

export function propertyName(member) {
    if (member.computed || !member.key) return null
    if (member.key.type === "Identifier") return member.key.name
    if (member.key.type === "StringLiteral") return member.key.value
    if (member.key.type === "NumericLiteral") return String(member.key.value)
    return null
}

export const plainName = name => /^[\p{ID_Start}_$][\p{ID_Continue}$‌‍]*$/u.test(name)

export function printField(name) {
    return plainName(name) ? name : JSON.stringify(name)
}

export class TypePrinter {
    constructor(context) {
        this.context = context
    }

    note(node, code, message) {
        this.context.report("note", code, message, node)
        return "any"
    }

    print(node, scope) {
        const type = unwrapped(node)
        if (type.type === "TSTypeAnnotation") return this.print(type.typeAnnotation, scope)
        if (type.type in KEYWORDS) {
            if (type.type === "TSObjectKeyword") return "any"
            return KEYWORDS[type.type]
        }
        switch (type.type) {
            case "TSTypeReference": return this.reference(type, scope)
            case "TSExpressionWithTypeArguments":
            case "TSInterfaceHeritage":
            case "TSClassImplements": return this.reference({ ...type, typeName: type.expression }, scope)
            case "TSArrayType": return `${this.operand(type.elementType, scope)}[]`
            case "TSTupleType": return this.tuple(type, scope)
            case "TSUnionType": return this.union(type, scope)
            case "TSIntersectionType": return this.intersection(type, scope)
            case "TSLiteralType": return this.literal(type)
            case "TSTypeLiteral": return this.objectType(type, scope)
            case "TSFunctionType": return this.functionType(type, scope)
            case "TSConstructorType": return "function"
            case "TSThisType": return scope.allowThis ? "this" : "any"
            case "TSTypePredicate": return type.asserts ? "any" : "bool"
            case "TSTypeOperator": return this.operator(type, scope)
            case "TSTemplateLiteralType": return "string"
            case "TSTypeQuery": return this.note(type, "typeof-type", `"typeof" in a type became "any"`)
            case "TSIndexedAccessType": return this.note(type, "indexed-type", `an indexed access type became "any"`)
            case "TSConditionalType": return this.note(type, "conditional-type", `a conditional type became "any"`)
            case "TSMappedType": return this.note(type, "mapped-type", `a mapped type became "any"`)
            case "TSInferType": return "any"
            case "TSImportType": return this.note(type, "import-type", `an import() type became "any"`)
            case "TSOptionalType":
            case "TSRestType": return this.print(type.typeAnnotation, scope)
            case "TSNamedTupleMember": return this.print(type.elementType, scope)
        }
        return this.note(type, "unknown-type", `this type became "any"`)
    }

    operand(node, scope) {
        const type = unwrapped(node)
        const text = this.print(type, scope)
        return isCompound(text) ? `(${text})` : text
    }

    reference(node, scope) {
        const name = entityName(node.typeName)
        const args = typeArguments(node)
        if (name === null) return this.note(node, "unknown-type", `this type became "any"`)
        const bound = scope.bound?.get(name)
        if (bound !== undefined) return bound
        if (scope.hidden?.has(name)) return "any"
        if (scope.params?.has(name)) return name

        const resolved = this.context.resolveType(name, node, scope)
        if (resolved !== null) return resolved === name ? this.withArguments(name, args, scope) : resolved

        if (name === "ReadonlyArray" && args) return `readonly ${this.operand(args[0], scope)}[]`
        if (name === "Function") return "function"
        if (name === "Object") return "any"
        if (name === "Boolean") return "bool"
        if (name === "String") return "string"
        if (name === "Number") return "number"
        if (ERASED_WRAPPERS.has(name) && args) return this.print(args[0], scope)
        if (UTILITY_TYPES.has(name)) return this.note(node, "utility-type", `"${name}<...>" became "any": Slim has no such type`)
        if (!name.includes(".") && (GLOBAL_TYPES.has(name) || BROWSER_TYPE.test(name))) return this.withArguments(name, args, scope)
        return this.note(node, "unknown-type", `the type "${name}" is not declared here and became "any"`)
    }

    withArguments(name, args, scope) {
        if (!args?.length) return name
        const printed = args.map(arg => this.print(arg, scope))
        const params = this.context.typeParametersOf?.(name) ?? []
        if (params.length > printed.length && params.slice(printed.length).every(param => param.default)) {
            const bound = new Map(scope.bound ?? [])
            params.forEach((param, index) => {
                if (index >= printed.length) printed.push(this.print(param.default, { ...scope, bound }))
                bound.set(param.name?.name ?? param.name, printed[index])
            })
        }
        return `${name}<${printed.join(", ")}>`
    }

    tuple(node, scope) {
        const items = node.elementTypes
        const optional = item => item.type === "TSOptionalType" || item.optional
        const rest = items.some(item => item.type === "TSRestType")
        const required = items.findIndex(optional)
        if (!rest && required >= 0 && items.slice(required).every(optional)) {
            const printed = items.map(item => this.print(item, scope))
            return Array.from({ length: items.length - required + 1 }, (_, extra) => `[${printed.slice(0, required + extra).join(", ")}]`).join(" | ")
        }
        if (rest || required >= 0) {
            this.context.report("note", "open-tuple", "a tuple with optional or rest members became an array")
            const parts = [...new Set(items.map(item => this.operand(item.type === "TSRestType" ? restElement(item) : item, scope)))]
            return parts.length === 1 ? `${parts[0]}[]` : `(${parts.join(" | ")})[]`
        }
        return `[${items.map(item => this.print(item, scope)).join(", ")}]`
    }

    union(node, scope) {
        const parts = [...new Set(node.types.map(type => this.operand(type, scope)))]
        return parts.includes("any") ? "any" : parts.join(" | ")
    }

    intersection(node, scope) {
        const types = node.types.map(unwrapped)
        if (types.some(type => type.type === "TSTypeLiteral")) {
            return this.note(node, "object-intersection", `an intersection with an object type became "any": Slim's object types are exact`)
        }
        const parts = types.map(type => this.operand(type, scope))
        return parts.includes("any") ? "any" : parts.join(" & ")
    }

    literal(node) {
        const value = node.literal
        switch (value.type) {
            case "StringLiteral": return JSON.stringify(value.value)
            case "NumericLiteral": return String(value.value)
            case "BooleanLiteral": return String(value.value)
            case "BigIntLiteral": return "bigint"
            case "UnaryExpression": return `-${value.argument.value}`
            case "TemplateLiteral":
                return value.expressions.length === 0 ? JSON.stringify(value.quasis[0].value.cooked) : "string"
        }
        return "any"
    }

    members(node) {
        return node.members ?? node.body?.body ?? []
    }

    objectType(node, scope) {
        const members = this.members(node)
        if (members.length === 0) return "any"
        const indexes = members.filter(member => member.type === "TSIndexSignature")
        const calls = members.filter(member => member.type === "TSCallSignatureDeclaration")
        const others = members.filter(member => member.type === "TSPropertySignature" || member.type === "TSMethodSignature")

        if (calls.length === 1 && members.length === 1) return this.signature(calls[0], scope)
        if (indexes.length === 1 && members.length === 1) {
            const index = indexes[0]
            const [parameter] = index.parameters
            const key = parameter.typeAnnotation ? this.print(parameter.typeAnnotation, scope) : "string"
            return `Record<${key}, ${this.print(index.typeAnnotation, scope)}>`
        }
        if (others.length !== members.length) return this.note(node, "object-type", `an object type with index or call signatures became "any"`)

        return this.context.hoistShape(others, scope) ?? this.note(node, "object-type", `an object type with computed or repeated names became "any"`)
    }

    fields(members, scope) {
        const seen = new Set()
        const fields = []
        for (const member of members) {
            const name = propertyName(member)
            if (name === null || seen.has(name)) return null
            seen.add(name)
            if (plainName(name)) fields.push(this.field(member, name, scope))
        }
        return fields
    }

    field(member, name, scope) {
        const inner = { ...scope, hint: `${scope.hint ?? ""}${name[0].toUpperCase()}${name.slice(1)}` }
        const annotation = member.typeAnnotation
        const type = member.type === "TSMethodSignature" ? this.signature(member, inner) : annotation ? this.print(annotation, inner) : "any"
        return `${printField(name)}${member.optional || type === "any" ? "?" : ""}: ${type}`
    }

    signature(node, scope) {
        const inner = this.innerScope(node, scope)
        const parameters = (node.parameters ?? node.params ?? []).filter(parameter => !(parameter.type === "Identifier" && parameter.name === "this"))
        if (parameters.some(parameter => parameter.type === "RestElement")) return "function"
        const printed = parameters.map((parameter, index) => this.parameter(parameter, index, inner))
        const returns = node.typeAnnotation ?? node.returnType
        return `(${printed.join(", ")}) => ${returns ? this.returnType(returns, inner) : "any"}`
    }

    functionType(node, scope) {
        return this.signature(node, scope)
    }

    returnType(annotation, scope) {
        const inner = annotation.type === "TSTypeAnnotation" ? annotation.typeAnnotation : annotation
        return this.print(inner, scope)
    }

    parameter(parameter, index, scope) {
        const name = parameter.type === "Identifier" ? parameter.name : `arg${index}`
        const type = parameter.typeAnnotation ? this.print(parameter.typeAnnotation, scope) : "any"
        return `${name}${parameter.optional ? "?" : ""}: ${type}`
    }

    innerScope(node, scope) {
        const params = (node.typeParameters ?? node.typeArguments)?.params
        if (!params?.length) return scope
        return { ...scope, hidden: new Set([...(scope.hidden ?? []), ...params.map(param => param.name?.name ?? param.name)]) }
    }

    operator(node, scope) {
        if (node.operator === "readonly") {
            const inner = unwrapped(node.typeAnnotation)
            if (inner.type === "TSArrayType") return `readonly ${this.print(inner, scope)}`
            return this.print(inner, scope)
        }
        if (node.operator === "unique") return "symbol"
        return this.note(node, "keyof-type", `"keyof" became "any"`)
    }

    typeParameters(node, scope) {
        const params = node?.params
        if (!params?.length) return ""
        const printed = params.map(param => {
            const name = param.name?.name ?? param.name
            const objectType = param.constraint && unwrapped(param.constraint).type === "TSTypeLiteral"
            if (objectType) this.note(param.constraint, "object-constraint", `the object type that "${name}" extends was dropped: a Slim trait accepts no strings or arrays`)
            const constraint = param.constraint && !objectType ? this.print(param.constraint, scope) : "any"
            return constraint !== "any" ? `${name} extends ${constraint}` : name
        })
        return `<${printed.join(", ")}>`
    }

    typeParameterNames(node) {
        return (node?.params ?? []).map(param => param.name?.name ?? param.name)
    }
}

function isCompound(text) {
    let depth = 0
    for (let index = 0; index < text.length; index++) {
        const char = text[index]
        if (char === '"') {
            index = text.indexOf('"', index + 1)
            if (index < 0) return false
        } else if ("([{<".includes(char)) depth++
        else if (char === ">" && text[index - 1] === "=") {
            if (depth === 0) return true
        } else if (")]}>".includes(char)) depth--
        else if (depth === 0 && (char === "|" || char === "&")) return true
    }
    return text.startsWith("readonly ")
}

function restElement(node) {
    const inner = unwrapped(node.typeAnnotation)
    return inner.type === "TSArrayType" ? inner.elementType : node.typeAnnotation
}
