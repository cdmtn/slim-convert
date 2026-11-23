# Slim Convert Documentation

`@slim-lang/convert` converts JavaScript and TypeScript to [Slim](https://github.com/cdmtn/slim-lang). It changes only what has to change, so your formatting and comments stay, and the result keeps the behaviour of the original code: an `interface` becomes a `trait`, but an `enum` stays a plain object, because a Slim enum value is not a number or a string.

```ts
interface User {
    name: string
    age?: number
}

enum Role { Admin, Guest }

export function greet(user: User, role: Role): string {
    return `Hello, ${user.name}!`
}
```

becomes:

```js
trait User {
    name: string
    age?: number
}

const Role = Object.freeze({ Admin: 0, Guest: 1, 0: "Admin", 1: "Guest" })

export func greet(user: User, role: number) -> string {
    return `Hello, ${user.name}!`
}
```

The converter works on whole folders: each `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` file gets a `.slim` file, types are followed between files, and the result is compiled with Slim when `@slim-lang/core` is installed. What Slim refuses and can be fixed without changing what the code does is fixed; everything else is reported with the file and, where there is one, the line.

## Getting started

- [What is Slim Convert?](01-start.md): what the converter does, what it keeps, and the usual workflow
- [Installation](02-installation.md): requirements and installing the CLI

## Using it

- [Command line](03-cli.md): `slim-convert`, every flag, where files are written and which folders are skipped
- [JavaScript API](04-api.md): `convert`, `convertProject` and `checkSlim`
- [Reports and exit codes](09-reports.md): errors, warnings and notes, what is repaired after converting, and exit codes

## What is converted

- [JavaScript](05-javascript.md): functions, modules, imports and exports
- [TypeScript](06-typescript.md): types, interfaces, enums, classes and generics
- [CommonJS](07-commonjs.md): `require`, `module.exports`, `exports`, `__dirname`
- [React](08-react.md): components, hooks, JSX attributes and what changes at runtime
- [Limitations](10-limitations.md): what can't be converted, and what behaves differently in Slim
