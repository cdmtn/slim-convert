import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { transform } from "@slim-lang/core"
import { convert } from "../src/index.js"
import { convertFiles } from "./helpers.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const runtime = new URL("./external/defaults.js", import.meta.resolve("@slim-lang/core")).href
const routerRuntime = new URL("./external/router.js", import.meta.resolve("@slim-lang/core")).href

const code = source => convert(source, { file: "x.jsx" }).code
const problems = (source, level = "error") => convert(source, { file: "x.jsx" }).diagnostics.filter(item => item.level === level).map(item => item.code)

function render(source, steps = "") {
    const parent = path.join(root, "dist")
    mkdirSync(parent, { recursive: true })
    const dir = mkdtempSync(path.join(parent, "slim-react-"))
    try {
        const { code: slim, diagnostics } = convert(source, { file: path.join(dir, "app.jsx") })
        assert.deepEqual(diagnostics.filter(item => item.level === "error"), [])
        const file = path.join(dir, "app.js")
        const script = `${slim}
const fire = (el, selector, type = "click") => {
    const event = el.ownerDocument.createEvent("Event")
    event.initEvent(type, true, true)
    el.querySelector(selector).dispatchEvent(event)
}
const host = App().ownerDocument.createElement("section")
host.append(App())
const show = () => log(host.innerHTML)
show()
${steps}
`
        const { code: compiled } = transform(script, path.join(dir, "app.slim"), { outFile: file, warnings: false })
        writeFileSync(file, compiled
            .replace(/"[^"]*@slim\/router\.js"/, JSON.stringify(routerRuntime))
            .replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import ${JSON.stringify(runtime)};`))
        const result = spawnSync(process.execPath, ["--no-warnings", file], { cwd: root, encoding: "utf8" })
        assert.equal(result.status, 0, `${result.stderr}\n${slim}`)
        return result.stdout.trim().split("\n")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test("useState becomes state, and setters become assignments", () => {
    const result = code(`import { useState } from "react"
function A() {
    const [count, setCount] = useState(0)
    const [name, setName] = useState(() => "a")
    const [, setHidden] = useState(false)
    setCount(1)
    setCount(c => c + 1)
    setName(prev => { return prev + "!" })
    setHidden(true)
    pass(setCount)
    return <p>{count}{name}</p>
}`)
    assert.doesNotMatch(result, /useState|react/)
    assert.match(result, /state count = 0/)
    assert.match(result, /state name = "a"/)
    assert.match(result, /state hidden = false/)
    assert.match(result, /count = 1\n/)
    assert.match(result, /count = count \+ 1/)
    assert.match(result, /name = \(prev => \{ return prev \+ "!" \}\)\(name\)/)
    assert.match(result, /hidden = true/)
    assert.match(result, /pass\(\(value => \{ count = typeof value === "function" \? value\(count\) : value \}\)\)/)
})

test("the type of useState stays", () => {
    const { code: result } = convert(`import { useState } from "react"\nfunction A() {\n    const [user, setUser] = useState<string | null>(null)\n    return <p>{user}</p>\n}`, { file: "x.tsx" })
    assert.match(result, /state user: string \| null = null/)
})

test("a parameter named like a state doesn't take its assignment", () => {
    assert.deepEqual(render(`import { useState } from "react"
function App() {
    const [value, setValue] = useState("a")
    const update = value => setValue(value + "!")
    return <p onClick={() => update("b")}>{value}</p>
}`, `fire(host, "p")\nshow()`), ["<p>a</p>", "<p>b!</p>"])
})

test("useMemo, useCallback, useRef and useReducer", () => {
    const result = code(`import { useMemo, useCallback, useRef, useReducer, useContext, memo } from "react"
const Row = memo(({ a }) => <i>{a}</i>)
function A({ size }) {
    const twice = useMemo(() => size * 2, [size])
    const text = useMemo(() => { return String(size) }, [size])
    const go = useCallback(() => log(size), [size])
    const box = useRef(null)
    const start = useRef(size)
    const [state, dispatch] = useReducer(reducer, { n: 0 })
    const theme = useContext(Theme)
    return <input ref={box} />
}`)
    assert.match(result, /component Row\(\{ a \}\) \{ return <i>\$\{a\}<\/i> \}/)
    assert.match(result, /const twice = size \* 2/)
    assert.match(result, /const text = \(\(\) => \{ return String\(size\) \}\)\(\)/)
    assert.match(result, /const go = \(\) => log\(size\)/)
    assert.match(result, /const box = \{ current: null \}/)
    assert.match(result, /const start = untrack\(\(\) => \(\{ current: size \}\)\)/)
    assert.match(result, /state state = \{ n: 0 \}/)
    assert.match(result, /const dispatch = action => \{ state = reducer\(state, action\) \}/)
    assert.match(result, /const theme = inject\(Theme\)/)
    assert.match(result, /ref=\$\{element => \{ box\.current = element \}\}/)
})

test("an effect keeps its dependencies", () => {
    const result = code(`import { useEffect, useState } from "react"
function A() {
    const [a, setA] = useState(0)
    const [b, setB] = useState(0)
    useEffect(() => { log(a) }, [a])
    useEffect(() => { log(a, b) }, [])
    useEffect(() => { log(a) }, [b])
    useEffect(() => { log("x") }, [])
    return <p />
}`)
    assert.match(result, /effect\(\(\) => \{ log\(a\) \}\)/)
    assert.match(result, /effect\(\(\) => untrack\(\(\) => \{ log\(a, b\) \}\)\)/)
    assert.match(result, /void \[b\]\n\s+return untrack\(\(\) => \{ log\(a\) \}\)/)
    assert.match(result, /effect\(\(\) => \{ log\("x"\) \}\)/)
})

test("a cleanup sees the values of its own run", () => {
    const lines = render(`import { useEffect, useState } from "react"
function App() {
    const [n, setN] = useState(0)
    useEffect(() => {
        log("start", n)
        return () => log("stop", n)
    }, [n])
    return <p onClick={() => setN(n + 1)}>{n}</p>
}`, `fire(host, "p")`)
    assert.deepEqual(lines.filter(line => line.includes("stop") || line.includes("start")).slice(-3), ["start 0", "stop 0", "start 1"])
})

test("an early return becomes a choice in the markup", () => {
    assert.deepEqual(render(`import { useState } from "react"
function App() {
    const [user, setUser] = useState(null)
    if (!user) return <button onClick={() => setUser({ name: "ada" })}>load</button>
    const { name } = user
    return <p>{name.toUpperCase()}</p>
}`, `fire(host, "button")\nshow()`), ["<button>load</button>", "<p>ADA</p>"])
})

test("a value worked out with statements stays up to date", () => {
    assert.deepEqual(render(`import { useState } from "react"
function App() {
    const [n, setN] = useState(0)
    let label = "low"
    if (n > 0) label = "high"
    let view
    if (n === 0) {
        view = <i>zero</i>
    } else {
        view = <b>{n}</b>
    }
    return <p onClick={() => setN(n + 1)}>{label}{view}</p>
}`, `fire(host, "p")\nshow()`), ["<p>low<i>zero</i></p>", "<p>high<b>1</b></p>"])
})

test("code that ran on every render runs in an effect", () => {
    assert.deepEqual(render(`import { useState } from "react"
function App() {
    const [n, setN] = useState(0)
    log("render", n)
    if (n > 1) {
        log("big")
    }
    return <p onClick={() => setN(n + 1)}>{n}</p>
}`, `fire(host, "p")\nfire(host, "p")`).filter(line => !line.startsWith("<")), ["render 0", "render 0", "render 1", "render 2", "big"])
    assert.match(code(`import { useState } from "react"
function A() {
    const [n, setN] = useState(0)
    if (n > 1) {
        log("big")
    }
    return <p>{n}</p>
}`), /effect\(\(\) => \{\n {8}if \(n > 1\) \{\n {12}log\("big"\)\n {8}\}\n {4}\}\)/)
})

test("render code that fills a local value stays, with a warning", () => {
    assert.deepEqual(problems(`import { useState } from "react"
function A({ items }) {
    const rows = []
    items.forEach(item => rows.push(<li>{item}</li>))
    return <ul>{rows}</ul>
}`, "warning"), ["react-render-code"])
})

test("a state read after its setter keeps its old value", () => {
    assert.deepEqual(render(`import { useState } from "react"
function App() {
    const [n, setN] = useState(1)
    const go = () => {
        setN(n + 1)
        setN(n + 1)
        log("old", n, { n })
    }
    return <p onClick={go}>{n}</p>
}`, `fire(host, "p")\nshow()`), ["<p>1</p>", "old 1 { n: 1 }", "<p>2</p>"])
    assert.deepEqual(problems(`import { useState } from "react"
function A() {
    const [n, setN] = useState(0)
    return <p onClick={() => { setN(n + 1); log(n) }}>{n}</p>
}`, "warning"), [])
})

test("useId, useTransition, startTransition, flushSync and useEffectEvent", () => {
    assert.deepEqual(render(`import { useId, useTransition, startTransition, useEffectEvent, useEffect, useState } from "react"
import { flushSync } from "react-dom"
function Field({ label }) {
    const id = useId()
    return <label htmlFor={id}>{label}<input id={id} /></label>
}
function App() {
    const [n, setN] = useState(0)
    const [pending, start] = useTransition()
    const report = useEffectEvent(() => log("seen", n))
    useEffect(() => { report() }, [])
    return <p onClick={() => { start(() => setN(n + 1)); startTransition(() => setN(c => c + 1)); flushSync(() => setN(c => c + 1)) }}>
        <Field label="a" /><Field label="b" />{n}{String(pending)}
    </p>
}`, `fire(host, "p")\nshow()`).filter(line => line !== "seen 0"), [
        `<p><label for=":r2:">a<input id=":r2:"></label><label for=":r3:">b<input id=":r3:"></label>0false</p>`,
        `<p><label for=":r2:">a<input id=":r2:"></label><label for=":r3:">b<input id=":r3:"></label>3false</p>`
    ])
})

test("forwardRef and useImperativeHandle hand the ref over", () => {
    assert.deepEqual(render(`import { forwardRef, useImperativeHandle, useRef, useEffect } from "react"
const Input = forwardRef(({ label }, ref) => <label>{label}<input ref={ref} /></label>)
const Counter = forwardRef(function Counter({ name }, handle) {
    useImperativeHandle(handle, () => ({ hello: () => "hello " + name }), [])
    return <b>{name}</b>
})
function App() {
    const input = useRef(null)
    const counter = useRef(null)
    useEffect(() => { log(input.current.tagName, counter.current.hello()) }, [])
    return <p><Input ref={input} label="x" /><Counter ref={counter} name="ada" /></p>
}`), ["INPUT hello ada", "INPUT hello ada", "<p><label>x<input></label><b>ada</b></p>"])
})

test("createPortal shows its content elsewhere", () => {
    const result = code(`import { createPortal } from "react-dom"
function Modal({ open }) {
    return <main>{open && createPortal(<div className="modal">hi</div>, document.body)}</main>
}`)
    assert.match(result, /\$\{open && <Portal to=\$\{document\.body\}><div class="modal">hi<\/div><\/Portal>\}/)
    assert.deepEqual(render(`import { createPortal } from "react-dom"
function App() {
    const box = <aside />
    return <p>{createPortal(<i>far</i>, box)}{box}</p>
}`), ["<p><aside><i>far</i></aside></p>"])
})

test("useSyncExternalStore follows the store", () => {
    assert.deepEqual(render(`import { useSyncExternalStore } from "react"
const listeners = new Set()
let value = 1
const store = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    set: next => { value = next; listeners.forEach(listener => listener()) }
}
function App() {
    const current = useSyncExternalStore(store.subscribe, () => value)
    return <p onClick={() => store.set(current + 1)}>{current}</p>
}`, `fire(host, "p")\nshow()`), ["<p>1</p>", "<p>2</p>"])
})

test("a context consumer reads the context", () => {
    assert.deepEqual(render(`import { createContext } from "react"
const Theme = createContext("light")
function Badge() {
    return <i><Theme.Consumer>{theme => <b>{theme}</b>}</Theme.Consumer></i>
}
function App() {
    return <Theme.Provider value="dark"><p><Badge /></p></Theme.Provider>
}`), ["<p><i><b>dark</b></i></p>"])
})

test("createElement becomes markup", () => {
    const result = code(`import { createElement } from "react"
function A({ items }) {
    return createElement("ul", { className: "list", onChange: go }, items.map(item => createElement(Row, { key: item, item })), "end")
}`)
    assert.match(result, /return <ul class="list" onChange=\$\{go\}>\$\{items\.map\(item => <Row key=\$\{item\} item=\$\{item\} \/>\)\}end<\/ul>/)
    assert.deepEqual(render(`import React from "react"
function App() {
    return React.createElement("p", { style: { width: 2 } }, React.createElement("b", null, "x"), 1)
}`), [`<p style="width: 2px"><b>x</b>1</p>`])
})

test("lazy loads a component and Suspense shows its content", async () => {
    const { results, dir } = await convertFiles({
        "page.jsx": `export default function Page({ name }) { return <b>{name}</b> }`,
        "app.jsx": `import { lazy, Suspense } from "react"
const Page = lazy(() => import("./page"))
export function App() {
    return <Suspense fallback={<i>...</i>}><Page name="ada" /></Suspense>
}`
    })
    rmSync(dir, { recursive: true, force: true })
    const app = results.find(result => result.file.endsWith("app.jsx"))
    assert.deepEqual(app.diagnostics.filter(item => item.level === "error"), [])
    assert.match(app.code, /component Page\(props\) \{\n {4}const loaded = resource\(\(\) => import\("\.\/page\.js"\)\)\n {4}return \$\{loaded\.value \? loaded\.value\.default\(props\) : null\}\n\}/)
    assert.match(app.code, /return <Page name="ada" \/>/)
})

test("React Router becomes the Slim router", () => {
    const result = code(`import { BrowserRouter, Routes, Route, Link, NavLink, useParams, useNavigate } from "react-router-dom"
function User() {
    const { id } = useParams()
    const navigate = useNavigate()
    return <button onClick={() => navigate("/")}>{id}</button>
}
export function App() {
    return <BrowserRouter>
        <NavLink to="/users/7" className="nav">Ann</NavLink>
        <Routes>
            <Route path="*" element={<Missing />} />
            <Route index element={<Home />} />
            <Route path="users/:id" element={<User />} />
        </Routes>
    </BrowserRouter>
}`)
    assert.match(result, /^use \{ route, navigate as slimNavigate, Link, Router \} from @slim\/router\n/)
    assert.match(result, /const \{ id \} = route\(\)\.params/)
    assert.match(result, /const navigate = \(to, options\) => typeof to == "number" \? history\.go\(to\) : slimNavigate\(to, options\)/)
    assert.match(result, /<Link href="\/users\/7" class="nav" active="active">Ann<\/Link>/)
    assert.match(result, /<Router routes=\$\{\{ "\/": Home, "\/users\/:id": User, "\*": Missing \}\} \/>/)
    assert.deepEqual(render(`import { Routes, Route, Link, useParams, useNavigate } from "react-router-dom"
function Home() {
    const navigate = useNavigate()
    return <button onClick={() => navigate("/users/7")}>home</button>
}
function User() {
    const { id } = useParams()
    return <b>user {id}</b>
}
function App() {
    return <div><Link to="/">home</Link><Routes><Route path="/" element={<Home />} /><Route path="/users/:id" element={<User />} /></Routes></div>
}`, `fire(host, "button")\nshow()`), [`<div><a href="/">home</a><button>home</button></div>`, `<div><a href="/">home</a><b>user 7</b></div>`])
})

test("attributes follow the DOM, props of components stay", () => {
    const result = code(`function A() {
    return <div className="a" tabIndex={1} onDoubleClick={go}>
        <label htmlFor="i">x</label>
        <input id="i" onChange={go} />
        <input type="checkbox" onChange={go} />
        <textarea onChange={go} />
        <select onChange={go} />
        <Card className="c" onChange={go} />
    </div>
}`)
    assert.match(result, /<div class="a" tabindex=\$\{1\} onDblClick=\$\{go\}>/)
    assert.match(result, /<label for="i">/)
    assert.match(result, /<input id="i" onInput=\$\{go\} \/>/)
    assert.match(result, /<input type="checkbox" onChange=\$\{go\} \/>/)
    assert.match(result, /<textarea onInput=\$\{go\} \/>/)
    assert.match(result, /<select onChange=\$\{go\} \/>/)
    assert.match(result, /<Card className="c" onChange=\$\{go\} \/>/)
})

test("style objects become text", () => {
    assert.match(code(`function A() { return <p style={{ color: "red", fontSize: 12, opacity: 0.5 }} /> }`), /style="color: red; font-size: 12px; opacity: 0\.5"/)
    assert.deepEqual(render(`import { useState } from "react"
function App() {
    const [w, setW] = useState(1)
    return <p style={{ width: w, zIndex: w }} onClick={() => setW(2)}>x</p>
}`, `fire(host, "p")\nshow()`), [`<p style="width: 1px; z-index: 1">x</p>`, `<p style="width: 2px; z-index: 2">x</p>`])
})

test("rest props reach the element, with their handlers", () => {
    assert.deepEqual(render(`import { useState } from "react"
function Button({ label, ...rest }) { return <button {...rest}>{label}</button> }
function App() {
    const [n, setN] = useState(0)
    return <Button className="big" label={"n" + n} onClick={() => setN(n + 1)} />
}`, `fire(host, "button")\nshow()`), [`<button class="big">n0</button>`, `<button class="big">n1</button>`])
})

test("a key on one element remakes it when the key changes", () => {
    assert.deepEqual(render(`import { useState } from "react"
function Box({ id }) {
    const [start] = useState(id)
    return <i>{start}</i>
}
function App() {
    const [id, setId] = useState(1)
    return <p onClick={() => setId(id + 1)}><Box key={id} id={id} /></p>
}`, `fire(host, "p")\nshow()`), ["<p><i>1</i></p>", "<p><i>2</i></p>"])
})

test("context reaches only what the provider wraps", () => {
    assert.deepEqual(render(`import { createContext, useContext, useState } from "react"
const Name = createContext("nobody")
function Show() { return <b>{useContext(Name)}</b> }
function App() {
    const [name, setName] = useState("ada")
    return <p onClick={() => setName("bob")}>
        <Show />
        <Name.Provider value={name}><Show /></Name.Provider>
    </p>
}`, `fire(host, "p")\nshow()`), ["<p><b>nobody</b><b>ada</b></p>", "<p><b>nobody</b><b>bob</b></p>"])
})

test("a provider around everything becomes provide", () => {
    const result = code(`import { createContext, useState } from "react"
const Name = createContext("x")
function App() {
    const [name, setName] = useState("a")
    return <Name.Provider value={name}><Inner /></Name.Provider>
}`)
    assert.match(result, /provide\(Name, name\)\n\s+return <Inner \/>/)
})

test("the mount call becomes an element", () => {
    const result = code(`import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
createRoot(document.getElementById("root")).render(<StrictMode><App size={1} name="a" /></StrictMode>)`)
    assert.match(result, /document\.getElementById\("root"\)\.replaceChildren\(App\(\{ size: 1, name: "a" \}\)\)/)
    assert.doesNotMatch(result, /react|StrictMode/)
})

test("an anonymous default export gets a name from its file", () => {
    const { code: result } = convert(`export default () => <p>a</p>`, { file: "user-card.jsx" })
    assert.match(result, /component Usercard\(\) \{ return <p>a<\/p> \}\nexport default Usercard/)
})

test("a custom hook keeps its state, and its arguments stay live", () => {
    assert.deepEqual(render(`import { useState } from "react"
function useCounter(step) {
    const [count, setCount] = useState(0)
    const inc = () => setCount(c => c + step)
    return { count, inc }
}
function useLabel({ text, mark = "!" } = {}) { return text + mark }
function App() {
    const [step, setStep] = useState(1)
    const { count, inc } = useCounter(step)
    const label = useLabel({ text: "n" + count })
    return <p>
        <a onClick={inc}>{count}</a>
        <b onClick={() => setStep(step + 9)}>{step}</b>
        <i>{label}</i>
    </p>
}`, `fire(host, "a")\nshow()\nfire(host, "b")\nfire(host, "a")\nshow()`), [
        "<p><a>0</a><b>1</b><i>n0!</i></p>",
        "<p><a>1</a><b>1</b><i>n1!</i></p>",
        "<p><a>11</a><b>10</b><i>n11!</i></p>"
    ])
})

test("a hook can come from another file", async () => {
    const { results, dir } = await convertFiles({
        "use-toggle.js": `import { useState } from "react"
export function useToggle(start) {
    const [on, setOn] = useState(start)
    return [on, () => setOn(!on)]
}`,
        "app.jsx": `import { useToggle } from "./use-toggle"
export default function App() {
    const [on, flip] = useToggle(false)
    return <p onClick={flip}>{String(on)}</p>
}`
    })
    rmSync(dir, { recursive: true, force: true })
    assert.deepEqual(results.flatMap(result => result.diagnostics.filter(item => item.level === "error")), [])
    const app = results.find(result => result.file.endsWith("app.jsx")).code
    assert.match(app, /const toggleResult = useToggle\(\(\) => false\)/)
    assert.match(app, /const \[on, flip\] = toggleResult\.value/)
})

test("a hook from a package is reported", () => {
    assert.deepEqual(problems(`import { useQuery } from "some-lib"\nfunction A() { const q = useQuery("a"); return <p>{q}</p> }`), ["custom-hook"])
})

test("what has no Slim form yet is reported, with what to write instead", () => {
    const messages = (source, file = "x.jsx") => convert(source, { file }).diagnostics.filter(item => item.level === "error").map(item => `${item.code}: ${item.message}`)
    assert.deepEqual(problems(`import { Component } from "react"\nclass A extends Component { render() { return <p /> } }`), ["class-component"])
    assert.match(messages(`import { Component } from "react"\nclass A extends Component { componentDidCatch() {} render() { return <p /> } }`)[0], /catchError/)
    assert.deepEqual(problems(`function A() { const a = useThing(); return <p>{a}</p> }`), ["custom-hook"])
    assert.match(messages(`import { useSelector } from "react-redux"\nfunction A() { const a = useSelector(s => s.a); return <p>{a}</p> }`)[0], /comes from "react-redux": keep the store's data in a state/)
    assert.match(messages(`import { cloneElement } from "react"\nfunction A({ c }) { return cloneElement(c, { a: 1 }) }`)[0], /react-api: "cloneElement" has no Slim form: pass the extra props/)
    assert.match(messages(`import { useOptimistic } from "react"\nfunction A({ v }) { const [o] = useOptimistic(v); return <p>{o}</p> }`)[0], /useOptimistic/)
    assert.match(messages(`import { createElement } from "react"\nfunction A({ tag }) { return createElement(tag) }`)[0], /write it as JSX/)
    assert.match(messages(`import { Navigate } from "react-router-dom"\nfunction A() { return <Navigate to="/" /> }`)[0], /router-api: "Navigate" has no Slim form: call navigate/)
    assert.match(messages(`import { Routes, Route } from "react-router-dom"\nfunction A() { return <Routes><Route path="/" element={<Page id={1} />} /></Routes> }`)[0], /a page is a component without props/)
    assert.match(messages(`import { useState } from "react"\nfunction helper() { return useState(0) }`)[0], /call it in a component, or in a function whose name starts with "use"/)
})

test("a custom hook called for its effect alone is not read for a value", () => {
    const result = code(`import { useEffect } from "react"
export const useFont = () => {
    useEffect(() => { document.title = "x" }, [])
}
export function Page() {
    useFont()
    return <p>page</p>
}
`)
    assert.match(result, /^\s*useFont\(\)$/m)
    assert.doesNotMatch(result, /useFont\(\)\.value/)
})

test("a switch whose every case returns becomes a choice that follows the state", () => {
    const output = render(`import { useState } from "react"
function Badge({ kind }) {
    switch (kind) {
        case "a":
        case "b":
            return <b>early</b>
        case "c": {
            return null
        }
        default:
            return <i>{kind}</i>
    }
}
export function App() {
    const [kind, setKind] = useState("a")
    return <div><Badge kind={kind} /><button onClick={() => setKind(kind === "a" ? "c" : "z")}>next</button></div>
}
`, `fire(host, "button")\nshow()\nfire(host, "button")\nshow()`)
    assert.equal(output.length, 3)
    assert.match(output[0], /<b>early<\/b>/)
    assert.doesNotMatch(output[1], /<b>|<i>/)
    assert.match(output[2], /<i>z<\/i>/)
})
