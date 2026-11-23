# Installation

Before installation, make sure you have the following:

| Name | Version | Why |
|---|---|---|
| Node.js | 22.12+ | runs the converter (`engines` in `package.json`) |
| `@slim-lang/core` | 1.2.16 or newer (`>=1.2.16`) | optional: compiles the result, so Slim's errors are reported and the ones that can be fixed are repaired |

## NPM installation

Install both packages in the project you are converting:

```bash
npm i -D @slim-lang/convert @slim-lang/core
npx slim-convert --help
```

`@slim-lang/core` is an optional peer dependency. Without it, the files are still converted, but they are not compiled, and the report ends with:

```text
The result was not compiled: install @slim-lang/core to check it
```

To have `slim-convert` everywhere, install it globally:

```bash
npm i -g @slim-lang/convert @slim-lang/core
slim-convert --help
```

## Checking the installation

```bash
npx slim-convert --help
```

```text
Usage: slim-convert <file or folder>... [options]

Converts JavaScript and TypeScript to Slim. Each file gets a .slim file next to it.

Options:
  -o, --out <folder>   write the .slim files to this folder
      --stdout         print one converted file instead of writing it
      --no-check       don't compile the result with Slim
  -f, --force          replace .slim files that already exist
  -h, --help           show this text
```

## A first conversion

```bash
npx slim-convert src
```

```text
2 of 2 files converted, 0 error(s), 0 warning(s), 0 note(s)
```

Each source file in `src` now has a `.slim` file next to it. Set up the Slim project itself (`slimconfig.json`, the entry file) as described in the [Slim installation guide](https://github.com/cdmtn/slim-lang), then build it with `slmc build`.

Next: every [command-line option](03-cli.md), or the [JavaScript API](04-api.md).
