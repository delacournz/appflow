/**
 * Tailwind v4 / Uniwind CSS to DesignSpec.
 *
 * - `@theme { --color-<ramp>-<step>: <literal> }` becomes the Primitives collection (`glacier/500`).
 * - `@theme inline { --color-X: var(--X) }` becomes `color/X` in Tokens, one value per theme mode
 *   (`@variant light` / `@variant dark`). Static `@theme` values fill every mode.
 * - `--radius-*`, `--spacing-*` and `--text-*` become floats (`radius/input`); `--radius` is `radius/base`.
 * - `--text-<role>` with `--line-height` / `--letter-spacing` / `--font-weight` sub-keys becomes a text style.
 *
 * A `var()` that names another token becomes an alias. `calc()`, `color-mix(in oklch, …)`, `oklch()` and
 * `rgb()` are resolved. Anything else is skipped with a warning.
 */
import { tokenKey, type DesignSpec, type SpecCollection, type SpecLetterSpacing, type SpecLineHeight, type SpecTextStyle, type SpecToken, type TokenValue } from '../../shared/design-spec';
import { hexToOklch, mixOklch, parseColor } from './color';
import { parseCustomProperties } from './css';

export type TailwindCssOptions = {
    /** Theme variants to export as modes, in order. Default: every `@variant light|dark` found. */
    modes?: string[];
    primitives?: string;
    tokens?: string;
    /** Prepended to each text style name, such as `Sony FT/`. */
    textStylePrefix?: string;
    /** Default: the first `--font-sans` found. */
    fontFamily?: string;
};

export type CssFile = { path: string; css: string };
export type Extraction = { spec: DesignSpec; warnings: string[] };

type Decl = { name: string; value: string; source: string; variant: string | null; theme: boolean; inline: boolean };

const THEME_MODES = ['light', 'dark'];
const REM = 16;
const SKIPPED = ['--shadow', '--inset-shadow', '--drop-shadow', '--font', '--ease', '--animate', '--blur', '--perspective', '--aspect', '--breakpoint', '--container', '--default'];
const FLOAT_NAMESPACES = ['radius', 'spacing', 'text'] as const;
const FLOAT_SCOPES: Record<(typeof FLOAT_NAMESPACES)[number], string[]> = { radius: ['CORNER_RADIUS'], spacing: ['WIDTH_HEIGHT', 'GAP'], text: ['FONT_SIZE'] };
const WEIGHTS: Record<string, string> = { '100': 'Thin', '200': 'ExtraLight', '300': 'Light', '400': 'Regular', '500': 'Medium', '600': 'SemiBold', '700': 'Bold', '800': 'ExtraBold', '900': 'Black' };

function colorScopes(name: string): string[] {
    if (/foreground|placeholder|disabled|on-/.test(name)) return ['TEXT_FILL'];
    if (/border|divider|ring|input|stroke/.test(name)) return ['STROKE_COLOR'];
    return ['FRAME_FILL', 'SHAPE_FILL'];
}

/** Splits on top-level commas. */
function splitArgs(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            out.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

const VAR = /^var\(\s*(--[\w-]+)\s*(?:,.*)?\)$/;

/** `12px`, `1rem`, `12` to px. */
function length(v: string): number | null {
    const m = /^(-?\d*\.?\d+)(px|rem)?$/.exec(v.trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === 'rem' ? n * REM : n;
}

/** Evaluates + - * / and parentheses over numbers. */
function arithmetic(expr: string): number | null {
    const tokens = expr.match(/\d*\.?\d+|[-+*/()]/g);
    if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) return null;
    let i = 0;
    const primary = (): number | null => {
        const t = tokens[i++];
        if (t === '(') {
            const v = sum();
            return tokens[i++] === ')' ? v : null;
        }
        if (t === '-') {
            const v = primary();
            return v === null ? null : -v;
        }
        return t !== undefined && /\d/.test(t) ? Number(t) : null;
    };
    const product = (): number | null => {
        let v = primary();
        while (v !== null && (tokens[i] === '*' || tokens[i] === '/')) {
            const op = tokens[i++];
            const r = primary();
            v = r === null ? null : op === '*' ? v * r : v / r;
        }
        return v;
    };
    const sum = (): number | null => {
        let v = product();
        while (v !== null && (tokens[i] === '+' || tokens[i] === '-')) {
            const op = tokens[i++];
            const r = product();
            v = r === null ? null : op === '+' ? v + r : v - r;
        }
        return v;
    };
    const v = sum();
    return i === tokens.length ? v : null;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
const sentence = (role: string) => {
    const s = role.replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
};

export function extractTailwindCss(files: CssFile[], options: TailwindCssOptions = {}): Extraction {
    const warnings: string[] = [];
    const decls: Decl[] = files.flatMap((f) =>
        parseCustomProperties(f.css).map((p) => {
            const variant = [...p.blocks].reverse().find((b) => b.startsWith('@variant'));
            return {
                name: p.name,
                value: p.value,
                source: `${f.path}:${p.line}`,
                variant: variant ? variant.replace(/^@variant\s+/, '').trim() : null,
                theme: p.blocks.some((b) => b.startsWith('@theme')),
                inline: p.blocks.some((b) => b.startsWith('@theme') && /\binline\b/.test(b)),
            };
        }),
    );

    const staticVars = new Map<string, Decl>();
    const modeVars = new Map<string, Map<string, Decl>>();
    const found: string[] = [];
    for (const d of decls) {
        if (d.variant && THEME_MODES.includes(d.variant)) {
            if (!found.includes(d.variant)) found.push(d.variant);
            const m = modeVars.get(d.variant) ?? new Map<string, Decl>();
            m.set(d.name, d);
            modeVars.set(d.variant, m);
        } else if (d.theme && !d.variant) staticVars.set(d.name, d);
    }
    const modes = options.modes ?? (found.length ? found : ['Value']);
    const lookup = (name: string, mode: string): Decl | undefined => modeVars.get(mode)?.get(name) ?? staticVars.get(name);

    const primitivesName = options.primitives ?? 'Primitives';
    const tokensName = options.tokens ?? 'Tokens';

    type Def = { decl: Decl; collection: 'primitives' | 'tokens'; name: string; type: 'color' | 'float'; scopes: string[] };
    const defs: Def[] = [];
    const keyOf = new Map<string, string>();
    const add = (def: Def) => {
        defs.push(def);
        keyOf.set(def.decl.name, tokenKey(def.collection === 'primitives' ? primitivesName : tokensName, def.name));
    };

    for (const d of staticVars.values()) {
        const bare = d.name.slice(2);
        if (d.name.startsWith('--color-')) {
            const rest = d.name.slice('--color-'.length);
            if (!d.inline && parseColor(d.value)) {
                const step = /^(.*)-(\d+)$/.exec(rest);
                add({ decl: d, collection: 'primitives', name: step ? `${step[1]}/${step[2]}` : rest, type: 'color', scopes: [] });
            } else add({ decl: d, collection: 'tokens', name: `color/${rest}`, type: 'color', scopes: colorScopes(rest) });
            continue;
        }
        if (d.name === '--radius') {
            add({ decl: d, collection: 'tokens', name: 'radius/base', type: 'float', scopes: FLOAT_SCOPES.radius });
            continue;
        }
        const ns = FLOAT_NAMESPACES.find((n) => d.name.startsWith(`--${n}-`));
        if (ns) {
            if (!bare.includes('--')) add({ decl: d, collection: 'tokens', name: `${ns}/${d.name.slice(ns.length + 3)}`, type: 'float', scopes: FLOAT_SCOPES[ns] });
            continue;
        }
        if (!SKIPPED.some((p) => d.name === p || d.name.startsWith(`${p}-`))) warnings.push(`Skipped ${d.name}: ${d.value} (${d.source}): no Figma variable type for this namespace.`);
    }

    // `--color-X: var(--X)` exposes the raw `--X`, so a `var(--X)` elsewhere is an alias of `color/X`.
    for (const def of defs) {
        const m = VAR.exec(def.decl.value);
        if (def.type === 'color' && m?.[1] && !keyOf.has(m[1]) && !staticVars.has(m[1])) keyOf.set(m[1], keyOf.get(def.decl.name) ?? '');
    }

    const resolveHex = (raw: string, mode: string, seen: Set<string>): string | null => {
        const v = raw.trim();
        const lit = parseColor(v);
        if (lit) return lit;
        const m = VAR.exec(v);
        if (m?.[1]) {
            if (seen.has(m[1])) return null;
            const d = lookup(m[1], mode);
            return d ? resolveHex(d.value, mode, new Set([...seen, m[1]])) : null;
        }
        const mix = /^color-mix\((.*)\)$/.exec(v);
        if (mix?.[1]) {
            const [space, a, b] = splitArgs(mix[1]);
            if (!space || !/^in\s+oklch$/.test(space) || !a || !b) return null;
            const part = (s: string) => {
                const pm = /^(.*?)(?:\s+(\d*\.?\d+)%)?$/.exec(s);
                return { color: resolveHex(pm?.[1] ?? s, mode, seen), pct: pm?.[2] === undefined ? null : Number(pm[2]) / 100 };
            };
            const pa = part(a);
            const pb = part(b);
            if (!pa.color || !pb.color) return null;
            const w = pa.pct !== null && pb.pct !== null ? pa.pct / (pa.pct + pb.pct) : pa.pct !== null ? pa.pct : pb.pct !== null ? 1 - pb.pct : 0.5;
            return mixOklch(hexToOklch(pa.color), hexToOklch(pb.color), w);
        }
        return null;
    };

    const resolveNumber = (raw: string, mode: string, seen: Set<string>): number | null => {
        const v = raw.trim();
        const direct = length(v);
        if (direct !== null) return direct;
        const m = VAR.exec(v);
        if (m?.[1]) {
            if (seen.has(m[1])) return null;
            const d = lookup(m[1], mode);
            return d ? resolveNumber(d.value, mode, new Set([...seen, m[1]])) : null;
        }
        const calc = /^calc\((.*)\)$/.exec(v);
        if (calc?.[1]) {
            let failed = false;
            const expr = calc[1].replace(/var\(\s*(--[\w-]+)\s*\)|(-?\d*\.?\d+)(px|rem)/g, (_all, name: string | undefined, n: string | undefined, unit: string | undefined) => {
                const r = name ? resolveNumber(`var(${name})`, mode, seen) : length(`${n}${unit}`);
                if (r === null) failed = true;
                return String(r ?? 0);
            });
            const r = failed ? null : arithmetic(expr);
            return r === null ? null : round(r);
        }
        return null;
    };

    const valueOf = (def: Def, mode: string): TokenValue | null => {
        const own = def.collection === 'tokens' ? (lookup(def.decl.name, mode) ?? def.decl) : def.decl;
        const self = keyOf.get(def.decl.name);
        let raw = own.value;
        // Follow a var() to the raw value unless it names another token.
        for (let hop = 0; hop < 8; hop++) {
            const m = VAR.exec(raw);
            if (!m?.[1]) break;
            const target = keyOf.get(m[1]);
            if (target && target !== self) return { kind: 'alias', to: target };
            const next = lookup(m[1], mode);
            if (!next) return null;
            raw = next.value;
        }
        if (def.type === 'color') {
            const hex = resolveHex(raw, mode, new Set([def.decl.name]));
            return hex ? { kind: 'color', hex } : null;
        }
        const n = resolveNumber(raw, mode, new Set([def.decl.name]));
        return n === null ? null : { kind: 'float', value: n };
    };

    const primitives: SpecCollection = { name: primitivesName, modes: ['Value'], tokens: [] };
    const tokens: SpecCollection = { name: tokensName, modes: [...modes], tokens: [] };
    for (const def of defs) {
        const target = def.collection === 'primitives' ? primitives : tokens;
        const values: Record<string, TokenValue> = {};
        let ok = true;
        for (const mode of target.modes) {
            const v = valueOf(def, def.collection === 'primitives' ? (modes[0] ?? mode) : mode);
            if (!v) {
                ok = false;
                warnings.push(`Skipped ${def.decl.name}: could not resolve "${(lookup(def.decl.name, mode) ?? def.decl).value}" for mode ${mode} (${def.decl.source}).`);
                break;
            }
            values[mode] = v;
        }
        if (!ok) continue;
        const token: SpecToken = { name: def.name, type: def.type, values, codeId: `css:${def.decl.name}`, scopes: def.scopes, codeSyntax: { WEB: `var(${def.decl.name})` }, source: def.decl.source };
        target.tokens.push(token);
    }

    const textStyles = extractTextStyles(staticVars, decls, options, warnings);
    return { spec: { collections: [primitives, tokens].filter((c) => c.tokens.length > 0), textStyles, components: [] }, warnings };
}

function extractTextStyles(staticVars: Map<string, Decl>, decls: Decl[], options: TailwindCssOptions, warnings: string[]): SpecTextStyle[] {
    const roles = new Set<string>();
    for (const name of staticVars.keys()) {
        const m = /^--text-(.+)--(line-height|letter-spacing|font-weight)$/.exec(name);
        if (m?.[1]) roles.add(m[1]);
    }
    const family = options.fontFamily ?? unquote(decls.find((d) => d.name === '--font-sans')?.value ?? 'Inter');
    const out: SpecTextStyle[] = [];
    for (const d of staticVars.values()) {
        const role = d.name.startsWith('--text-') ? d.name.slice('--text-'.length) : null;
        if (!role || !roles.has(role)) continue;
        const size = length(d.value);
        if (size === null) {
            warnings.push(`Skipped text style ${role}: font size "${d.value}" is not a length (${d.source}).`);
            continue;
        }
        const sub = (key: string) => staticVars.get(`--text-${role}--${key}`)?.value.trim();
        const weight = sub('font-weight') ?? '400';
        const fontStyle = WEIGHTS[weight];
        if (!fontStyle) warnings.push(`Text style ${role}: unknown font weight "${weight}", using Regular.`);
        out.push({
            name: `${options.textStylePrefix ?? ''}${sentence(role)}`,
            fontFamily: family,
            fontStyle: fontStyle ?? 'Regular',
            fontSize: size,
            lineHeight: lineHeight(sub('line-height')),
            letterSpacing: letterSpacing(sub('letter-spacing')),
            codeId: `css:${d.name}`,
            source: d.source,
        });
    }
    return out;
}

function lineHeight(v: string | undefined): SpecLineHeight {
    if (v === undefined) return { unit: 'AUTO' };
    if (v.endsWith('%')) return { unit: 'PERCENT', value: Number(v.slice(0, -1)) };
    if (/^\d*\.?\d+$/.test(v)) return { unit: 'PERCENT', value: round(Number(v) * 100) };
    const px = length(v);
    return px === null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: px };
}

function letterSpacing(v: string | undefined): SpecLetterSpacing {
    if (v === undefined) return { unit: 'PIXELS', value: 0 };
    if (v.endsWith('em') && !v.endsWith('rem')) return { unit: 'PERCENT', value: round(Number(v.slice(0, -2)) * 100) };
    return { unit: 'PIXELS', value: length(v) ?? 0 };
}
