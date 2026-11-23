import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Converter } from "./convert.js"
import { SOURCE_EXTENSIONS, extensionOf, parseSource } from "./parse.js"
import { enumMembers, memberList } from "./declarations.js"
import { slimPath } from "./modules.js"
import { analyzeCommonJs } from "./commonjs.js"
import { REPAIR_NOTES, repair } from "./repair.js"

const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "slim-dist", "build", "coverage", ".git"])

function isSource(file) {
    return SOURCE_EXTENSIONS.includes(extensionOf(file)) && !/\.d\.[cm]?ts$/.test(file)
}

function listSources(entry, found = []) {
    if (statSync(entry).isFile()) {
        if (isSource(entry)) found.push(entry)
        return found
    }
    for (const item of readdirSync(entry)) {
        const full = path.join(entry, item)
        if (statSync(full).isDirectory()) {
            if (!SKIPPED_FOLDERS.has(item) && !item.startsWith(".")) listSources(full, found)
        } else if (isSource(full)) found.push(full)
    }
    return found
}

function resolveModule(from, source, known) {
    const base = path.resolve(path.dirname(from), slimPath(source))
    for (const extension of SOURCE_EXTENSIONS) {
        if (known.has(base + extension)) return base + extension
        const index = path.join(base, `index${extension}`)
        if (known.has(index)) return index
    }
    return null
}

class ProjectContext {
    constructor(files) {
        this.files = files
        this.modules = new Map()
        for (const [file, code] of files) this.modules.set(file, this.summary(file, code))
    }

    summary(file, code) {
        const enums = new Map()
        const interfaces = new Map()
        const aliases = new Map()
        const typeParams = new Map()
        let ast
        try {
            ast = parseSource(code, file)
        } catch {
            return { enums, interfaces, aliases, typeParams, commonJs: undefined }
        }
        for (const statement of ast.program.body) {
            const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement
            if (!node) continue
            if (node.type === "TSEnumDeclaration") enums.set(node.id.name, node)
            if (node.type === "TSInterfaceDeclaration") interfaces.set(node.id.name, [...(interfaces.get(node.id.name) ?? []), node])
            if (node.type === "TSTypeAliasDeclaration") aliases.set(node.id.name, node)
            const named = ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "ClassDeclaration"].includes(node.type) && node.id
            if (named && node.typeParameters && !typeParams.has(node.id.name)) typeParams.set(node.id.name, node.typeParameters.params)
        }
        return { enums, interfaces, aliases, typeParams, commonJs: analyzeCommonJs(ast.program) }
    }

    commonJsOf(from, source) {
        const file = resolveModule(from, source, this.files)
        return file ? this.modules.get(file).commonJs : undefined
    }

    target(from, imported) {
        const file = resolveModule(from, imported.source, this.files)
        return file ? this.modules.get(file) : null
    }

    enumType(from, imported) {
        const node = this.target(from, imported)?.enums.get(imported.imported)
        if (!node) return null
        const members = enumMembers(node)
        const isString = member => member.initializer?.type === "StringLiteral"
        if (members.length && members.every(isString)) return members.map(member => JSON.stringify(member.initializer.value)).join(" | ")
        return members.some(isString) ? "any" : "number"
    }

    interfaceOf(from, imported) {
        const target = this.target(from, imported)
        const nodes = target?.interfaces.get(imported.imported)
        if (nodes) return { nodes, members: nodes.flatMap(memberList), parents: [] }
        const alias = target?.aliases.get(imported.imported)
        if (alias?.typeAnnotation.type === "TSTypeLiteral") return { nodes: [alias], members: alias.typeAnnotation.members, parents: [] }
        return null
    }

    modulePath(from, source) {
        const file = resolveModule(from, source, this.files)
        if (!file) return slimPath(source)
        const relative = path.relative(path.dirname(from), file).replace(/\.[^./\\]+$/, "").replaceAll("\\", "/")
        return relative.startsWith(".") ? relative : `./${relative}`
    }
}

async function loadCompiler() {
    try {
        return (await import("@slim-lang/core")).transform
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("@slim-lang/core")) return null
        throw error
    }
}

export async function checkSlim(code, file, options = {}) {
    const transform = options.transform ?? await loadCompiler()
    if (!transform) return { available: false, errors: [] }
    try {
        transform(code, file, { warnings: false, globals: options.globals ?? [] })
        return { available: true, errors: [] }
    } catch (error) {
        if (error.slimTypeErrors) return { available: true, errors: error.slimTypeErrors }
        const loc = error.loc
        return { available: true, errors: [{ message: String(error.message).split("\n")[0], line: loc?.line ?? null, column: loc ? loc.column + 1 : null }] }
    }
}

const MAX_REPAIR_ROUNDS = 20

async function checkWithRepairs(code, file, options) {
    let current = code
    const repaired = []
    for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
        const result = await checkSlim(current, file, options)
        if (!result.available) return { code: current, errors: [], repaired, checked: false }
        const fixed = repair(current, result.errors)
        if (fixed === null) return { code: current, errors: result.errors, repaired, checked: true }
        current = fixed.code
        repaired.push(...fixed.done)
    }
    const result = await checkSlim(current, file, options)
    return { code: current, errors: result.errors, repaired, checked: true }
}

function isInside(folder, entry) {
    const relative = path.relative(folder, entry)
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function commonFolder(folders) {
    return folders.reduce((common, folder) => {
        while (!isInside(common, folder)) {
            const parent = path.dirname(common)
            if (parent === common) throw new Error(`${folders[0]} and ${folder} have no folder in common: convert them one at a time`)
            common = parent
        }
        return common
    })
}

export async function convertProject(entries, options = {}) {
    const inputs = (Array.isArray(entries) ? entries : [entries]).map(entry => path.resolve(entry))
    for (const entry of inputs) if (!existsSync(entry)) throw new Error(`${entry} does not exist`)
    const root = path.resolve(options.root ?? commonFolder(inputs.map(entry => statSync(entry).isDirectory() ? entry : path.dirname(entry))))
    const outDir = path.resolve(options.outDir ?? root)
    const sources = inputs.flatMap(entry => listSources(entry))
    const files = new Map(sources.map(file => [file, readFileSync(file, "utf8")]))
    const context = new ProjectContext(files)
    const results = []
    const globals = new Set(options.globals ?? [])
    const outputs = new Map()

    for (const [file, code] of files) {
        const output = path.join(outDir, `${path.relative(root, file).replace(/\.[^./\\]+$/, "")}.slim`)
        if (outputs.has(output)) {
            results.push({
                file, output, code: null,
                diagnostics: [{ level: "error", code: "same-output", message: `this file and ${path.basename(outputs.get(output))} would both become ${path.basename(output)}: rename one`, line: null, column: null }]
            })
            continue
        }
        outputs.set(output, file)
        if (!options.overwrite && existsSync(output)) {
            results.push({
                file, output, code: null,
                diagnostics: [{ level: "error", code: "exists", message: `${path.basename(output)} already exists and was kept: use --force to replace it`, file: output, line: null, column: null }]
            })
            continue
        }
        try {
            const converter = new Converter(code, { file, context })
            const result = converter.run()
            result.globals.forEach(name => globals.add(name))
            results.push({ file, output, code: result.code, diagnostics: result.diagnostics })
        } catch (error) {
            const loc = error.loc
            const parse = !!loc && error instanceof SyntaxError
            const message = String(error.message).split("\n")[0]
            results.push({
                file, output, code: null,
                diagnostics: [{
                    level: "error", code: parse ? "parse" : "internal", message: parse ? message : `the converter failed on this file: ${message}`,
                    line: parse ? loc.line : null, column: parse ? loc.column + 1 : null
                }]
            })
        }
    }

    const written = results.filter(result => result.code !== null)
    for (const result of written) {
        mkdirSync(path.dirname(result.output), { recursive: true })
        writeFileSync(result.output, result.code)
    }

    let checked = false
    if (options.check !== false) {
        for (const result of written) await checkSlim(result.code, result.output, { transform: options.transform, globals: [...globals] })
        for (const result of written) {
            const outcome = await checkWithRepairs(result.code, result.output, { transform: options.transform, globals: [...globals] })
            checked = checked || outcome.checked
            if (outcome.code !== result.code) {
                result.code = outcome.code
                writeFileSync(result.output, outcome.code)
                for (const { kind, line } of outcome.repaired) {
                    result.diagnostics.push({ level: "note", code: `repair-${kind}`, message: REPAIR_NOTES[kind], file: result.output, line, column: null })
                }
            }
            for (const error of outcome.errors) {
                result.diagnostics.push({ level: "error", code: "slim-check", message: error.message, file: result.output, line: error.line ?? null, column: error.column ?? null })
            }
        }
    }
    const compiler = options.check !== false && (checked || !!(options.transform ?? await loadCompiler()))
    return { results, globals: [...globals], checked, compiler }
}
