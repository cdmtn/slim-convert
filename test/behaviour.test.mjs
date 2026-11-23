import { test } from "node:test"
import { assertSameBehaviour } from "./helpers.mjs"

test("a TypeScript program behaves the same after conversion", async () => {
    await assertSameBehaviour({
        "main.ts": `
import { helper, type Thing } from "./helper"

export interface User {
    id: number
    name: string;
    email?: string
    readonly roles: string[]
    greet(greeting: string): string
    onChange?(value: number): void
}

interface Admin extends User { level: number }

export type Id = string | number
type Point = { x: number; y: number }
type Maybe<T> = T | null
type Handler = (event: string, payload?: unknown) => void
type Part = Partial<User>

export enum Status { Draft, Sent = 5, Paid }
enum Color { Red = "red", Green = "green" }
const enum Flag { A = 1 << 0, B = 1 << 1, AB = A | B }

function overload(a: string): string
function overload(a: number): number
function overload(a: any): any { return a }

abstract class Shape<T> implements Comparable {
    private static count = 0
    protected readonly name: string
    public tag!: string
    data: T | null = null

    constructor(name: string, private readonly sides: number, public color: Color = Color.Red) {
        this.name = name
        Shape.count++
    }

    abstract area(): number

    describe(): string {
        return \`\${this.name} \${this.sides} \${this.area()} \${this.color}\`
    }
    static total(): number { return Shape.count }
}

interface Comparable { compare?(other: unknown): number }

class Square extends Shape<number> {
    constructor(private side: number) {
        super("square", 4)
    }
    area(): number { return this.side ** 2 }
    override describe(): string { return "sq " + super.describe() }
}

async function load(id: number): Promise<User | null> {
    const raw = await Promise.resolve(id)
    return raw > 0 ? ({ id, name: "a", roles: [], greet: g => g } as User) : null
}

const twice = <T,>(x: T): T[] => [x, x]
const asyncArrow = async (a: number): Promise<number> => a + 1

function* gen(): Generator<number> { yield 1; yield 2 }

function first<T extends { id: number }>(items: T[]): T | undefined {
    return items[0]!
}

function isUser(x: unknown): x is User { return typeof x === "object" }
function assertUser(x: unknown): asserts x is User { if (!x) throw new Error("no") }

const cfg = { a: 1 } as const
const n = <number>(5 + 1)
const s = "x" satisfies string
let later!: number
later = 3
const map = new Map<string, Point>()
map.set("p", { x: 1, y: 2 })

function describeUser(user: User, handler: Handler): string {
    handler("seen", user.id)
    return user.greet("hi") + user.name
}

const wide = { id: 1, name: "wide", roles: ["a"], greet: (g: string) => g, extra: true, more: [1, 2] }
console.log(describeUser(wide, (event, payload) => console.log(event, payload)))
const admin: Admin = { ...wide, level: 3 }
console.log(admin.level, admin.name)

const thing: Thing = { label: "t" }
console.log(helper(thing), overload(1), overload("a"))
console.log(new Square(2).describe(), Shape.total(), Status.Sent, Status[5], Status.Paid, Color.Green, Flag.AB)
console.log(Object.keys(Status), JSON.stringify({ s: Status.Draft, c: Color.Red }), Status.Sent === 5)
console.log(twice(1), [...gen()], first([{ id: 1 }]), isUser({}), cfg, n, s, later, map.get("p")?.x)
assertUser(1)
const part: Part = { id: 1 }
const maybe: Maybe<number> = null
const id: Id = "x"
console.log(part, maybe, id)
console.log(await load(1).then(user => user?.name), await load(0), await asyncArrow(1))
`,
        "helper.ts": `
export interface Thing { label: string }
export function helper(thing: Thing): string { return thing.label.toUpperCase() }
`
    })
})
