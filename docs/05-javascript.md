# JavaScript

Most JavaScript is already Slim. The converter changes function declarations, local imports and file extensions, and leaves the rest of the code as it is.

| JavaScript | Slim |
|---|---|
| `function f(a) { ... }` | `func f(a) { ... }` |
| `async function f() { ... }`, `function* f() { ... }` | `async func f() { ... }`, `func* f() { ... }` |
| `const f = function () { ... }`, `export default function () { ... }` | unchanged: only function declarations become `func` |
| `import x from "./a.js"`, `import { y } from "./a.ts"` | `use x from "./a"`, `use { y } from "./a"` |
| `import x, { y } from "./a.js"` | `use x from "./a"` and `use { y } from "./a"` on two lines |
| `import "./setup.ts"` | `import "./setup.js"` |
| `export { x } from "./a.ts"`, `export * from "./a.mjs"` | `export { x } from "./a.js"`, `export * from "./a.js"` |
| `export * as ns from "./a.js"` | `use * as ns from "./a"` and `export { ns }` |
| `export * as ns from "pkg"` | `import * as ns from "pkg"` and `export { ns }` |
| `import x from "pkg"`, `import fs from "node:fs"` | unchanged |
| `import data from "./data.json" with { type: "json" }`, `import "./styles.css"` | unchanged: only code files change their path |
| JSX, a capitalized function that returns it | Slim markup, `component` (see [React](08-react.md)) |
| `require`, `module.exports`, `exports.x`, `__dirname` | see [CommonJS](07-commonjs.md) |

## Modules

A local import (a path that starts with `./` or `../` and points to code) becomes `use`, without the file extension: the converted file is a `.slim` file, and `use` finds it. Imports from packages and Node built-in modules stay `import`.

Statements that load a module without naming its exports (`import "./x"`, `export ... from "./x"`) keep `import` and `export`, and point to the compiled `.js` file.

```js
import "./setup.ts"
import data from "./data.json" with { type: "json" }
import { format } from "./format.mjs"
import * as path from "node:path"
import def, { named } from "../lib/index.js"
export { format } from "./format.mjs"
export * from "./all.js"
export * as tools from "./tools/index.js"
```

becomes:

```js
import "./setup.js"
import data from "./data.json" with { type: "json" }
use { format } from "./format"
import * as path from "node:path"
use def from "../lib/index"
use { named } from "../lib/index"
export { format } from "./format.js"
export * from "./all.js"
use * as tools from "./tools/index"
export { tools }
```

With [`convertProject`](04-api.md) and the command line, a local path is resolved against the converted files, so `"./utils"` that means `./utils/index.ts` becomes `"./utils/index"`.

In a JavaScript file every import is kept. In a TypeScript file, an import from a package that is only used as a type is removed (see [TypeScript](06-typescript.md)).

## Functions

```js
export function* ids() {
    yield 1
}

export const double = function (n) {
    return n * 2
}
```

becomes:

```js
export func* ids() {
    yield 1
}

export const double = function (n) {
    return n * 2
}
```

## Other changes

- A statement that starts with `or(` or `and[` (a call of a function named `or`, for example) gets a `;` in front, because Slim would read it as the `or` or `and` operator continuing the line above.
- A file with only CRLF line endings gives a `.slim` file with CRLF line endings, including the lines the converter adds. In any other file the endings are left as they are, and added lines end with LF.
- Comments, blank lines and indentation stay as they were.
