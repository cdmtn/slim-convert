import { attribute } from "./jsx.js"

const ROUTER_MODULES = new Set(["react-router", "react-router-dom"])

const HINTS = {
    HashRouter: "the Slim router follows the path, not the hash: use paths in the address",
    MemoryRouter: "the Slim router follows the address of the page: pass the path to <Router url=...> instead",
    StaticRouter: "pass the path of the request to <Router url=...> instead",
    Navigate: "call navigate(to) in an effect, or in the handler that decides to leave the page",
    Outlet: "give every page its full path in one <Routes>: the Slim router has no nested routes",
    Route: "put it straight inside <Routes>",
    useMatch: "compare route().path yourself, or match it with matchRoute(pattern, route().path) from @slim/router",
    useRoutes: "write the routes as <Routes> with one <Route> per page",
    useOutlet: "give every page its full path in one <Routes>: the Slim router has no nested routes",
    useOutletContext: "pass the value as a prop, or with provide and inject"
}

const SLIM_NAMES = { Router: "Router", Link: "Link", navigate: "navigate", route: "route" }

const LINK_PROPS = new Set(["href", "class", "active", "target", "replace", "children"])
const DROPPED_PROPS = new Set(["state", "preventScrollReset", "relative", "viewTransition", "discover", "prefetch", "reloadDocument", "end", "caseSensitive"])

export const isRouterModule = source => ROUTER_MODULES.has(source)

function routerName(converter, local) {
    const imported = converter.imports.get(local)
    return imported && isRouterModule(imported.source) ? imported.imported : null
}

function slimName(converter, name) {
    converter.router ??= new Map()
    const known = converter.router.get(name)
    if (known) return known
    const taken = alias => {
        const imported = converter.imports.get(alias)
        if (imported) return !isRouterModule(imported.source)
        return converter.valueNames.has(alias) || [...converter.router.values()].includes(alias)
    }
    const base = SLIM_NAMES[name]
    let alias = base
    const prefixed = `slim${base[0].toUpperCase()}${base.slice(1)}`
    for (let index = 1; taken(alias); index++) alias = index === 1 ? prefixed : `${prefixed}${index}`
    converter.router.set(name, alias)
    return alias
}

const routerError = (converter, name, node) =>
    converter.report("error", "router-api", `"${name}" has no Slim form${HINTS[name] ? `: ${HINTS[name]}` : ": rewrite this by hand"}`, node)

function locationHelper(converter) {
    const route = slimName(converter, "route")
    converter.useHelper("routeLocation", `const routeLocation = () => {
    const { path, query } = ${route}()
    const search = new URLSearchParams(query).toString()
    return { pathname: path, search: search ? "?" + search : "", hash: globalThis.location?.hash ?? "", state: null }
}`)
    return "routeLocation()"
}

function searchHelper(converter) {
    const route = slimName(converter, "route")
    const navigate = slimName(converter, "navigate")
    converter.useHelper("searchParams", `const searchParams = () => {
    const update = (next, options) => {
        const current = new URLSearchParams(${route}().query)
        const search = new URLSearchParams(typeof next == "function" ? next(current) : next).toString()
        ${navigate}(${route}().path + (search ? "?" + search : ""), options)
    }
    return [new URLSearchParams(${route}().query), update]
}`)
    return "searchParams()"
}

export function routerCall(converter, node, scope) {
    if (node.callee.type !== "Identifier") return false
    const name = routerName(converter, node.callee.name)
    if (name === null) return false
    let text = null
    switch (name) {
        case "useNavigate":
            text = `(to, options) => typeof to == "number" ? history.go(to) : ${slimName(converter, "navigate")}(to, options)`
            break
        case "useParams":
            text = `${slimName(converter, "route")}().params`
            break
        case "useLocation":
            text = locationHelper(converter)
            break
        case "useSearchParams":
            text = searchHelper(converter)
            break
        default:
            routerError(converter, name, node)
            return true
    }
    converter.edits.replace(node.start, node.end, text)
    return true
}

function routeEntry(converter, element) {
    const field = name => element.openingElement.attributes.find(item => item.type === "JSXAttribute" && item.name.name === name)
    const path = field("path")
    const index = field("index")
    const page = field("element")?.value?.expression
    if (element.children.some(child => child.type === "JSXElement")) {
        converter.report("error", "router-api", `a <Route> inside a <Route> has no Slim form: ${HINTS.Outlet}`, element)
        return null
    }
    if (path && path.value?.type !== "StringLiteral" || !path && !index) {
        converter.report("error", "router-api", "a <Route> needs a path written as text", element)
        return null
    }
    const tag = page?.type === "JSXElement" ? page.openingElement.name : null
    const plain = tag?.type === "JSXIdentifier" && /^[A-Z]/.test(tag.name) && page.openingElement.attributes.length === 0 &&
        page.children.every(child => child.type === "JSXText" && child.value.trim() === "")
    if (!plain) {
        const hint = tag?.type === "JSXIdentifier" && routerName(converter, tag.name) === "Navigate" ? HINTS.Navigate
            : "a page is a component without props: write element={<Page />}, and give Page what it needs with provide and inject"
        converter.report("error", "router-api", `this route has no Slim form: ${hint}`, element)
        return null
    }
    const raw = index ? "/" : path.value.value
    const pattern = raw === "*" || raw.startsWith("/") ? raw : `/${raw}`
    return [pattern, tag.name]
}

function routes(converter, element) {
    const entries = []
    for (const child of element.children) {
        if (child.type === "JSXText" && child.value.trim() === "") continue
        const name = child.type === "JSXElement" && child.openingElement.name.type === "JSXIdentifier" ? routerName(converter, child.openingElement.name.name) : null
        if (name !== "Route") {
            converter.report("error", "router-api", "only <Route> elements can be inside <Routes>", child)
            return false
        }
        const entry = routeEntry(converter, child)
        if (!entry) return false
        entries.push(entry)
    }
    const ordered = [...entries.filter(([pattern]) => pattern !== "*"), ...entries.filter(([pattern]) => pattern === "*")]
    const object = ordered.map(([pattern, page]) => `${JSON.stringify(pattern)}: ${page}`).join(", ")
    converter.edits.replace(element.start, element.end, `<${slimName(converter, "Router")} routes=\${{ ${object} }} />`)
    return true
}

function link(converter, element, name, scope) {
    const tag = slimName(converter, "Link")
    const opening = element.openingElement
    converter.edits.replace(opening.name.start, opening.name.end, tag)
    if (element.closingElement) converter.edits.replace(element.closingElement.name.start, element.closingElement.name.end, tag)
    for (const item of opening.attributes) {
        if (item.type === "JSXSpreadAttribute") {
            converter.report("note", "link-props", "a spread on a link keeps only href, class, target and replace", item)
            attribute(converter, element, item, scope)
            continue
        }
        const prop = item.name.name
        const value = item.value?.type === "JSXExpressionContainer" ? item.value.expression : null
        if (prop === "className" && (value?.type === "ArrowFunctionExpression" || value?.type === "FunctionExpression")) {
            converter.report("error", "router-api", "a className that depends on the link being active has no Slim form: give the active class with active=\"...\"", item)
            continue
        }
        const renamed = prop === "to" ? "href" : prop === "className" ? "class" : prop
        if (DROPPED_PROPS.has(prop)) {
            converter.edits.remove(item.start - (converter.code[item.start - 1] === " " ? 1 : 0), item.end)
            continue
        }
        if (!LINK_PROPS.has(renamed)) converter.report("note", "link-props", `"${prop}" doesn't reach the link: a Slim <Link> takes only href, class, active, target and replace`, item)
        if (renamed !== prop) converter.edits.replace(item.name.start, item.name.end, renamed)
        if (prop === "to" && value?.type === "ObjectExpression") {
            converter.report("error", "router-api", "a link's \"to\" has to be a path: write it as text, with the query after \"?\"", item)
        }
        attribute(converter, element, item, scope)
    }
    if (name === "NavLink") {
        let end = opening.selfClosing ? opening.end - 2 : opening.end - 1
        while (/\s/.test(converter.code[end - 1])) end--
        converter.edits.insert(end, ` active="active"`)
    }
}

export function routerElement(converter, element, name, scope) {
    if (!name || name.includes(".")) return null
    const real = routerName(converter, name)
    if (real === null) return null
    switch (real) {
        case "BrowserRouter":
            return "transparent"
        case "Routes":
            routes(converter, element)
            return "replaced"
        case "Link":
        case "NavLink":
            link(converter, element, real, scope)
            return "attributes"
        default:
            routerError(converter, real, element)
            return null
    }
}

export function routerImport(converter, node) {
    converter.routerImport ??= node
    converter.edits.removeStatement(node)
}

export function routerImports(converter) {
    if (!converter.router?.size) return
    const names = [...converter.router].map(([name, alias]) => name === alias ? name : `${name} as ${alias}`)
    const at = converter.routerImport ?? converter.ast.program.body[0]
    const lineStart = at ? converter.code.lastIndexOf("\n", at.start - 1) + 1 : 0
    converter.edits.insert(lineStart, `use { ${names.join(", ")} } from @slim/router\n`)
}
