import { children, extensionOf, isTypeNode, SOURCE_EXTENSIONS } from "./parse.js"
import { plainName, printField } from "./types.js"
import { isReactModule } from "./react.js"
import { isRouterModule, routerImport } from "./router.js"

const isTypeScript = file => /\.[cm]?tsx?$/i.test(file)

const isRelative = source => source.startsWith("./") || source.startsWith("../") || source === "." || source === ".."

function isCodeModule(source) {
    const extension = extensionOf(source)
    return extension === "" || SOURCE_EXTENSIONS.includes(extension) || !/^\.[a-z]+$/i.test(extension)
}

export function slimPath(source) {
    return source.replace(/(?:\.d)?\.(?:[cm]?[jt]s|[jt]sx)$/, "")
}

export const isLocalModule = source => isRelative(source) && isCodeModule(source)

export function targetPath(converter, source) {
    return converter.context?.modulePath(converter.file, source) ?? slimPath(source)
}

export function jsPath(converter, source) {
    if (!isRelative(source) || !isCodeModule(source)) return source
    return `${targetPath(converter, source)}.js`
}

const TYPE_DECLARATIONS = new Set(["ImportDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSDeclareMethod"])

function collectValueNames(program) {
    const names = new Set()
    const visit = (node, parent, key) => {
        if (TYPE_DECLARATIONS.has(node.type)) return
        if (node.type === "Identifier" || node.type === "JSXIdentifier") {
            const isProperty = (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property" && !parent.computed
            const isKey = (parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty") &&
                key === "key" && !parent.computed
            const isExported = (parent.type === "ExportSpecifier" || parent.type === "ExportNamespaceSpecifier") && key === "exported"
            if (!isProperty && !isKey && !isExported) names.add(node.name)
        }
        if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") return
        if (node.type === "ExportSpecifier" && node.exportKind === "type") return
        for (const [child, childKey] of children(node)) if (!isTypeNode(child)) visit(child, node, childKey)
    }
    for (const statement of program.body) visit(statement, program, "body")
    return names
}

export function collectImports(converter) {
    converter.imports = new Map()
    converter.valueNames = collectValueNames(converter.ast.program)
    for (const statement of converter.ast.program.body) {
        if (statement.type !== "ImportDeclaration") continue
        const source = statement.source.value
        const relative = isRelative(source) && isCodeModule(source)
        for (const specifier of statement.specifiers) {
            const imported = specifier.type === "ImportDefaultSpecifier" ? "default"
                : specifier.type === "ImportNamespaceSpecifier" ? "*"
                : specifier.imported.name ?? specifier.imported.value
            const typeOnly = statement.importKind === "type" || specifier.importKind === "type"
            converter.imports.set(specifier.local.name, { source, imported, relative, typeOnly })
        }
    }
}

function specifierText(specifier) {
    const imported = specifier.imported.name ?? JSON.stringify(specifier.imported.value)
    return imported === specifier.local.name ? imported : `${imported} as ${specifier.local.name}`
}

function importLines(keyword, kept, source, attributes) {
    const lines = []
    const namespace = kept.find(specifier => specifier.type === "ImportNamespaceSpecifier")
    const defaults = kept.find(specifier => specifier.type === "ImportDefaultSpecifier")
    const named = kept.filter(specifier => specifier.type === "ImportSpecifier")
    const from = `from ${JSON.stringify(source)}${attributes}`
    if (keyword === "use") {
        if (defaults) lines.push(`use ${defaults.local.name} ${from}`)
        if (namespace) lines.push(`use * as ${namespace.local.name} ${from}`)
        if (named.length) lines.push(`use { ${named.map(specifierText).join(", ")} } ${from}`)
        return lines
    }
    const parts = []
    if (defaults) parts.push(defaults.local.name)
    if (namespace) parts.push(`* as ${namespace.local.name}`)
    if (named.length) parts.push(`{ ${named.map(specifierText).join(", ")} }`)
    lines.push(`import ${parts.join(", ")} ${from}`)
    return lines
}

export function importDeclaration(converter, node) {
    const source = node.source.value
    const relative = isRelative(source) && isCodeModule(source)
    const attributes = node.attributes?.length ? ` ${converter.code.slice(node.source.end, node.end).replace(/;$/, "").trim()}` : ""

    if (node.specifiers.length === 0) {
        if (relative) converter.edits.replace(node.source.start, node.source.end, JSON.stringify(jsPath(converter, source)))
        return
    }
    if (relative) {
        const kept = node.specifiers
        converter.edits.replace(node.start, node.end, importLines("use", kept, targetPath(converter, source), attributes).join("\n"))
        return
    }

    if (isReactModule(source)) {
        converter.edits.removeStatement(node)
        return
    }
    if (isRouterModule(source)) {
        routerImport(converter, node)
        return
    }
    const kept = node.specifiers.filter(specifier => {
        const typeOnly = node.importKind === "type" || specifier.importKind === "type"
        return !typeOnly && (converter.valueNames.has(specifier.local.name) || !isTypeScript(converter.file))
    })
    if (kept.length === 0) {
        converter.edits.removeStatement(node)
        return
    }
    const removed = kept.length !== node.specifiers.length
    if (removed) converter.edits.replace(node.start, node.end, importLines("import", kept, source, attributes).join("\n"))
}

function namespaceExport(converter, specifier, source) {
    const exported = specifier.exported.name ?? specifier.exported.value
    const base = plainName(exported) ? exported : "namespace"
    let local = base
    for (let index = 2; converter.valueNames.has(local) || converter.imports.has(local); index++) local = `${base}${index}`
    const binding = isLocalModule(source)
        ? `use * as ${local} from ${JSON.stringify(targetPath(converter, source))}`
        : `import * as ${local} from ${JSON.stringify(source)}`
    converter.valueNames.add(local)
    return `${binding}\nexport { ${local === exported ? local : `${local} as ${printField(exported)}`} }`
}

function exportedTypeImport(converter, name) {
    const imported = converter.imports.get(name)
    return !!imported && !imported.relative && !converter.valueNames.has(name)
}

export function exportDeclaration(converter, node, scope) {
    if (node.type === "ExportAllDeclaration") {
        if (node.exportKind === "type" && !isRelative(node.source.value)) {
            converter.edits.removeStatement(node)
            return
        }
        const keyword = converter.code.slice(node.start, node.source.start).replace(/\btype\s+/, "")
        converter.edits.replace(node.start, node.source.end, `${keyword}${JSON.stringify(jsPath(converter, node.source.value))}`)
        return
    }

    if (node.type === "ExportDefaultDeclaration") {
        const declaration = node.declaration
        if (declaration.type === "TSInterfaceDeclaration") {
            converter.edits.replace(node.start, declaration.start, "export ")
            converter.visit(declaration, node, scope)
            converter.edits.insert(node.end, `\nexport { ${declaration.id.name} as default }`)
            return
        }
        converter.visit(declaration, node, scope)
        return
    }

    if (node.declaration) {
        converter.visit(node.declaration, node, scope)
        return
    }

    const specifiers = node.specifiers.filter(specifier => {
        const typeOnly = node.exportKind === "type" || specifier.exportKind === "type"
        if (node.source) return !typeOnly || isRelative(node.source.value)
        return !typeOnly || !exportedTypeImport(converter, specifier.local.name)
    }).filter(specifier => node.source || !exportedTypeImport(converter, specifier.local.name))

    if (specifiers.length === 0 && node.specifiers.length > 0) {
        converter.edits.removeStatement(node)
        return
    }
    const from = node.source ? ` from ${JSON.stringify(jsPath(converter, node.source.value))}` : ""
    const namespaces = specifiers.filter(specifier => specifier.type === "ExportNamespaceSpecifier")
        .map(specifier => namespaceExport(converter, specifier, node.source.value))
    const names = specifiers.filter(specifier => specifier.type !== "ExportNamespaceSpecifier").map(specifier => {
        if (specifier.type !== "ExportSpecifier") return converter.code.slice(specifier.start, specifier.end)
        const local = specifier.local.name ?? JSON.stringify(specifier.local.value)
        const exported = specifier.exported.name ?? JSON.stringify(specifier.exported.value)
        return local === exported ? local : `${local} as ${exported}`
    })
    const lines = names.length || namespaces.length === 0 ? [`export { ${names.join(", ")} }${from}`, ...namespaces] : namespaces
    converter.edits.replace(node.start, node.end, lines.join("\n"))
}
