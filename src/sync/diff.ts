/**
 * Compares a code DesignSpec (the source of truth) with a Figma export and
 * returns the ops that would make Figma match code. Pure: no I/O.
 *
 * Tokens match in this order: a stored code id, then the rename map
 * (Figma key to code key), then the same key. Figma items that match nothing
 * are orphans; they are reported, never removed here.
 */
import { tokenKey, type CodeSyntax, type DesignSpec, type SpecCollection, type SpecComponent, type SpecLetterSpacing, type SpecLineHeight, type SpecTextStyle, type SpecToken, type TokenValue } from '../../shared/design-spec';
import type { Rename, SyncOp, TextStyleChange, ValueChange } from '../../shared/design-ops';
import { matchesGlob } from './config';

type Names = Record<string, string>;
export type DesignMapping = {
    /** Figma name or key to code name or key. */
    rename: { tokens: Names; textStyles: Names; components: Names };
    /** Globs over token keys, text style names and component names, applied to both sides. */
    ignore: { tokens: string[]; textStyles: string[]; components: string[] };
    /** Per Figma component and axis: the code axis name and option names it stands for. */
    variants: Record<string, Record<string, VariantRename>>;
    /** Per code component and axis: the option existing Figma variants take when that axis is added. Default: the code default. */
    variantDefaults: Record<string, Record<string, string>>;
    /** Per Figma component: code slot name to the Figma layer name it styles. Default: a layer named like the slot. */
    layers: Record<string, Record<string, string>>;
};

export type VariantRename = { axis?: string; options?: Record<string, string> };

export const emptyMapping = (): DesignMapping => ({ rename: { tokens: {}, textStyles: {}, components: {} }, ignore: { tokens: [], textStyles: [], components: [] }, variants: {}, variantDefaults: {}, layers: {} });

export type { Rename, SyncOp, TextStyleChange, ValueChange } from '../../shared/design-ops';

export type RenameCandidate = { kind: 'token' | 'textStyle' | 'component'; figma: string; code: string };

export type SyncPlan = {
    ops: SyncOp[];
    counts: { create: number; update: number; orphan: number; matched: number };
    renameCandidates: RenameCandidate[];
};

const FLOAT_EPSILON = 1e-3;
const COLOR_TOLERANCE = 1;

const ignored = (value: string, globs: string[]) => globs.some((g) => matchesGlob(value, g));
const withId = (figmaId: string | undefined) => (figmaId === undefined ? {} : { figmaId });
const lower = (s: string) => s.toLowerCase();

function sameColor(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    for (let i = 1; i < a.length; i += 2) {
        if (Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)) > COLOR_TOLERANCE) return false;
    }
    return true;
}

function sameLiteral(code: TokenValue, figma: TokenValue): boolean {
    switch (code.kind) {
        case 'color':
            return figma.kind === 'color' && sameColor(code.hex.toUpperCase(), figma.hex.toUpperCase());
        case 'float':
            return figma.kind === 'float' && Math.abs(code.value - figma.value) <= FLOAT_EPSILON;
        case 'string':
            return figma.kind === 'string' && code.value === figma.value;
        case 'boolean':
            return figma.kind === 'boolean' && code.value === figma.value;
        case 'alias':
            return false;
    }
}

/** Follows aliases inside one spec to a literal. The target's same-named mode wins, else its first value. */
function resolver(spec: DesignSpec): (value: TokenValue, mode: string) => TokenValue | null {
    const index = new Map<string, SpecToken>();
    for (const c of spec.collections) for (const t of c.tokens) index.set(tokenKey(c.name, t.name), t);
    return (value, mode) => {
        let v: TokenValue | undefined = value;
        for (let hop = 0; v?.kind === 'alias' && hop < 16; hop++) {
            const t = index.get(v.to);
            if (!t) return null;
            const own = Object.entries(t.values).find(([m]) => lower(m) === lower(mode));
            v = own ? own[1] : Object.values(t.values)[0];
        }
        return v && v.kind !== 'alias' ? v : null;
    };
}

type Compare = { figmaToCode: Map<string, string>; code: (v: TokenValue, mode: string) => TokenValue | null; figma: (v: TokenValue, mode: string) => TokenValue | null };

/**
 * Two aliases compare by target (Figma's translated to its code key). A literal and an alias compare by what the
 * alias resolves to, so a Figma link to a primitive survives a code literal of the same colour.
 */
function sameValue(code: TokenValue, figma: TokenValue, mode: string, cmp: Compare): boolean {
    if (code.kind === 'alias' && figma.kind === 'alias') return (cmp.figmaToCode.get(figma.to) ?? figma.to) === code.to;
    if (code.kind !== 'alias' && figma.kind !== 'alias') return sameLiteral(code, figma);
    const a = cmp.code(code, mode);
    const b = cmp.figma(figma, mode);
    return a !== null && b !== null && sameLiteral(a, b);
}

const sameSyntax = (a: CodeSyntax | undefined, b: CodeSyntax | undefined) => (a?.WEB ?? '') === (b?.WEB ?? '') && (a?.ANDROID ?? '') === (b?.ANDROID ?? '') && (a?.iOS ?? '') === (b?.iOS ?? '');

/** Code mode name to Figma mode name. Two single-mode collections pair up whatever their modes are called. */
function modeMap(code: SpecCollection, figma: SpecCollection): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (code.modes.length === 1 && figma.modes.length === 1 && code.modes[0] !== undefined && figma.modes[0] !== undefined) {
        out.set(code.modes[0], figma.modes[0]);
        return out;
    }
    for (const m of code.modes) out.set(m, figma.modes.find((f) => lower(f) === lower(m)) ?? null);
    return out;
}

type Entry = { collection: SpecCollection; token: SpecToken; key: string };

function entries(spec: DesignSpec, globs: string[]): Entry[] {
    const out: Entry[] = [];
    for (const collection of spec.collections) {
        for (const token of collection.tokens) {
            const key = tokenKey(collection.name, token.name);
            if (!ignored(key, globs)) out.push({ collection, token, key });
        }
    }
    return out;
}

/** Pairs code items with Figma items: code id first, then the rename map, then the same key. */
function pair<T>(code: T[], figma: T[], keyOf: (t: T) => string, codeIdOf: (t: T) => string | undefined, rename: Names, ci = false): Map<T, T> {
    const norm = (k: string) => (ci ? lower(k) : k);
    const out = new Map<T, T>();
    const free = new Set(figma);
    const take = (c: T, f: T | undefined) => {
        if (f === undefined || !free.has(f) || out.has(c)) return;
        out.set(c, f);
        free.delete(f);
    };
    // Several code items can share a code id (one tv() for List row and Toggle row): prefer the same or renamed name.
    const nameOf = (f: T) => norm(rename[keyOf(f)] ?? keyOf(f));
    for (const c of code) {
        const id = codeIdOf(c);
        if (id === undefined) continue;
        const linked = figma.filter((f) => free.has(f) && codeIdOf(f) === id);
        take(c, linked.find((f) => nameOf(f) === norm(keyOf(c))) ?? (linked.length === 1 || !code.some((o) => o !== c && codeIdOf(o) === id) ? linked[0] : undefined));
    }
    const renamedTo = new Map<string, T>();
    for (const f of figma) {
        const target = rename[keyOf(f)];
        if (target !== undefined) renamedTo.set(norm(target), f);
    }
    for (const c of code) if (!out.has(c)) take(c, renamedTo.get(norm(keyOf(c))));
    for (const c of code) if (!out.has(c)) take(c, figma.find((f) => free.has(f) && norm(keyOf(f)) === norm(keyOf(c))));
    return out;
}

function diffTokens(code: DesignSpec, figma: DesignSpec, mapping: DesignMapping, plan: SyncPlan): void {
    const codeEntries = entries(code, mapping.ignore.tokens);
    const figmaEntries = entries(figma, mapping.ignore.tokens);
    const pairs = pair(codeEntries, figmaEntries, (e) => e.key, (e) => e.token.codeId, mapping.rename.tokens);

    const figmaToCode = new Map<string, string>();
    for (const [c, f] of pairs) figmaToCode.set(f.key, c.key);
    const cmp: Compare = { figmaToCode, code: resolver(code), figma: resolver(figma) };

    const created: Entry[] = [];
    const doneCollections = new Set<string>();
    for (const collection of code.collections) {
        const target = figma.collections.find((f) => f.name === collection.name);
        const mine = codeEntries.filter((e) => e.collection === collection);
        if (!target) {
            if (mine.length === 0) continue;
            plan.ops.push({ op: 'create-collection', collection: collection.name, modes: [...collection.modes] });
        } else if (!doneCollections.has(target.name)) {
            doneCollections.add(target.name);
            for (const [mode, figmaMode] of modeMap(collection, target)) if (figmaMode === null) plan.ops.push({ op: 'add-mode', collection: target.name, mode });
        }
        for (const entry of mine) {
            const match = pairs.get(entry);
            if (!match) {
                plan.ops.push({ op: 'create-token', collection: collection.name, token: entry.token });
                created.push(entry);
                continue;
            }
            const modes = modeMap(entry.collection, match.collection);
            const values: ValueChange[] = [];
            for (const [mode, to] of Object.entries(entry.token.values)) {
                const figmaMode = modes.get(mode) ?? null;
                const from = figmaMode === null ? undefined : match.token.values[figmaMode];
                if (from === undefined) values.push({ mode: figmaMode ?? mode, from: null, to });
                else if (!sameValue(to, from, figmaMode ?? mode, cmp)) values.push({ mode: figmaMode ?? mode, from, to });
            }
            const rename = match.token.name === entry.token.name ? undefined : { from: match.token.name, to: entry.token.name };
            const codeId = entry.token.codeId !== undefined && entry.token.codeId !== match.token.codeId ? entry.token.codeId : undefined;
            const codeSyntax = entry.token.codeSyntax !== undefined && !sameSyntax(entry.token.codeSyntax, match.token.codeSyntax) ? entry.token.codeSyntax : undefined;
            if (values.length === 0 && !rename && codeId === undefined && codeSyntax === undefined) {
                plan.counts.matched++;
                continue;
            }
            plan.ops.push({
                op: 'update-token',
                collection: match.collection.name,
                name: match.token.name,
                ...withId(match.token.figmaId),
                values,
                ...(rename ? { rename } : {}),
                ...(codeId === undefined ? {} : { codeId }),
                ...(codeSyntax === undefined ? {} : { codeSyntax }),
            });
        }
    }

    const matched = new Set(pairs.values());
    const orphans = figmaEntries.filter((f) => !matched.has(f));
    const lookalikes = (f: Entry) => created.filter((c) => c.collection.name === f.collection.name && c.token.type === f.token.type && sameValues(c, f, cmp));
    const claims = new Map<Entry, number>();
    const found = orphans.map((f) => {
        const list = lookalikes(f);
        for (const c of list) claims.set(c, (claims.get(c) ?? 0) + 1);
        return list;
    });
    orphans.forEach((f, i) => {
        plan.ops.push({ op: 'orphan-token', collection: f.collection.name, name: f.token.name, ...withId(f.token.figmaId) });
        // Only an unambiguous pair: one lookalike, claimed by this orphan alone.
        const [only, ...more] = found[i] ?? [];
        if (only && more.length === 0 && claims.get(only) === 1) plan.renameCandidates.push({ kind: 'token', figma: f.key, code: only.key });
    });
}

function sameValues(code: Entry, figma: Entry, cmp: Compare): boolean {
    const modes = modeMap(code.collection, figma.collection);
    const pairs = Object.entries(code.token.values);
    return (
        pairs.length > 0 &&
        pairs.every(([mode, to]) => {
            const figmaMode = modes.get(mode);
            const from = figmaMode ? figma.token.values[figmaMode] : undefined;
            return from !== undefined && figmaMode !== undefined && figmaMode !== null && sameValue(to, from, figmaMode, cmp);
        })
    );
}

/** A metric in px at `fontSize`; AUTO line height is null. */
const px = (m: SpecLineHeight | SpecLetterSpacing, fontSize: number): number | null => ('value' in m ? (m.unit === 'PERCENT' ? (m.value / 100) * fontSize : m.value) : null);
const METRIC_EPSILON = 0.01;
/** Equal when both are AUTO, or both resolve to the same px at the font size (so 0% equals 0px and -1% at 22 equals -0.22px). */
function sameMetric(a: SpecLineHeight | SpecLetterSpacing, b: SpecLineHeight | SpecLetterSpacing, fontSize: number): boolean {
    const pa = px(a, fontSize);
    const pb = px(b, fontSize);
    if (pa === null || pb === null) return pa === pb;
    return Math.abs(pa - pb) <= METRIC_EPSILON;
}

function styleChanges(code: SpecTextStyle, figma: SpecTextStyle): TextStyleChange[] {
    const out: TextStyleChange[] = [];
    if (code.fontFamily !== figma.fontFamily) out.push({ field: 'fontFamily', from: figma.fontFamily, to: code.fontFamily });
    if (code.fontStyle !== figma.fontStyle) out.push({ field: 'fontStyle', from: figma.fontStyle, to: code.fontStyle });
    if (Math.abs(code.fontSize - figma.fontSize) > FLOAT_EPSILON) out.push({ field: 'fontSize', from: figma.fontSize, to: code.fontSize });
    if (!sameMetric(code.lineHeight, figma.lineHeight, code.fontSize)) out.push({ field: 'lineHeight', from: figma.lineHeight, to: code.lineHeight });
    if (!sameMetric(code.letterSpacing, figma.letterSpacing, code.fontSize)) out.push({ field: 'letterSpacing', from: figma.letterSpacing, to: code.letterSpacing });
    return out;
}

function diffTextStyles(code: DesignSpec, figma: DesignSpec, mapping: DesignMapping, plan: SyncPlan): void {
    const keep = (s: SpecTextStyle) => !ignored(s.name, mapping.ignore.textStyles);
    const codeStyles = code.textStyles.filter(keep);
    const figmaStyles = figma.textStyles.filter(keep);
    const pairs = pair(codeStyles, figmaStyles, (s) => s.name, (s) => s.codeId, mapping.rename.textStyles);
    for (const style of codeStyles) {
        const match = pairs.get(style);
        if (!match) {
            plan.ops.push({ op: 'create-text-style', style });
            continue;
        }
        const changes = styleChanges(style, match);
        const rename = match.name === style.name ? undefined : { from: match.name, to: style.name };
        const codeId = style.codeId !== undefined && style.codeId !== match.codeId ? style.codeId : undefined;
        if (changes.length === 0 && !rename && codeId === undefined) {
            plan.counts.matched++;
            continue;
        }
        plan.ops.push({ op: 'update-text-style', name: match.name, ...withId(match.figmaId), changes, ...(rename ? { rename } : {}), ...(codeId === undefined ? {} : { codeId }) });
    }
    const matched = new Set(pairs.values());
    for (const f of figmaStyles) if (!matched.has(f)) plan.ops.push({ op: 'orphan-text-style', name: f.name, ...withId(f.figmaId) });
}

/** Code components paired with their Figma component sets: code id, then rename map, then name (any case). */
export function matchComponents(code: DesignSpec, figma: DesignSpec, mapping: DesignMapping): { codeComps: SpecComponent[]; figmaComps: SpecComponent[]; pairs: Map<SpecComponent, SpecComponent> } {
    const keep = (c: SpecComponent) => !ignored(c.name, mapping.ignore.components);
    const codeComps = code.components.filter(keep);
    const figmaComps = figma.components.filter(keep);
    return { codeComps, figmaComps, pairs: pair(codeComps, figmaComps, (c) => c.name, (c) => c.codeId, mapping.rename.components, true) };
}

function diffComponents(code: DesignSpec, figma: DesignSpec, mapping: DesignMapping, plan: SyncPlan): void {
    const { codeComps, figmaComps, pairs } = matchComponents(code, figma, mapping);
    for (const comp of codeComps) {
        const match = pairs.get(comp);
        if (!match) {
            plan.ops.push({ op: 'create-component', component: comp });
            continue;
        }
        const base = { component: match.name, ...withId(match.figmaId) };
        const before = plan.ops.length;
        const renames = mapping.variants[match.name] ?? {};
        const figmaAxes: [string, string[]][] = Object.entries(match.axes).map(([axis, options]) => {
            const r = renames[axis];
            if (!r) return [axis, options];
            const to = r.axis ?? axis;
            const changed = Object.fromEntries(Object.entries(r.options ?? {}).filter(([from, o]) => from !== o && options.includes(from)));
            if (to !== axis || Object.keys(changed).length) plan.ops.push({ op: 'rename-variant', ...base, axis, to, options: changed });
            return [to, options.map((o) => changed[o] ?? o)];
        });
        for (const [axis, options] of Object.entries(comp.axes)) {
            const found = figmaAxes.find(([name]) => lower(name) === lower(axis));
            if (!found) {
                const existing = mapping.variantDefaults[comp.name]?.[axis] ?? comp.defaults[axis] ?? options[0] ?? '';
                plan.ops.push({ op: 'add-variant-axis', ...base, axis, options: [...options], existing });
                continue;
            }
            const [figmaAxis, figmaOptions] = found;
            for (const option of options) if (!figmaOptions.some((o) => lower(o) === lower(option))) plan.ops.push({ op: 'add-variant-option', ...base, axis: figmaAxis, option });
            for (const option of figmaOptions) if (!options.some((o) => lower(o) === lower(option))) plan.ops.push({ op: 'orphan-variant-option', ...base, axis: figmaAxis, option });
        }
        for (const [figmaAxis] of figmaAxes) if (!Object.keys(comp.axes).some((a) => lower(a) === lower(figmaAxis))) plan.ops.push({ op: 'orphan-variant-axis', ...base, axis: figmaAxis });
        const codeId = comp.codeId !== undefined && comp.codeId !== match.codeId ? comp.codeId : undefined;
        if (codeId !== undefined) plan.ops.push({ op: 'link-component', ...base, codeId });
        if (plan.ops.length === before) plan.counts.matched++;
    }
    const matched = new Set(pairs.values());
    for (const f of figmaComps) if (!matched.has(f)) plan.ops.push({ op: 'orphan-component', component: f.name, ...withId(f.figmaId) });
}

const KIND: Record<SyncOp['op'], 'create' | 'update' | 'orphan'> = {
    'create-collection': 'create',
    'add-mode': 'create',
    'create-token': 'create',
    'update-token': 'update',
    'orphan-token': 'orphan',
    'create-text-style': 'create',
    'update-text-style': 'update',
    'orphan-text-style': 'orphan',
    'create-component': 'create',
    'add-variant-axis': 'update',
    'add-variant-option': 'update',
    'orphan-variant-option': 'orphan',
    'orphan-variant-axis': 'orphan',
    'link-component': 'update',
    'rename-variant': 'update',
    'style-component': 'update',
    'orphan-component': 'orphan',
};

export function diffSpecs(code: DesignSpec, figma: DesignSpec, mapping: DesignMapping): SyncPlan {
    const plan: SyncPlan = { ops: [], counts: { create: 0, update: 0, orphan: 0, matched: 0 }, renameCandidates: [] };
    diffTokens(code, figma, mapping, plan);
    diffTextStyles(code, figma, mapping, plan);
    diffComponents(code, figma, mapping, plan);
    for (const op of plan.ops) plan.counts[KIND[op.op]]++;
    return plan;
}
