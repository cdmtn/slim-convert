import { builtinModules } from "node:module"
import { children, isTypeNode } from "./parse.js"
import { isLocalModule, jsPath, targetPath } from "./modules.js"

const BUILTINS = new Set(builtinModules)

const isRequireCall = node => node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require" &&
    node.arguments.length === 1 && node.arguments[0].type === "StringLiteral"

const isModuleExports = node => node.type === "MemberExpression" && !node.computed &&
    node.object.type === "Identifier" && node.object.name === "module" && node.property.name === "exports"

function exportsMember(node) {
    if (node.type !== "MemberExpression" || node.computed) return null
    const owner = node.object
    if ((owner.type === "Identifier" && owner.name === "exports") || isModuleExports(owner)) return node.property.name
    return null
}

const isRequireMain = node => node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "require" && node.property.name === "main"

const isMainCheck = node => node.type === "BinaryExpression" && /^[!=]==?$/.test(node.operator) &&
    ((isRequireMain(node.left) && node.right.type === "Identifier" && node.right.name === "module") ||
        (isRequireMain(node.right) && node.left.type === "Identifier" && node.left.name === "module"))

function declaredNames(program) {
    const names = new Set()
    const pattern = node => {
        if (!node) return
        if (node.type === "Identifier") names.add(node.name)
        else if (node.type === "ObjectPattern") node.properties.forEach(property => pattern(property.value ?? property.argument))
        else if (node.type === "ArrayPattern") node.elements.forEach(pattern)
        else if (node.type === "AssignmentPattern") pattern(node.left)
        else if (node.type === "RestElement") pattern(node.argument)
    }
    const visit = node => {
        if (node.type === "VariableDeclarator") pattern(node.id)
        if (node.params) node.params.forEach(pattern)
        if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) names.add(node.id.name)
        for (const [child] of children(node)) if (!isTypeNode(child)) visit(child)
    }
    program.body.forEach(visit)
    return names
}

function usesCommonJs(program) {
    let found = false
    const visit = node => {
        if (found) return
        const name = node.type === "Identifier" ? node.name : null
        if (name === "module" || name === "exports" || name === "require" || name === "__dirname" || name === "__filename") {
            found = true
            return
        }
        for (const [child] of children(node)) if (!isTypeNode(child)) visit(child)
    }
    program.body.forEach(visit)
    return found
}

function exportStatement(statement) {
    if (statement.type !== "ExpressionStatement") return null
    const expression = statement.expression
    if (expression.type !== "AssignmentExpression" || expression.operator !== "=") return null
    if (isModuleExports(expression.left)) return { kind: "module", value: expression.right }
    const name = exportsMember(expression.left)
    return name === null ? null : { kind: "member", name, value: expression.right }
}

export function analyzeCommonJs(program) {
    const hasModuleSyntax = program.body.some(statement => statement.type === "ImportDeclaration" || statement.type.startsWith("Export"))
    if (hasModuleSyntax || !usesCommonJs(program)) return null
    const declared = declaredNames(program)
    if (declared.has("module") || declared.has("exports") || declared.has("require")) return null

    const statements = new Map()
    const members = new Map()
    let moduleAssignments = 0
    let dynamic = false
    for (const statement of program.body) {
        const found = exportStatement(statement)
        if (!found) continue
        statements.set(statement, found)
        if (found.kind === "module") moduleAssignments++
        else if (members.has(found.name)) dynamic = true
        else members.set(found.name, found.value.type === "Identifier" ? found.value.name : found.name)
    }
    if (moduleAssignments > 1 || (moduleAssignments === 1 && members.size > 0)) dynamic = true

    const visit = (node, parent) => {
        if (dynamic || isMainCheck(node)) return
        const found = statements.get(node)
        if (found) {
            visit(found.value, node)
            return
        }
        const member = exportsMember(node)
        if (member !== null) {
            if (!members.has(member)) dynamic = true
            return
        }
        if (node.type === "Identifier" && (node.name === "exports" || node.name === "module")) {
            const isField = (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
                (parent.type === "ObjectProperty" && parent.key === node && !parent.computed && !parent.shorthand)
            if (!isField) dynamic = true
        }
        for (const [child] of children(node)) if (!isTypeNode(child)) visit(child, node)
    }
    for (const statement of program.body) visit(statement, program)

    const single = [...statements.values()].find(item => item.kind === "module")
    const defaultOnly = !dynamic && !!single && !namedObject(single.value)
    return { dynamic, defaultOnly, statements, members }
}

function namedObject(node) {
    return node.type === "ObjectExpression" && node.properties.every(property =>
        property.type === "ObjectProperty" && !property.computed && property.key.type === "Identifier")
}

function moduleVariable(source) {
    const base = source.split("/").filter(Boolean).at(-1).replace(/\.[a-z]+$/i, "").replace(/[^A-Za-z0-9_$]+(.)?/g, (_, next) => next?.toUpperCase() ?? "")
    return `${/^[0-9]/.test(base) ? "_" : ""}${base || "module"}Module`
}

function namedList(pattern) {
    const parts = []
    for (const property of pattern.properties) {
        if (property.type !== "ObjectProperty" || property.computed || property.value.type !== "Identifier") return null
        parts.push(property.key.name === property.value.name ? property.key.name : `${property.key.name} as ${property.value.name}`)
    }
    return parts.join(", ")
}

function localRequire(converter, pattern, source, member) {
    const path = JSON.stringify(targetPath(converter, source))
    const target = converter.context?.commonJsOf(converter.file, source)
    const isModule = target === null
    const isOpaque = target?.dynamic || target?.defaultOnly

    if (member) {
        if (isOpaque) {
            const variable = moduleVariable(source)
            return `use ${variable} from ${path}\nconst ${pattern.name} = ${variable}.${member}`
        }
        return `use { ${member === pattern.name ? member : `${member} as ${pattern.name}`} } from ${path}`
    }
    if (pattern.type === "Identifier") return isModule ? `use * as ${pattern.name} from ${path}` : `use ${pattern.name} from ${path}`
    const named = isOpaque ? null : namedList(pattern)
    if (named !== null) return `use { ${named} } from ${path}`
    const variable = moduleVariable(source)
    return `use ${variable} from ${path}\nconst ${converter.code.slice(pattern.start, pattern.end)} = ${variable}`
}

function packageRequire(converter, pattern, source, member) {
    const path = `${JSON.stringify(source)}${/\.json$/i.test(source) ? ` with { type: "json" }` : ""}`
    const builtin = BUILTINS.has(source.replace(/^node:/, ""))
    if (member) {
        if (builtin) return `import { ${member === pattern.name ? member : `${member} as ${pattern.name}`} } from ${path}`
        const variable = moduleVariable(source)
        return `import ${variable} from ${path}\nconst ${pattern.name} = ${variable}.${member}`
    }
    if (pattern.type === "Identifier") return `import ${pattern.name} from ${path}`
    const named = builtin ? namedList(pattern) : null
    if (named !== null) return `import { ${named} } from ${path}`
    const variable = moduleVariable(source)
    return `import ${variable} from ${path}\nconst ${converter.code.slice(pattern.start, pattern.end)} = ${variable}`
}

function requireText(converter, pattern, source, member = null) {
    return isLocalModule(source) ? localRequire(converter, pattern, source, member) : packageRequire(converter, pattern, source, member)
}

function requireStatement(converter, statement) {
    if (statement.type === "ExpressionStatement" && isRequireCall(statement.expression)) {
        return `import ${JSON.stringify(jsPath(converter, statement.expression.arguments[0].value))}`
    }
    if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return null
    const [{ id, init }] = statement.declarations
    if (isRequireCall(init)) return requireText(converter, id, init.arguments[0].value)
    if (init?.type === "MemberExpression" && !init.computed && isRequireCall(init.object) && id.type === "Identifier") {
        return requireText(converter, id, init.object.arguments[0].value, init.property.name)
    }
    return null
}

function objectExports(converter, statement, object) {
    const named = []
    const hoisted = []
    const fields = []
    for (const property of object.properties) {
        const { name: key } = property.key
        if (property.value.type === "Identifier") {
            const { name: value } = property.value
            named.push(key === value ? key : `${value} as ${key}`)
            fields.push(key === value ? key : `${key}: ${value}`)
        } else {
            hoisted.push([key, property.value])
            fields.push(key)
        }
    }
    const lines = hoisted.map(([key, value]) => `export const ${key} = ${converter.code.slice(value.start, value.end)}`)
    if (named.length) lines.push(`export { ${named.join(", ")} }`)
    lines.push(`export default { ${fields.join(", ")} }`)
    converter.edits.replace(statement.start, statement.end, lines.join("\n"))
}

function moduleExportStatement(converter, statement, found, scope) {
    const { value } = found
    if (found.kind === "module") {
        if (namedObject(value) && value.properties.every(property => property.value.type === "Identifier" || !hasReplacedRead(converter, property.value))) {
            objectExports(converter, statement, value)
            return
        }
        converter.edits.replace(statement.start, value.start, "export default ")
        converter.visit(value, statement, scope)
        return
    }
    const { name } = found
    if (value.type === "Identifier") {
        converter.edits.replace(statement.start, statement.end, value.name === name ? `export { ${name} }` : `export { ${value.name} as ${name} }`)
        return
    }
    converter.edits.replace(statement.start, value.start, `export const ${name} = `)
    converter.visit(value, statement, scope)
}

function hasReplacedRead(converter, node) {
    if (converter.replacements.has(node)) return true
    return children(node).some(([child]) => hasReplacedRead(converter, child))
}

export function convertCommonJs(converter, plan, scope) {
    const { program } = converter.ast
    const handled = new Set()
    converter.replacements = new Map()
    let needsRequire = false

    const scan = (node, parent) => {
        if (node.type === "Identifier" && (node.name === "__dirname" || node.name === "__filename")) {
            const isField = parent.type === "MemberExpression" && parent.property === node && !parent.computed
            if (!isField) converter.replacements.set(node, node.name === "__dirname" ? "import.meta.dirname" : "import.meta.filename")
        }
        if (isMainCheck(node)) {
            converter.replacements.set(node, `process.argv[1] ${node.operator.startsWith("!") ? "!==" : "==="} import.meta.filename`)
            return
        }
        if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
            needsRequire = true
            if (isRequireCall(node) && isLocalModule(node.arguments[0].value)) {
                converter.report("warning", "local-require", `"${node.arguments[0].value}" is required inside the code: this works only for a module that stays CommonJS`, node)
            }
        }
        if (!plan.dynamic) {
            const member = exportsMember(node)
            if (member !== null) {
                converter.replacements.set(node, plan.members.get(member))
                return
            }
        }
        for (const [child] of children(node)) if (!isTypeNode(child)) scan(child, node)
    }

    for (const statement of program.body) {
        const text = requireStatement(converter, statement)
        if (text !== null) {
            converter.edits.replace(statement.start, statement.end, text)
            handled.add(statement)
            continue
        }
        const found = plan.dynamic ? null : plan.statements.get(statement)
        if (found) scan(found.value, statement)
        else scan(statement, program)
    }

    const first = program.body[0]?.start ?? 0
    const header = []
    if (needsRequire) header.push(`import { createRequire } from "node:module"`, `const require = createRequire(import.meta.url)`)
    if (plan.dynamic) header.push("const module = { exports: {} }", "let exports = module.exports")
    if (header.length) converter.edits.insert(first, `${header.join("\n")}\n`)

    if (plan.dynamic) converter.edits.insert(program.end, "\nexport default module.exports\n")
    else {
        for (const [statement, found] of plan.statements) {
            handled.add(statement)
            moduleExportStatement(converter, statement, found, scope)
        }
        if (plan.members.size) {
            const fields = [...plan.members].map(([name, local]) => name === local ? name : `${name}: ${local}`)
            converter.edits.insert(program.end, `\nexport default { ${fields.join(", ")} }\n`)
        }
    }
    converter.handled = handled
}
