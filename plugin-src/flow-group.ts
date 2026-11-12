import { overlapsAny } from './duplicate-plan';
import type { GroupMeta, GroupStyle } from './flowmeta';
import { unionRect, type Rect } from './rect';
import { ROUTE_ABOVE } from './screen-group';

/**
 * Pure geometry for flow groups: labelled boxes around sets of screens on a flow board.
 * No `figma` global. Storage and rendering live elsewhere (GRP-3).
 *
 * A box is a rect with a 4px INSIDE stroke, so the rect bounds are the visual bounds.
 * The title is a text node centred above the box; its planning rect spans the box width.
 * Arrow lines may cross a stroke. Strokes and titles must never touch screens, route text, badges,
 * arrow labels, other boxes or other titles.
 */

/** Member content to the inner stroke edge. */
export const GROUP_PAD = 64;
export const GROUP_STROKE = 4;
/** Minimum distance from a stroke to any non-member content or arrow label. */
export const GROUP_CLEAR = 48;
export const TITLE_SIZE = 96;
/** Space between the title's bottom and the box's top edge. */
export const TITLE_GAP = 32;
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

/** Estimated rendered height of a title at `size`. */
export const titleHeightOf = (size: number): number => Math.ceil(size * TITLE_LINE_HEIGHT);

const EDGE = GROUP_PAD + GROUP_STROKE;

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
 * The box around `members` (and any nested `children`: their boxes and titles), padded by PAD+STROKE,
 * and the title rect centred above it. `titleHeight` is the title's own height (child titles are smaller).
 */
export function fitBox(members: readonly Rect[], children: readonly FittedBox[] = [], titleHeight: number = titleHeightOf(TITLE_SIZE)): FittedBox {
    const content = unionRect([...members, ...children.flatMap((c) => [c.box, c.title])]);
    if (!content) throw new Error('fitBox needs at least one member or child');
    const box = inflate(content, EDGE);
    const title: Rect = { x: box.x, y: box.y - TITLE_GAP - titleHeight, width: box.width, height: titleHeight };
    return { box, title };
}

/** Four thin rects (top, bottom, left, right) covering the stroke, each inflated by `GROUP_CLEAR`. Content must stay out of these. */
export function strokeBands(box: Rect): [Rect, Rect, Rect, Rect] {
    const t = GROUP_STROKE + 2 * GROUP_CLEAR;
    const w = box.width + 2 * GROUP_CLEAR;
    const h = box.height + 2 * GROUP_CLEAR;
    return [
        { x: box.x - GROUP_CLEAR, y: box.y - GROUP_CLEAR, width: w, height: t },
        { x: box.x - GROUP_CLEAR, y: box.y + box.height - GROUP_STROKE - GROUP_CLEAR, width: w, height: t },
        { x: box.x - GROUP_CLEAR, y: box.y - GROUP_CLEAR, width: t, height: h },
        { x: box.x + box.width - GROUP_STROKE - GROUP_CLEAR, y: box.y - GROUP_CLEAR, width: t, height: h },
    ];
}

export type BoundaryGroup = {
    id: string;
    parentId?: string;
    /** Grid cells of the group's own screens. A parent's range also covers its children. */
    cells: readonly Cell[];
};

export type BoundaryInput = {
    groups: readonly BoundaryGroup[];
    /** Cells holding screens that belong to no group. */
    ungrouped: readonly Cell[];
    base: { colWidth: number; rowHeight: number; screenW: number; screenH: number };
    /** Part of the base gap kept free for arrow lanes and labels. */
    laneBand: number;
};

export type BoundaryExtras = { colExtra: Record<number, number>; rowExtra: Record<number, number> };

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
 * or ungrouped content, padding + stroke + clear (+ title on rows, + nested bands) fit next to the lane band.
 * Each group uses its bounding cell range, so L-shapes and sparse groups are covered. Row tracks need title
 * height and `ROUTE_TOP`; column tracks do not. Keys are the index of the track after the boundary.
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
    const colExtra: Record<number, number> = {};
    const rowExtra: Record<number, number> = {};
    if (!cols.length) return { colExtra, rowExtra };
    const [minC, maxC, minR, maxR] = [Math.min(...cols), Math.max(...cols), Math.min(...rows), Math.max(...rows)];

    const titleOf = (g: BoundaryGroup): number => titleHeightOf(g.parentId ? TITLE_SIZE * CHILD_TITLE_SCALE : TITLE_SIZE) + TITLE_GAP;

    /** Distance needed between the content on either side of a boundary, before the lane band is added. */
    const needed = (a: BoundaryGroup[], b: BoundaryGroup[], vertical: boolean): number | null => {
        const ids = (xs: BoundaryGroup[]) => new Set(xs.map((g) => g.id));
        const [idsA, idsB] = [ids(a), ids(b)];
        const exits = a.filter((g) => !idsB.has(g.id));
        const entries = b.filter((g) => !idsA.has(g.id));
        if (!exits.length && !entries.length) return null;
        const edges = (exits.length + entries.length) * EDGE;
        const clears = ((exits.length ? 1 : 0) + (entries.length ? 1 : 0)) * GROUP_CLEAR;
        const titles = vertical ? entries.reduce((s, g) => s + titleOf(g), 0) + ROUTE_TOP : 0;
        return edges + clears + titles;
    };

    const bump = (into: Record<number, number>, track: number, need: number, baseGap: number) => {
        const extra = Math.max(0, Math.ceil(need + laneBand - baseGap));
        if (extra > 0) into[track] = Math.max(into[track] ?? 0, extra);
    };

    for (let c = minC + 1; c <= maxC; c++) {
        for (let r = minR; r <= maxR; r++) {
            const [a, b] = [chainAt(c - 1, r), chainAt(c, r)];
            if (!occupied(c - 1, r, a) || !occupied(c, r, b)) continue;
            const n = needed(a, b, false);
            if (n !== null) bump(colExtra, c, n, base.colWidth - base.screenW);
        }
    }
    for (let r = minR + 1; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const [a, b] = [chainAt(c, r - 1), chainAt(c, r)];
            if (!occupied(c, r - 1, a) || !occupied(c, r, b)) continue;
            const n = needed(a, b, true);
            if (n !== null) bump(rowExtra, r, n, base.rowHeight - base.screenH);
        }
    }
    return { colExtra, rowExtra };
}

export type ConflictGroup = { id: string; parentId?: string; box: Rect; title: Rect };
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
        const bands = strokeBands(g.box);
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
            if (overlaps(g.title, c.rect)) issues.push({ kind: 'title-overlaps', groupId: g.id, withKind: c.kind, withId: c.id });
        }
        for (const o of groups) {
            if (o.id === g.id) continue;
            if (overlapsAny(g.title, strokeBands(o.box)) >= 0) issues.push({ kind: 'title-overlaps', groupId: g.id, withKind: 'box', withId: o.id });
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
