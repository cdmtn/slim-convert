import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { assertSameBehaviour, convertFiles } from "./helpers.mjs"
import { convert } from "../src/index.js"

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url))

test("what Slim refuses in working code is fixed without changing it", async () => {
    await assertSameBehaviour({
        "main.js": `
async function save(list) { list.push("saved") }
const log = []
async function run() {
    save(log)
    await 0
}
await run()

const users = [{ id: 1, name: "a" }]
console.log(users.find(user => user.id === 1).name, log)

const stack = [{ tag: "root" }]
stack.push({ tag: "x", depth: 1 })
const items = new Set()
items.open = true
console.log(items.open, stack.length)
`
    })
})

test("a switch over every enum member keeps working", async () => {
    await assertSameBehaviour({
        "main.ts": `
enum Kind { A, B }
function name(kind: Kind): string {
    switch (kind) {
        case Kind.A: return "a"
        case Kind.B: return "b"
    }
}
console.log(name(Kind.A), name(Kind.B))
`
    })
})

test("a real problem stays an error in the report", async () => {
    const { results, dir } = await convertFiles({ "main.js": `const n = 1\nif (n === 2) {}\nmissing()\n` })
    rmSync(dir, { recursive: true, force: true })
    const messages = results[0].diagnostics.filter(item => item.level === "error").map(item => item.message)
    assert.equal(messages.length, 2)
    assert.match(messages[0], /always false/)
    assert.match(messages[1], /"missing" is not defined/)
})

test("code that doesn't parse is reported, the other files are converted", async () => {
    const { results, dir } = await convertFiles({ "bad.ts": `const = 1`, "good.ts": `export const a: number = 1\n` })
    rmSync(dir, { recursive: true, force: true })
    assert.equal(results.find(result => result.file.endsWith("bad.ts")).diagnostics[0].code, "parse")
    assert.match(results.find(result => result.file.endsWith("good.ts")).code, /export const a: number = 1/)
})

test("the CLI writes .slim files and reports", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-convert-cli-"))
    try {
        writeFileSync(path.join(dir, "app.ts"), `export function add(a: number, b: number): number { return a + b }\n`)
        writeFileSync(path.join(dir, "types.d.ts"), `declare const x: number\n`)
        const run = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" })
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stderr, /1 of 1 file converted, 0 error/)
        assert.match(readFileSync(path.join(dir, "app.slim"), "utf8"), /export func add\(a: number, b: number\) -> number/)
        assert.equal(existsSync(path.join(dir, "types.slim")), false)

        const printed = spawnSync(process.execPath, [cli, "--stdout", path.join(dir, "app.ts")], { encoding: "utf8" })
        assert.match(printed.stdout, /export func add/)

        const out = path.join(dir, "out")
        const elsewhere = spawnSync(process.execPath, [cli, path.join(dir, "app.ts"), "--out", out, "--no-check"], { encoding: "utf8" })
        assert.equal(elsewhere.status, 0, elsewhere.stderr)
        assert.equal(existsSync(path.join(out, "app.slim")), true)

        const failed = spawnSync(process.execPath, [cli, path.join(dir, "missing")], { encoding: "utf8" })
        assert.notEqual(failed.status, 0)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("two sources that would become one file are reported", async () => {
    const { results, dir } = await convertFiles({ "a.js": "export const x = 1\n", "a.ts": "export const y = 2\n" })
    rmSync(dir, { recursive: true, force: true })
    assert.deepEqual(results.flatMap(result => result.diagnostics).map(item => item.code), ["same-output"])
})

test("JSX becomes Slim markup and components", () => {
    const { code } = convert(`
export function Card({ title, children }) {
    return <section className="card" onClick={open}>
        {/* a note */}
        <h2 {...rest}>{title}</h2>
        {children}
    </section>
}
const Badge = ({ count }) => <span htmlFor="x">{count}</span>
`, { file: "x.jsx" })
    assert.match(code, /export component Card\(\{ title, children \}\) \{/)
    assert.match(code, /<section class="card" onClick=\$\{open\}>/)
    assert.match(code, /<h2 \$\{rest\}>\$\{title\}<\/h2>/)
    assert.doesNotMatch(code, /a note/)
    assert.match(code, /component Badge\(\{ count \}\) \{ return <span for="x">\$\{count\}<\/span> \}/)
})
