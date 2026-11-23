import { children, isTypeNode } from "./parse.js"
import { entityName, propertyName, typeArguments } from "./types.js"

export const enumMembers = node => node.members ?? node.body?.members ?? []

export const memberList = node => node.body?.body ?? node.members ?? []

function evaluate(node, known, owner) {
    switch (node.type) {
        case "NumericLiteral":
        case "StringLiteral": return node.value
        case "TemplateLiteral":
            return node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined
        case "Identifier": return known.get(node.name)
        case "ParenthesizedExpression": return evaluate(node.expression, known, owner)
        case "MemberExpression":
            return !node.computed && node.object.type === "Identifier" && node.object.name === owner ? known.get(node.property.name) : undefined
        case "UnaryExpression": {
            const value = evaluate(node.argument, known, owner)
            if (typeof value !== "number") return undefined
            if (node.operator === "-") return -value
            if (node.operator === "+") return value
            if (node.operator === "~") return ~value
            return undefined
        }
        case "BinaryExpression": {
            const left = evaluate(node.left, known, owner)
            const right = evaluate(node.right, known, owner)
            if (left === undefined || right === undefined) return undefined
            if (node.operator === "+") return left + right
            if (typeof left !== "number" || typeof right !== "number") return undefined
            switch (node.operator) {
                case "-": return left - right
                case "*": return left * right
                case "/": return left / right
                case "%": return left % right
                case "**": return left ** right
                case "<<": return left << right
                case ">>": return left >> right
                case ">>>": return left >>> right
                case "&": return left & right
                case "|": return left | right
                case "^": return left ^ right
            }
        }
    }
    return undefined
}

const valueText = value => typeof value === "number" ? (Object.is(value, -0) ? "-0" : String(value)) : JSON.stringify(value)

export const reverseKey = value => /^\d+$/.test(String(value)) ? String(value) : JSON.stringify(String(value))

function enumInfo(converter, node) {
    const known = new Map()
    const printed = new Map()
    const values = new Map()
    const reverse = []
    let next = 0
    let opaque = false

    for (const member of enumMembers(node)) {
        const key = propertyName({ key: member.id, computed: false })
        let value = next
        if (member.initializer) {
            value = evaluate(member.initializer, known, node.id.name)
            if (value === undefined) {
                opaque = true
                printed.set(key, converter.code.slice(member.initializer.start, member.initializer.end))
                converter.report("warning", "computed-enum", `the value of "${node.id.name}.${key}" is computed: check it, it was copied as it is`, member)
                next = NaN
                continue
            }
        }
        known.set(key, value)
        printed.set(key, valueText(value))
        values.set(key, typeof value === "number" && !Number.isFinite(value) ? "number" : valueText(value))
        if (typeof value === "number") {
            if (!node.const) reverse.push([value, key])
            next = value + 1
        } else next = NaN
    }

    const all = [...known.values()]
    const numeric = all.some(value => typeof value === "number") || opaque
    const strings = [...new Set(all.filter(value => typeof value === "string"))].map(value => JSON.stringify(value))
    const type = numeric ? (strings.length ? "any" : "number") : strings.join(" | ") || "any"
    return { node, printed, values, reverse, type }
}

function bindingNames(pattern, names) {
    if (!pattern) return
    switch (pattern.type) {
        case "Identifier": names.add(pattern.name); break
        case "ObjectPattern": pattern.properties.forEach(property => bindingNames(property.value ?? property.argument, names)); break
        case "ArrayPattern": pattern.elements.forEach(element => bindingNames(element, names)); break
        case "AssignmentPattern": bindingNames(pattern.left, names); break
        case "RestElement": bindingNames(pattern.argument, names); break
    }
}

export function collectDeclarations(converter) {
    converter.interfaces = new Map()
    converter.aliases = new Map()
    converter.enums = new Map()
    converter.classNames = new Set()
    converter.declaredTypes = new Set()
    converter.anyTypes = new Set()
    converter.overloaded = new Set()
    converter.hooks = new Set()
    converter.typeParams = new Map()
    const values = new Set()

    const visit = (node, top) => {
        switch (node.type) {
            case "TSInterfaceDeclaration": {
                const list = converter.interfaces.get(node.id.name) ?? []
                list.push(node)
                converter.interfaces.set(node.id.name, list)
                converter.declaredTypes.add(node.id.name)
                if (node.typeParameters && !converter.typeParams.has(node.id.name)) converter.typeParams.set(node.id.name, node.typeParameters.params)
                return
            }
            case "TSTypeAliasDeclaration":
                converter.aliases.set(node.id.name, node)
                converter.declaredTypes.add(node.id.name)
                if (node.typeParameters) converter.typeParams.set(node.id.name, node.typeParameters.params)
                return
            case "TSDeclareFunction":
                if (!node.declare && node.id) converter.overloaded.add(node.id.name)
                return
            case "TSEnumDeclaration":
                if (!converter.enums.has(node.id.name)) converter.enums.set(node.id.name, enumInfo(converter, node))
                return
            case "ClassDeclaration":
                if (node.id) {
                    converter.classNames.add(node.id.name)
                    converter.declaredTypes.add(node.id.name)
                    if (node.typeParameters) converter.typeParams.set(node.id.name, node.typeParameters.params)
                }
                break
            case "FunctionDeclaration":
                if (top && node.id) values.add(node.id.name)
                if (top && /^use[A-Z]/.test(node.id?.name ?? "")) converter.hooks.add(node.id.name)
                break
            case "VariableDeclaration":
                if (top) node.declarations.forEach(declaration => bindingNames(declaration.id, values))
                if (top) for (const { id, init } of node.declarations) if (/^use[A-Z]/.test(id.name ?? "") && /Function/.test(init?.type ?? "")) converter.hooks.add(id.name)
                break
        }
        for (const [child] of children(node)) {
            if (!isTypeNode(child)) visit(child, top && (child.type === "ExportNamedDeclaration" || child.type === "ExportDefaultDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration"))
        }
    }
    for (const statement of converter.ast.program.body) visit(statement, true)

    for (const name of [...converter.interfaces.keys(), ...converter.aliases.keys()]) {
        if (values.has(name)) {
            converter.anyTypes.add(name)
            converter.declaredTypes.delete(name)
        }
    }
}

export function interfaceShape(converter, own, inherited, scope) {
    const all = [...own, ...inherited.map(item => item.member)]
    const calls = all.filter(member => member.type === "TSCallSignatureDeclaration")
    const constructs = all.filter(member => member.type === "TSConstructSignatureDeclaration")
    const indexes = all.filter(member => member.type === "TSIndexSignature")
    const fields = all.filter(member => member.type === "TSPropertySignature" || member.type === "TSMethodSignature")
    const result = { alias: null, names: new Set(), overloaded: new Set() }

    if (calls.length || constructs.length) {
        result.alias = calls.length === 1 && all.length === 1 ? converter.printer.signature(calls[0], scope) : "function"
        return result
    }
    if (fields.length === 0) {
        if (indexes.length === 1) {
            const [parameter] = indexes[0].parameters
            const key = parameter.typeAnnotation ? converter.print(parameter.typeAnnotation, scope) : "string"
            result.alias = `Record<${key}, ${converter.print(indexes[0].typeAnnotation, scope)}>`
        } else result.alias = "any"
        return result
    }
    if (indexes.length) converter.report("note", "index-signature", "an index signature next to named fields was dropped: a trait allows other fields anyway", indexes[0])

    const counts = new Map()
    for (const member of own.filter(item => item.type === "TSMethodSignature" && !item.kind?.match(/get|set/))) {
        const name = propertyName(member)
        if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    for (const [name, count] of counts) if (count > 1) result.overloaded.add(name)
    for (const member of fields) {
        const name = propertyName(member)
        if (name !== null) result.names.add(name)
    }
    return result
}

function parentDeclaration(converter, name) {
    const interfaces = converter.interfaces.get(name)
    if (interfaces) return { nodes: interfaces, members: interfaces.flatMap(memberList), parents: interfaces.flatMap(node => node.extends ?? []) }
    const alias = converter.aliases.get(name)
    if (alias?.typeAnnotation.type === "TSTypeLiteral") return { nodes: [alias], members: alias.typeAnnotation.members, parents: [] }
    const imported = converter.imports.get(name)
    if (imported?.relative) return converter.context?.interfaceOf(converter.file, imported) ?? null
    return null
}

export function inheritedMembers(converter, references, scope, strict = false) {
    const found = []
    for (const reference of references) {
        const expression = reference.expression ?? reference.typeName
        const name = expression ? entityName(expression) : null
        const parent = name && parentDeclaration(converter, name)
        if (!parent) {
            if (strict) return null
            converter.report("note", "unknown-parent", `the fields of "${name ?? "a parent type"}" are not known here and were left out`, reference)
            continue
        }
        const params = (parent.nodes[0].typeParameters?.params ?? []).map(param => param.name?.name ?? param.name)
        const args = typeArguments(reference) ?? []
        const bound = new Map(scope.bound ?? [])
        params.forEach((param, index) => bound.set(param, args[index] ? converter.print(args[index], scope) : "any"))
        const inner = { ...scope, bound }
        for (const member of parent.members) found.push({ member, scope: inner })
        found.push(...inheritedMembers(converter, parent.parents, inner))
    }
    return found
}
