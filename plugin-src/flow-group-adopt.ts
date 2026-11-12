/**
 * Pure detection for adopt_flow_groups: finds hand-drawn group boxes (stroked, unfilled rectangles/frames around screens)
 * and `Section Heading` instances in plain node data, and plans flow groups from them. No `figma` global.
 */
import type { Rect } from './rect';

export type CandidateType = 'RECTANGLE' | 'FRAME' | 'TEXT' | 'INSTANCE';
export type Candidate = { id: string; type: CandidateType; name: string; rect: Rect; hasStroke: boolean; fillAlpha: number; text?: string; parentId?: string };
export type ScreenRect = { id: string; name: string; rect: Rect };
export type AdoptInput = { candidates: readonly Candidate[]; screens: readonly ScreenRect[] };

export type PlannedGroup = {
    key: string;
    name: string;
    /** Screens this group owns directly (innermost group wins). */
    memberIds: string[];
    /** Every screen inside it, children's included. Create the parent with these, then the child takes its own. */
    allMemberIds: string[];
    parentKey?: string;
    /** Old nodes the group replaces: [box?, title?]. */
    sourceNodeIds: string[];
    source: 'box' | 'heading';
    confidence: 'high' | 'medium' | 'low';
    notes: string[];
};
export type SkippedItem = { id: string; name: string; reason: string };
export type AdoptPlan = { groups: PlannedGroup[]; skipped: SkippedItem[] };

const TOL = 1;
const MAX_FILL = 0.3;
const ABOVE_GAP = 400;
const TOP_BAND = 0.25;
const EXCLUDED_NAME = /^(Flow groups\s*·|Board background\s*·|Flow arrows|Flow arrow labels|Arrows)/;
const HEADING_NAME = /^Section Heading/;

const area = (r: Rect): number => r.width * r.height;
const contains = (o: Rect, i: Rect): boolean => i.x >= o.x - TOL && i.y >= o.y - TOL && i.x + i.width <= o.x + o.width + TOL && i.y + i.height <= o.y + o.height + TOL;
const hOverlap = (a: Rect, b: Rect): boolean => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > TOL;
const centerX = (r: Rect): number => r.x + r.width / 2;

const isHeading = (c: Candidate): boolean => c.type === 'INSTANCE' && HEADING_NAME.test(c.name);

/** Title text of a TEXT node or Section Heading instance, or null when blank. */
export function titleOf(c: Candidate): string | null {
    const raw = c.text?.trim() || (isHeading(c) ? c.name.replace(/^Section Heading\s*[·:\-–—]?\s*/, '').trim() : '');
    return raw || null;
}

type Box = { c: Candidate; parent?: Box; depth: number };

export function planAdopt(input: AdoptInput): AdoptPlan {
    const skipped: SkippedItem[] = [];
    const screenIds = new Set(input.screens.map((s) => s.id));
    const live = input.candidates.filter((c) => !screenIds.has(c.id) && !EXCLUDED_NAME.test(c.name));
    const insideScreen = (c: Candidate): boolean => input.screens.some((s) => contains(s.rect, c.rect));

    const rawBoxes = live
        .filter((c) => (c.type === 'RECTANGLE' || c.type === 'FRAME') && c.hasStroke && c.fillAlpha <= MAX_FILL && !insideScreen(c))
        .filter((c) => input.screens.some((s) => contains(c.rect, s.rect)))
        .sort((a, b) => area(b.rect) - area(a.rect));

    const kept: Box[] = [];
    for (const c of rawBoxes) {
        const parent = [...kept].reverse().find((k) => contains(k.c.rect, c.rect) && k.c.id !== c.id);
        const depth = parent ? parent.depth + 1 : 0;
        if (depth > 1) {
            skipped.push({ id: c.id, name: c.name, reason: `nesting deeper than one level (inside "${parent?.c.name}"); its screens stay with the enclosing group` });
            continue;
        }
        kept.push({ c, ...(parent ? { parent } : {}), depth });
    }

    const titleCands = live.filter((c) => (c.type === 'TEXT' && titleOf(c)) || isHeading(c)).filter((c) => !insideScreen(c));
    const used = new Set<string>();
    const titles = new Map<string, Candidate>();
    for (const b of [...kept].sort((x, y) => area(x.c.rect) - area(y.c.rect))) {
        const r = b.c.rect;
        const children = kept.filter((k) => k.parent === b);
        let best: { t: Candidate; d: number } | null = null;
        for (const t of titleCands) {
            if (used.has(t.id) || !hOverlap(t.rect, r)) continue;
            if (children.some((k) => contains(k.c.rect, t.rect))) continue;
            const bottom = t.rect.y + t.rect.height;
            let d: number;
            if (bottom <= r.y + TOL) d = r.y - bottom > ABOVE_GAP ? Infinity : r.y - bottom;
            else if (t.rect.y >= r.y - TOL && contains(r, t.rect) && t.rect.y - r.y <= r.height * TOP_BAND) d = t.rect.y - r.y;
            else d = Infinity;
            if (d !== Infinity && (!best || d < best.d)) best = { t, d };
        }
        if (best) {
            used.add(best.t.id);
            titles.set(b.c.id, best.t);
        }
    }

    const owner = (s: ScreenRect): Box | undefined => kept.filter((b) => contains(b.c.rect, s.rect)).sort((a, b) => area(a.c.rect) - area(b.c.rect))[0];
    const own = new Map<string, string[]>();
    for (const s of input.screens) {
        const o = owner(s);
        if (o) own.set(o.c.id, [...(own.get(o.c.id) ?? []), s.id]);
    }

    const ordered = [...kept].sort((a, b) => a.c.rect.y - b.c.rect.y || a.c.rect.x - b.c.rect.x);
    const groups: PlannedGroup[] = [];
    let n = 0;
    for (const b of ordered) {
        const t = titles.get(b.c.id);
        const title = t ? titleOf(t) : null;
        const memberIds = own.get(b.c.id) ?? [];
        const allMemberIds = input.screens.filter((s) => contains(b.c.rect, s.rect)).map((s) => s.id);
        const notes: string[] = [];
        if (!title) {
            n += 1;
            notes.push('no title found near the box');
        }
        if (!memberIds.length) notes.push('screens all belong to child groups');
        groups.push({
            key: `box:${b.c.id}`,
            name: title ?? `Group ${n}`,
            memberIds,
            allMemberIds,
            ...(b.parent ? { parentKey: `box:${b.parent.c.id}` } : {}),
            sourceNodeIds: t ? [b.c.id, t.id] : [b.c.id],
            source: 'box',
            confidence: title ? 'high' : 'medium',
            notes,
        });
    }

    const takenByBox = new Set(groups.flatMap((g) => g.allMemberIds));
    const headings = live.filter((c) => isHeading(c) && !used.has(c.id) && !insideScreen(c)).sort((a, b) => a.rect.y - b.rect.y);
    for (const h of headings) {
        const hb = h.rect.y + h.rect.height;
        const next = headings.find((o) => o.rect.y > h.rect.y + TOL && hOverlap(o.rect, h.rect));
        const limit = next ? next.rect.y : Infinity;
        const inBand = input.screens.filter((s) => s.rect.y >= hb - TOL && s.rect.y < limit && centerX(s.rect) >= h.rect.x && centerX(s.rect) <= h.rect.x + h.rect.width);
        const free = inBand.filter((s) => !takenByBox.has(s.id));
        if (!free.length) {
            skipped.push({ id: h.id, name: h.name, reason: inBand.length ? 'every screen below it is already in a box group' : 'no screens below this heading within its width' });
            continue;
        }
        const title = titleOf(h);
        const notes = ['screens below the heading, within its width, down to the next heading'];
        if (free.length < inBand.length) notes.push(`${inBand.length - free.length} screen(s) left to their box groups`);
        if (!title) n += 1;
        groups.push({
            key: `heading:${h.id}`,
            name: title ?? `Group ${n}`,
            memberIds: free.map((s) => s.id),
            allMemberIds: free.map((s) => s.id),
            sourceNodeIds: [h.id],
            source: 'heading',
            confidence: 'medium',
            notes,
        });
    }
    return { groups, skipped };
}
