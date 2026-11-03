/** A minimal CSS reader: every custom property (`--x: …`) with the block preludes around it. No selectors, no cascade. */

export type CustomProperty = { name: string; value: string; blocks: string[]; line: number };

export function parseCustomProperties(css: string): CustomProperty[] {
    const out: CustomProperty[] = [];
    const blocks: string[] = [];
    let buf = '';
    let bufStart = 0;
    let line = 1;
    let depth = 0;
    let quote: string | null = null;

    const flush = () => {
        const text = buf.trim();
        if (text.startsWith('--')) {
            const colon = text.indexOf(':');
            if (colon > 0) out.push({ name: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim(), blocks: [...blocks], line: bufStart });
        }
        buf = '';
    };
    const append = (ch: string) => {
        if (buf.trim() === '' && ch.trim() !== '') bufStart = line;
        buf += ch;
    };

    for (let i = 0; i < css.length; i++) {
        const ch = css[i] ?? '';
        if (quote) {
            buf += ch;
            if (ch === quote && css[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            const stop = end < 0 ? css.length : end + 2;
            line += (css.slice(i, stop).match(/\n/g) ?? []).length;
            i = stop - 1;
            continue;
        }
        if (ch === '\n') line++;
        if (ch === '"' || ch === "'") {
            append(ch);
            quote = ch;
            continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (depth > 0) {
            append(ch);
            continue;
        }
        if (ch === '{') {
            blocks.push(buf.trim());
            buf = '';
        } else if (ch === '}') {
            flush();
            blocks.pop();
        } else if (ch === ';') {
            flush();
        } else {
            append(ch);
        }
    }
    flush();
    return out;
}
