/** Pure matching heuristics for adopting an existing flow board. No `figma` global. */

import type { Pt, Rect } from './route';

export type Grid = { originX: number; originY: number; colWidth: number; rowHeight: number; screenW: number; screenH: number };

export const DEFAULT_GUTTER = 307;
export const DEFAULT_ROW_GAP = 260;

/** The most common value, clustering values within `tolerance` of each other. `null` for an empty list. */
export function modeOf(values: readonly number[], tolerance: number): number | null {
    let best: { value: number; count: number } | null = null;
    for (const v of values) {
        const count = values.filter((o) => Math.abs(o - v) <= tolerance).length;
        const current = best as { value: number; count: number } | null;
        if (!current || count > current.count) best = { value: v, count };
    }
    return best ? (best as { value: number; count: number }).value : null;
}

const distinct = (values: number[], tolerance: number): number[] => {
    const out: number[] = [];
    for (const v of [...values].sort((a, b) => a - b)) if (!out.length || v - (out[out.length - 1] as number) > tolerance) out.push(v);
    return out;
};

const gaps = (positions: number[]): number[] => positions.slice(1).map((p, i) => p - (positions[i] as number));

/** Column width and row height are the most common spacing between screen origins. */
export function inferGrid(screens: readonly Rect[]): Grid {
    const screenW = modeOf(screens.map((s) => s.width), 1) ?? 393;
    const screenH = modeOf(screens.map((s) => s.height), 1) ?? 852;
    const xs = distinct(screens.map((s) => s.x), 4);
    const ys = distinct(screens.map((s) => s.y), 4);
    const colWidth = modeOf(gaps(xs), 4) ?? screenW + DEFAULT_GUTTER;
    const rowHeight = modeOf(gaps(ys), 4) ?? screenH + DEFAULT_ROW_GAP;
    return { originX: xs[0] ?? 0, originY: ys[0] ?? 0, colWidth: Math.round(colWidth), rowHeight: Math.round(rowHeight), screenW, screenH };
}

export function distanceToRect(p: Pt, r: Rect): number {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
    return Math.hypot(dx, dy);
}

/** The screen nearest to a point, if one is within `tolerance`. Never guesses beyond it. */
export function matchScreenAt(p: Pt, screens: readonly { id: string; rect: Rect }[], tolerance = 14, exclude?: string): { id: string; rect: Rect } | null {
    let best: { s: { id: string; rect: Rect }; d: number } | null = null;
    for (const s of screens) {
        if (s.id === exclude) continue;
        const d = distanceToRect(p, s.rect);
        const current = best as { s: { id: string; rect: Rect }; d: number } | null;
        if (d <= tolerance && (!current || d < current.d)) best = { s, d };
    }
    return best ? (best as { s: { id: string; rect: Rect }; d: number }).s : null;
}

export type TriggerCandidate = { id: string; rect: Rect; destinationId: string | null };

/**
 * The control an arrow tail starts from: level with the tail (vertically within its bounds) and no more than
 * `reach` px to its side. Among several, prefer the one whose reaction goes to `targetId`, then the nearest, then the smallest.
 */
export function matchTrigger(tail: Pt, triggers: readonly TriggerCandidate[], targetId: string, reach = 40): TriggerCandidate | null {
    const level = triggers.filter((t) => tail.y >= t.rect.y - 2 && tail.y <= t.rect.y + t.rect.height + 2 && distanceToRect(tail, t.rect) <= reach);
    if (!level.length) return null;
    const rank = (t: TriggerCandidate) => [t.destinationId === targetId ? 0 : 1, Math.round(distanceToRect(tail, t.rect)), t.rect.width * t.rect.height];
    return [...level].sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return (ra[0] as number) - (rb[0] as number) || (ra[1] as number) - (rb[1] as number) || (ra[2] as number) - (rb[2] as number);
    })[0] as TriggerCandidate;
}

export function nearestUnclaimed<T extends { id: string; center: Pt }>(p: Pt, items: readonly T[], within: number, claimed: ReadonlySet<string>): T | null {
    let best: { item: T; d: number } | null = null;
    for (const item of items) {
        if (claimed.has(item.id)) continue;
        const d = Math.hypot(item.center.x - p.x, item.center.y - p.y);
        const current = best as { item: T; d: number } | null;
        if (d <= within && (!current || d < current.d)) best = { item, d };
    }
    return best ? (best as { item: T; d: number }).item : null;
}

export function longestSegmentMid(points: readonly Pt[]): Pt {
    let best = -1;
    let at: Pt = points[0] ?? { x: 0, y: 0 };
    points.slice(1).forEach((p, i) => {
        const a = points[i] as Pt;
        const len = Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
        if (len > best) {
            best = len;
            at = { x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 };
        }
    });
    return at;
}

/** A screen's label and route texts, found by position above it (label at y-72, route at y-40) rather than by name. */
export function assignScreenTexts(screen: Rect, texts: readonly { id: string; name: string; rect: Rect }[]): { labelId: string | null; routeId: string | null } {
    const find = (prefix: string, offset: number) =>
        texts.find((t) => t.name.startsWith(prefix) && Math.abs(t.rect.x - screen.x) <= 2 && Math.abs(t.rect.y - (screen.y - offset)) <= 14)?.id ?? null;
    return { labelId: find('Label ·', 72), routeId: find('Route ·', 40) };
}
