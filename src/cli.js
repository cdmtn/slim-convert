#!/usr/bin/env node
import path from "node:path"
import { existsSync, readFileSync, statSync } from "node:fs"
import { parseArgs } from "node:util"
import { convert } from "./convert.js"
import { convertProject } from "./project.js"

const USAGE = `Usage: slim-convert <file or folder>... [options]

Converts JavaScript and TypeScript to Slim. Each file gets a .slim file next to it.

Options:
  -o, --out <folder>   write the .slim files to this folder
      --stdout         print one converted file instead of writing it
      --no-check       don't compile the result with Slim
  -f, --force          replace .slim files that already exist
  -h, --help           show this text`

function fail(message) {
    console.error(message)
    process.exit(2)
}

function location(file, diagnostic) {
    const name = path.relative(process.cwd(), diagnostic.file ?? file)
    if (!diagnostic.line) return name
    return diagnostic.column ? `${name}:${diagnostic.line}:${diagnostic.column}` : `${name}:${diagnostic.line}`
}

function printReport(results, missingCompiler, globals) {
    const count = level => results.flatMap(result => result.diagnostics).filter(item => item.level === level).length
    for (const level of ["error", "warning", "note"]) {
        for (const result of results) {
            for (const diagnostic of result.diagnostics.filter(item => item.level === level)) {
                console.error(`${level}: ${diagnostic.message}\n    at ${location(result.file, diagnostic)}`)
            }
        }
    }
    const converted = results.filter(result => result.code !== null).length
    console.error(`\n${converted} of ${results.length} file${results.length === 1 ? "" : "s"} converted, ${count("error")} error(s), ${count("warning")} warning(s), ${count("note")} note(s)`)
    if (missingCompiler) console.error("The result was not compiled: install @slim-lang/core to check it")
    if (globals.length) console.error(`These names were only declared: add them to "globals" in slimconfig.json: ${globals.join(", ")}`)
}

async function main() {
    let parsed
    try {
        parsed = parseArgs({
            allowPositionals: true,
            options: {
                out: { type: "string", short: "o" },
                stdout: { type: "boolean" },
                "no-check": { type: "boolean" },
                force: { type: "boolean", short: "f" },
                help: { type: "boolean", short: "h" }
            }
        })
    } catch (error) {
        fail(`${error.message}\n\n${USAGE}`)
    }
    const { values, positionals } = parsed
    if (values.help) {
        console.log(USAGE)
        return
    }
    if (positionals.length === 0) fail(USAGE)
    for (const entry of positionals) if (!existsSync(entry)) fail(`${entry}: no such file or folder`)

    if (values.stdout) {
        if (positionals.length !== 1) fail("--stdout takes one file")
        const file = positionals[0]
        if (statSync(file).isDirectory()) fail("--stdout takes one file, not a folder")
        let result
        try {
            result = convert(readFileSync(file, "utf8"), { file })
        } catch (error) {
            const loc = error.loc
            if (!loc || !(error instanceof SyntaxError)) throw error
            console.error(`error: ${String(error.message).split("\n")[0]}\n    at ${location(file, { line: loc.line, column: loc.column + 1 })}`)
            process.exitCode = 1
            return
        }
        process.stdout.write(result.code)
        for (const diagnostic of result.diagnostics) console.error(`${diagnostic.level}: ${diagnostic.message}\n    at ${location(file, diagnostic)}`)
        process.exitCode = result.diagnostics.some(item => item.level === "error") ? 1 : 0
        return
    }

    const { results, compiler, globals } = await convertProject(positionals, { outDir: values.out, check: !values["no-check"], overwrite: !!values.force })
    if (results.length === 0) fail("No JavaScript or TypeScript files found")
    printReport(results, !values["no-check"] && !compiler, globals)
    process.exitCode = results.some(result => result.diagnostics.some(item => item.level === "error")) ? 1 : 0
}

main().catch(error => fail(error.stack ?? String(error)))
