# What is Slim Convert?

Slim Convert (`@slim-lang/convert`, command `slim-convert`) moves an existing JavaScript or TypeScript code base to Slim. It reads each source file, rewrites the parts that are written differently in Slim, and writes a `.slim` file.

## What it changes, and what it keeps

The converter edits the source text instead of printing a new file from a syntax tree. Only the code that has to change is touched: indentation, blank lines, quotes and comments stay where they were, so the result reads like your code and a diff against the original is short.

The goal is the same behaviour, not the most idiomatic Slim. Two examples:

- an `interface` becomes a `trait`, because both describe the shape of an object;
- an `enum` stays a frozen object with the same values and the same reverse mapping, because a Slim `enum` value is not a number or a string, and code that compares, stores or sends those values would break.

Slim checks types when the code runs, and TypeScript doesn't. A TypeScript type that Slim can't describe exactly (`Partial<T>`, `keyof T`, a mapped type) becomes `any` with a note, so the converted code doesn't refuse values that the original accepted.

## A first look

```ts
class Circle {
    constructor(private radius: number) {}

    public area(): number {
        return Math.PI * this.radius ** 2
    }
}
```

becomes:

```js
class Circle {
    radius: number
    constructor(radius: number) { this.radius = radius }

    area() -> number {
        return Math.PI * this.radius ** 2
    }
}
```

## The usual workflow

1. Install the converter and `@slim-lang/core` (see [Installation](02-installation.md)).
2. Convert a folder: `npx slim-convert src`. Each source file gets a `.slim` file next to it, or under the folder given with `--out`.
3. Read the report. Errors are what the converter or Slim can't accept, warnings are places where the behaviour may differ, and notes list what was simplified or repaired (see [Reports and exit codes](09-reports.md)).
4. Fix the errors in the source or in the `.slim` files, and add the names listed as "only declared" to `globals` in `slimconfig.json`.
5. To convert again after changing the source, pass `--force`: existing `.slim` files are kept otherwise.

## What is converted

- [JavaScript](05-javascript.md): `function` becomes `func`, local imports become `use`, file extensions are adjusted;
- [TypeScript](06-typescript.md): types, interfaces, enums, classes, generics, overloads and declarations;
- [CommonJS](07-commonjs.md): `require` and `module.exports` become imports and exports;
- [React](08-react.md): function components become Slim components, hooks become `state`, `effect`, `inject` and `provide`.

What can't be converted is listed in [Limitations](10-limitations.md).
