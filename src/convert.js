import { Edits } from "./edits.js"
import { children, isTypeNode, parseSource } from "./parse.js"
import { TypePrinter, entityName, plainName, printField, propertyName, typeArguments } from "./types.js"
import { collectDeclarations, enumMembers, inheritedMembers, interfaceShape, memberList, reverseKey } from "./declarations.js"
import { collectImports, exportDeclaration, importDeclaration, isLocalModule, jsPath } from "./modules.js"
import { analyzeCommonJs, convertCommonJs } from "./commonjs.js"
import { PROVIDER_HELPER, STYLE_HELPER, componentOf, convertComponent, convertJsx, defaultComponent } from "./jsx.js"
import { convertHook, classComponentHint, isClassComponent, isHookDeclaration, lazyDeclaration, reactCall, rootDeclaration, setterValue } from "./react.js"
import { routerImports } from "./router.js"

const capitalized = name => `${name[0].toUpperCase()}${name.slice(1)}`

const hinted = (scope, name) => ({ ...scope, hint: `${scope.owner ?? ""}${capitalized(name)}` })

const MODIFIERS = /\b(?:public|private|protected|abstract|override|declare)\b[ \t]*/g

export class Converter {
    constructor(code, options = {}) {
        this.code = code
        this.file = options.file ?? "input.ts"
        this.options = options
        this.context = options.context ?? null
        this.edits = new Edits(code)
        this.diagnostics = []
        this.globals = new Set()
        this.printer = new TypePrinter(this)
        this.hoisted = new Map()
        this.ast = parseSource(code, this.file)
    }

    report(level, code, message, node) {
        const loc = node?.loc?.start
        const line = loc?.line ?? null
        const repeated = this.diagnostics.some(item => item.code === code && item.message === message && (level === "note" || item.line === line))
        if (!repeated) this.diagnostics.push({ level, code, message, line, column: loc ? loc.column + 1 : null })
    }

    resolveType(name, node) {
        if (name.includes(".")) {
            const [owner, member] = name.split(".")
            return this.enums.get(owner)?.values.get(member) ?? null
        }
        const local = this.enums.get(name)
        if (local) return local.type
        if (this.anyTypes.has(name)) return "any"
        if (this.declaredTypes.has(name)) return name
        const imported = this.imports.get(name)
        if (!imported) return null
        if (imported.relative) return this.context?.enumType(this.file, imported) ?? name
        this.report("note", "package-type", `the type "${name}" comes from "${imported.source}" and became "any"`, node)
        return "any"
    }

    print(node, scope) {
        return this.printer.print(node, scope)
    }

    typeParametersOf(name) {
        const local = this.typeParams.get(name)
        if (local) return local
        const imported = this.imports.get(name)
        return imported?.relative ? this.context?.target(this.file, imported)?.typeParams.get(imported.imported) ?? null : null
    }

    run() {
        const program = this.ast.program
        collectDeclarations(this)
        collectImports(this)
        const scope = { params: new Set(), allowThis: false }
        const commonJs = analyzeCommonJs(program)
        if (commonJs) convertCommonJs(this, commonJs, scope)
        this.statements(program.body, program, scope)
        routerImports(this)
        this.insertHoisted()
        const code = this.edits.apply()
        const crlf = this.code.includes("\r\n") && !/(?:^|[^\r])\n/.test(this.code)
        return {
            code: crlf ? code.replace(/\r?\n/g, "\r\n") : code,
            diagnostics: this.diagnostics,
            globals: [...this.globals]
        }
    }

    statements(list, parent, scope) {
        for (const statement of list) {
            if (statement.type === "ExpressionStatement" && /^(?:or|and)\s*[([]/.test(this.code.slice(statement.start, statement.start + 8))) {
                this.edits.insert(statement.start, ";")
            }
            this.visit(statement, parent, scope)
        }
    }

    children(node, scope) {
        for (const [child, key] of children(node)) {
            if (isTypeNode(child)) this.typeChild(child, node, scope)
            else {
                this.visitingKey = key
                this.visit(child, node, scope)
            }
        }
    }

    textOfRange(node, start, end, scope) {
        const outer = this.edits
        this.edits = new Edits(this.code)
        this.visit(node, { type: "Moved" }, scope)
        const text = this.edits.apply(start, end)
        this.edits = outer
        return text
    }

    textOf(node, scope) {
        const outer = this.edits
        this.edits = new Edits(this.code)
        const parenthesized = node.extra?.parenthesized
        this.visit(node, { type: "Moved" }, scope)
        const text = this.edits.apply(node.start, node.end)
        this.edits = outer
        return parenthesized && !/^JSX/.test(node.type) ? `(${text})` : text
    }

    typeChild(child, parent, scope) {
        if (child.type === "TSTypeAnnotation") {
            const name = parent.type === "Identifier" ? parent.name : parent.key?.name
            this.replaceType(child.start, child.end, `: ${this.print(child, name ? hinted(scope, name) : scope)}`)
            return
        }
        if (child.type === "TSTypeParameterDeclaration") {
            this.edits.replace(child.start, child.end, this.printer.typeParameters(child, scope))
            return
        }
        if (child.type === "TSTypeParameterInstantiation") {
            this.edits.replace(child.start, child.end, `<${child.params.map(param => this.print(param, scope)).join(", ")}>`)
            return
        }
        this.report("warning", "unknown-node", `"${child.type}" was left as it is`, child)
    }

    visit(node, parent, scope) {
        if (this.handled?.has(node)) return
        switch (node.type) {
            case "BlockStatement":
            case "StaticBlock": {
                const prefix = this.prefixes?.get(node)
                if (prefix) this.edits.insert(node.start + 1, prefix)
                this.statements(node.body, node, scope)
                return
            }
            case "SwitchCase":
                if (node.test) this.visit(node.test, node, scope)
                this.statements(node.consequent, node, scope)
                return
            case "ImportDeclaration": return importDeclaration(this, node)
            case "ExportDefaultDeclaration":
                if (defaultComponent(this, node, scope)) return
                return exportDeclaration(this, node, scope)
            case "ExportNamedDeclaration":
            case "ExportAllDeclaration": return exportDeclaration(this, node, scope)
            case "TSImportEqualsDeclaration": return this.importEquals(node)
            case "TSExportAssignment":
                this.edits.replace(node.start, node.expression.start, "export default ")
                this.visit(node.expression, node, scope)
                return
            case "TSNamespaceExportDeclaration": return this.edits.removeStatement(node)
            case "TSInterfaceDeclaration": return this.interfaceDeclaration(node, parent, scope)
            case "TSTypeAliasDeclaration": return this.typeAlias(node, parent, scope)
            case "TSEnumDeclaration": return this.enumDeclaration(node, parent)
            case "TSModuleDeclaration": return this.moduleDeclaration(node, parent)
            case "TSDeclareFunction": return this.declaredFunction(node, parent)
            case "VariableDeclaration": return this.variableDeclaration(node, parent, scope)
            case "FunctionDeclaration": return this.functionDeclaration(node, parent, scope)
            case "FunctionExpression":
            case "ArrowFunctionExpression":
            case "ObjectMethod": return this.functionLike(node, scope)
            case "ClassDeclaration":
            case "ClassExpression": return this.classLike(node, parent, scope)
            case "CatchClause": return this.catchClause(node, scope)
            case "TSAsExpression": return this.asExpression(node, scope)
            case "TSSatisfiesExpression":
                this.visit(node.expression, node, scope)
                this.edits.remove(this.keywordStart("satisfies", node.typeAnnotation.start), node.end)
                return
            case "TSTypeAssertion": return this.typeAssertion(node, scope)
            case "TSInstantiationExpression":
                this.visit(node.expression, node, scope)
                this.edits.remove(node.expression.end, node.end)
                return
            case "JSXElement":
            case "JSXFragment": return convertJsx(this, node, scope)
            case "CallExpression":
                if (node.callee.type === "Import") this.dynamicImport(node)
                if (reactCall(this, node, scope, parent)) return
                break
            case "Identifier":
                if (setterValue(this, node, parent, this.visitingKey)) return
                break
        }
        const swap = this.replacements?.get(node)
        if (swap !== undefined) {
            if (node.type === "Identifier" && node.typeAnnotation) {
                this.edits.replace(node.start, node.start + node.name.length, swap)
                this.children(node, scope)
            } else this.edits.replace(node.start, node.end, swap)
            return
        }
        this.children(node, scope)
    }

    dynamicImport(node) {
        const [source] = node.arguments
        if (source?.type !== "StringLiteral" || !isLocalModule(source.value)) return
        this.edits.replace(source.start, source.end, JSON.stringify(jsPath(this, source.value)))
    }

    useHelper(name, text) {
        this.helpers ??= new Map()
        this.helpers.set(name, text)
    }

    replaceType(start, end, text, after = "") {
        const comments = this.ast.comments
            .filter(comment => comment.start >= start && comment.end <= end)
            .map(comment => comment.type === "CommentBlock" ? `/*${comment.value}*/` : comment.value.includes("*/") ? null : `/*${comment.value} */`)
            .filter(comment => comment !== null)
        const kept = comments.length ? `${text}${text ? " " : ""}${comments.join(" ")}` : text
        this.edits.replace(start, end, `${kept}${after}`)
    }

    nextToken(at) {
        for (;;) {
            while (/\s/.test(this.code[at] ?? "")) at++
            const comment = this.ast.comments.find(item => item.start === at)
            if (!comment) return at
            at = comment.end
        }
    }

    keywordStart(word, before) {
        let at = this.code.lastIndexOf(word, before)
        while (at > 0 && /\s/.test(this.code[at - 1])) at--
        return at
    }

    importEquals(node) {
        const name = node.id.name
        if (node.moduleReference.type === "TSExternalModuleReference") {
            const source = node.moduleReference.expression.value
            this.edits.replace(node.start, node.end, `import ${name} from ${JSON.stringify(source)}`)
            return
        }
        const target = entityName(node.moduleReference)
        this.edits.replace(node.start, node.end, `const ${name} = ${target}`)
    }

    moduleDeclaration(node, parent) {
        if (node.declare || node.kind === "global" || node.id?.type === "StringLiteral") {
            this.edits.removeStatement(this.statementOf(node, parent))
            return
        }
        this.report("error", "namespace", `namespaces have no Slim form: move "${entityName(node.id) ?? "this namespace"}" to its own file`, node)
    }

    statementOf(node, parent) {
        return parent.type === "ExportNamedDeclaration" || parent.type === "ExportDefaultDeclaration" ? parent : node
    }

    declaredFunction(node, parent) {
        if (node.declare && node.id) this.globals.add(node.id.name)
        this.edits.removeStatement(this.statementOf(node, parent))
    }

    variableDeclaration(node, parent, scope) {
        if (node.declare) {
            for (const declaration of node.declarations) if (declaration.id.name) this.globals.add(declaration.id.name)
            this.edits.removeStatement(this.statementOf(node, parent))
            return
        }
        for (const declarator of node.declarations) {
            if (isHookDeclaration(declarator.id.name, declarator.init) && this.hooks.has(declarator.id.name)) {
                convertHook(this, declarator.init, scope)
                continue
            }
            const component = componentOf(this, declarator, node, parent)
            if (component) return convertComponent(this, component, scope)
            if (lazyDeclaration(this, node, declarator, scope)) return
            if (rootDeclaration(this, declarator)) continue
            this.children(declarator, scope)
        }
    }

    functionDeclaration(node, parent, scope) {
        if (node.id && this.overloaded.has(node.id.name)) node.overloaded = true
        if (isHookDeclaration(node.id?.name, node) && this.hooks.has(node.id.name)) {
            const at = this.code.slice(node.start, node.id.start).search(/\bfunction\b/)
            this.edits.replace(node.start + at, node.start + at + "function".length, "func")
            return convertHook(this, node, scope)
        }
        const component = componentOf(this, node, null, parent)
        if (component) return convertComponent(this, component, scope)
        if (parent.type !== "ExportDefaultDeclaration") {
            const end = node.id ? node.id.start : node.body.start
            const at = this.code.slice(node.start, end).search(/\bfunction\b/)
            if (at >= 0) this.edits.replace(node.start + at, node.start + at + "function".length, "func")
        }
        this.functionLike(node, scope)
    }

    functionScope(node, scope) {
        const names = this.printer.typeParameterNames(node.typeParameters)
        const owner = node.id?.name ?? node.key?.name
        const named = owner ? { ...scope, hint: `${scope.owner ?? ""}${capitalized(owner)}`, owner: `${scope.owner ?? ""}${capitalized(owner)}` } : scope
        return names.length ? { ...named, params: new Set([...named.params, ...names]) } : named
    }

    functionLike(node, scope) {
        const inner = this.functionScope(node, scope)
        if (node.typeParameters) this.typeChild(node.typeParameters, node, inner)
        if (node.type === "ClassMethod" || node.type === "ObjectMethod") {
            if (node.computed) this.visit(node.key, node, scope)
        }
        if (node.id && node.type === "FunctionExpression") this.visit(node.id, node, scope)
        this.parameters(node, inner)
        this.returnType(node, inner)
        if (node.body) this.visit(node.body, node, inner)
    }

    parameters(node, scope) {
        node.params.forEach((parameter, index) => {
            if (parameter.type === "Identifier" && parameter.name === "this") {
                const next = node.params[index + 1]
                this.edits.remove(parameter.start, next ? next.start : parameter.end)
                return
            }
            this.visit(parameter, node, scope)
        })
    }

    returnType(node, scope) {
        const annotation = node.returnType
        if (node.overloaded) {
            if (annotation) this.edits.replace(annotation.start, annotation.end, " -> any")
            else this.edits.insert(this.code.lastIndexOf(")", node.body.start) + 1, " -> any")
            return
        }
        if (!annotation) return
        const text = this.returnText(node, annotation.typeAnnotation, hinted(scope, "result"))
        let start = annotation.start
        while (start > 0 && /[ \t]/.test(this.code[start - 1])) start--
        this.replaceType(start, annotation.end, text === "any" ? "" : ` -> ${text}`)
    }

    returnText(node, type, scope) {
        if (node.generator) return "any"
        if (node.async) {
            if (type.type === "TSTypeReference" && entityName(type.typeName) === "Promise") {
                const [inner] = typeArguments(type) ?? []
                return inner ? this.print(inner, scope) : "any"
            }
            return "any"
        }
        return this.print(type, scope)
    }

    catchClause(node, scope) {
        const annotation = node.param?.typeAnnotation
        if (annotation) {
            this.edits.remove(annotation.start, annotation.end)
            delete node.param.typeAnnotation
        }
        if (node.param) this.visit(node.param, node, scope)
        this.visit(node.body, node, scope)
    }

    asExpression(node, scope) {
        this.visit(node.expression, node, scope)
        const type = node.typeAnnotation
        if (type.type === "TSTypeReference" && entityName(type.typeName) === "const") {
            this.edits.remove(this.keywordStart("as", type.start), node.end)
            return
        }
        this.replaceType(type.start, type.end, this.print(type, scope))
    }

    typeAssertion(node, scope) {
        const close = this.code.indexOf(">", node.typeAnnotation.end)
        this.edits.replace(node.start, close + 1, "(")
        this.visit(node.expression, node, scope)
        this.edits.insert(node.end, ` as ${this.print(node.typeAnnotation, scope)})`)
    }

    interfaceDeclaration(node, parent, scope) {
        const name = node.id.name
        const statement = this.statementOf(node, parent)
        if (node.declare) {
            this.edits.removeStatement(statement)
            return
        }
        const declarations = this.interfaces.get(name)
        if (declarations[0] !== node) {
            this.edits.removeStatement(statement)
            return
        }
        if (this.anyTypes.has(name) || this.classNames.has(name)) {
            this.report("note", "name-clash", `"${name}" is both a type and a value, which Slim doesn't allow: the type was dropped`, node)
            this.edits.removeStatement(statement)
            return
        }
        const typeScope = { ...scope, params: new Set([...scope.params, ...this.printer.typeParameterNames(node.typeParameters)]), allowThis: true }
        const others = declarations.slice(1).flatMap(declaration => memberList(declaration))
        this.declareType(node, node.body.start, node.body, memberList(node), others, this.heritageMembers(declarations, typeScope), typeScope)
    }

    heritageMembers(declarations, scope) {
        return declarations.flatMap(declaration => inheritedMembers(this, declaration.extends ?? [], scope))
    }

    declareType(node, bodyStart, body, own, merged, inherited, scope) {
        const name = node.id.name
        const generics = this.printer.typeParameters(node.typeParameters, scope)
        const shape = interfaceShape(this, [...own, ...merged], inherited, scope)
        if (shape.alias !== null) {
            this.replaceType(node.start, node.end, `type ${name}${generics} = ${shape.alias}`)
            return
        }

        this.edits.replace(node.start, bodyStart, `trait ${name}${generics} `)
        const seen = new Set()
        const multiline = this.code.slice(body.start, body.end).includes("\n")
        const indent = multiline ? this.lineIndent(own[0]?.start ?? body.start, body) : ""
        const texts = own.map(member => this.traitMember(member, seen, shape, scope))
        own.forEach((member, index) => {
            const text = texts[index]
            if (text === null) {
                this.removeTraitMember(member)
                return
            }
            const next = own.findIndex((item, later) => later > index && texts[later] !== null)
            const sameLine = next >= 0 && !this.code.slice(member.end, own[next].start).includes("\n")
            this.replaceType(member.start, member.end, text, sameLine ? "," : "")
        })
        const extra = []
        for (const member of merged) {
            const text = this.traitMember(member, seen, shape, scope)
            if (text !== null) extra.push(text)
        }
        for (const { member, scope: inner } of inherited) {
            const memberName = propertyName(member)
            if (memberName === null || shape.names.has(memberName) && seen.has(memberName)) continue
            const text = this.traitMember(member, seen, shape, inner)
            if (text !== null) extra.push(text)
        }
        if (extra.length) {
            const kept = texts.some(text => text !== null)
            const closing = body.end - 1
            let at = closing
            while (at > 0 && /\s/.test(this.code[at - 1])) at--
            const text = multiline ? extra.map(item => `\n${indent}${item}`).join("") : kept ? `, ${extra.join(", ")}` : ` ${extra.join(", ")}${at === closing ? " " : ""}`
            this.edits.insert(at, text)
        }
    }

    removeTraitMember(member) {
        const lineStart = this.code.lastIndexOf("\n", member.start - 1) + 1
        const lineEnd = this.code.indexOf("\n", member.end)
        const before = this.code.slice(lineStart, member.start)
        const after = this.code.slice(member.end, lineEnd < 0 ? this.code.length : lineEnd)
        const hasComments = this.ast.comments.some(comment => comment.start >= member.start && comment.end <= member.end)
        if (hasComments) this.replaceType(member.start, member.end, "")
        else if (/^[ \t]*$/.test(before) && /^[ \t;,]*\r?$/.test(after)) this.edits.removeStatement(member)
        else {
            let start = member.start
            while (start > lineStart && /[ \t]/.test(this.code[start - 1])) start--
            this.edits.remove(start, member.end)
        }
    }

    lineIndent(position, body) {
        if (position === body.start) return "    "
        const lineStart = this.code.lastIndexOf("\n", position) + 1
        return /^[ \t]*/.exec(this.code.slice(lineStart))[0]
    }

    traitMember(member, seen, shape, scope) {
        if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") return null
        const name = propertyName(member)
        if (name === null || !plainName(name)) {
            this.report("note", "computed-field", "a field without a plain name was dropped: a trait allows it anyway", member)
            return null
        }
        if (seen.has(name)) return null
        seen.add(name)
        if (shape.overloaded.has(name)) return `${printField(name)}: function`
        if (member.kind === "set") return seen.delete(name) && null
        if (member.kind === "get") {
            const returns = member.returnType ?? member.typeAnnotation
            return `${printField(name)}: ${returns ? this.printer.returnType(returns, scope) : "any"}`
        }
        if (member.type === "TSPropertySignature" || member.optional) return this.printer.field(member, name, scope)
        return this.traitMethod(member, name, scope)
    }

    traitMethod(member, name, scope) {
        const names = this.printer.typeParameterNames(member.typeParameters)
        const inner = names.length ? { ...scope, params: new Set([...scope.params, ...names]) } : scope
        const parameters = (member.parameters ?? member.params ?? []).filter(parameter => !(parameter.type === "Identifier" && parameter.name === "this"))
        const printed = parameters.map((parameter, index) => {
            if (parameter.type === "RestElement") {
                return `...${parameter.argument.name}${parameter.typeAnnotation ? `: ${this.print(parameter.typeAnnotation, inner)}` : ""}`
            }
            return this.printer.parameter(parameter, index, inner)
        })
        const returns = member.returnType ?? member.typeAnnotation
        const text = returns ? this.printer.returnType(returns, inner) : "any"
        return `${printField(name)}${this.printer.typeParameters(member.typeParameters, inner)}(${printed.join(", ")})${text === "any" ? "" : ` -> ${text}`}`
    }

    hoistShape(members, scope) {
        const hidden = new Set([...(scope.hidden ?? []), ...scope.params])
        const inner = { ...scope, hidden, params: new Set(), allowThis: false }
        const fields = this.printer.fields(members, inner)
        if (fields === null) return null
        const body = fields.join("\n    ")
        const known = this.hoisted.get(body)
        if (known) return known
        const name = this.freeTypeName(scope.hint ?? "Shape")
        this.hoisted.set(body, name)
        return name
    }

    freeTypeName(base) {
        const taken = name => this.declaredTypes.has(name) || this.imports.has(name) || this.valueNames.has(name) || this.enums.has(name) ||
            [...this.hoisted.values()].includes(name)
        let name = base
        for (let index = 2; taken(name); index++) name = `${base}${index}`
        return name
    }

    insertHoisted() {
        if (this.hoisted.size === 0 && !this.needsStyleHelper && !this.needsProvider && !this.helpers?.size) return
        const parts = [...this.hoisted].map(([body, name]) => `trait ${name} {\n    ${body}\n}`)
        if (this.needsStyleHelper) parts.push(STYLE_HELPER)
        if (this.needsProvider) parts.push(PROVIDER_HELPER)
        parts.push(...this.helpers?.values() ?? [])
        const text = parts.join("\n\n")
        const { body } = this.ast.program
        const first = body.find(statement => statement.type !== "ImportDeclaration" && statement.type !== "TSImportEqualsDeclaration")
        this.edits.insert(first ? this.commentBlockStart(first) : this.ast.program.end, `${text}\n\n`)
    }

    commentBlockStart(statement) {
        let at = statement.start
        const comments = (statement.leadingComments ?? []).filter(comment => comment.end <= statement.start)
        for (const comment of comments.reverse()) {
            if (!/^[ \t]*(?:\r?\n)?[ \t]*$/.test(this.code.slice(comment.end, at))) break
            const lineStart = this.code.lastIndexOf("\n", comment.start - 1) + 1
            if (!/^[ \t]*$/.test(this.code.slice(lineStart, comment.start))) break
            at = comment.start
        }
        return at
    }

    typeAlias(node, parent, scope) {
        const name = node.id.name
        const statement = this.statementOf(node, parent)
        if (node.declare) {
            this.edits.removeStatement(statement)
            return
        }
        if (this.anyTypes.has(name) || this.classNames.has(name)) {
            this.report("note", "name-clash", `"${name}" is both a type and a value, which Slim doesn't allow: the type was dropped`, node)
            this.edits.removeStatement(statement)
            return
        }
        const params = this.printer.typeParameterNames(node.typeParameters)
        const typeScope = { ...scope, params: new Set([...scope.params, ...params]), allowThis: true }
        const target = node.typeAnnotation

        if (target.type === "TSTypeLiteral") {
            this.declareType(node, target.start, target, target.members, [], [], typeScope)
            return
        }
        if (target.type === "TSIntersectionType") {
            const parts = target.types
            const literals = parts.filter(part => part.type === "TSTypeLiteral")
            const references = parts.filter(part => part.type !== "TSTypeLiteral")
            const inherited = inheritedMembers(this, references, typeScope, true)
            if (inherited !== null) {
                const members = literals.flatMap(literal => literal.members)
                const shape = interfaceShape(this, members, inherited, typeScope)
                const seen = new Set()
                const lines = [...members, ...inherited.map(item => item.member)].map((member, index) =>
                    this.traitMember(member, seen, shape, index < members.length ? typeScope : inherited[index - members.length].scope))
                const fields = lines.filter(line => line !== null).map(line => `    ${line}`).join("\n")
                this.replaceType(node.start, target.end, `trait ${name}${this.printer.typeParameters(node.typeParameters, typeScope)} {\n${fields}\n}`)
                return
            }
        }
        const generics = this.printer.typeParameters(node.typeParameters, typeScope)
        this.replaceType(node.start, target.end, `type ${name}${generics} = ${this.print(target, { ...typeScope, allowThis: false, hint: name })}`)
    }

    enumDeclaration(node, parent) {
        const statement = this.statementOf(node, parent)
        if (node.declare) {
            this.edits.removeStatement(statement)
            return
        }
        const info = this.enums.get(node.id.name)
        if (info.node !== node) {
            this.report("error", "merged-enum", `"${node.id.name}" is declared twice: merge its members by hand`, node)
            return
        }
        const members = enumMembers(node)
        const start = this.nextToken(node.id.end)
        this.edits.replace(node.start, start + 1, `const ${node.id.name} = Object.freeze({`)
        const multiline = this.code.slice(start, node.end).includes("\n")
        const isIndex = value => reverseKey(value) === String(value)
        const trailing = info.reverse.filter(([value]) => isIndex(value))
        members.forEach((member, index) => {
            const key = propertyName({ key: member.id, computed: false })
            const value = info.printed.get(key)
            const comma = this.nextToken(member.end)
            if (this.code[comma] === ",") this.edits.remove(comma, comma + 1)
            const inline = info.reverse.filter(([number, name]) => name === key && !isIndex(number))
                .map(([number]) => `, ${reverseKey(number)}: ${JSON.stringify(key)}`).join("")
            const separator = index === members.length - 1 && trailing.length === 0 ? "" : ","
            this.replaceType(member.start, member.end, `${printField(key)}: ${value}${inline}`, separator)
        })
        const indent = multiline && members.length ? this.lineIndent(members[0].start, { start: -1 }) : ""
        const reverse = trailing.map(([value, key], index) => {
            const separator = index === trailing.length - 1 ? "" : ","
            return `${multiline ? `\n${indent}` : " "}${reverseKey(value)}: ${JSON.stringify(key)}${separator}`
        }).join("")
        const closing = node.end - 1
        let at = closing
        while (at > 0 && /\s/.test(this.code[at - 1])) at--
        if (reverse) this.edits.insert(at, reverse)
        this.edits.insert(node.end, ")")
    }

    classLike(node, parent, scope) {
        if (node.declare) {
            if (node.id) this.globals.add(node.id.name)
            this.edits.removeStatement(this.statementOf(node, parent))
            return
        }
        if (node.decorators?.length) {
            this.report("error", "decorator", "decorators have no Slim form: apply them by hand after the class", node.decorators[0])
        }
        if (isClassComponent(this, node)) {
            this.report("error", "class-component", `"${node.id?.name ?? "this class"}" is a class component: ${classComponentHint(node)}`, node)
        }
        const inner = { ...this.functionScope(node, scope), allowThis: true }
        if (node.abstract) {
            const at = this.code.slice(node.start, node.id?.start ?? node.body.start).search(/\babstract\b/)
            if (at >= 0) this.edits.remove(node.start + at, node.start + at + "abstract".length + 1)
        }
        if (node.typeParameters) this.typeChild(node.typeParameters, node, inner)
        if (node.superClass) this.visit(node.superClass, node, scope)
        const superArguments = node.superTypeParameters ?? node.superTypeArguments
        if (superArguments) this.typeChild(superArguments, node, inner)
        if (node.implements?.length) this.implementsClause(node, inner)
        this.classBody(node, inner)
    }

    implementsClause(node, scope) {
        const list = node.implements
        const start = this.keywordStart("implements", list[0].start)
        const printed = list.map(item => this.print(item, scope)).filter(text => text !== "any")
        this.edits.replace(start, list.at(-1).end, printed.length ? ` implements ${printed.join(", ")}` : "")
    }

    classBody(node, scope) {
        const constructor = node.body.body.find(member => member.kind === "constructor" && member.type === "ClassMethod")
        const overloads = new Set(node.body.body.filter(member => member.type === "TSDeclareMethod" && !member.abstract).map(propertyName))
        for (const member of node.body.body) {
            if (member.type === "ClassMethod" && member.kind !== "constructor" && overloads.has(propertyName(member))) member.overloaded = true
            switch (member.type) {
                case "ClassMethod":
                case "ClassPrivateMethod":
                    this.modifiers(member)
                    if (member.decorators?.length) this.report("error", "decorator", "decorators have no Slim form", member.decorators[0])
                    if (member.kind === "constructor") this.constructorMethod(node, member, scope)
                    else this.functionLike(member, scope)
                    break
                case "TSDeclareMethod":
                    this.declaredMethod(node, member, scope)
                    break
                case "ClassProperty":
                case "ClassPrivateProperty":
                case "ClassAccessorProperty":
                    this.classProperty(member, constructor, scope, node)
                    break
                case "TSIndexSignature":
                    this.edits.removeStatement(member)
                    break
                default:
                    this.visit(member, node, scope)
            }
        }
    }

    modifiers(member) {
        const start = member.decorators?.length ? member.decorators.at(-1).end : member.start
        const prefix = this.code.slice(start, member.key.start)
        const cleaned = prefix.replace(MODIFIERS, "")
        if (cleaned !== prefix) this.edits.replace(start, member.key.start, cleaned.replace(/^[ \t]+/, ""))
    }

    declaredMethod(node, member, scope) {
        if (!member.abstract) {
            if (!member.optional) {
                this.edits.removeStatement(member)
                return
            }
            const name = propertyName(member)
            this.edits.replace(member.start, member.end, `${printField(name)}?: ${this.printer.signature(member, scope)}`)
            return
        }
        this.modifiers(member)
        const inner = this.functionScope(member, scope)
        if (member.typeParameters) this.typeChild(member.typeParameters, member, inner)
        this.parameters(member, inner)
        this.returnType(member, inner)
        const owner = node.id?.name ?? "class"
        const name = propertyName(member) ?? "method"
        const end = this.code[member.end - 1] === ";" ? member.end - 1 : member.end
        this.edits.replace(end, member.end, ` { throw new Error(${JSON.stringify(`${owner}.${name} is abstract`)}) }`)
    }

    classProperty(member, constructor, scope, owner) {
        if (member.declare) {
            this.edits.removeStatement(member)
            return
        }
        if (member.decorators?.length) this.report("error", "decorator", "decorators have no Slim form", member.decorators[0])
        if (member.type === "ClassAccessorProperty") return this.accessorProperty(member, scope, owner)
        this.modifiers(member)
        if (member.computed) this.visit(member.key, member, scope)
        if (member.typeAnnotation) {
            const annotation = member.typeAnnotation
            const assigned = this.assignedIn(constructor, propertyName(member))
            const definite = !member.value && !member.optional && !member.definite && !member.static && !assigned
            this.replaceType(annotation.start, annotation.end, `${definite ? "!" : ""}: ${this.print(annotation, scope)}`)
        }
        if (member.value) this.visit(member.value, member, scope)
    }

    accessorProperty(member, scope, owner) {
        const name = member.key.type === "Identifier" && !member.computed ? member.key.name : null
        if (name === null) {
            this.report("error", "accessor", `an "accessor" field without a plain name has no Slim form: write a getter and a setter`, member)
            return
        }
        const start = member.decorators?.length ? member.decorators.at(-1).end : member.start
        const lineStart = this.code.lastIndexOf("\n", start - 1) + 1
        const ownLine = /^[ \t]*$/.test(this.code.slice(lineStart, start))
        const indent = ownLine ? this.code.slice(lineStart, start) : ""
        const prefix = member.static ? "static " : ""
        const storage = `#${name}Value`
        const holder = member.static && owner?.id ? owner.id.name : "this"
        const type = member.typeAnnotation ? this.print(member.typeAnnotation, scope) : null
        const value = member.value ? ` = ${this.textOf(member.value, scope)}` : ""
        const field = `${prefix}${storage}${type ? `: ${type}` : ""}${value}`
        const getter = `${prefix}get ${name}()${type ? ` -> ${type}` : ""} { return ${holder}.${storage} }`
        const setter = `${prefix}set ${name}(value${type ? `: ${type}` : ""}) { ${holder}.${storage} = value }`
        this.edits.replace(start, member.end, ownLine ? [field, getter, setter].join(`\n${indent}`) : `${field}; ${getter} ${setter}`)
    }

    assignedIn(constructor, name) {
        if (!constructor || !name) return false
        const text = this.code.slice(constructor.start, constructor.end)
        return new RegExp(`\\bthis\\.${name.replace(/[$]/g, "\\$&")}\\s*=[^=]`).test(text)
    }

    constructorMethod(node, member, scope) {
        const properties = member.params.filter(parameter => parameter.type === "TSParameterProperty")
        const fields = []
        const assignments = []
        for (const property of properties) {
            const parameter = property.parameter
            const target = parameter.type === "AssignmentPattern" ? parameter.left : parameter
            const name = target.name
            const annotation = target.typeAnnotation ? `: ${this.print(target.typeAnnotation, scope)}` : ""
            const mark = target.optional ? "?" : ""
            const readonly = property.readonly ? "readonly " : ""
            fields.push(`${readonly}${name}${mark}${annotation}`)
            assignments.push(`this.${name} = ${name}`)
            this.edits.remove(property.start, parameter.start)
        }
        this.functionLike({ ...member, params: member.params.map(parameter => parameter.type === "TSParameterProperty" ? parameter.parameter : parameter) }, scope)
        if (properties.length === 0) return

        const open = node.body.start + 1
        const memberIndent = this.lineIndent(member.start, { start: -1 })
        const classInline = !this.code.slice(node.body.start, member.start).includes("\n")
        this.edits.insert(open, classInline ? ` ${fields.join("; ")};` : fields.map(field => `\n${memberIndent}${field}`).join(""))

        const body = member.body
        const superCall = body.body.find(statement => statement.type === "ExpressionStatement" && statement.expression.type === "CallExpression" && statement.expression.callee.type === "Super")
        const inlineBody = !this.code.slice(body.start, body.end).includes("\n")
        if (inlineBody && (body.body.length > 0 || classInline || assignments.length === 1)) {
            const list = assignments.join("; ")
            if (body.body.length === 0) this.edits.insert(body.start + 1, ` ${list} `)
            else if (superCall) this.edits.insert(superCall.end, this.code[superCall.end - 1] === ";" ? ` ${list};` : `; ${list}`)
            else this.edits.insert(body.start + 1, ` ${list};`)
            return
        }
        const bodyIndent = `${memberIndent}    `
        this.edits.insert(superCall ? superCall.end : body.start + 1, assignments.map(line => `\n${bodyIndent}${line}`).join(""))
        if (inlineBody) this.edits.insert(body.end - 1, `\n${memberIndent}`)
    }
}

export function convert(code, options = {}) {
    return new Converter(code, options).run()
}

