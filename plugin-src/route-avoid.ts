/**
 * Pure helpers that keep arrow labels and lanes clear of flow group boxes. No `figma` global.
 *
 * Arrow LINES may cross a box stroke (perpendicular). A stroke or title must never touch an arrow label,
 * and a lane must not run alongside a stroke closer than `GROUP_CLEAR`.
 */
import { GROUP_CLEAR, GROUP_STROKE, TITLE_LINE_HEIGHT, TITLE_PAD_X, TITLE_PAD_Y, strokeBands } from './flow-group';
import type { Pt, Rect, Route } from './route';

/**
 * What a group box leaves behind on the board: the box rect and its title's planning rect.
 * `strokeWeight` is the box's own stroke; absent = `GROUP_STROKE`.
 * `titleChars` is the title's length in characters, used to estimate where its text ends; absent = `TITLE_FALLBACK_CHARS`.
 */
export type GroupObstacle = { box: Rect; title: Rect; strokeWeight?: number; titleChars?: number };

/** Average glyph width as a fraction of the font size, for estimating title text extents. */
export const TITLE_CHAR_WIDTH = 0.6;
/** Title length assumed when the obstacle does not say. */
export const TITLE_FALLBACK_CHARS = 16;

/**
 * Where a title's text sits: left-aligned `TITLE_PAD_X` in from the bar, `chars x 0.6 x titleSize` wide (capped at the
 * bar's text width), as tall as the bar. The font size is recovered from the bar height. Null for a bar with no height.
 */
export function titleTextRect(g: GroupObstacle): Rect | null {
    if (g.title.height <= 0) return null;
    const size = Math.max(1, (g.title.height - 2 * TITLE_PAD_Y) / TITLE_LINE_HEIGHT);
    const width = Math.min((g.titleChars ?? TITLE_FALLBACK_CHARS) * TITLE_CHAR_WIDTH * size, Math.max(0, g.title.width - 2 * TITLE_PAD_X));
    return { x: g.title.x + TITLE_PAD_X, y: g.title.y, width, height: g.title.height };
}

/** A box rect that carries its own stroke weight. */
export type StrokedBox = Rect & { strokeWeight?: number };

/** A stroke line: vertical (`axis: 'v'`, fixed x) or horizontal (`axis: 'h'`, fixed y), spanning `from`..`to` on the other axis. */
export type Edge = { axis: 'v' | 'h'; at: number; from: number; to: number };

export type LabelSize = { width: number; height: number };
export type ClearLabel = { ok: true; anchor: Pt; moved: boolean } | { ok: false; blocked: string };

/** The four stroke centre lines of a box. */
export function boxEdges(box: StrokedBox): Edge[] {
    const half = (box.strokeWeight ?? GROUP_STROKE) / 2;
    return [
        { axis: 'h', at: box.y + half, from: box.x, to: box.x + box.width },
        { axis: 'h', at: box.y + box.height - half, from: box.x, to: box.x + box.width },
        { axis: 'v', at: box.x + half, from: box.y, to: box.y + box.height },
        { axis: 'v', at: box.x + box.width - half, from: box.y, to: box.y + box.height },
    ];
}

/** Rects a label must not overlap: each box's stroke bands (stroke plus `GROUP_CLEAR` each side) and each title inflated by `GROUP_CLEAR`. */
export function labelObstacles(groups: readonly GroupObstacle[]): Rect[] {
    return groups.flatMap((g) => [
        ...strokeBands(g.box, g.strokeWeight),
        { x: g.title.x - GROUP_CLEAR, y: g.title.y - GROUP_CLEAR, width: g.title.width + 2 * GROUP_CLEAR, height: g.title.height + 2 * GROUP_CLEAR },
    ]);
}

/** True when a segment of `points` runs parallel to a stroke line, within `GROUP_CLEAR` of it, over a stretch longer than 0. */
export function laneConflicts(points: readonly Pt[], edges: readonly Edge[]): boolean {
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1] as Pt;
        const b = points[i] as Pt;
        const vertical = a.x === b.x;
        const horizontal = a.y === b.y;
        if (vertical === horizontal) continue;
        const at = vertical ? a.x : a.y;
        const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
        const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
        for (const e of edges) {
            if (e.axis !== (vertical ? 'v' : 'h')) continue;
            if (Math.abs(e.at - at) >= GROUP_CLEAR) continue;
            if (Math.min(hi, e.to) - Math.max(lo, e.from) > 0) return true;
        }
    }
    return false;
}

const overlapsRect = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const labelRect = (at: Pt, size: LabelSize): Rect => ({ x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height });

/** The point of [lo, hi] closest to `pref` that lies in none of the open `forbidden` intervals, or null. */
function nearestAllowed(lo: number, hi: number, pref: number, forbidden: readonly [number, number][]): number | null {
    const free = (c: number) => forbidden.every(([a, b]) => !(c > a && c < b));
    const cands = [Math.min(Math.max(pref, lo), hi), lo, hi, ...forbidden.flatMap(([a, b]) => [a, b])].filter((c) => c >= lo && c <= hi && free(c));
    if (!cands.length) return null;
    return cands.reduce((best, c) => (Math.abs(c - pref) < Math.abs(best - pref) ? c : best));
}

/** Best spot for the label centre along one segment, nearest `pref`, or null when the whole segment is blocked. */
function slideOnSegment(a: Pt, b: Pt, size: LabelSize, pref: Pt, obstacles: readonly Rect[]): Pt | null {
    const vertical = a.x === b.x;
    const half = (vertical ? size.height : size.width) / 2;
    const min = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    const max = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
    const mid = (min + max) / 2;
    const lo = min + half <= max - half ? min + half : mid;
    const hi = min + half <= max - half ? max - half : mid;
    const forbidden: [number, number][] = [];
    for (const o of obstacles) {
        if (vertical) {
            if (o.x < a.x + size.width / 2 && o.x + o.width > a.x - size.width / 2) forbidden.push([o.y - half, o.y + o.height + half]);
        } else if (o.y < a.y + size.height / 2 && o.y + o.height > a.y - size.height / 2) forbidden.push([o.x - half, o.x + o.width + half]);
    }
    const c = nearestAllowed(lo, hi, vertical ? pref.y : pref.x, forbidden);
    if (c === null) return null;
    return vertical ? { x: a.x, y: c } : { x: c, y: a.y };
}

const dist = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Re-centres an arrow label so it overlaps no obstacle. Keeps the anchor when it is already clear; otherwise slides it
 * along its own segment, then along the other segments of the path, to the nearest clear spot. `blocked` when none exists.
 *
 * Because the obstacle bands cover every point within `GROUP_CLEAR` of a stroke, "nearest clear" on a gutter segment
 * is automatically the stretch outside both boxes (source box right stroke + CLEAR to target box left stroke - CLEAR).
 */
export function clearLabel(route: Route, size: LabelSize, obstacles: readonly Rect[]): ClearLabel {
    const from = route.labelAnchor;
    if (!obstacles.some((o) => overlapsRect(labelRect(from, size), o))) return { ok: true, anchor: from, moved: false };
    let best: Pt | null = null;
    for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1] as Pt;
        const b = route.points[i] as Pt;
        if (a.x !== b.x && a.y !== b.y) continue;
        const spot = slideOnSegment(a, b, size, from, obstacles);
        if (spot && !obstacles.some((o) => overlapsRect(labelRect(spot, size), o)) && (!best || dist(spot, from) < dist(best, from))) best = spot;
    }
    return best ? { ok: true, anchor: best, moved: true } : { ok: false, blocked: 'no spot on the arrow keeps its label 48px clear of group box strokes and titles' };
}

export type LabelItem = { id: string; route: Route; anchor: Pt; size: LabelSize };

/** Minimum gap between two arrow labels. */
export const LABEL_PAD = 8;

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

/**
 * Board-wide label de-overlap. Items are handled in the order given (callers pass `stableArrowOrder`), so the result
 * is deterministic. The first label stays; each later one slides along its own path (`clearLabel`) until it is `pad`
 * clear of `obstacles` and of every label placed before it. `fixed` are label rects that cannot move (arrows not being
 * redrawn). A label with no clear spot keeps its anchor and its id is listed in `blocked`.
 */
export function separateLabels(items: readonly LabelItem[], obstacles: readonly Rect[], pad = LABEL_PAD, fixed: readonly Rect[] = []): { anchors: Map<string, Pt>; blocked: string[] } {
    const anchors = new Map<string, Pt>();
    const blocked: string[] = [];
    const placed: Rect[] = fixed.map((r) => inflate(r, pad));
    for (const it of items) {
        const res = clearLabel({ ...it.route, labelAnchor: it.anchor }, it.size, [...obstacles, ...placed]);
        const at = res.ok ? res.anchor : it.anchor;
        if (!res.ok) blocked.push(it.id);
        anchors.set(it.id, at);
        placed.push(inflate(labelRect(at, it.size), pad));
    }
    return { anchors, blocked };
}

type Run = { axis: 'v' | 'h'; at: number; lo: number; hi: number };

function runsOf(points: readonly Pt[]): Run[] {
    const out: Run[] = [];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1] as Pt;
        const b = points[i] as Pt;
        if (a.x === b.x && a.y !== b.y) out.push({ axis: 'v', at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
        else if (a.y === b.y && a.x !== b.x) out.push({ axis: 'h', at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
    }
    return out;
}

/**
 * Total length two routes share on one line (same axis, same coordinate), the quantity `lines-overlap` measures.
 * `ignore` leaves out the lines of a deliberately merged trunk (`v`: its x) and final run (`h`: its y).
 */
export function sharedRunLength(a: readonly Pt[], b: readonly Pt[], ignore: { v?: number; h?: number } = {}): number {
    const rb = runsOf(b);
    let total = 0;
    for (const s of runsOf(a)) {
        if (s.at === (s.axis === 'v' ? ignore.v : ignore.h)) continue;
        for (const t of rb) if (s.axis === t.axis && s.at === t.at) total += Math.max(0, Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo));
    }
    return total;
}

/** Length two routes run side by side (same axis) closer than `gap` apart but not on the same line. */
export function crowdedRunLength(a: readonly Pt[], b: readonly Pt[], gap: number): number {
    const rb = runsOf(b);
    let total = 0;
    for (const s of runsOf(a)) for (const t of rb) if (s.axis === t.axis && s.at !== t.at && Math.abs(s.at - t.at) < gap) total += Math.max(0, Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo));
    return total;
}

/** How many of `titles` have a segment of `points` strictly through them (the `line-crosses-title` test). */
export function titleHitCount(points: readonly Pt[], titles: readonly Rect[]): number {
    const runs = runsOf(points);
    return titles.filter((r) =>
        runs.some((s) => (s.axis === 'v' ? s.at > r.x && s.at < r.x + r.width && s.hi > r.y && s.lo < r.y + r.height : s.at > r.y && s.at < r.y + r.height && s.hi > r.x && s.lo < r.x + r.width)),
    ).length;
}

/** How many of `screens` a segment of `points` passes through (strictly inside, more than 1px), ignoring screens equal to `except`. */
export function screensCrossed(points: readonly Pt[], screens: readonly Rect[], except: readonly Rect[] = []): number {
    const runs = runsOf(points);
    const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    return screens.filter(
        (r) =>
            !except.some((e) => same(e, r)) &&
            runs.some((s) => (s.axis === 'v' ? s.at > r.x + 1 && s.at < r.x + r.width - 1 && s.hi > r.y + 1 && s.lo < r.y + r.height - 1 : s.at > r.y + 1 && s.at < r.y + r.height - 1 && s.hi > r.x + 1 && s.lo < r.x + r.width - 1)),
    ).length;
}
