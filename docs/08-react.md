# React

Function components become Slim components. A Slim component runs once and updates by itself when the state it reads changes, so what depends on a new render is rewritten.

A function is a component when its name starts with a capital letter and it returns JSX or calls React. Imports from `react`, `react-dom` and `react-dom/client` are removed.

## Hooks and APIs

| React | Slim |
|---|---|
| `const [n, setN] = useState(0)` | `state n = 0` |
| `setN(n + 1)`, `setN(v => v + 1)` | `n = n + 1` |
| `useMemo(() => x, deps)`, `useCallback(fn, deps)`, `memo(C)` | `x`, `fn`, `C` |
| `useRef(v)` | `{ current: v }` |
| `useReducer(reducer, start)` | a `state` and a `dispatch` function |
| `useContext(C)`, `<C.Provider value={v}>` | `inject(C)`, `provide(C, v)` |
| `useEffect(fn, deps)`, `useLayoutEffect(fn, deps)` | `effect`, with `untrack` when `deps` differ from what `fn` reads |
| `if (x) return <A />` | `return ${x ? <A /> : ...}` |
| a `switch` at the end whose every case returns | `return ${kind === "a" ? <A /> : kind === "b" ? <B /> : ...}` |
| `let a = 1; if (x) a = 2` | a `const` worked out in one function |
| `function useThing(a) { ... }` | a `use...` function with `state`; its arguments and result are wrapped to stay live |
| `createRoot(el).render(<App />)` | `el.replaceChildren(App())` |
| `<Fragment>`, `<StrictMode>`, `<Profiler>` | their children |
| `forwardRef((props, ref) => ...)` | a component that reads `ref` from its props; the props type is dropped, with a `props-type` note |
| `useImperativeHandle(ref, () => api)` | `setRef(ref, api)`, with a `setRef` helper added to the file |
| `createPortal(content, el)` | `<Portal to=${el}>content</Portal>` |
| `useId()` | `nextId()`, with a helper added to the file |
| `useSyncExternalStore(subscribe, get)` | `state value = get()` and an `effect` that subscribes |
| `useTransition()`, `startTransition(fn)` | `[false, fn => fn()]`, `fn()`: Slim updates the page right away |
| `flushSync(fn)` | `fn()`, with a `flush-sync` note: inside an event handler the page is updated when the handler ends |
| `useEffectEvent(fn)` | `(...args) => untrack(() => fn(...args))` |
| `<C.Consumer>{value => ...}</C.Consumer>` | `${(value => ...)(inject(C))}` |
| `createElement("div", props, ...children)` | `<div ...>...</div>`, when the tag is text or a component name |
| `const Page = lazy(() => import("./Page"))` | a `Page` component that loads the module with `resource` |
| `<Suspense>` | its children, with a `suspense` note: the fallback isn't shown |

## JSX

| React | Slim |
|---|---|
| `attribute={value}`, `{value}` | `attribute=${value}`, `${value}` |
| `className`, `htmlFor`, `tabIndex`, `onDoubleClick` | `class`, `for`, `tabindex`, `onDblClick` |
| `readOnly`, `maxLength`, `autoComplete`, `colSpan`, `strokeWidth` and other DOM and SVG names | `readonly`, `maxlength`, `autocomplete`, `colspan`, `stroke-width` |
| `defaultValue`, `defaultChecked` | `value`, `checked` |
| `onChange` on a text input or a `<textarea>` | `onInput` (it stays `onChange` on a checkbox, a radio button and a file input) |
| `style={{ fontSize: 12, opacity: 0.5 }}` | `style="font-size: 12px; opacity: 0.5"` |
| `style={styles}` | `style=${styleText(styles)}`, with a `styleText` helper added to the file |
| `dangerouslySetInnerHTML={{ __html: html }}` | `${raw(html)}` as the content |
| `ref={inputRef}`, where `inputRef` comes from `useRef` | `ref=${element => { inputRef.current = element }}` |
| `key` outside a list | a list of one, so the element is made again when the key changes |
| a fragment with several children | `<div style="display: contents">`, with a `fragment` note |
| a context provider that is not the root of a component | a `ContextProvider` component added to the file |

## An example

```js
import { useState, useEffect, useMemo, useRef } from "react"

export function Counter({ start }) {
    const [count, setCount] = useState(start)
    const double = useMemo(() => count * 2, [count])
    const input = useRef(null)

    useEffect(() => {
        document.title = `Count: ${count}`
    }, [count])

    return (
        <div className="counter">
            <input ref={input} onChange={e => setCount(Number(e.target.value))} />
            <button onClick={() => setCount(c => c + 1)}>{count} / {double}</button>
        </div>
    )
}
```

becomes:

```js
export component Counter({ start }) {
    state count = start
    const double = count * 2
    const input = { current: null }

    effect(() => {
        document.title = `Count: ${count}`
    })

    return <div class="counter">
            <input ref=${element => { input.current = element }} onInput=${e => count = Number(e.target.value)} />
            <button onClick=${() => count = count + 1}>${count} / ${double}</button>
        </div>
}
```

Context, a reducer, an early return and the root:

```js
import { createContext, useContext, useReducer } from "react"
import { createRoot } from "react-dom/client"

const Theme = createContext("light")

function reducer(state, action) {
    return action === "add" ? state + 1 : state
}

function Label({ text }) {
    const theme = useContext(Theme)
    return <span className={theme} style={{ fontSize: 12, opacity: 0.5 }}>{text}</span>
}

function App({ loading }) {
    const [total, dispatch] = useReducer(reducer, 0)
    if (loading) return <p>Loading</p>
    return (
        <Theme.Provider value="dark">
            <>
                <Label text={total} />
                <button onDoubleClick={() => dispatch("add")}>Add</button>
            </>
        </Theme.Provider>
    )
}

createRoot(document.getElementById("root")).render(<App />)
```

becomes:

```js
const Theme = createContext("light")

func reducer(state, action) {
    return action === "add" ? state + 1 : state
}

component Label({ text }) {
    const theme = inject(Theme)
    return <span class=${theme} style="font-size: 12px; opacity: 0.5">${text}</span>
}

component App({ loading }) {
    state total = 0
    const dispatch = action => { total = reducer(total, action) }
    provide(Theme, "dark")
    return ${loading ? <p>Loading</p> : <div style="display: contents">
                <Label text=${total} />
                <button onDblClick=${() => dispatch("add")}>Add</button>
            </div>}
}

document.getElementById("root").replaceChildren(App())
```

Both results compile with Slim.

## Props

Destructured props stay destructured. Their TypeScript type is dropped, with a `props-type` note, because Slim can't annotate the pattern; props that are not destructured keep their type:

```ts
interface CardProps {
    title: string
    done?: boolean
}

export function Card({ title, done }: CardProps) {
    return <h2>{done ? "Done: " : ""}{title}</h2>
}

export const Badge = (props: { label: string }) => <b>{props.label}</b>
```

becomes:

```js
trait Props {
    label: string
}

trait CardProps {
    title: string
    done?: bool
}

export component Card({ title, done }) {
    return <h2>${done ? "Done: " : ""}${title}</h2>
}

export component Badge(props: Props) { return <b>${props.label}</b> }
```

A component takes one props object: a second parameter is a `component-parameters` error, except the `ref` of `forwardRef`.

## React Router

`react-router` and `react-router-dom` become `@slim/router`, a module of Slim:

| React Router | Slim |
|---|---|
| `<BrowserRouter>` | its children |
| `<Routes><Route path="users/:id" element={<User />} /></Routes>` | `<Router routes=${{ "/users/:id": User }} />` |
| `<Route index element={<Home />} />`, `<Route path="*" ...>` | the routes `"/"` and `"*"`; `"*"` goes last |
| `<Link to="/a">`, `<NavLink to="/a">` | `<Link href="/a">`, `<Link href="/a" active="active">` |
| `useParams()` | `route().params` |
| `useNavigate()` | a function that calls `navigate`, or `history.go` for a number |
| `useLocation()`, `useSearchParams()` | `routeLocation()`, `searchParams()`, with helpers added to the file |

A page is a component without props, so `element` has to be like `<User />`. A Slim `<Link>` takes only `href`, `class`, `active`, `target` and `replace`: other props are dropped with a `link-props` note.

```js
import { BrowserRouter, Routes, Route, Link, useParams } from "react-router-dom"

function User() {
    const { id } = useParams()
    return <h1>User {id}</h1>
}

export function App() {
    return <BrowserRouter>
        <Routes>
            <Route index element={<Home />} />
            <Route path="users/:id" element={<User />} />
        </Routes>
    </BrowserRouter>
}
```

becomes:

```js
use { route, Router } from @slim/router

component User() {
    const { id } = route().params
    return <h1>User ${id}</h1>
}

export component App() {
    return <Router routes=${{ "/": Home, "/users/:id": User }} />
}
```

## Rewritten to behave the same

A component runs once in Slim, so two things that depended on a new render are rewritten, each with a note:

- a state read after its setter in the same function keeps the value it had before, as in React: `setN(n + 1); log(n)` becomes `const oldN = n` at the start of the function, then `n = n + 1; log(oldN)` (`react-stale-read`);
- code at the top of a component that reads a state, like `console.log(n)` or `document.title = n`, moves into an `effect`, so it runs again when the state changes (`react-render-code`).

When this can't be done, the same codes are warnings: an arrow function without braces keeps the new value, and code that fills or changes a local value of the component (`rows.push(...)`) stays where it is, because an effect would run after the markup is built.

## Reported as errors

These stay as they are, and the message says what to write instead:

| React | What to write in Slim |
|---|---|
| a class component | a function component; an error boundary becomes `catchError(() => content, (error, reset) => fallback)` |
| `useOptimistic` | a state set before the request starts, or the `value` of a `resource` |
| `useActionState`, `useFormStatus` | states for the result and a pending flag, set in the submit handler |
| `cloneElement`, `isValidElement`, `Children` | `children` used directly: a Slim element is a DOM node |
| `createElement(tag)` with a tag in a variable | JSX |
| a hook from a package (`custom-hook`) | `state` and `effect`; for Redux, a state at the top of a module; for React Query and SWR, `resource` |
| a React hook in a function that is neither a component nor a `use...` function (`custom-hook`) | the same code in a component, or a function renamed to `use...` |
| `<Navigate>`, `<Outlet>`, nested `<Route>`, `useMatch`, `useRoutes`, `HashRouter` (`router-api`) | `navigate(...)` in an effect; one `<Routes>` with full paths; `route().path` |

## Other differences

- `{n && <A />}` with `n` equal to `0` shows nothing, while React shows `0`.
- An effect without dependencies runs again when what it reads changes, not after every render (a `react-effect` note).
- A fragment with several children becomes a `<div style="display: contents">`.
- A lazy component shows nothing until its module loads: the fallback of `Suspense` isn't shown.
- A function inside a component sees the current value of a state, not the value of the render it was made in.
