import assert from "node:assert/strict"
import { test } from "node:test"
import { assertSameBehaviour } from "./helpers.mjs"
import { convert } from "../src/index.js"

const code = (source, file = "x.ts") => convert(source, { file }).code

test("an interface becomes a trait and keeps its comments", () => {
    const result = code(`/** a user */\nexport interface User {\n    id: number // the id\n    readonly name: string;\n    say(text: string): void\n    done?(): void\n}\n`)
    assert.match(result, /\/\*\* a user \*\/\nexport trait User \{/)
    assert.match(result, /id: number \/\/ the id/)
    assert.match(result, /\n    name: string\n/)
    assert.match(result, /say\(text: string\) -> void/)
    assert.match(result, /done\?: \(\) => void/)
})

test("interfaces with special members become types", () => {
    assert.match(code(`interface A { [key: string]: number }`), /type A = Record<string, number>/)
    assert.match(code(`interface A { (x: number): string }`), /type A = \(x: number\) => string/)
    assert.match(code(`interface A { new (): object }`), /type A = function/)
    assert.match(code(`interface A {}`), /type A = any/)
})

test("declaration merging puts members in the first interface", () => {
    const result = code(`interface A { a: number }\ninterface A { b: string }\n`)
    assert.match(result, /trait A \{ a: number, b: string \}/)
    assert.equal(result.match(/trait/g).length, 1)
})

test("TypeScript type words become Slim ones", () => {
    const result = code(`let a: boolean\nlet b: unknown\nlet c: object\nlet d: Function\nlet e: Object\nlet f: ReadonlyArray<string>\nlet g: Readonly<number[]>\n`)
    for (const line of [/a: bool/, /b: any/, /c: any/, /d: function/, /e: any/, /f: readonly string\[\]/, /g: number\[\]/]) assert.match(result, line)
})

test("types Slim doesn't have become any, with a note", () => {
    const { code: result, diagnostics } = convert(`type A = Partial<{ a: 1 }>\ntype B = keyof Date\ntype C<T> = T extends string ? 1 : 2\ntype D = { [K in "a"]: 1 }\ntype E = Date["getTime"]\n`, { file: "x.ts" })
    for (const name of "ABDE") assert.match(result, new RegExp(`type ${name} = any`))
    assert.match(result, /type C<T> = any/)
    assert.deepEqual(diagnostics.map(item => item.code).sort(), ["conditional-type", "indexed-type", "keyof-type", "mapped-type", "utility-type"])
})

test("an object type is moved to a trait, so extra fields stay allowed", async () => {
    await assertSameBehaviour({
        "main.ts": `
function total(order: { price: number, count: number }): number { return order.price * order.count }
function names(list: Array<{ name: string }>): string[] { return list.map(item => item.name) }
const order = { price: 2, count: 3, id: "extra" }
console.log(total(order), names([{ name: "a" }, JSON.parse('{"name":"b","age":1}')]))
type Event = { kind: "click", x: number } | { kind: "key", key: string }
function show(event: Event): string { return event.kind === "click" ? String(event.x) : event.key }
console.log(show({ kind: "click", x: 1 }), show({ kind: "key", key: "a" }))
`
    })
})

test("async functions drop the Promise, generators drop their type", () => {
    const result = code(`async function a(): Promise<number> { return 1 }\nconst b = async (): Promise<void> => {}\nclass C { async m(): Promise<string> { return "" } }\nfunction* g(): Generator<number> { yield 1 }\nfunction p(): Promise<number> { return Promise.resolve(1) }\n`)
    assert.match(result, /async func a\(\) -> number/)
    assert.match(result, /async \(\) -> void =>/)
    assert.match(result, /async m\(\) -> string/)
    assert.match(result, /func\* g\(\) \{/)
    assert.match(result, /func p\(\) -> Promise<number>/)
})

test("function overloads leave one function that returns any", async () => {
    const source = `
function pick(all: true): number[]
function pick(all: false): number
function pick(all: boolean): number | number[] { return all ? [1] : 1 }
const list: number[] = pick(true)
const one: number = pick(false)
class Box {
    get(): string
    get(key: string): number
    get(key?: string): any { return key ?? "all" }
}
console.log(list, one, new Box().get())
`
    assert.match(code(source), /func pick\(all: bool\) -> any/)
    await assertSameBehaviour({ "main.ts": source })
})

test("enums keep their runtime values", async () => {
    await assertSameBehaviour({
        "main.ts": `
enum Plain { A, B, C = 10, D }
enum Text { Up = "UP", Down = "DOWN" }
enum Mixed { No = 0, Yes = "YES" }
enum Bits { Read = 1 << 0, Write = 1 << 1, All = Read | Write }
const enum Inline { One = 1 }

function take(value: Plain, text: Text): string { return \`\${value}-\${text}\` }
const flags: Bits = Bits.Read | Bits.Write
console.log(Plain.A, Plain.D, Plain[1], Plain[Plain.C], Text.Down, Mixed.Yes, Bits.All, flags, Inline.One)
console.log(Object.keys(Plain), Object.values(Text), JSON.stringify({ p: Plain.B, t: Text.Up }), take(Plain.B, Text.Up), take(99, Text.Down))
console.log(Plain.A === 0, Text.Up === "UP", [10, 20][Plain.B], Plain.B + 1)
switch (Plain.A as Plain) {
    case Plain.A: console.log("a"); break
    case Plain.B: console.log("b"); break
}
`
    })
})

test("classes lose TypeScript-only modifiers but keep what they mean", async () => {
    await assertSameBehaviour({
        "main.ts": `
abstract class Base<T> {
    abstract readonly kind: string
    protected items: T[] = []
    private static made = 0
    static create(): number { return ++Base.made }
    abstract size(): number
    add(item: T): this { this.items.push(item); return this }
}

class Stack extends Base<number> {
    readonly kind = "stack"
    declare hidden: string
    label!: string
    untouched: string
    constructor(public name: string, private readonly limit = 3, protected extra?: string) {
        super()
    }
    size(): number { return Math.min(this.items.length, this.limit) }
    override add(item: number): this { return super.add(item * 2) }
    get first(): number | undefined { return this.items[0] }
    set first(value: number | undefined) { if (value !== undefined) this.items[0] = value }
}

const stack = new Stack("s").add(1).add(2)
stack.first = 9
console.log(stack.kind, stack.name, stack.size(), stack.first, stack.extra, stack.label, Base.create(), Object.keys(stack).sort())
`
    })
})

test("casts stay meaningful to the Slim checker", async () => {
    await assertSameBehaviour({
        "main.ts": `
interface Item { id: number, tags?: string[] }
const found = [{ id: 1 }].find(item => item.id === 1)!
const raw = JSON.parse('{"id":2}') as Item
const list = (raw.tags ?? []) as string[]
const value: unknown = "text"
const size = (value as string).length
const angle = <string>value
const map = new Map<string, number>([["a", 1]])
const one = map.get("a")! + 1
const fixed = [1, 2] as const
const seen = { a: 1 } satisfies Record<string, number>
const built = {} as Record<string, number>
built.x = 1
console.log(found.id, raw.id, list, size, angle, one, fixed, seen, built)
`
    })
})

test("names Slim uses for itself stay usable", async () => {
    await assertSameBehaviour({
        "main.ts": `
function lock(value: number): number { return value + 1 }
function or(a: number, b: number): number { return a || b }
function describe(type: string, state: number, match: string, empty: boolean): string {
    return \`\${type} \${state} \${match} \${empty}\`
}
const type = "t"
const state = { on: true }
const func = () => 1
function check(value: number): number { return value }
const a = 1
or(a, 2)
console.log(lock(1), describe(type, 1, "m", false), state.on, func(), check(2), a)
function count() { return arguments.length }
console.log((count as any)(1, 2, 3))
`
    })
})

test("declare statements disappear and their names are reported", () => {
    const { code: result, globals } = convert(`declare const VERSION: string\ndeclare function track(name: string): void\ndeclare class Legacy {}\ndeclare global { interface Window { x: number } }\ndeclare module "x" { export const y: number }\nconsole.log(VERSION)\n`, { file: "x.ts" })
    assert.equal(result.trim(), "console.log(VERSION)")
    assert.deepEqual(globals.sort(), ["Legacy", "VERSION", "track"])
})

test("what can't be converted is reported as an error", () => {
    const { diagnostics } = convert(`namespace N { export const a = 1 }\n@sealed class A { @field x = 1 }\n`, { file: "x.ts" })
    assert.deepEqual(diagnostics.filter(item => item.level === "error").map(item => item.code), ["namespace", "decorator", "decorator"])
})

test("a type and a value with the same name lose the type", () => {
    const { code: result, diagnostics } = convert(`const User = { parse() {} }\ntype User = { name: string }\nfunction f(user: User) {}\n`, { file: "x.ts" })
    assert.doesNotMatch(result, /trait|type User/)
    assert.match(result, /func f\(user: any\)/)
    assert.equal(diagnostics[0].code, "name-clash")
})
