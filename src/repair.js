function closingBracket(line, open) {
    let depth = 0
    for (let index = open; index < line.length; index++) {
        if (line[index] === "(" || line[index] === "[") depth++
        if ((line[index] === ")" || line[index] === "]") && --depth === 0) return index
    }
    return -1
}

function subjectEnd(line, column, subject) {
    let at = column
    let index = 0
    while (index < subject.length) {
        if (subject.startsWith("(...)", index)) {
            if (line[at] !== "(") return -1
            const close = closingBracket(line, at)
            if (close < 0) return -1
            at = close + 1
            index += "(...)".length
        } else {
            if (line[at] !== subject[index]) return -1
            at++
            index++
        }
    }
    return at
}

function chainEnd(line, column) {
    let at = column
    while (at < line.length) {
        if (line[at] === "(" || line[at] === "[") {
            const close = closingBracket(line, at)
            if (close < 0) return -1
            at = close + 1
        } else if (/[\w$.?!]/.test(line[at]) && !(line[at] === "?" && line[at + 1] !== ".")) at++
        else break
    }
    return at > column ? at : -1
}

const REPAIRS = [
    {
        pattern: /is async and nothing awaits it/,
        kind: "void",
        apply: (line, column) => /^\s*$/.test(line.slice(0, column)) ? `${line.slice(0, column)}void ${line.slice(column)}` : null
    },
    {
        pattern: /^"(.+)" may be (?:null|undefined) here/,
        kind: "non-null",
        apply(line, column, subject) {
            const matched = subjectEnd(line, column, subject)
            const end = matched < 0 ? chainEnd(line, column) : matched
            return end < 0 ? null : `${line.slice(0, end)}!${line.slice(end)}`
        }
    },
    {
        pattern: / has no (?:field|property) "(.+?)"/,
        kind: "dynamic-field",
        apply(line, column, field) {
            if (!line.startsWith(field, column)) return null
            const object = /(?:this|[\w$]+)(?:\.[\w$]+)*\??\.$/.exec(line.slice(0, column))
            if (!object) return null
            const dot = object[0].endsWith("?.") ? "?." : "."
            const text = object[0].slice(0, -dot.length)
            return `${line.slice(0, object.index)}(${text} as any)${dot}${line.slice(column)}`
        }
    },
    {
        pattern: /^"(.+)" must return .+, but it can reach the end/,
        kind: "return-type",
        apply(line) {
            const fixed = line.replace(/\s*->\s*[^{=]*?(?=\s*(?:\{|=>)\s*$|\s*\{)/, "")
            return fixed === line ? null : fixed
        }
    },
    {
        pattern: /^"(.+)" is .+, so this condition is always true/,
        kind: "condition",
        apply(line, column, subject) {
            const matched = subjectEnd(line, column, subject)
            const end = matched < 0 ? chainEnd(line, column) : matched
            return end < 0 ? null : `${line.slice(0, column)}(${line.slice(column, end)} as any)${line.slice(end)}`
        }
    }
]

export const REPAIR_NOTES = {
    void: `a call nothing awaits got "void", which Slim requires`,
    "non-null": `a value Slim sees as possibly null got "!": the code already read it without a check`,
    "dynamic-field": `a field Slim doesn't see on this value is read through "as any": the code sets it dynamically, or it is a typo`,
    "return-type": `a return type was dropped: Slim can't see that the switch in this function handles every case`,
    condition: `a condition Slim sees as always true got "as any": check that it does what you meant`
}

export function repair(code, errors) {
    const lines = code.split("\n")
    const done = []
    const touched = new Set()
    const ordered = errors.filter(error => error.line).sort((a, b) => b.line - a.line || b.column - a.column)
    for (const error of ordered) {
        if (touched.has(error.line)) continue
        for (const fix of REPAIRS) {
            const match = fix.pattern.exec(error.message)
            if (!match) continue
            const line = lines[error.line - 1]
            const applied = line === undefined ? null : fix.apply(line, error.column - 1, match[1])
            if (applied === null) continue
            const fixed = /^\s*[([`]/.test(applied) && !/^\s*[([`]/.test(line) ? applied.replace(/^\s*/, indent => `${indent};`) : applied
            lines[error.line - 1] = fixed
            touched.add(error.line)
            done.push({ kind: fix.kind, line: error.line })
            break
        }
    }
    return done.length ? { code: lines.join("\n"), done } : null
}
