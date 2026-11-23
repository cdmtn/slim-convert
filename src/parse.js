import { parse } from "@babel/parser"

const LANGUAGES = {
    ".js": ["jsx"], ".mjs": ["jsx"], ".cjs": ["jsx"], ".jsx": ["jsx"],
    ".ts": ["typescript"], ".mts": ["typescript"], ".cts": ["typescript"],
    ".tsx": ["typescript", "jsx"]
}

export const SOURCE_EXTENSIONS = Object.keys(LANGUAGES)

export function extensionOf(file) {
    const match = /\.[^./\\]+$/.exec(file)
    return match ? match[0].toLowerCase() : ""
}

function detachLeadingSemicolons(node, code) {
    if (/(?:Statement|Declaration)$/.test(node.type) && code[node.end - 1] === ";") {
        let end = node.end - 1
        while (end > node.start && /\s/.test(code[end - 1])) end--
        if (code.slice(end, node.end).includes("\n")) node.end = end
    }
    for (const [child] of children(node)) detachLeadingSemicolons(child, code)
}

export function parseSource(code, file) {
    const ast = parseProgram(code, file)
    for (const statement of ast.program.body) detachLeadingSemicolons(statement, code)
    return ast
}

function parseProgram(code, file) {
    const language = LANGUAGES[extensionOf(file)] ?? LANGUAGES[".ts"]
    return parse(code, {
        sourceType: "unambiguous",
        sourceFilename: file,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowUndeclaredExports: true,
        allowNewTargetOutsideFunction: true,
        allowSuperOutsideMethod: true,
        plugins: [...language, "decorators-legacy", "decoratorAutoAccessors", "explicitResourceManagement", "importAttributes"]
    })
}

export function isNode(value) {
    return !!value && typeof value === "object" && typeof value.type === "string"
}

const SKIPPED_KEYS = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "errors", "tokens"])

export function children(node) {
    const found = []
    for (const key of Object.keys(node)) {
        if (SKIPPED_KEYS.has(key)) continue
        const value = node[key]
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) found.push([item, key])
        } else if (isNode(value)) found.push([value, key])
    }
    return found
}

export function isTypeNode(node) {
    return node.type.startsWith("TS") && !TS_VALUE_NODES.has(node.type)
}

const TS_VALUE_NODES = new Set([
    "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "TSInstantiationExpression",
    "TSParameterProperty", "TSEnumDeclaration", "TSEnumMember", "TSEnumBody", "TSModuleDeclaration", "TSModuleBlock",
    "TSExportAssignment", "TSImportEqualsDeclaration", "TSExternalModuleReference", "TSDeclareMethod",
    "TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSDeclareFunction", "TSNamespaceExportDeclaration"
])
