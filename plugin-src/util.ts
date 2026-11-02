/** Small pure helpers shared by the plugin tools. */

export type Rgba = { r: number; g: number; b: number; a: number };

/** Parses `rgb()`, `rgba()` (comma or space syntax) and hex. Fully transparent and unknown values give `null`. */
export function parseCssColor(value: string): Rgba | null {
    const v = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3,8})$/.exec(v);
    if (hex) {
        let h = hex[1] as string;
        if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
        const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
        const color = { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
        return color.a === 0 ? null : color;
    }
    const fn = /^rgba?\(([^)]+)\)$/.exec(v);
    if (!fn) return null;
    const parts = (fn[1] as string).split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const color = { r: channel(parts[0] as string), g: channel(parts[1] as string), b: channel(parts[2] as string), a: alpha };
    if ([color.r, color.g, color.b, color.a].some((n) => Number.isNaN(n)) || color.a === 0) return null;
    return color;
}

const arbitrary = (value: string) => value.replace(/"/g, "'").replace(/,\s+/g, ',').replace(/\s+/g, '_');

const NAMED: Record<string, Record<string, string>> = {
    display: { flex: 'flex', grid: 'grid', none: 'hidden', block: 'block', 'inline-flex': 'inline-flex' },
    'flex-direction': { column: 'flex-col', row: 'flex-row' },
    'justify-content': { center: 'justify-center', 'space-between': 'justify-between', 'flex-end': 'justify-end', 'flex-start': 'justify-start' },
    'align-items': { center: 'items-center', 'flex-end': 'items-end', 'flex-start': 'items-start', stretch: 'items-stretch' },
    position: { absolute: 'absolute', relative: 'relative' },
    'flex-wrap': { wrap: 'flex-wrap' },
    overflow: { hidden: 'overflow-hidden' },
};

const PREFIX: Record<string, string> = {
    gap: 'gap',
    width: 'w',
    height: 'h',
    'min-width': 'min-w',
    'max-width': 'max-w',
    'min-height': 'min-h',
    padding: 'p',
    'padding-top': 'pt',
    'padding-right': 'pr',
    'padding-bottom': 'pb',
    'padding-left': 'pl',
    background: 'bg',
    'background-color': 'bg',
    color: 'text',
    'border-radius': 'rounded',
    opacity: 'opacity',
    'font-size': 'text',
    'line-height': 'leading',
    'letter-spacing': 'tracking',
    left: 'left',
    top: 'top',
    flex: 'flex',
};

/** CSS declarations as Tailwind classes. Unknown properties become arbitrary properties: `[prop:value]`. */
export function toTailwind(css: Record<string, string>): string {
    return Object.entries(css)
        .map(([prop, value]) => {
            const named = NAMED[prop]?.[value];
            if (named) return named;
            const prefix = PREFIX[prop];
            if (prefix) return `${prefix}-[${arbitrary(value)}]`;
            return `[${prop}:${arbitrary(value)}]`;
        })
        .join(' ');
}

export function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A layer name as a component identifier: `Button / Kind=Primary` → `ButtonKindPrimary`. */
export function pascalCase(name: string): string {
    const id = name
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() + w.slice(1))
        .join('');
    if (!id) return 'Layer';
    return /^[0-9]/.test(id) ? `C${id}` : id;
}
