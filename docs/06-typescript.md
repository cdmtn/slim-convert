# TypeScript

TypeScript types are kept where Slim can describe them, because Slim checks them when the code runs. A type Slim can't describe exactly becomes `any`, with a note, so the converted code accepts every value the original accepted.

## Types

| TypeScript | Slim |
|---|---|
| `function f(a: number): string` | `func f(a: number) -> string` |
| `async function f(): Promise<T>` | `async func f() -> T` |
| a return type that becomes `any`, the return type of a generator | removed |
| `boolean`, `unknown`, `object`, `{}` | `bool`, `any`, `any`, `any` |
| `Function`, `new () => T`, a function type with a rest parameter | `function` |
| `(a: number) => string` | `(a: number) => string` |
| `Boolean`, `String`, `Number`, `Object` | `bool`, `string`, `number`, `any` |
| `string`, `number`, `bigint`, `symbol`, `null`, `undefined`, `void`, `never` | unchanged |
| `"a"`, `1`, `-1`, `true` | unchanged |
| `10n` (a bigint literal type), `` `/${string}` `` (a template literal type) | `bigint`, `string` |
| `A \| B`, `A & B` | unchanged; a union with `any` in it becomes `any` |
| `T[]`, `Array<T>`, `[A, B]` | unchanged |
| `readonly T[]`, `ReadonlyArray<T>` | `readonly T[]` |
| `Readonly<T>` | `T` |
| `[A, B?]` | `[A] \| [A, B]` |
| `[A, ...B[]]` | `(A \| B)[]`, with an `open-tuple` note |
| `{ [k: string]: T }` | `Record<string, T>` |
| `{ x: T }` in an annotation | a `trait` with a name made from its place |
| `x is T` | `bool` |
| `E.A`, where `E` is an enum | the value of `E.A`, like `"red"` |
| `Promise<T>`, `Map<K, V>`, `Date`, `Error`, `URL`, `HTMLElement`, other built-in and DOM types | unchanged |
| `Box<number>` where `Box<T, Tag = string>` | `Box<number, string>`: omitted type arguments are filled from the defaults |
| `<T>x`, `x satisfies T`, `x as const` | `(x as T)`, `x`, `x` |
| `catch (e: unknown)` | `catch (e)` |
| a `this` parameter | removed |

```ts
function add(a: number, b: number): number {
    return a + b
}

async function load(url: string): Promise<string> {
    const response = await fetch(url)
    return response.text()
}

let ok: boolean = true
let raw: unknown = null
let anything: object = {}
let callback: Function = () => {}
```

becomes:

```js
func add(a: number, b: number) -> number {
    return a + b
}

async func load(url: string) -> string {
    const response = await fetch(url)
    return response.text()
}

let ok: bool = true
let raw: any = null
let anything: any = {}
let callback: function = () => {}
```

## Types that become `any`

These become `any`, each with a note:

| TypeScript | Note code |
|---|---|
| `Partial`, `Required`, `Pick`, `Omit`, `Exclude`, `Extract`, `NonNullable`, `ReturnType`, `Parameters`, `Awaited` and the other utility types | `utility-type` |
| `keyof T` | `keyof-type` |
| `T extends U ? X : Y` | `conditional-type` |
| `{ [K in keyof T]: ... }` | `mapped-type` |
| `T["name"]` | `indexed-type` |
| `typeof value` | `typeof-type` |
| `import("./a").A` | `import-type` |
| `A & { x: T }`, an intersection with an object type in an annotation | `object-intersection` |
| an object type with index or call signatures next to fields | `object-type` |
| a type imported from an npm package, like `Request` from `"express"` | `package-type` |
| a name that is not declared in the file, or a qualified name that can't be resolved, like `NodeJS.Timeout` or `Intl.DateTimeFormat` | `unknown-type` |

```ts
interface Base {
    id: number
}

type Keys = keyof Base
type Draft = Partial<Base>
type Name = Base["id"]
let timer: NodeJS.Timeout
```

becomes:

```js
trait Base {
    id: number
}

type Keys = any
type Draft = any
type Name = any
let timer: any
```

## Interfaces and type aliases

| TypeScript | Slim |
|---|---|
| `interface A { x: T }`, `type A = { x: T }` | `trait A { x: T }` |
| `interface A extends B { ... }` | `trait A { ... }` with the fields of `B` written out after its own |
| `type A = B & { x: T }` | `trait A` with the fields of `B` and `x` |
| an interface declared twice | one `trait` with the fields of both |
| `interface A { [k: string]: T }` | `type A = Record<string, T>` |
| an index signature next to named fields | removed, with an `index-signature` note: a trait accepts other fields anyway |
| `interface F { (x: number): string }` | `type F = (x: number) => string` |
| an interface with a call signature and fields, or a constructor signature | `type F = function` |
| a method in an interface, `m(a: T): R` | `m(a: T) -> R` |
| a method declared several times (overloads) | `m: function` |
| a field without a plain name (`[Symbol.iterator]`) | removed, with a `computed-field` note |
| a type with the same name as a value (`const Config` and `type Config`) | removed, with a `name-clash` note |
| `export default interface A` | `export trait A` and `export { A as default }` |

```ts
interface Named {
    name: string
}

interface User extends Named {
    id: number
    email?: string
    greet(other: User): string
}

type Point = { x: number, y: number }

interface Scores {
    [player: string]: number
}

function move(p: Point, by: { dx: number, dy: number }): Point {
    return { x: p.x + by.dx, y: p.y + by.dy }
}
```

becomes:

```js
trait MoveBy {
    dx: number
    dy: number
}

trait Named {
    name: string
}

trait User {
    id: number
    email?: string
    greet(other: User) -> string
    name: string
}

trait Point { x: number, y: number }

type Scores = Record<string, number>

func move(p: Point, by: MoveBy) -> Point {
    return { x: p.x + by.dx, y: p.y + by.dy }
}
```

The type of `by` had no name, so it became the trait `MoveBy`, from the function and the parameter. The same object type used in several places becomes one trait.

When the parent of an interface is in another file, `convertProject` (and the command line) reads it from there. With `convert` or `--stdout`, or when the parent comes from a package, its fields are left out with an `unknown-parent` note.

## Enums

A Slim `enum` value is not a number or a string, so a TypeScript enum becomes a frozen object with the same members and the same reverse mapping. Where the enum is used as a type, it becomes the type of its values.

| TypeScript | Slim |
|---|---|
| `enum E { A, B = 5 }` | `const E = Object.freeze({ A: 0, B: 5, 0: "A", 5: "B" })`, and `E` as a type becomes `number` |
| `enum E { A = "a", B = "b" }` | `const E = Object.freeze({ A: "a", B: "b" })`, and `E` as a type becomes `"a" \| "b"` |
| an enum with numbers and strings | the same object, and `E` as a type becomes `any` |
| `enum E { A = -1, B = 0.5 }` | the reverse key of a negative or fractional value is written right after its member: `A: -1, "-1": "A", B: 0.5, "0.5": "B"` |
| `const enum E { ... }` | the same object, without the reverse mapping |
| `A = 1 << 2`, `B = A * 4` | the computed value, `4`, `16` |
| `A = getValue()` | copied as it is, with a `computed-enum` warning |
| an enum declared twice | a `merged-enum` error |

```ts
enum Direction { Up, Down, Left = 10, Right }

enum Color { Red = "red", Green = "green" }

enum Signed { Below = -1, Half = 0.5, Zero = 0 }

function paint(c: Color, d: Direction) {}
```

becomes:

```js
const Direction = Object.freeze({ Up: 0, Down: 1, Left: 10, Right: 11, 0: "Up", 1: "Down", 10: "Left", 11: "Right" })

const Color = Object.freeze({ Red: "red", Green: "green" })

const Signed = Object.freeze({ Below: -1, "-1": "Below", Half: 0.5, "0.5": "Half", Zero: 0, 0: "Zero" })

func paint(c: "red" | "green", d: number) {}
```

An enum imported from another file is used as a type the same way when the project is converted with `convertProject` or the command line.

## Classes

| TypeScript | Slim |
|---|---|
| `constructor(private a: number)` | a field `a: number` and `this.a = a` in the constructor |
| `constructor(public readonly a: number)` | a field `readonly a: number` and `this.a = a` |
| `public`, `private`, `protected`, `override`, `abstract class` | removed |
| `abstract m(): T` | `m() -> T { throw new Error("A.m is abstract") }` |
| `x: T` that nothing sets in the constructor and has no value | `x!: T` |
| `accessor x: T = v` | a private field `#xValue`, a getter and a setter |
| `declare x: T` in a class, an index signature in a class | removed |
| `m?(): void { ... }` | `m?() -> void { ... }`: Slim accepts the `?`, and the method keeps its body, so it is always there |
| method overloads | one method with `-> any` |
| `implements A, B` | unchanged, except the types that became `any`, which are removed |
| decorators | a `decorator` error |

```ts
abstract class Shape {
    abstract area(): number
}

class Circle extends Shape {
    label: string
    color: string

    constructor(private radius: number, public readonly name: string) {
        super()
        this.color = "red"
    }

    public override area(): number {
        return Math.PI * this.radius ** 2
    }
}

class Counter {
    accessor count: number = 0
}
```

becomes:

```js
class Shape {
    area() -> number { throw new Error("Shape.area is abstract") }
}

class Circle extends Shape {
    radius: number
    readonly name: string
    label!: string
    color: string

    constructor(radius: number, name: string) {
        super()
        this.radius = radius
        this.name = name
        this.color = "red"
    }

    area() -> number {
        return Math.PI * this.radius ** 2
    }
}

class Counter {
    #countValue: number = 0
    get count() -> number { return this.#countValue }
    set count(value: number) { this.#countValue = value }
}
```

## Functions and overloads

Overload signatures are removed, and the implementation returns `any`, because one Slim return type can't describe several:

```ts
function parse(x: string): number
function parse(x: number): number
function parse(x: any): number {
    return Number(x)
}
```

becomes:

```js
func parse(x: any) -> any {
    return Number(x)
}
```

## Generics

Type parameters stay. A constraint stays when Slim can describe it; an object-type constraint is dropped with an `object-constraint` note, because a Slim trait doesn't accept the strings or arrays that a TypeScript object type accepts. Defaults are removed from the declaration, and filled in where the type is used with fewer arguments.

```ts
interface Box<T, Tag = string> {
    value: T
    tag: Tag
}

function first<T extends { id: number }>(items: T[]): T {
    return items[0]
}

let box: Box<number>
```

becomes:

```js
trait Box<T, Tag> {
    value: T
    tag: Tag
}

func first<T>(items: T[]) -> T {
    return items[0]
}

let box: Box<number, string>
```

## Imports and declarations

| TypeScript | Slim |
|---|---|
| `import x from "./a.ts"` | `use x from "./a"` |
| `import type { A } from "./a"`, `import { type A } from "./a"` | `use { A } from "./a"` |
| `import type { A } from "pkg"` | removed, and `A` becomes `any` |
| `import { A, f } from "pkg"` where `A` is only used as a type | `import { f } from "pkg"` |
| `import fs = require("fs")` | `import fs from "fs"` |
| `import A = B.C` | `const A = B.C` |
| `export = value` | `export default value` |
| `export type { A } from "pkg"` | removed |
| `declare const`, `declare function`, `declare class` | removed; the names are listed for `globals` in `slimconfig.json` |
| `declare global { ... }`, `declare module "x" { ... }`, `declare` interfaces, types and enums | removed |
| `namespace A { ... }` | a `namespace` error: move it to its own file |

```ts
import { helper } from "./helper.ts"
import type { Options } from "pkg"
import express from "express"

const app = express()
function run(options: Options) {
    helper(options)
}
```

becomes:

```js
use { helper } from "./helper"
import express from "express"

const app = express()
func run(options: any) {
    helper(options)
}
```

with the note:

```text
note: the type "Options" comes from "pkg" and became "any"
```
