/** Pure helpers for adopting arrows whose ends no longer line up with their screens. No `figma` global. */
import { distanceToRect } from './adopt';
import type { Pt, Rect } from './route';

export type ScreenRef = { id: string; name: string; rect: Rect };

/** How far an arrow end may be from a screen and still snap to it: screens shifted by group gaps move by up to this much. */
export const MAX_OFFSET = 650;
/** The nearest screen must beat the runner-up by this much to be taken without a name to confirm it. */
export const SNAP_MARGIN = 60;
export const EXACT = 14;

export type Endpoint =
    | { kind: 'exact' | 'snapped' | 'named'; screen: ScreenRef; offset: number }
    | { kind: 'ambiguous'; candidates: string[] }
    | { kind: 'none' };

export type ResolveOptions = {
    /** Screens an arrow's name says this end must be; resolves ties and stale ends. */
    hint?: readonly ScreenRef[];
    exclude?: string;
    maxOffset?: number;
    margin?: number;
};

const ranked = (p: Pt, screens: readonly ScreenRef[]): { s: ScreenRef; d: number }[] =>
    screens.map((s) => ({ s, d: distanceToRect(p, s.rect) })).sort((a, b) => a.d - b.d);

/**
 * The screen an arrow end belongs to, from where the end is NOW.
 * - sitting on a screen (within 14px): that screen (exact);
 * - a name hint with one screen: that screen, however far the end is (named); with several: the nearest of them, if it
 *   is clearly nearer than the others, else ambiguous;
 * - otherwise the nearest screen within `maxOffset`, if it is `margin` nearer than the runner-up (snapped);
 * - otherwise ambiguous (two close candidates) or none (nothing in reach). Never a guess.
 */
export function resolveEndpoint(p: Pt, screens: readonly ScreenRef[], opts: ResolveOptions = {}): Endpoint {
    const maxOffset = opts.maxOffset ?? MAX_OFFSET;
    const margin = opts.margin ?? SNAP_MARGIN;
    const pool = screens.filter((s) => s.id !== opts.exclude);
    const hint = (opts.hint ?? []).filter((s) => s.id !== opts.exclude);

    if (hint.length) {
        const r = ranked(p, hint);
        const [first, second] = [r[0] as { s: ScreenRef; d: number }, r[1]];
        if (!second || first.d <= EXACT || second.d - first.d >= margin) return { kind: 'named', screen: first.s, offset: Math.round(first.d) };
        return { kind: 'ambiguous', candidates: r.map((x) => x.s.id) };
    }

    const r = ranked(p, pool);
    const first = r[0];
    if (!first || first.d > maxOffset) return { kind: 'none' };
    if (first.d <= EXACT) return { kind: 'exact', screen: first.s, offset: Math.round(first.d) };
    const near = r.filter((x) => x.d <= maxOffset && x.d - first.d < margin);
    if (near.length > 1) return { kind: 'ambiguous', candidates: near.map((x) => x.s.id) };
    return { kind: 'snapped', screen: first.s, offset: Math.round(first.d) };
}

/**
 * Screens an arrow group's name points at. Names are `Flow · {from} → {to} · {label}`; screen names contain " · " too, so every
 * (from, to) pair whose joined text is a prefix is tried. Returns every screen with a matching from name and with a matching to name.
 */
export function endpointsFromName(groupName: string, screens: readonly ScreenRef[]): { from: ScreenRef[]; to: ScreenRef[] } {
    const names = [...new Set(screens.map((s) => s.name))];
    const pairs: { from: string; to: string }[] = [];
    for (const a of names) {
        for (const b of names) if (groupName.startsWith(`Flow · ${a} → ${b} · `)) pairs.push({ from: a, to: b });
    }
    const longest = pairs.sort((x, y) => y.from.length + y.to.length - (x.from.length + x.to.length))[0];
    if (!longest) return { from: [], to: [] };
    return { from: screens.filter((s) => s.name === longest.from), to: screens.filter((s) => s.name === longest.to) };
}

export type Part = { id: string; at: Pt };
export type LoosePair = { vectorId: string; dotId: string; labelId: string };
export type Unpaired = { vectorId: string; reason: 'no-start-dot' | 'no-label' };

/**
 * Pairs loose arrow parts. Each vector gets the nearest start dot to its tail (within `dotReach`) and the nearest label to the
 * middle of its longest segment (within `labelReach`); the closest matches are made first and each dot or label serves one
 * vector, so a vector never steals another's parts, and parts that drifted a little still find their arrow.
 */
export function pairLooseParts(
    vectors: readonly { id: string; tail: Pt; mid: Pt }[],
    dots: readonly Part[],
    labels: readonly Part[],
    reach: { dot: number; label: number } = { dot: 40, label: 120 },
): { pairs: LoosePair[]; unpaired: Unpaired[] } {
    const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    const claim = (items: readonly Part[], pick: (v: (typeof vectors)[number]) => Pt, within: number): Map<string, string> => {
        const cands = vectors.flatMap((v) => items.map((it) => ({ v: v.id, it: it.id, d: dist(pick(v), it.at) })).filter((c) => c.d <= within));
        cands.sort((a, b) => a.d - b.d);
        const byVector = new Map<string, string>();
        const used = new Set<string>();
        for (const c of cands) {
            if (byVector.has(c.v) || used.has(c.it)) continue;
            byVector.set(c.v, c.it);
            used.add(c.it);
        }
        return byVector;
    };
    const dotOf = claim(dots, (v) => v.tail, reach.dot);
    const labelOf = claim(labels, (v) => v.mid, reach.label);
    const pairs: LoosePair[] = [];
    const unpaired: Unpaired[] = [];
    for (const v of vectors) {
        const dotId = dotOf.get(v.id);
        const labelId = labelOf.get(v.id);
        if (!dotId) unpaired.push({ vectorId: v.id, reason: 'no-start-dot' });
        else if (!labelId) unpaired.push({ vectorId: v.id, reason: 'no-label' });
        else pairs.push({ vectorId: v.id, dotId, labelId });
    }
    return { pairs, unpaired };
}

export type ArrowEnds =
    | { ok: true; from: ScreenRef; to: ScreenRef; fromHow: Endpoint['kind']; toHow: Endpoint['kind']; stale: boolean }
    | { ok: false; reason: 'no-source-screen' | 'no-target-screen' | 'ambiguous-source' | 'ambiguous-target' | 'same-screen'; candidates?: string[] };

/**
 * Source and target of one arrow from its tail and head as drawn now, its group name (if it has one) and the ends it
 * remembers (if the ids still point at screens). A remembered end wins; then the name narrows candidates; then geometry.
 * `stale` is true when an end was snapped or named rather than found where it was drawn, so the route needs redrawing.
 */
export function resolveArrowEnds(
    tail: Pt,
    head: Pt,
    screens: readonly ScreenRef[],
    memory: { from?: string | null; to?: string | null; groupName?: string } = {},
): ArrowEnds {
    const byId = new Map(screens.map((s) => [s.id, s]));
    const named = memory.groupName ? endpointsFromName(memory.groupName, screens) : { from: [], to: [] };
    const remembered = (id: string | null | undefined): ScreenRef | undefined => (id ? byId.get(id) : undefined);

    const rf = remembered(memory.from);
    const from: Endpoint = rf ? { kind: 'named', screen: rf, offset: Math.round(distanceToRect(tail, rf.rect)) } : resolveEndpoint(tail, screens, { hint: named.from });
    if (from.kind === 'none') return { ok: false, reason: 'no-source-screen' };
    if (from.kind === 'ambiguous') return { ok: false, reason: 'ambiguous-source', candidates: from.candidates };

    const rt = remembered(memory.to);
    const to: Endpoint = rt && rt.id !== from.screen.id ? { kind: 'named', screen: rt, offset: Math.round(distanceToRect(head, rt.rect)) } : resolveEndpoint(head, screens, { hint: named.to, exclude: from.screen.id });
    if (to.kind === 'none') return { ok: false, reason: 'no-target-screen' };
    if (to.kind === 'ambiguous') return { ok: false, reason: 'ambiguous-target', candidates: to.candidates };
    if (to.screen.id === from.screen.id) return { ok: false, reason: 'same-screen' };
    return { ok: true, from: from.screen, to: to.screen, fromHow: from.kind, toHow: to.kind, stale: from.offset > EXACT || to.offset > EXACT };
}
