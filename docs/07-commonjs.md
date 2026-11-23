# CommonJS

A CommonJS file (one that uses `require`, `module`, `exports`, `__dirname` or `__filename`, and has no `import` or `export`) becomes an ES module.

| CommonJS | Slim |
|---|---|
| `const fs = require("fs")` | `import fs from "fs"` |
| `const { join } = require("path")` | `import { join } from "path"` (for Node built-in modules) |
| `const { a } = require("pkg")` | `import pkgModule from "pkg"` and `const { a } = pkgModule` |
| `const a = require("pkg").a` | `import pkgModule from "pkg"` and `const a = pkgModule.a` |
| `const config = require("./config.json")` | `import config from "./config.json" with { type: "json" }` |
| `const helper = require("./helper")` | `use helper from "./helper"`, or `use * as helper` when `./helper` is an ES module |
| `const { a, b } = require("./helper")` | `use { a, b } from "./helper"` |
| `require("./setup")` | `import "./setup.js"` |
| `module.exports = value` | `export default value` |
| `module.exports = { a, b: c }` | `export { a, c as b }` and `export default { a, b: c }` |
| `exports.a = value` | `export const a = value`, and `export default { a, ... }` at the end |
| `exports.a` read in the code | `a` |
| `__dirname`, `__filename` | `import.meta.dirname`, `import.meta.filename` |
| `require.main === module` | `process.argv[1] === import.meta.filename` |
| `require(...)` inside the code | kept, with `const require = createRequire(import.meta.url)` at the top |

```js
const fs = require("fs")
const { join } = require("path")
const config = require("./config.json")
const lodash = require("lodash")
const { helper } = require("./helper")

function read(name) {
    return fs.readFileSync(join(__dirname, name), "utf8")
}

module.exports = { read, version: config.version }
```

becomes:

```js
import fs from "fs"
import { join } from "path"
import config from "./config.json" with { type: "json" }
import lodash from "lodash"
use { helper } from "./helper"

func read(name) {
    return fs.readFileSync(join(import.meta.dirname, name), "utf8")
}

export const version = config.version
export { read }
export default { read, version }
```

## `exports.x`

```js
exports.add = (a, b) => a + b
exports.twice = n => exports.add(n, n)

if (require.main === module) {
    const extra = require("./extra")
    console.log(exports.twice(2), __filename)
}
```

becomes:

```js
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
export const add = (a, b) => a + b
export const twice = n => add(n, n)

if (process.argv[1] === import.meta.filename) {
    const extra = require("./extra")
    console.log(twice(2), import.meta.filename)
}

export default { add, twice }
```

with a `local-require` warning: `"./extra" is required inside the code: this works only for a module that stays CommonJS`. Once `./extra` is converted too, change that `require` to a `use` at the top of the file, or to a dynamic `import()`.

## Requiring files of the project

How a local file is required depends on what that file exports, so `convertProject` and the command line look at it:

- a file that is an ES module: `const m = require("./esm")` becomes `use * as m from "./esm"`;
- a file that only sets `module.exports = value`, or that exports in a way an `export` can't describe: `const { get } = require("./store")` becomes `use storeModule from "./store"` and `const { get } = storeModule`;
- a file with named exports: `const { add } = require("./math")` becomes `use { add } from "./math"`.

```js
const Store = require("./store")
const { add } = require("./math")
const esm = require("./esm.mjs")
const { get } = require("./store")
```

becomes, when `store.js` sets `module.exports = Store`, `math.js` sets `exports.add` and `esm.mjs` is an ES module:

```js
use Store from "./store"
use { add } from "./math"
use * as esm from "./esm"
use storeModule from "./store"
const { get } = storeModule
```

With `convert` or `--stdout`, the other files are not read, and a required file is treated as a CommonJS file with a default export.

## Exports an `export` can't describe

CommonJS code that uses `exports` in a way an `export` can't describe (`exports = module.exports = fn`, `Object.defineProperty(exports, ...)`, `exports` passed to a function, the same `exports.x` set twice) keeps working: the file gets a local `module` object and exports it as default.

```js
function create() {
    return {}
}

exports = module.exports = create
Object.defineProperty(exports, "version", { value: "1.0" })
```

becomes:

```js
const module = { exports: {} }
let exports = module.exports
func create() {
    return {}
}

exports = module.exports = create
Object.defineProperty(exports, "version", { value: "1.0" })

export default module.exports
```

A file that declares its own `module`, `exports` or `require` variable is not treated as CommonJS.
