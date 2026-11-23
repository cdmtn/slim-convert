# @slim-lang/convert

Converts JavaScript and TypeScript to [Slim](https://github.com/cdmtn/slim-lang). It changes only what has to change, so your formatting and comments stay, and the result keeps the behaviour of the original code: `interface` becomes `trait`, but an `enum` stays a plain object, because a Slim enum value is not a number or a string.

## Install

Requires Node.js 22.12+. `@slim-lang/core` (`>=1.2.16`) is an optional peer dependency: with it, the result is compiled, Slim's errors are reported, and the ones that can be fixed without changing behaviour are repaired.

```bash
npm i -D @slim-lang/convert @slim-lang/core
```

## Quick example

`src/user.ts`, one of two files in `src`:

```ts
export interface User {
    name: string
    age?: number
}

export function greet(user: User): string {
    return `Hello, ${user.name}!`
}
```

```bash
npx slim-convert src
```

```text
2 of 2 files converted, 0 error(s), 0 warning(s), 0 note(s)
```

`src/user.slim`:

```js
export trait User {
    name: string
    age?: number
}

export func greet(user: User) -> string {
    return `Hello, ${user.name}!`
}
```

Each `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` file gets a `.slim` file next to it. `.d.ts` files, `node_modules`, `coverage`, `slim-dist`, hidden folders and any folder named `build` or `dist` are skipped.

## Options

```text
-o, --out <folder>   write the .slim files to this folder
    --stdout         print one converted file instead of writing it (not compiled)
    --no-check       don't compile the result with Slim
-f, --force          replace .slim files that already exist
-h, --help           show this text
```

Existing `.slim` files are kept unless you pass `--force`. The exit code is 0 when nothing is reported as an error, 1 for conversion or compile errors, and 2 for usage errors and missing paths.

## From code

```js
import { convert, convertProject, checkSlim } from "@slim-lang/convert"

const { code, diagnostics, globals } = convert(source, { file: "app.ts" })
const { results, checked } = await convertProject("src", { outDir: "slim", overwrite: true })
```

## Documentation

The full documentation is in [docs/index.md](docs/index.md):

- [Command line](docs/03-cli.md): every flag, output paths, skipped folders, `--stdout`
- [JavaScript API](docs/04-api.md): `convert`, `convertProject`, `checkSlim` and the diagnostic fields
- [JavaScript](docs/05-javascript.md), [TypeScript](docs/06-typescript.md), [CommonJS](docs/07-commonjs.md) and [React](docs/08-react.md): what is converted, with examples
- [Reports and exit codes](docs/09-reports.md): errors, warnings, notes, and the repairs made after converting
- [Limitations](docs/10-limitations.md): what can't be converted and what behaves differently
