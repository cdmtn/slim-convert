# Command line

```text
slim-convert <file or folder>... [options]
```

`slim-convert` converts every JavaScript and TypeScript file in the files and folders you give it, writes a `.slim` file for each one, compiles the result with Slim and prints a report.

## Options

| Option | Description |
|---|---|
| `-o, --out <folder>` | Write the `.slim` files to this folder, with the same structure as the input, instead of next to the source files |
| `--stdout` | Convert one file and print the result instead of writing it. The result is not compiled |
| `--no-check` | Don't compile the result with Slim. Nothing is repaired, and Slim's errors are not reported |
| `-f, --force` | Replace `.slim` files that already exist. Without it, an existing file is kept and reported as an error |
| `-h, --help` | Show the usage text |

## Common examples

```bash
slim-convert src                  # a .slim file next to each source file
slim-convert src --out slim       # write to another folder, with the same structure
slim-convert src lib --out slim   # several inputs at once
slim-convert app.ts --stdout      # print one converted file
slim-convert src --no-check       # don't compile the result
slim-convert src --force          # convert again, replacing the .slim files
```

## Which files are converted

A file is converted when its extension is `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` or `.tsx`. Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped.

In a folder, these folders are skipped at any depth:

- `node_modules`, `coverage` and `slim-dist`;
- any folder named `build` or `dist`, not only the one at the top of the project;
- hidden folders: any folder whose name starts with `.`, like `.git` or `.cache`.

The rules apply to the folders found inside an input. A folder you name on the command line is always read, even if it is called `dist`.

When no file is found, `slim-convert` prints `No JavaScript or TypeScript files found` and exits with code 2.

## Where the files are written

Without `--out`, each `.slim` file is written next to its source file: `src/user.ts` becomes `src/user.slim`.

With `--out`, the files keep their place relative to the input. With several inputs, the place is relative to the folder that contains all of them:

```bash
slim-convert app/src/lib app/tools --out out
```

```text
out/src/lib/a.slim
out/tools/a.slim
```

Inputs with no folder in common (on different drives, for example) can't be converted together: convert them one at a time.

Only code is written. JSON, CSS, images and other files are not copied to the `--out` folder; an `import` of `./data.json` or `./styles.css` keeps its path, so copy those files next to the converted code yourself.

Two source files that would get the same `.slim` file, like `a.ts` and `a.js` in one folder, are not converted: the second one is reported with a `same-output` error.

## Existing files are kept

A `.slim` file that already exists is not replaced. The source file is reported with an `exists` error, and the exit code is 1:

```text
error: main.slim already exists and was kept: use --force to replace it
    at src/main.slim
error: user.slim already exists and was kept: use --force to replace it
    at src/user.slim

0 of 2 files converted, 2 error(s), 0 warning(s), 0 note(s)
```

Pass `--force` to replace them, for example to convert again after changing the source. Keep the `.slim` files you have edited by hand somewhere else first.

## `--stdout`

`--stdout` takes exactly one file, not a folder. The converted code goes to standard output, and the report to standard error, so the code can be redirected:

```bash
slim-convert app.ts --stdout > app.slim
```

With `--stdout` the file is converted on its own:

- the result is not compiled with Slim, so nothing is repaired and Slim's errors are not reported;
- nothing is written, and an existing `.slim` file doesn't matter;
- types are not followed into other files: an enum or an interface imported from another file is not looked up, and a `require` of a local file is converted as if that file had a default export (see [CommonJS](07-commonjs.md));
- the names that are only declared (`declare const VERSION: string`) are not listed.

A file that can't be parsed is reported with its line, and the exit code is 1:

```text
error: Unexpected token (2:0)
    at bad.ts:2:1
```

## The report

After converting a folder, `slim-convert` prints every error, then every warning, then every note, each with the file and, when there is one, the line and the column:

```text
note: the type "Options" comes from "pkg" and became "any"
    at src/run.ts:7:23
```

Then a summary, and, when they apply, two more lines: the first only when `@slim-lang/core` is not installed (and `--no-check` is not given), the second when some names were only declared:

```text
2 of 2 files converted, 0 error(s), 0 warning(s), 0 note(s)
The result was not compiled: install @slim-lang/core to check it
These names were only declared: add them to "globals" in slimconfig.json: VERSION
```

What each kind of report means, which ones have no line, and the exit codes are described in [Reports and exit codes](09-reports.md).

## Exit codes

| Code | When |
|---|---|
| `0` | Every file was converted, and nothing was reported as an error. Warnings and notes don't change the code |
| `1` | A file could not be converted or doesn't compile: a parse error, an error from the converter, a Slim compile error, an `exists` or a `same-output` error |
| `2` | A usage error: no input, an unknown option, a path that doesn't exist, `--stdout` with a folder or with several files, no source files found, inputs with no folder in common |
