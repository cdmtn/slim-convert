import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { transform } from "@slim-lang/core"
import { convertProject } from "../src/index.js"

const cli = fileURLToPath(new URL("./bin/cli.js", import.meta.resolve("@slim-lang/core")))

function write(dir, name, content) {
    const file = path.join(dir, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    return file
}

function run(file, cwd) {
    const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd, encoding: "utf8" })
    return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() }
}

function compileOriginal(name, code, files) {
    if (/\.c?js$/.test(name) || /\.mjs$/.test(name)) return { name, code }
    const { outputText } = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, useDefineForClassFields: true, verbatimModuleSyntax: false }
    })
    const withExtensions = outputText.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(?:\.[jt]s)?(["'])/g, (_, before, target, after) => {
        const inFolder = path.posix.join(path.posix.dirname(name), target, "index.ts")
        return `${before}${target}${inFolder in files ? "/index" : ""}.js${after}`
    })
    return { name: name.replace(/\.ts$/, ".js"), code: withExtensions }
}

export async function convertFiles(files, options = {}) {
    mkdirSync(options.parent ?? tmpdir(), { recursive: true })
    const dir = mkdtempSync(path.join(options.parent ?? tmpdir(), "slim-convert-"))
    const source = path.join(dir, "source")
    for (const [name, code] of Object.entries(files)) write(source, name, code)
    const slim = path.join(dir, "slim")
    const result = await convertProject(source, { outDir: slim, transform })
    return { dir, source, slim, ...result }
}

export async function assertSameBehaviour(files, { entry = Object.keys(files)[0], commonJs = false, parent } = {}) {
    const converted = await convertFiles(files, { parent })
    const { dir, slim, results } = converted
    try {
        const errors = results.flatMap(result => result.diagnostics.filter(item => item.level === "error").map(item => `${path.basename(result.file)}:${item.line}: ${item.message}`))
        assert.deepEqual(errors, [], `converted code has errors:\n${results.map(result => result.code).join("\n---\n")}`)

        const original = path.join(dir, "original")
        write(original, "package.json", JSON.stringify({ type: commonJs ? "commonjs" : "module" }))
        for (const [name, code] of Object.entries(files)) {
            const compiled = compileOriginal(name, code, files)
            write(original, compiled.name, compiled.code)
        }
        const before = run(path.join(original, entry.replace(/\.ts$/, ".js")), original)
        assert.equal(before.status, 0, `the original program fails:\n${before.output}`)

        const main = entry.replace(/\.[^.]+$/, "")
        write(slim, "slimconfig.json", JSON.stringify({ main, warnings: false }))
        write(slim, "package.json", JSON.stringify({ type: "module" }))
        const built = spawnSync(process.execPath, [cli, "build"], { cwd: slim, encoding: "utf8" })
        assert.equal(built.status, 0, `${built.stdout}${built.stderr}`)
        const after = run(path.join(slim, "slim-dist", `${main}.js`), slim)
        assert.equal(after.output, before.output, `the converted code behaves differently:\n${results.map(result => result.code).join("\n---\n")}`)
        return converted
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}
