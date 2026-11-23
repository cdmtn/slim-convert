export class Edits {
    constructor(code) {
        this.code = code
        this.list = []
    }

    replace(start, end, text) {
        this.list.push({ start, end, text, order: this.list.length })
    }

    remove(start, end) {
        this.replace(start, end, "")
    }

    insert(at, text) {
        this.replace(at, at, text)
    }

    removeStatement(node) {
        let start = node.start
        let end = node.end
        while (start > 0 && (this.code[start - 1] === " " || this.code[start - 1] === "\t")) start--
        const atLineStart = start === 0 || this.code[start - 1] === "\n"
        if (atLineStart) {
            let next = end
            while (this.code[next] === " " || this.code[next] === "\t" || this.code[next] === ";") next++
            if (this.code[next] === "\r") next++
            if (this.code[next] === "\n") end = next + 1
        }
        this.remove(atLineStart ? start : node.start, end)
    }

    apply(start = 0, end = this.code.length) {
        const ordered = [...this.list].sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
        let result = ""
        let position = start
        for (const edit of ordered) {
            if (edit.start < position) continue
            result += this.code.slice(position, edit.start) + edit.text
            position = edit.end
        }
        return result + this.code.slice(position, Math.max(position, end))
    }
}
