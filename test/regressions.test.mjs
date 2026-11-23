import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { assertSameBehaviour } from "./helpers.mjs"
import { convert } from "../src/index.js"

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url))
const code = (source, file = "x.ts") => convert(source, { file }).code

test("enum members with negative or fractional values keep a valid reverse mapping", async () => {
    await assertSameBehaviour({
        "main.ts": `
enum Step { Back = -1, Stay, Half = 0.5, Next = 1 }
console.log(Step.Back, Step.Stay, Step[-1], Step[0], Step[0.5], Step[1], Object.keys(Step))
`
    })
})

test("parameter properties work in a class written on one line", async () => {
    await assertSameBehaviour({
        "main.ts": `
const made: string[] = []
class Point { constructor(public x = 0, public y = 0) {} }
class Named { constructor(public name: string, private tag: string) { made.push(name + tag) } }
class Coded extends Error { constructor(message: string, public code = 1) { super(message); this.name = "Coded" } }
const error = new Coded("m", 7)
console.log(new Point(1).x, new Point().y, new Named("a", "b").name, made, error.code, error.name, error.message)
`
    })
})

test("a generic constraint with an object type still accepts strings and arrays", async () => {
    const { results } = await assertSameBehaviour({
        "main.ts": `
function longest<T extends { length: number }>(a: T, b: T): T { return a.length >= b.length ? a : b }
console.log(longest("ab", "c"), longest([1], [2, 3]))
`
    })
    assert.ok(results[0].diagnostics.some(item => item.code === "object-constraint"))
})

test("non-ASCII names stay fields of a trait", async () => {
    const { results } = await assertSameBehaviour({
        "main.ts": `
interface Ünïcode { naïve: string; 日本: number }
const value: Ünïcode = { naïve: "ç", 日本: 1 }
console.log(value.naïve, value.日本)
`
    })
    assert.match(results[0].code, /trait Ünïcode \{ naïve: string, 日本: number \}/)
})

test("comments inside types and enums are kept", () => {
    const result = code(`type Kind =\n    | "a" // first\n    | "b" /* second */\ninterface I { x: number /* t */; y(a: string /* who */): void }\nenum E { A = 1 /* one */, B }\nclass C { v: /* pre */ number = 1 }\n`)
    assert.match(result, /type Kind = "a" \| "b" \/\* first \*\/ \/\* second \*\//)
    assert.match(result, /x: number \/\* t \*\/, y\(a: string\) -> void \/\* who \*\//)
    assert.match(result, /Object\.freeze\(\{ A: 1, \/\* one \*\/ B: 2, 1: "A", 2: "B" \}\)/)
    assert.match(result, /v: number \/\* pre \*\/ = 1/)
})

test("accessor fields become a getter and a setter", async () => {
    await assertSameBehaviour({
        "main.ts": `
class Base {
    static accessor count: number = 1
    accessor label = "a"
}
class Child extends Base {}
const item = new Child()
item.label = "b"
Child.count = 2
console.log(item.label, Base.count, Child.count, Object.keys(item))
`
    })
})

test("an interface that extends one with an index signature converts", () => {
    const result = code(`interface A { [key: string]: unknown }\ninterface B extends A { x: number }\n`)
    assert.match(result, /trait B \{ x: number \}/)
})

test("namespace re-exports, type parameter defaults and leading semicolons keep working", async () => {
    await assertSameBehaviour({
        "main.ts": `
import { tools, type Result } from "./lib"
type Pair<A, B = A> = [A, B]
const log = (value: unknown) => console.log(value)
type Mark = { mark: string }
;[1, 2].forEach(log)
declare const VERSION: string
;(() => log("iife"))()
const pair: Pair<number> = [1, 2]
const done: Result<number> = { ok: true, value: 3 }
log([pair, done, tools.twice(2)])
`,
        "lib.ts": `
export * as tools from "./tools"
export type Result<T, E = Error> = { ok: true, value: T } | { ok: false, error: E }
`,
        "tools.ts": `export const twice = (n: number): number => n * 2\n`
    })
})

test("a type from a namespace of a package becomes any", () => {
    const { code: result, diagnostics } = convert(`import React from "react"\nexport function add(event: React.FormEvent): void { event.preventDefault() }\n`, { file: "x.ts" })
    assert.match(result, /func add\(event: any\)/)
    assert.ok(diagnostics.some(item => item.code === "unknown-type"))
})

test("a file with CRLF line ends gets only CRLF line ends", () => {
    const result = code(`const p: { x: number } = { x: 1 }\r\nclass A {\r\n    constructor(private a: number) {}\r\n}\r\nenum E {\r\n    X,\r\n    Y\r\n}\r\n`)
    assert.doesNotMatch(result, /[^\r]\n/)
    assert.match(result, /trait P \{\r\n/)
})

test("a required JSON file is imported with its type", () => {
    const result = code(`const data = require("./data.json")\nconsole.log(data)\n`, "x.js")
    assert.match(result, /import data from "\.\/data\.json" with \{ type: "json" \}/)
})

function run(args, cwd) {
    return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
}

test("the CLI keeps outputs inside --out, keeps existing files and explains bad input", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-convert-cli-"))
    try {
        for (const [name, content] of [["src/a/x.js", "export const a = 1\n"], ["lib/b/y.js", "export const b = 2\n"], ["bad.ts", "const = 1\n"]]) {
            mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
            writeFileSync(path.join(dir, name), content)
        }
        const first = run(["src/a", "lib/b", "--out", "out", "--no-check"], dir)
        assert.equal(first.status, 0, first.stderr)
        assert.equal(existsSync(path.join(dir, "out/src/a/x.slim")), true)
        assert.equal(existsSync(path.join(dir, "out/lib/b/y.slim")), true)
        assert.equal(existsSync(path.join(dir, "lib/b/y.slim")), false)

        writeFileSync(path.join(dir, "out/src/a/x.slim"), "edited by hand\n")
        const again = run(["src/a", "lib/b", "--out", "out", "--no-check"], dir)
        assert.equal(again.status, 1)
        assert.match(again.stderr, /x\.slim already exists/)
        assert.equal(readFileSync(path.join(dir, "out/src/a/x.slim"), "utf8"), "edited by hand\n")
        const forced = run(["src/a", "lib/b", "--out", "out", "--no-check", "--force"], dir)
        assert.equal(forced.status, 0, forced.stderr)
        assert.match(readFileSync(path.join(dir, "out/src/a/x.slim"), "utf8"), /export const a = 1/)

        const missing = run(["nothing"], dir)
        assert.equal(missing.status, 2)
        assert.match(missing.stderr, /^nothing: no such file or folder/)

        const broken = run(["--stdout", "bad.ts"], dir)
        assert.equal(broken.status, 1)
        assert.match(broken.stderr, /^error: Unexpected token \(1:6\)\n    at bad\.ts:1:7/)
        assert.doesNotMatch(broken.stderr, /node_modules/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a Slim error is reported at its line in the .slim file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-convert-cli-"))
    try {
        writeFileSync(path.join(dir, "a.ts"), "const p: { x: number } = { x: 1 }\nconst n = 1\nif (n === 2) {}\n")
        const result = run(["a.ts"], dir)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /always false.*\n    at a\.slim:7:5/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a repair note has no column, and a run that writes nothing doesn't ask to install Slim", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "slim-convert-cli-"))
    try {
        writeFileSync(path.join(dir, "app.js"), "const items = new Set()\nitems.open = true\nconsole.log(items.open)\n")
        const first = run(["app.js"], dir)
        assert.equal(first.status, 0, first.stderr)
        assert.match(first.stderr, /\n    at app\.slim:\d+\n/)
        assert.doesNotMatch(first.stderr, /null/)
        const again = run(["app.js"], dir)
        assert.equal(again.status, 1)
        assert.match(again.stderr, /already exists/)
        assert.doesNotMatch(again.stderr, /install @slim-lang\/core/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("an optional method with a body keeps its question mark and gets no note", async () => {
    assert.deepEqual(convert(`class A { m?(): void {} }\n`, { file: "x.ts" }), { code: `class A { m?() -> void {} }\n`, diagnostics: [], globals: [] })
    await assertSameBehaviour({
        "main.ts": `
class A { m?(): string { return "m" } }
const a = new A()
console.log(a.m?.(), typeof a.m)
`
    })
})

test("a dropped index signature leaves no stray comma", () => {
    assert.match(code(`interface S { a: number; [k: string]: number }\n`), /^trait S \{ a: number \}\n$/)
    assert.match(code(`interface S { [k: string]: number; a: number }\n`), /^trait S \{ a: number \}\n$/)
    assert.match(code(`interface S {\n    a: number\n    [k: string]: number\n    b: string\n}\n`), /^trait S \{\n    a: number\n    b: string\n\}\n$/)
    assert.match(code(`interface A { x: number }\ninterface B extends A { [k: string]: number }\n`), /trait B \{ x: number \}/)
})

test("traits from object types go above the comments of the first statement", () => {
    assert.match(code(`// about p\n/** p */\nconst p: { x: number } = { x: 1 }\n`), /^trait P \{\n    x: number\n\}\n\n\/\/ about p\n\/\*\* p \*\/\nconst p: P/)
    assert.match(code(`// license\n\n// about p\nconst p: { x: number } = { x: 1 }\n`), /^\/\/ license\n\ntrait P \{\n    x: number\n\}\n\n\/\/ about p\nconst p: P/)
})

test("a tuple with optional members becomes a union of tuples and keeps its member types", async () => {
    await assertSameBehaviour({
        "main.ts": `
type Shot = [number, number, boolean, number?]
const shots: Shot[] = [[1, 2, true], [3, 4, false, 5]]
const add = (a: number, b: number) => a + b
const [a, b, flag, extra] = shots[1]
console.log(add(a, b), flag, extra, add(shots[0][0], shots[0][1]), shots[0][3])
`
    })
    assert.match(code(`type T = [string, number?, boolean?]\n`), /type T = \[string\] \| \[string, number\] \| \[string, number, bool\]/)
})

test("a repair that puts a parenthesis at the start of a line keeps it apart from the line above", async () => {
    const converted = await assertSameBehaviour({
        "main.js": `
class Group {
    constructor(...items) { this.items = items }
}
Group.prototype.grow = function () { this.items.push(0) }
function make(a, b) {
    const group = new Group(a, b)
    group.grow()
    return group.items.length
}
console.log(make(1, 2))
`
    })
    assert.match(converted.results[0].code, /^\s*;\(group as any\)\.grow\(\)$/m)
})
