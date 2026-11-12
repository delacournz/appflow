import { overlapsAny } from './duplicate-plan';
import type { GroupMeta, GroupStyle } from './flowmeta';
import { unionRect, type Rect } from './rect';
import { ROUTE_ABOVE } from './screen-group';
import { cleanExtras, type Band } from './tracks';

/**
 * Pure geometry for flow groups: labelled boxes around sets of screens on a flow board.
 * No `figma` global. Storage and rendering live elsewhere (GRP-3).
 *
 * A box is a rect with an INSIDE stroke (default 12px), so the rect bounds are the visual bounds.
 * The title is a filled bar (auto-layout frame) sitting flush on the box's top edge, the same width and x as the box;
 * its planning rect is the bar. Flush (not floating above) so the bar and box read as one labelled panel, and the bar
 * needs no gap constant to keep consistent.
 * Padding, stroke weight and title size are per-group (`GroupStyle`); the constants below are only defaults.
 * Arrow lines may cross a stroke. Strokes and titles must never touch screens, route text, badges,
 * arrow labels, other boxes or other titles.
 */

/**
 * Member content to the inner stroke edge. 160 = 20 x the 8px grid: it clears the 12px stroke and the 48px `GROUP_CLEAR`
 * with ~100px of breathing room, and is ~40% of a 393px screen, so route text and badges no longer crowd the line.
 */
export const GROUP_PAD = 160;
export const GROUP_STROKE = 12;
/** Minimum distance from a stroke to any non-member content or arrow label. */
export const GROUP_CLEAR = 48;
export const TITLE_SIZE = 96;
/** Title bar padding around the text (vertical, horizontal). */
export const TITLE_PAD_Y = 48;
export const TITLE_PAD_X = 64;
/** Default title bar fill and title text colour. */
export const TITLE_FILL = '#2C2C2C';
export const TITLE_COLOR = '#FFFFFF';
/** A nested child's title is this fraction of `TITLE_SIZE`. */
export const CHILD_TITLE_SCALE = 0.66;
/** Estimated line height multiplier used for planning before the text is rendered. */
export const TITLE_LINE_HEIGHT = 1.2;
/** Space reserved above the route text for Figma's own frame title. */
export const FRAME_TITLE_CLEAR = 28;
/** How far a screen's content reaches above its frame: route text line plus frame title clearance. */
export const ROUTE_TOP = ROUTE_ABOVE + FRAME_TITLE_CLEAR;

export type { GroupMeta, GroupStyle };

export type Cell = { col: number; row: number };
export type FittedBox = { box: Rect; title: Rect };

/** Per-group spacing options (a subset of `GroupStyle`). */
export type BoxMetrics = { padding: number; strokeWeight: number; titleSize: number };

/** The metrics a group gets when its style says nothing; a nested child's title is smaller. */
export const defaultMetrics = (nested = false): BoxMetrics => ({
    padding: GROUP_PAD,
    strokeWeight: GROUP_STROKE,
    titleSize: nested ? Math.round(TITLE_SIZE * CHILD_TITLE_SCALE) : TITLE_SIZE,
});

/** Line height of the title text in px: set explicitly on the node so planning and rendering agree. */
export const titleLineOf = (size: number): number => Math.ceil(size * TITLE_LINE_HEIGHT);

/** Height of a title bar at `size`: one line of text plus vertical padding. Exact, since the line height is pinned. */
export const titleHeightOf = (size: number): number => titleLineOf(size) + 2 * TITLE_PAD_Y;

/** Distance from member content to a box's outer edge. */
export const edgeOf = (m: BoxMetrics): number => m.padding + m.strokeWeight;

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });
const overlaps = (a: Rect, b: Rect): boolean => overlapsAny(a, [b]) === 0;
const contains = (outer: Rect, inner: Rect): boolean =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** A screen's footprint for grouping: frame, route text and badge, plus `ROUTE_TOP` above the frame. */
export function memberContentRect(frame: Rect, route?: Rect, badge?: Rect): Rect {
    const topLine = Math.min(frame.y - ROUTE_ABOVE, route?.y ?? Infinity, badge?.y ?? Infinity);
    const head: Rect = { x: frame.x, y: topLine - FRAME_TITLE_CLEAR, width: frame.width, height: frame.y - (topLine - FRAME_TITLE_CLEAR) };
    return unionRect([frame, head, ...(route ? [route] : []), ...(badge ? [badge] : [])]) as Rect;
}

/**
 * The box around `members` (and any nested `children`: their boxes and title bars), padded by padding+stroke,
 * and the title bar rect flush on top of it, the box's width.
 */
export function fitBox(members: readonly Rect[], children: readonly FittedBox[] = [], metrics: BoxMetrics = defaultMetrics()): FittedBox {
    const content = unionRect([...members, ...children.flatMap((c) => [c.box, c.title])]);
    if (!content) throw new Error('fitBox needs at least one member or child');
    const box = inflate(content, edgeOf(metrics));
    const height = titleHeightOf(metrics.titleSize);
    const title: Rect = { x: box.x, y: box.y - height, width: box.width, height };
    return { box, title };
}

/** Four thin rects (top, bottom, left, right) covering the stroke, each inflated by `GROUP_CLEAR`. Content must stay out of these. */
export function strokeBands(box: Rect, stroke: number = GROUP_STROKE): [Rect, Rect, Rect, Rect] {
    const t = stroke + 2 * GROUP_CLEAR;
    const w = box.width + 2 * GROUP_CLEAR;
    const h = box.height + 2 * GROUP_CLEAR;
    return [
        { x: box.x - GROUP_CLEAR, y: box.y - GROUP_CLEAR, width: w, height: t },
        { x: box.x - GROUP_CLEAR, y: box.y + box.height - stroke - GROUP_CLEAR, width: w, height: t },
        { x: box.x - GROUP_CLEAR, y: box.y - GROUP_CLEAR, width: t, height: h },
        { x: box.x + box.width - stroke - GROUP_CLEAR, y: box.y - GROUP_CLEAR, width: t, height: h },
    ];
}

export type BoundaryGroup = {
    id: string;
    parentId?: string;
    /** Grid cells of the group's own screens. A parent's range also covers its children. */
    cells: readonly Cell[];
    /** This group's own spacing; absent = defaults (smaller title when nested). */
    metrics?: BoxMetrics;
};

export type BoundaryInput = {
    groups: readonly BoundaryGroup[];
    /** Cells holding screens that belong to no group. */
    ungrouped: readonly Cell[];
    base: { colWidth: number; rowHeight: number; screenW: number; screenH: number };
    /** Part of the base gap kept free for arrow lanes and labels. */
    laneBand: number;
};

export type BoundaryExtras = { colExtra: Band[]; rowExtra: Band[] };

type Range = { c0: number; c1: number; r0: number; r1: number };

const rangeOf = (cells: readonly Cell[]): Range | null => {
    if (!cells.length) return null;
    return {
        c0: Math.min(...cells.map((c) => c.col)),
        c1: Math.max(...cells.map((c) => c.col)),
        r0: Math.min(...cells.map((c) => c.row)),
        r1: Math.max(...cells.map((c) => c.row)),
    };
};
const inRange = (r: Range, col: number, row: number): boolean => col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1;

/**
 * Extra px needed BEFORE each column/row track so that, wherever one group's edge meets another group
 * or ungrouped content, padding + stroke + clear (+ title bar on rows, + nested bands) fit next to the lane band.
 * Each group uses its bounding cell range, so L-shapes and sparse groups are covered. Row tracks need title
 * height and `ROUTE_TOP`; column tracks do not. Bands use the index of the track after the boundary as `at`.
 *
 * Extras are BAND-SCOPED: a column boundary only widens the rows where content on its two sides actually meets
 * (a row boundary only the columns), so screens elsewhere on the board stay put.
 * 1. Trigger lines: where a group edge or ungrouped content meets something across the boundary. Consecutive
 *    trigger lines form one band, with the largest extra among them.
 * 2. No group may tear. A band carries to every later track on its lines, so a group whose screens get different
 *    shifts is repaired: at the first track where the shifts differ, the lines that fell short get a band for the
 *    missing amount (union of bands = every line of the group's span sees the same extras). That stretches a band
 *    over a group that straddles the boundary, and gives a group lying wholly past it a compensating band at its
 *    own first track instead of dragging unrelated content between. Repeated until nothing changes (transitive).
 * Groups that end before the boundary are never touched: nothing of theirs moves.
 */
export function boundaryExtras(input: BoundaryInput): BoundaryExtras {
    const { groups, ungrouped, base, laneBand } = input;
    const ranges = new Map<string, Range>();
    for (const g of groups) {
        const own = [...g.cells, ...groups.filter((k) => k.parentId === g.id).flatMap((k) => k.cells)];
        const r = rangeOf(own);
        if (r) ranges.set(g.id, r);
    }
    const ungroupedKeys = new Set(ungrouped.map((c) => `${c.col},${c.row}`));
    const ranged = groups.filter((g) => ranges.has(g.id));

    const chainAt = (col: number, row: number): BoundaryGroup[] =>
        ranged
            .filter((g) => inRange(ranges.get(g.id) as Range, col, row))
            .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId));
    const occupied = (col: number, row: number, chain: BoundaryGroup[]): boolean => chain.length > 0 || ungroupedKeys.has(`${col},${row}`);

    const allRanges = [...ranges.values()];
    const cols = [...allRanges.flatMap((r) => [r.c0, r.c1]), ...ungrouped.map((c) => c.col)];
    const rows = [...allRanges.flatMap((r) => [r.r0, r.r1]), ...ungrouped.map((c) => c.row)];
    if (!cols.length) return { colExtra: [], rowExtra: [] };
    const [minC, maxC, minR, maxR] = [Math.min(...cols), Math.max(...cols), Math.min(...rows), Math.max(...rows)];

    const metricsOf = (g: BoundaryGroup): BoxMetrics => g.metrics ?? defaultMetrics(!!g.parentId);
    const titleOf = (g: BoundaryGroup): number => titleHeightOf(metricsOf(g).titleSize);

    /** Distance needed between the content on either side of a boundary, before the lane band is added. */
    const needed = (a: BoundaryGroup[], b: BoundaryGroup[], vertical: boolean): number | null => {
        const ids = (xs: BoundaryGroup[]) => new Set(xs.map((g) => g.id));
        const [idsA, idsB] = [ids(a), ids(b)];
        const exits = a.filter((g) => !idsB.has(g.id));
        const entries = b.filter((g) => !idsA.has(g.id));
        if (!exits.length && !entries.length) return null;
        const edges = [...exits, ...entries].reduce((sum, g) => sum + edgeOf(metricsOf(g)), 0);
        const clears = ((exits.length ? 1 : 0) + (entries.length ? 1 : 0)) * GROUP_CLEAR;
        const titles = vertical ? entries.reduce((s, g) => s + titleOf(g), 0) + ROUTE_TOP : 0;
        return edges + clears + titles;
    };

    const extraFor = (need: number, baseGap: number): number => Math.max(0, Math.ceil(need + laneBand - baseGap));

    type Axis = {
        /** Boundary tracks to test (the track after each boundary). */
        tracks: number[];
        /** Lines of the other axis that are scanned for a trigger. */
        lines: number[];
        /** The cells either side of boundary `t` on line `l`. */
        sides: (t: number, l: number) => [[number, number], [number, number]];
        vertical: boolean;
        baseGap: number;
        /** The tracks a group range covers on this axis, and the lines of the other axis it spans. */
        reach: (r: Range) => [number, number];
        span: (r: Range) => [number, number];
    };
    const range = (lo: number, hi: number): number[] => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
    const colAxis: Axis = {
        tracks: range(minC + 1, maxC),
        lines: range(minR, maxR),
        sides: (t, l) => [[t - 1, l], [t, l]],
        vertical: false,
        baseGap: base.colWidth - base.screenW,
        reach: (r) => [r.c0, r.c1],
        span: (r) => [r.r0, r.r1],
    };
    const rowAxis: Axis = {
        tracks: range(minR + 1, maxR),
        lines: range(minC, maxC),
        sides: (t, l) => [[l, t - 1], [l, t]],
        vertical: true,
        baseGap: base.rowHeight - base.screenH,
        reach: (r) => [r.r0, r.r1],
        span: (r) => [r.c0, r.c1],
    };

    const bandsOf = (axis: Axis): Band[] => {
        const out: Band[] = [];
        for (const t of axis.tracks) {
            const triggers = new Map<number, number>();
            for (const l of axis.lines) {
                const [[ac, ar], [bc, br]] = axis.sides(t, l);
                const [a, b] = [chainAt(ac, ar), chainAt(bc, br)];
                if (!occupied(ac, ar, a) || !occupied(bc, br, b)) continue;
                const n = needed(a, b, axis.vertical);
                if (n === null) continue;
                const extra = extraFor(n, axis.baseGap);
                if (extra > 0) triggers.set(l, Math.max(triggers.get(l) ?? 0, extra));
            }
            if (!triggers.size) continue;
            const sorted = [...triggers.keys()].sort((a, b) => a - b);
            let runStart = sorted[0] as number;
            let prev = runStart;
            const flush = (end: number) => {
                const px = Math.max(...[...triggers].filter(([l]) => l >= runStart && l <= end).map(([, v]) => v));
                out.push({ at: t, from: runStart, to: end, px });
            };
            for (const l of sorted.slice(1)) {
                if (l === prev + 1) {
                    prev = l;
                    continue;
                }
                flush(prev);
                runStart = l;
                prev = l;
            }
            flush(prev);
        }
        return out;
    };

    /** Adds bands until every group sees the same extras on all its lines, so no box tears. */
    const untear = (axis: Axis, primary: Band[]): Band[] => {
        let cur = cleanExtras(primary);
        for (let pass = 0; pass < 64; pass++) {
            const added: Band[] = [];
            for (const r of allRanges) {
                const [a0, a1] = axis.reach(r);
                const [l0, l1] = axis.span(r);
                const offsets = (a: number) => range(l0, l1).map((l) => cur.reduce((s, b) => (b.at <= a && l >= b.from && l <= b.to ? s + b.px : s), 0));
                for (let a = a0; a <= a1; a++) {
                    const offs = offsets(a);
                    const target = Math.max(...offs);
                    if (offs.every((o) => o === target)) continue;
                    const deficits = new Map<number, number[]>();
                    offs.forEach((o, i) => {
                        if (o < target) deficits.set(target - o, [...(deficits.get(target - o) ?? []), l0 + i]);
                    });
                    for (const [px, lines] of deficits) {
                        let from = lines[0] as number;
                        lines.forEach((l, i) => {
                            if (lines[i + 1] === l + 1) return;
                            added.push({ at: a, from, to: l, px });
                            from = lines[i + 1] as number;
                        });
                    }
                    break;
                }
            }
            if (!added.length) break;
            cur = cleanExtras([...cur, ...added]);
        }
        return cur;
    };

    return { colExtra: untear(colAxis, bandsOf(colAxis)), rowExtra: untear(rowAxis, bandsOf(rowAxis)) };
}

export type ConflictGroup = { id: string; parentId?: string; box: Rect; title: Rect; strokeWeight?: number };
export type ConflictContentKind = 'screen' | 'route' | 'badge' | 'label';
export type ConflictContent = { kind: ConflictContentKind; id: string; rect: Rect; ownerGroupId?: string };

export type GroupIssue =
    | { kind: 'group-crosses-content'; groupId: string; contentId: string; contentKind: Exclude<ConflictContentKind, 'label'> }
    | { kind: 'group-crosses-label'; groupId: string; labelId: string }
    | { kind: 'group-overlaps-group'; groupId: string; otherId: string }
    | { kind: 'group-encloses-foreign'; groupId: string; screenId: string }
    | { kind: 'title-overlaps'; groupId: string; withKind: ConflictContentKind | 'title' | 'box'; withId: string };

/**
 * Everything wrong with a set of fitted groups. Stroke bands (stroke + CLEAR) must miss all content;
 * titles must miss content, other titles and other boxes' bands; unrelated boxes must stay CLEAR apart.
 * A child fully inside its declared parent is allowed. Non-member screens may not sit inside a box.
 */
export function groupConflicts(groups: readonly ConflictGroup[], contents: readonly ConflictContent[]): GroupIssue[] {
    const issues: GroupIssue[] = [];
    const descendants = (id: string): Set<string> => new Set([id, ...groups.filter((g) => g.parentId === id).map((g) => g.id)]);

    for (const g of groups) {
        const bands = strokeBands(g.box, g.strokeWeight);
        const titleZone = inflate(g.title, GROUP_CLEAR);
        const family = descendants(g.id);
        for (const c of contents) {
            if (overlapsAny(c.rect, bands) >= 0) {
                issues.push(
                    c.kind === 'label'
                        ? { kind: 'group-crosses-label', groupId: g.id, labelId: c.id }
                        : { kind: 'group-crosses-content', groupId: g.id, contentId: c.id, contentKind: c.kind },
                );
            }
            if (c.kind === 'screen' && overlaps(c.rect, g.box) && !(c.ownerGroupId && family.has(c.ownerGroupId))) {
                issues.push({ kind: 'group-encloses-foreign', groupId: g.id, screenId: c.id });
            }
            if (overlaps(titleZone, c.rect)) issues.push({ kind: 'title-overlaps', groupId: g.id, withKind: c.kind, withId: c.id });
        }
        for (const o of groups) {
            if (o.id === g.id) continue;
            if (overlapsAny(g.title, strokeBands(o.box, o.strokeWeight)) >= 0) issues.push({ kind: 'title-overlaps', groupId: g.id, withKind: 'box', withId: o.id });
            if (g.id < o.id && overlaps(g.title, o.title)) issues.push({ kind: 'title-overlaps', groupId: g.id, withKind: 'title', withId: o.id });
        }
    }

    for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
            const [a, b] = [groups[i] as ConflictGroup, groups[j] as ConflictGroup];
            const child = a.parentId === b.id ? a : b.parentId === a.id ? b : null;
            const parent = child === a ? b : a;
            const bad = child ? overlaps(child.box, parent.box) && !contains(parent.box, child.box) : overlaps(inflate(a.box, GROUP_CLEAR), b.box);
            if (bad) issues.push({ kind: 'group-overlaps-group', groupId: a.id, otherId: b.id });
        }
    }
    return issues;
}

export type NestingIssue =
    | { kind: 'nesting-too-deep'; groupId: string }
    | { kind: 'child-outside-parent'; groupId: string; parentId: string }
    | { kind: 'parent-missing'; groupId: string; parentId: string };

/** One level of nesting only; a child's box must lie fully inside its parent's. */
export function validateNesting(groups: readonly ConflictGroup[]): NestingIssue[] {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const issues: NestingIssue[] = [];
    for (const g of groups) {
        if (!g.parentId) continue;
        const parent = byId.get(g.parentId);
        if (!parent) {
            issues.push({ kind: 'parent-missing', groupId: g.id, parentId: g.parentId });
            continue;
        }
        if (parent.parentId) issues.push({ kind: 'nesting-too-deep', groupId: g.id });
        if (!contains(parent.box, g.box)) issues.push({ kind: 'child-outside-parent', groupId: g.id, parentId: parent.id });
    }
    return issues;
}
