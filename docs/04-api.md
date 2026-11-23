# JavaScript API

The package exports three functions:

```js
import { convert, convertProject, checkSlim } from "@slim-lang/convert"
```

| Function | What it does |
|---|---|
| `convert(source, options)` | Converts the text of one file. Doesn't read or write files, and doesn't compile the result |
| `convertProject(entries, options)` | Converts files and folders, follows types between files, writes the `.slim` files and compiles them |
| `checkSlim(code, file, options)` | Compiles Slim code and returns Slim's errors |

## `convert`

```js
import { convert } from "@slim-lang/convert"

const { code, diagnostics, globals } = convert("let ok: boolean = true\ndeclare const VERSION: string\n", { file: "app.ts" })
// code: "let ok: bool = true\n"
// diagnostics: []
// globals: ["VERSION"]
```

| Option | Default | Description |
|---|---|---|
| `file` | `"input.ts"` | The name of the file. Its extension picks the parser (`.ts`, `.tsx`, `.js`, `.jsx` and the others), and it is used to name a default-exported component without a name |

It returns:

| Field | Description |
|---|---|
| `code` | The Slim code. A source with only CRLF line endings gives CRLF output |
| `diagnostics` | The reports, see Diagnostics below |
| `globals` | The names that were only declared (`declare const`, `declare function`, `declare class`): add them to `globals` in `slimconfig.json` |

A source that can't be parsed throws a `SyntaxError` with a `loc` field (`{ line, column }`, the column counted from 0).

`convert` sees one file. An enum or an interface imported from another file is not looked up, and a `require` of a local file is converted as if that file had a default export. Use `convertProject` for anything with more than one file.

## `convertProject`

```js
import { convertProject } from "@slim-lang/convert"

const { results, globals, checked } = await convertProject("src", { outDir: "slim" })
```

`entries` is a path or an array of paths, to files or folders. Folders are read the way the [command line](03-cli.md) reads them. A path that doesn't exist throws an error, and so do entries with no folder in common.

`convertProject` also follows types between files: an interface that extends one from another file, an enum used as a type in another file, the default type arguments of a generic type from another file, and how a CommonJS module is required.

| Option | Default | Description |
|---|---|---|
| `outDir` | `root` | The folder the `.slim` files are written to, with the same structure as under `root` |
| `root` | the folder that contains every entry | The folder the output paths are relative to |
| `overwrite` | `false` | Replace `.slim` files that already exist. When it is `false`, an existing file is kept and its source gets an `exists` error |
| `check` | `true` | Compile the result with Slim, repair what can be repaired and report the rest. `false` skips it |
| `transform` | `transform` from `@slim-lang/core` | The Slim compiler to check with. When it is not given and `@slim-lang/core` is not installed, nothing is checked |
| `globals` | `[]` | More names for the check to accept as globals, next to the ones found in `declare` statements |

It returns:

| Field | Description |
|---|---|
| `results` | One item per source file: `file` (the source path), `output` (the `.slim` path), `code` (the Slim code, or `null` when the file was not converted) and `diagnostics` |
| `globals` | Every name that was only declared, from every file, plus the `globals` option |
| `checked` | `true` when at least one file was compiled with Slim |
| `compiler` | `true` when a Slim compiler was found (the `transform` option or `@slim-lang/core`), even if no file was written; `false` with `check: false` |

The `.slim` files are written before they are checked; when a repair changes the code, the file is written again, and `code` holds the repaired version.

## `checkSlim`

```js
import { checkSlim } from "@slim-lang/convert"

const { available, errors } = await checkSlim("let x: int = 1.5", "x.slim")
// available: true
// errors: [{ message: '"x" expects int, got float', line: 1, column: 14, ... }]
```

| Option | Default | Description |
|---|---|---|
| `transform` | `transform` from `@slim-lang/core` | The Slim compiler |
| `globals` | `[]` | Names to accept as globals |

`available` is `false` when no compiler was given and `@slim-lang/core` is not installed; `errors` is then empty. Each error has `message`, `line` and `column`; a syntax error that has no place has `line` and `column` set to `null`.

## Diagnostics

Every item of `diagnostics` has these fields:

| Field | Description |
|---|---|
| `level` | `"error"`, `"warning"` or `"note"` |
| `code` | What was reported, for example `utility-type`, `exists` or `slim-check`; see [Reports and exit codes](09-reports.md) |
| `message` | A sentence that says what happened and what to do |
| `line`, `column` | Where, counted from 1, or `null` when the report is not about one place |
| `file` | Only on reports about the `.slim` file: the path of that file. The other reports are about the source file of the result |

`line` and `column` point into the `.slim` file when `file` is set (Slim compile errors and repair notes), and into the source file otherwise. Reports with no line: `same-output`, `exists`, `internal` and some notes, like `open-tuple`. Repair notes have a line but no column.
