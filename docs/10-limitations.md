# Limitations

## What can't be converted

These are reported as errors, and the code stays as it is:

- `namespace`: move it to its own file;
- decorators: apply them by hand after the class;
- an enum declared twice: merge its members by hand;
- an `accessor` field without a plain name, like `accessor [key] = 1`: write a getter and a setter;
- the parts of React listed in [React](08-react.md): class components, `cloneElement`, `Children`, `useOptimistic`, nested routes, hooks from packages other than React Router, and others.

## What becomes `any`

These become `any`, with a note: `Partial`, `Pick`, `Omit` and the other utility types, `keyof`, conditional and mapped types, indexed access, `typeof` in a type, `import()` types, intersections with an object type, qualified names that can't be resolved (`NodeJS.Timeout`), and types from npm packages. See [TypeScript](06-typescript.md) for the full list.

Some types lose part of their meaning:

- a tuple with rest members becomes an array of the union of its members;
- an object-type constraint of a type parameter (`T extends { id: number }`) is dropped;
- the parent of an interface that comes from a package, or from a file the converter didn't read, is left out of the trait;
- the type of destructured component props is dropped, and so is the props type of a `forwardRef` component.

## Not converted

- JSON, CSS, images and other files are not copied to the `--out` folder.
- `--stdout` and `convert` see one file: types and CommonJS exports of other files are not looked up, and the result is not compiled.
- Comments inside a type that is rewritten are kept, but moved after the new type as block comments: `let c: string | /* none */ null` becomes `let c: string | null /* none */`.

## What behaves differently

Slim checks types when the code runs, and TypeScript doesn't. A value that doesn't fit its annotation (a wrong cast, an API that returns something else) ran quietly before and throws now. `number` doesn't accept `NaN`, and `number[]` doesn't accept an array with holes.

A Slim object type is exact, which is why an intersection with an object type becomes `any`, and why a trait is used for interfaces: a trait accepts objects with more fields.

In React code, a component runs once instead of on every render; see [React](08-react.md) for what changes.
