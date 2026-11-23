import assert from "node:assert/strict"
import { test } from "node:test"
import { assertSameBehaviour } from "./helpers.mjs"
import { convert } from "../src/index.js"

test("imports and exports between TypeScript files keep working", async () => {
    await assertSameBehaviour({
        "main.ts": `
import fallback, { Level, parse as read, type Config } from "./lib/config"
import * as text from "./lib/text"
import { upper } from "./lib"

function level(value: Level): string {
    return value === Level.High ? "high" : "low"
}

const config: Config = read("a=1")
console.log(fallback.name, config.name, level(Level.High), level(Level.Low), text.shout("x"), upper("y"))
`,
        "lib/config.ts": `
export enum Level { Low, High }
export interface Config { name: string }
export function parse(raw: string): Config { return { name: raw.split("=")[0] } }
const fallback: Config = { name: "default" }
export default fallback
`,
        "lib/text.ts": `
export const shout = (value: string): string => value.toUpperCase() + "!"
export const quiet = (value: string): string => value.toLowerCase()
`,
        "lib/index.ts": `
export { shout as upper } from "./text"
export * from "./config"
`
    })
})

test("an interface can extend one from another file", async () => {
    await assertSameBehaviour({
        "main.ts": `
import type { Base, Pair } from "./base"

interface Named<T> extends Base<T> { name: string }
type Both = Pair & { extra: boolean }

function show(item: Named<number>): string { return item.name + item.value }
const both: Both = { left: 1, right: 2, extra: true }
console.log(show({ name: "n", value: 1 }), both.left)
`,
        "base.ts": `
export interface Base<T> { value: T }
export type Pair = { left: number, right: number }
`
    })
})

test("CommonJS modules become ES modules", async () => {
    await assertSameBehaviour({
        "main.cjs": `
const path = require("node:path")
const { join, basename: base } = require("node:path")
const math = require("./math.cjs")
const { add } = require("./math.cjs")
const single = require("./single.cjs")
const lazy = () => require("node:os").EOL.length

console.log(math.add(1, 2), add(2, 3), math.PI, single(), lazy())
console.log(join("a", "b") === path.join("a", "b"), base("/x/y.txt"), typeof __dirname, typeof __filename)
console.log(__filename.endsWith("main.cjs") || __filename.endsWith("main.js"))
`,
        "math.cjs": `
const PI = 3
function add(a, b) { return a + b }
exports.add = add
exports.PI = PI
exports.twice = function (a) { return exports.add(a, a) }
`,
        "single.cjs": `
function single() { return "single" }
module.exports = single
`
    }, { commonJs: true })
})

test("module.exports with an object gives named and default exports", () => {
    const { code } = convert(`function a() {}\nconst b = 1\nmodule.exports = { a, c: b, d: 2 }\n`, { file: "x.js" })
    assert.match(code, /export const d = 2/)
    assert.match(code, /export \{ a, b as c \}/)
    assert.match(code, /export default \{ a, c: b, d \}/)
})

test("types from packages are dropped, values stay", () => {
    const { code } = convert(`import { Foo, bar } from "pkg"\nimport type { Baz } from "other"\nconst x: Foo = bar()\nlet y: Baz\n`, { file: "x.ts" })
    assert.match(code, /import \{ bar \} from "pkg"/)
    assert.doesNotMatch(code, /other/)
    assert.match(code, /const x: any = bar\(\)/)
})

test("an unused import stays in JavaScript, where it may have side effects", () => {
    const { code } = convert(`import { a } from "pkg"\nimport "./style.css"\n`, { file: "x.js" })
    assert.match(code, /import \{ a \} from "pkg"/)
    assert.match(code, /import "\.\/style\.css"/)
})

test("relative imports become use, data files stay imports", () => {
    const { code } = convert(`import a from "./a.js"\nimport b, { c } from "../b"\nimport data from "./data.json" with { type: "json" }\nconsole.log(a, b, c, data)\n`, { file: "x.ts" })
    assert.match(code, /use a from "\.\/a"/)
    assert.match(code, /use b from "\.\.\/b"\nuse \{ c \} from "\.\.\/b"/)
    assert.match(code, /import data from "\.\/data\.json" with \{ type: "json" \}/)
})
