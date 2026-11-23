# Reports and exit codes

Everything the converter or Slim has to say about a file is a report (a "diagnostic" in the [API](04-api.md)). Each one has a level, a code and a message.

| Level | Meaning |
|---|---|
| `error` | The file was not converted, or the converted code is not accepted by Slim. The exit code is 1 |
| `warning` | The code was converted, but it may behave differently: check it |
| `note` | Something was simplified (a type became `any`) or repaired (a `!` was added): read it once |

The command line prints the errors first, then the warnings, then the notes:

```text
note: the type "Options" comes from "pkg" and became "any"
    at src/run.ts:7:23
```

## Where a report points

Most reports point to a line and a column of the source file. Some don't:

- reports about the `.slim` file point to the `.slim` file, not to the source: Slim compile errors (`slim-check`), repair notes (`repair-...`) and `exists`. In the API they have a `file` field with the path of the `.slim` file;
- `same-output`, `exists` and `internal` are about a whole file and have no line, so only the file is printed;
- some notes are about a type, not a place, and have no line either, like `open-tuple`;
- repair notes have a line but no column.

A Slim compile error points to the `.slim` file because Slim compiles the converted code, whose lines can differ from the source.

## After converting

The result is compiled with Slim, if `@slim-lang/core` is installed and `--no-check` is not given. Slim is stricter than JavaScript, so working code can be refused. What can be fixed without changing what the code does is fixed, and listed as a note:

| Note code | What Slim refused | What is done |
|---|---|---|
| `repair-void` | an async call that nothing awaits, inside an async function | `void` is added in front of it |
| `repair-non-null` | a value that may be `null` or `undefined`, read without a check | `!` is added after it: the code already read it without a check |
| `repair-dynamic-field` | a field Slim doesn't see on a value, like one set from outside | the value is read through `(value as any)` |
| `repair-condition` | a condition Slim sees as always true | it is written with `as any`: check that it does what you meant |
| `repair-return-type` | a function that may reach its end without a return, because Slim can't see that a `switch` handles every enum member | the return type is removed |

```ts
interface Cart {
    items: string[]
}

async function save(cart: Cart): Promise<void> {
    console.log(cart.items.length)
}

export async function checkout(carts: Cart[]) {
    const first = carts.find(cart => cart.items.length > 0)
    console.log(first.items)
    const cart = carts[0]
    save(cart)
    console.log(cart.total)
    if (cart.items) console.log("has items")
}
```

becomes, after four repairs:

```js
trait Cart {
    items: string[]
}

async func save(cart: Cart) -> void {
    console.log(cart.items.length)
}

export async func checkout(carts: Cart[]) {
    const first = carts.find(cart => cart.items.length > 0)
    console.log(first!.items)
    const cart = carts[0]
    void save(cart)
    console.log((cart as any).total)
    if ((cart.items as any)) console.log("has items")
}
```

Other Slim errors are reported with the `slim-check` code, and they are usually real bugs: `if (n === NaN)`, `arr.sort()` on numbers, a name nothing declares.

```text
error: NaN is not equal to anything, itself included, so this is always false — use Number.isNaN(n)
    at src/app.slim:27:9
```

A name that is only declared (`declare const VERSION: string`) is accepted while checking, and listed at the end of the report, to be added to `globals` in `slimconfig.json`.

## Codes

| Code | Level | Meaning |
|---|---|---|
| `parse` | error | The source can't be parsed |
| `exists` | error | The `.slim` file already exists and was kept: use `--force` (API: `overwrite: true`) |
| `same-output` | error | Two source files would get the same `.slim` file, like `a.ts` and `a.js`: rename one |
| `internal` | error | The converter failed on this file: please report it |
| `slim-check` | error | Slim doesn't accept the converted code |
| `namespace`, `decorator`, `merged-enum`, `accessor` | error | TypeScript with no Slim form: see [Limitations](10-limitations.md) |
| `class-component`, `react-api`, `react-context`, `react-state`, `react-effect`, `react-html`, `custom-hook`, `component-parameters`, `jsx-spread-child`, `router-api` | error | React with no Slim form; the message says what to write instead: see [React](08-react.md) |
| `computed-enum` | warning | An enum value is computed and was copied as it is |
| `local-require` | warning | A local file is required inside the code, which only works while that file stays CommonJS |
| `react-stale-read`, `react-render-code` | warning | React code that behaves differently in Slim and couldn't be rewritten |
| `unknown-node` | warning | A piece of TypeScript the converter doesn't know was left as it is |
| `utility-type`, `keyof-type`, `conditional-type`, `mapped-type`, `indexed-type`, `typeof-type`, `import-type`, `object-type`, `object-intersection`, `package-type`, `unknown-type` | note | A type became `any`: see [TypeScript](06-typescript.md) |
| `object-constraint` | note | An object-type constraint of a type parameter was dropped |
| `open-tuple` | note | A tuple with rest members became an array |
| `unknown-parent` | note | The fields of a parent interface are not known here and were left out |
| `index-signature`, `computed-field` | note | An index signature next to fields, or a field without a plain name, was dropped from a trait |
| `name-clash` | note | A type with the name of a value was dropped |
| `props-type`, `fragment`, `react-effect`, `react-stale-read`, `react-render-code`, `flush-sync`, `suspense`, `link-props` | note | React differences, and React code rewritten to behave the same: see [React](08-react.md) |
| `repair-void`, `repair-non-null`, `repair-dynamic-field`, `repair-condition`, `repair-return-type` | note | The converted code was repaired to compile |

## Exit codes

| Code | When |
|---|---|
| `0` | Nothing was reported as an error. Warnings and notes don't change the exit code |
| `1` | At least one error: a file that can't be parsed or converted, a Slim compile error, an existing `.slim` file that was kept, two files with the same output |
| `2` | A usage error, and nothing was converted: no input, an unknown option, a path that doesn't exist, `--stdout` with a folder or several files, no JavaScript or TypeScript files found, inputs with no folder in common |
