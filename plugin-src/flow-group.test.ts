import { describe, expect, test } from 'bun:test';

import {
    boundaryExtras,
    CHILD_TITLE_SCALE,
    fitBox,
    GROUP_CLEAR,
    GROUP_PAD,
    GROUP_STROKE,
    groupConflicts,
    memberContentRect,
    ROUTE_TOP,
    strokeBands,
    TITLE_GAP,
    titleHeightOf,
    TITLE_SIZE,
    validateNesting,
    type BoundaryGroup,
    type Cell,
    type ConflictContent,
    type ConflictGroup,
} from './flow-group';
import type { Rect } from './rect';

const W = 393;
const H = 852;
const COL = 700;
const ROW = 1112;
const LANE = 160;
const BASE = { colWidth: COL, rowHeight: ROW, screenW: W, screenH: H };
const EDGE = GROUP_PAD + GROUP_STROKE;

type Extras = { colExtra: Record<number, number>; rowExtra: Record<number, number> };
const sumBefore = (extra: Record<number, number>, i: number): number =>
    Object.entries(extra).reduce((s, [k, v]) => (Number(k) <= i ? s + v : s), 0);
const frameAt = (col: number, row: number, e: Extras): Rect => ({
    x: 1000 + col * COL + sumBefore(e.colExtra, col),
    y: 2000 + row * ROW + sumBefore(e.rowExtra, row),
    width: W,
    height: H,
});
const routeOf = (f: Rect): Rect => ({ x: f.x, y: f.y - 72, width: 160, height: 28 });
const cellsOf = (...pairs: [number, number][]): Cell[] => pairs.map(([col, row]) => ({ col, row }));

type SimGroup = { id: string; parentId?: string; cells: Cell[] };

/** Lay screens out with extras, fit every box/title and gather conflicts. */
function simulate(groups: SimGroup[], ungrouped: Cell[], e: Extras) {
    const contents: ConflictContent[] = [];
    const contentOf = new Map<string, Rect>();
    const addScreen = (c: Cell, owner?: string) => {
        const f = frameAt(c.col, c.row, e);
        const id = `s${c.col}_${c.row}`;
        contents.push({ kind: 'screen', id, rect: f, ownerGroupId: owner });
        contents.push({ kind: 'route', id: `r${id}`, rect: routeOf(f), ownerGroupId: owner });
        contentOf.set(id, memberContentRect(f, routeOf(f)));
        return id;
    };
    const ids = new Map<string, string[]>();
    for (const g of groups) ids.set(g.id, g.cells.map((c) => addScreen(c, g.id)));
    for (const c of ungrouped) addScreen(c);
    const fitted = new Map<string, ConflictGroup>();
    const rectsOf = (g: SimGroup) => (ids.get(g.id) ?? []).map((i) => contentOf.get(i) as Rect);
    for (const g of groups.filter((x) => x.parentId)) {
        const { box, title } = fitBox(rectsOf(g), [], titleHeightOf(TITLE_SIZE * CHILD_TITLE_SCALE));
        fitted.set(g.id, { id: g.id, parentId: g.parentId, box, title });
    }
    for (const g of groups.filter((x) => !x.parentId)) {
        const kids = groups.filter((x) => x.parentId === g.id).map((k) => fitted.get(k.id) as ConflictGroup);
        const { box, title } = fitBox(rectsOf(g), kids);
        fitted.set(g.id, { id: g.id, box, title });
    }
    return { groups: [...fitted.values()], contents };
}

const toBoundary = (g: SimGroup): BoundaryGroup => ({ id: g.id, parentId: g.parentId, cells: g.cells });
const extrasFor = (groups: SimGroup[], ungrouped: Cell[]): Extras =>
    boundaryExtras({ groups: groups.map(toBoundary), ungrouped, base: BASE, laneBand: LANE });
const none: Extras = { colExtra: {}, rowExtra: {} };

describe('memberContentRect', () => {
    test('covers frame plus route line and frame title clearance above', () => {
        const f: Rect = { x: 100, y: 500, width: W, height: H };
        const r = memberContentRect(f);
        expect(r).toEqual({ x: 100, y: 500 - ROUTE_TOP, width: W, height: H + ROUTE_TOP });
        expect(ROUTE_TOP).toBe(100);
    });
    test('grows to hold a wide route label and a badge', () => {
        const f: Rect = { x: 100, y: 500, width: W, height: H };
        const route: Rect = { x: 100, y: 428, width: 600, height: 28 };
        const badge: Rect = { x: 650, y: 420, width: 80, height: 28 };
        const r = memberContentRect(f, route, badge);
        expect(r.x + r.width).toBe(730);
        expect(r.y).toBeLessThanOrEqual(420 - 28);
    });
});

describe('fitBox', () => {
    test('pads members by PAD+STROKE and centres the title above', () => {
        const m: Rect = { x: 1000, y: 2000, width: W, height: H };
        const { box, title } = fitBox([m]);
        expect(box).toEqual({ x: 1000 - EDGE, y: 2000 - EDGE, width: W + 2 * EDGE, height: H + 2 * EDGE });
        const th = titleHeightOf(TITLE_SIZE);
        expect(title.height).toBe(th);
        expect(title.y + title.height + TITLE_GAP).toBe(box.y);
        expect(title.x + title.width / 2).toBe(box.x + box.width / 2);
    });
    test('parent grows over child box and child title', () => {
        const a: Rect = { x: 0, y: 0, width: W, height: H };
        const b: Rect = { x: 700, y: 0, width: W, height: H };
        const kid = fitBox([b], [], titleHeightOf(TITLE_SIZE * CHILD_TITLE_SCALE));
        const parent = fitBox([a], [{ id: 'k', ...kid }]);
        expect(parent.box.x + parent.box.width).toBeGreaterThanOrEqual(kid.box.x + kid.box.width + EDGE);
        expect(parent.box.y).toBeLessThanOrEqual(kid.title.y - EDGE);
    });
});

describe('strokeBands', () => {
    test('four bands inflated by CLEAR around the stroke', () => {
        const box: Rect = { x: 0, y: 0, width: 1000, height: 800 };
        const bands = strokeBands(box);
        expect(bands).toHaveLength(4);
        expect(bands[0]).toEqual({ x: -GROUP_CLEAR, y: -GROUP_CLEAR, width: 1000 + 2 * GROUP_CLEAR, height: GROUP_STROKE + 2 * GROUP_CLEAR });
        const interior: Rect = { x: GROUP_STROKE + GROUP_CLEAR, y: GROUP_STROKE + GROUP_CLEAR, width: 100, height: 100 };
        expect(bands.every((b) => !(interior.x < b.x + b.width && b.x < interior.x + 100 && interior.y < b.y + b.height && b.y < interior.y + 100))).toBe(true);
    });
});

describe('boundaryExtras', () => {
    test('no groups, no extras', () => {
        expect(extrasFor([], cellsOf([0, 0], [0, 1]))).toEqual(none);
    });
    test('one group, nothing around it, no extras', () => {
        expect(extrasFor([{ id: 'A', cells: cellsOf([0, 0], [1, 0]) }], [])).toEqual(none);
    });
    test('stacked groups: row gap grows by the title band and boxes stay clear (screenshot bug)', () => {
        const groups: SimGroup[] = [
            { id: 'A', cells: cellsOf([0, 0], [1, 0], [2, 0]) },
            { id: 'B', cells: cellsOf([0, 1], [1, 1]) },
        ];
        const bad = simulate(groups, [], none);
        expect(groupConflicts(bad.groups, bad.contents).length).toBeGreaterThan(0);

        const e = extrasFor(groups, []);
        const needed = 2 * EDGE + 2 * GROUP_CLEAR + titleHeightOf(TITLE_SIZE) + TITLE_GAP + ROUTE_TOP;
        expect(e.rowExtra[1]).toBe(Math.max(0, needed + LANE - (ROW - H)));
        expect(e.colExtra).toEqual({});
        const ok = simulate(groups, [], e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
    });
    test('side-by-side groups: column gap grows, no title height', () => {
        const groups: SimGroup[] = [
            { id: 'A', cells: cellsOf([0, 0], [0, 1]) },
            { id: 'B', cells: cellsOf([1, 0], [1, 1]) },
        ];
        const e = extrasFor(groups, []);
        expect(e.rowExtra).toEqual({});
        expect(e.colExtra[1]).toBe(2 * EDGE + 2 * GROUP_CLEAR + LANE - (COL - W));
        const ok = simulate(groups, [], e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
    });
    test('group next to ungrouped content gets clearance on that edge only', () => {
        const groups: SimGroup[] = [{ id: 'A', cells: cellsOf([0, 0]) }];
        const ungrouped = cellsOf([1, 0]);
        const e = extrasFor(groups, ungrouped);
        expect(e.colExtra[1]).toBeUndefined();
        const tight = boundaryExtras({ groups: groups.map(toBoundary), ungrouped, base: BASE, laneBand: 300 });
        expect(tight.colExtra[1]).toBe(EDGE + GROUP_CLEAR + 300 - (COL - W));
        const ok = simulate(groups, ungrouped, e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
    });
    test('ungrouped content above a group: title band needed', () => {
        const groups: SimGroup[] = [{ id: 'B', cells: cellsOf([0, 1]) }];
        const ungrouped = cellsOf([0, 0]);
        const e = extrasFor(groups, ungrouped);
        expect(e.rowExtra[1]).toBeGreaterThan(0);
        const ok = simulate(groups, ungrouped, e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
    });
    test('L-shape group (2 on top, 7 below) with a group underneath', () => {
        const top = cellsOf([0, 0], [1, 0]);
        const bottom = cellsOf(...[0, 1, 2, 3, 4, 5, 6].map((c): [number, number] => [c, 1]));
        const groups: SimGroup[] = [
            { id: 'P', cells: [...top, ...bottom] },
            { id: 'D', cells: cellsOf([0, 2], [1, 2]) },
        ];
        const e = extrasFor(groups, []);
        expect(e.rowExtra[2]).toBeGreaterThan(0);
        expect(e.rowExtra[1]).toBeUndefined();
        expect(e.colExtra).toEqual({});
        const ok = simulate(groups, [], e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
    });
    test('nested: parent with two children stacked inside, parent above another group', () => {
        const groups: SimGroup[] = [
            { id: 'Acc', cells: [] },
            { id: 'Pk', parentId: 'Acc', cells: cellsOf([0, 0], [1, 0]) },
            { id: 'Dev', parentId: 'Acc', cells: cellsOf([0, 1], [1, 1]) },
            { id: 'Other', cells: cellsOf([0, 2]) },
        ];
        const e = extrasFor(groups, []);
        const childTitle = titleHeightOf(TITLE_SIZE * CHILD_TITLE_SCALE);
        const childNeeded = 2 * EDGE + 2 * GROUP_CLEAR + childTitle + TITLE_GAP + ROUTE_TOP;
        expect(e.rowExtra[1]).toBe(Math.max(0, childNeeded + LANE - (ROW - H)));
        const parentNeeded = 2 * EDGE + 2 * GROUP_CLEAR + titleHeightOf(TITLE_SIZE) + TITLE_GAP + ROUTE_TOP;
        expect(e.rowExtra[2]).toBeGreaterThanOrEqual(Math.max(0, parentNeeded + LANE - (ROW - H)));
        const ok = simulate(groups, [], e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
        expect(validateNesting(ok.groups)).toEqual([]);
    });
    test('nested band: child entry directly under parent title row', () => {
        const groups: SimGroup[] = [
            { id: 'Acc', cells: cellsOf([0, 0]) },
            { id: 'Pk', parentId: 'Acc', cells: cellsOf([0, 1]) },
        ];
        const e = extrasFor(groups, []);
        const ok = simulate(groups, [], e);
        expect(groupConflicts(ok.groups, ok.contents)).toEqual([]);
        expect(validateNesting(ok.groups)).toEqual([]);
    });
});

describe('groupConflicts', () => {
    const box: Rect = { x: 0, y: 0, width: 1000, height: 800 };
    const group = (id: string, b: Rect, parentId?: string): ConflictGroup => ({ id, parentId, box: b, title: { x: b.x, y: b.y - 147, width: b.width, height: 115 } });
    const A = group('A', box);

    test('clean layout has no issues', () => {
        const inside: ConflictContent = { kind: 'screen', id: 's1', rect: { x: 200, y: 200, width: 100, height: 100 }, ownerGroupId: 'A' };
        expect(groupConflicts([A], [inside])).toEqual([]);
    });
    test('group-crosses-content: stroke through a route', () => {
        const route: ConflictContent = { kind: 'route', id: 'r1', rect: { x: 500, y: -10, width: 100, height: 28 } };
        expect(groupConflicts([A], [route]).map((i) => i.kind)).toContain('group-crosses-content');
    });
    test('group-crosses-label: stroke through an arrow label', () => {
        const label: ConflictContent = { kind: 'label', id: 'l1', rect: { x: 990, y: 300, width: 60, height: 20 } };
        const issues = groupConflicts([A], [label]);
        expect(issues).toEqual([{ kind: 'group-crosses-label', groupId: 'A', labelId: 'l1' }]);
    });
    test('group-overlaps-group: partial overlap', () => {
        const B = group('B', { x: 800, y: 300, width: 1000, height: 800 });
        expect(groupConflicts([A, B], []).some((i) => i.kind === 'group-overlaps-group')).toBe(true);
    });
    test('full containment by the declared parent is fine', () => {
        const kid = group('K', { x: 100, y: 200, width: 400, height: 400 }, 'A');
        expect(groupConflicts([A, kid], []).filter((i) => i.kind === 'group-overlaps-group')).toEqual([]);
    });
    test('full containment without a parent link is an overlap', () => {
        const kid = group('K', { x: 100, y: 200, width: 400, height: 400 });
        expect(groupConflicts([A, kid], []).some((i) => i.kind === 'group-overlaps-group')).toBe(true);
    });
    test('group-encloses-foreign: non-member screen inside the box', () => {
        const foreign: ConflictContent = { kind: 'screen', id: 'x', rect: { x: 300, y: 300, width: 100, height: 100 } };
        expect(groupConflicts([A], [foreign])).toEqual([{ kind: 'group-encloses-foreign', groupId: 'A', screenId: 'x' }]);
    });
    test('child member inside parent is not foreign', () => {
        const kid = group('K', { x: 100, y: 200, width: 400, height: 400 }, 'A');
        const s: ConflictContent = { kind: 'screen', id: 's', rect: { x: 200, y: 300, width: 100, height: 100 }, ownerGroupId: 'K' };
        expect(groupConflicts([A, kid], [s]).filter((i) => i.kind === 'group-encloses-foreign')).toEqual([]);
    });
    test('title-overlaps: title over another box stroke, a screen and another title', () => {
        const B = group('B', { x: 0, y: 900, width: 1000, height: 800 });
        const kinds = groupConflicts([A, B], []).filter((i) => i.kind === 'title-overlaps');
        expect(kinds.length).toBeGreaterThan(0);
        const screen: ConflictContent = { kind: 'screen', id: 's', rect: { x: 100, y: -140, width: 50, height: 50 }, ownerGroupId: 'Z' };
        expect(groupConflicts([A], [screen]).some((i) => i.kind === 'title-overlaps')).toBe(true);
    });
});

describe('validateNesting', () => {
    const g = (id: string, b: Rect, parentId?: string): ConflictGroup => ({ id, parentId, box: b, title: { x: b.x, y: b.y - 50, width: b.width, height: 40 } });
    const outer: Rect = { x: 0, y: 0, width: 1000, height: 800 };
    test('valid one level', () => {
        expect(validateNesting([g('P', outer), g('C', { x: 50, y: 50, width: 200, height: 200 }, 'P')])).toEqual([]);
    });
    test('depth > 1', () => {
        const issues = validateNesting([g('P', outer), g('C', { x: 50, y: 50, width: 400, height: 400 }, 'P'), g('G', { x: 60, y: 60, width: 100, height: 100 }, 'C')]);
        expect(issues).toContainEqual({ kind: 'nesting-too-deep', groupId: 'G' });
    });
    test('child outside parent', () => {
        const issues = validateNesting([g('P', outer), g('C', { x: 900, y: 50, width: 400, height: 400 }, 'P')]);
        expect(issues).toContainEqual({ kind: 'child-outside-parent', groupId: 'C', parentId: 'P' });
    });
    test('missing parent', () => {
        expect(validateNesting([g('C', outer, 'nope')])).toEqual([{ kind: 'parent-missing', groupId: 'C', parentId: 'nope' }]);
    });
});
