import { describe, expect, test } from 'bun:test';
import { lintArrows, lintGroups, lintOffGrid } from './group-lint';
import type { LayoutGrid } from './layout-grid';

const box = { x: 0, y: 0, width: 1000, height: 800 };
const title = { x: 0, y: -200, width: 300, height: 115 };

describe('lintGroups', () => {
    test('clean layout passes', () => {
        const r = lintGroups([{ id: 'g', box, title }], [{ kind: 'screen', id: 's', rect: { x: 200, y: 200, width: 300, height: 400 }, ownerGroupId: 'g' }]);
        expect(r.issues).toEqual([]);
        expect(r.counts).toEqual({});
    });

    test('merges conflict and nesting kinds with counts', () => {
        const r = lintGroups(
            [
                { id: 'p', box, title },
                { id: 'c', parentId: 'p', box: { x: 900, y: 100, width: 400, height: 300 }, title: { x: 900, y: -50, width: 100, height: 50 } },
            ],
            [{ kind: 'screen', id: 's', rect: { x: 2000, y: 0, width: 100, height: 100 } }],
        );
        expect(r.counts['child-outside-parent']).toBe(1);
        expect(r.counts['group-overlaps-group']).toBe(1);
        expect(r.issues.every((i) => typeof i.message === 'string' && i.message.length > 0)).toBe(true);
    });

    test('foreign screen inside a box is reported', () => {
        const r = lintGroups([{ id: 'g', box, title }], [{ kind: 'screen', id: 's', rect: { x: 200, y: 200, width: 100, height: 100 } }]);
        expect(r.counts['group-encloses-foreign']).toBe(1);
    });
});

describe('lintArrows', () => {
    const arrow = (id: string, points: { x: number; y: number }[], label: { x: number; y: number; width: number; height: number } | null = null) => ({ id, points, label });

    test('two labels that intersect are reported once', () => {
        const r = lintArrows(
            [arrow('a', [{ x: 0, y: 0 }, { x: 0, y: 500 }], { x: -50, y: 200, width: 100, height: 31 }), arrow('b', [{ x: 24, y: 0 }, { x: 24, y: 500 }], { x: -26, y: 210, width: 100, height: 31 })],
            [],
        );
        expect(r.counts['label-overlaps-label']).toBe(1);
        expect(r.issues.find((i) => i.kind === 'label-overlaps-label')?.message).toContain('a');
    });

    test('labels that only touch or sit apart are fine', () => {
        const r = lintArrows(
            [arrow('a', [{ x: 0, y: 0 }, { x: 0, y: 500 }], { x: 0, y: 0, width: 100, height: 31 }), arrow('b', [{ x: 300, y: 0 }, { x: 300, y: 500 }], { x: 0, y: 31, width: 100, height: 31 })],
            [],
        );
        expect(r.counts['label-overlaps-label']).toBeUndefined();
    });

    test('shared-start: two arrows from one dot to different targets that share a long first run are flagged; a short fork stub or the same target is not', () => {
        const start = { x: 400, y: 100 };
        const long = lintArrows([{ id: 'a', points: [start, { x: 700, y: 100 }, { x: 700, y: 0 }, { x: 900, y: 0 }], label: null, from: 's', to: 't1' }, { id: 'b', points: [start, { x: 760, y: 100 }, { x: 760, y: 300 }, { x: 900, y: 300 }], label: null, from: 's', to: 't2' }], []);
        expect(long.counts['shared-start']).toBe(1);
        expect(long.issues.find((i) => i.kind === 'shared-start')?.message).toContain('300px');
        const forked = lintArrows([{ id: 'a', points: [start, { x: 408, y: 100 }, { x: 408, y: 76 }, { x: 700, y: 76 }, { x: 700, y: 0 }], label: null, from: 's', to: 't1' }, { id: 'b', points: [start, { x: 416, y: 100 }, { x: 416, y: 124 }, { x: 760, y: 124 }, { x: 760, y: 300 }], label: null, from: 's', to: 't2' }], []);
        expect(forked.counts['shared-start']).toBeUndefined();
        const same = lintArrows([{ id: 'a', points: [start, { x: 700, y: 100 }, { x: 700, y: 0 }, { x: 900, y: 0 }], label: null, from: 's', to: 't1' }, { id: 'b', points: [start, { x: 700, y: 100 }, { x: 700, y: 0 }, { x: 900, y: 0 }], label: null, from: 's', to: 't1' }], []);
        expect(same.counts['shared-start']).toBeUndefined();
    });

    test('collinear segments sharing more than 40px are lines-overlap; 40px or less, offset lanes and crossings are not', () => {
        const base = arrow('a', [{ x: 100, y: 0 }, { x: 100, y: 300 }]);
        expect(lintArrows([base, arrow('b', [{ x: 100, y: 200 }, { x: 100, y: 400 }])], []).counts['lines-overlap']).toBe(1);
        expect(lintArrows([base, arrow('b', [{ x: 100, y: 260 }, { x: 100, y: 400 }])], []).counts['lines-overlap']).toBeUndefined();
        expect(lintArrows([base, arrow('b', [{ x: 124, y: 0 }, { x: 124, y: 300 }])], []).counts['lines-overlap']).toBeUndefined();
        expect(lintArrows([base, arrow('b', [{ x: 0, y: 150 }, { x: 400, y: 150 }])], []).counts['lines-overlap']).toBeUndefined();
        const horizontal = arrow('h', [{ x: 0, y: 50 }, { x: 300, y: 50 }]);
        expect(lintArrows([horizontal, arrow('i', [{ x: 100, y: 50 }, { x: 500, y: 50 }])], []).counts['lines-overlap']).toBe(1);
    });

    test('a line through a title text rect is line-crosses-title; one beside it is not', () => {
        const title = { id: 'g', text: { x: 0, y: 0, width: 300, height: 173 } };
        const crossing = arrow('a', [{ x: 150, y: 400 }, { x: 150, y: -300 }]);
        const beside = arrow('b', [{ x: 340, y: 400 }, { x: 340, y: -300 }]);
        const above = arrow('c', [{ x: 150, y: -100 }, { x: 150, y: -300 }]);
        const horizontal = arrow('d', [{ x: -100, y: 80 }, { x: 600, y: 80 }]);
        const r = lintArrows([crossing, beside, above, horizontal], [title]);
        expect(r.issues.filter((i) => i.kind === 'line-crosses-title').map((i) => (i as { arrowId: string }).arrowId)).toEqual(['a', 'd']);
        expect(r.counts['line-crosses-title']).toBe(2);
    });
});

describe('lintArrows line-crosses-screen', () => {
    const screens = [
        { id: 's1', rect: { x: 0, y: 0, width: 393, height: 852 } },
        { id: 's2', rect: { x: 1140, y: 0, width: 393, height: 852 } },
        { id: 's3', rect: { x: 2280, y: 0, width: 393, height: 852 } },
    ];
    test('a line through a screen that is neither end is reported; one that only touches its ends is not', () => {
        const through = { id: 'a', from: 's1', to: 's3', label: null, points: [{ x: 393, y: 426 }, { x: 2280, y: 426 }] };
        const around = { id: 'b', from: 's1', to: 's3', label: null, points: [{ x: 393, y: 426 }, { x: 417, y: 426 }, { x: 417, y: 1000 }, { x: 2256, y: 1000 }, { x: 2256, y: 426 }, { x: 2280, y: 426 }] };
        const r = lintArrows([through, around], [], screens);
        expect(r.issues.filter((i) => i.kind === 'line-crosses-screen').map((i) => [i.kind, 'arrowId' in i ? i.arrowId : ''])).toEqual([['line-crosses-screen', 'a']]);
        expect(lintArrows([through], [], []).issues).toEqual([]);
    });
});

describe('lintArrows merged arrows', () => {
    const mk = (id: string, to: string, pts: [number, number][]) => ({ id, to, label: null, points: pts.map(([x, y]) => ({ x, y })) });
    test('arrows into one target may share trunk and final run; different targets may not; a short shared dot stub is ignored, a long one is shared-start', () => {
        const a = mk('a', 'T', [[0, 0], [900, 0], [900, 500], [1000, 500]]);
        const b = mk('b', 'T', [[0, 1000], [900, 1000], [900, 500], [1000, 500]]);
        expect(lintArrows([a, b], []).issues).toEqual([]);
        const c = mk('c', 'U', [[0, 1000], [900, 1000], [900, 500], [1000, 500]]);
        expect(lintArrows([a, c], []).counts['lines-overlap']).toBe(1);
        const d = mk('d', 'X', [[0, 0], [30, 0], [30, 800]]);
        const e = mk('e', 'Y', [[0, 0], [30, 0], [30, -800]]);
        expect(lintArrows([d, e], []).issues).toEqual([]);
        const f = mk('f', 'X', [[0, 0], [300, 0], [300, 800]]);
        const g = mk('g', 'Y', [[0, 0], [300, 0], [300, -800]]);
        expect(lintArrows([f, g], []).counts['shared-start']).toBe(1);
    });
});

describe('lintArrows starts-wrong-side and ends-wrong-side', () => {
    const screens = [
        { id: 'a', rect: { x: 1000, y: 0, width: 393, height: 852 } },
        { id: 'b', rect: { x: 2140, y: 0, width: 393, height: 852 } },
    ];
    const run = (points: [number, number][]) => lintArrows([{ id: 'x', from: 'a', to: 'b', label: null, points: points.map(([x, y]) => ({ x, y })) }], [], screens).issues.map((i) => i.kind);

    test('right-edge start and left-edge end are fine; a dot inside the screen is fine', () => {
        expect(run([[1393, 400], [2140, 400]])).toEqual([]);
        expect(run([[1300, 400], [1400, 400], [2140, 400]])).toEqual([]);
    });
    test('bottom start and top end are fine', () => {
        expect(run([[1200, 852], [1200, 900], [2300, 900], [2300, 0]])).toEqual([]);
    });
    test('a start on the left or top edge is flagged', () => {
        expect(run([[1000, 400], [900, 400], [2140, 400]])).toEqual(['starts-wrong-side']);
        expect(run([[1200, 0], [1200, -60], [2140, -60], [2140, 400]])).toEqual(['starts-wrong-side']);
    });
    test('an end on the right or bottom edge is flagged', () => {
        expect(run([[1393, 400], [2600, 400], [2533, 400]])).toEqual(['ends-wrong-side']);
        expect(run([[1393, 400], [2300, 400], [2300, 900], [2300, 852]])).toEqual(['ends-wrong-side']);
    });
});

describe('lintOffGrid', () => {
    const grids: Record<string, LayoutGrid> = {
        board: { id: 'board', originX: 164, originY: 2174, colWidth: 700, rowHeight: 1112 },
        G: { id: 'G', originX: 9000, originY: 3500, colWidth: 700, rowHeight: 1112 },
    };
    const gridFor = (id: string): LayoutGrid => grids[id] as LayoutGrid;

    test('screens on their own grid are fine, whatever the rows of other groups', () => {
        const r = lintOffGrid(
            [
                { id: 'a', layoutId: 'board', rect: { x: 164 + 700, y: 2174 } },
                { id: 'b', layoutId: 'G', rect: { x: 9000, y: 3500 + 1112 } },
            ],
            gridFor,
        );
        expect(r).toEqual([]);
    });

    test('a screen between pitches is flagged with the nearest cell and the offset', () => {
        const [issue] = lintOffGrid([{ id: 'b', layoutId: 'G', rect: { x: 9000 + 700 + 40, y: 3500 - 25 } }], gridFor);
        expect(issue).toMatchObject({ kind: 'off-grid', screenId: 'b', layoutId: 'G', col: 1, row: 0, dx: 40, dy: -25 });
        expect(issue?.message).toContain('b');
    });

    test('a couple of pixels of drift is not off-grid', () => {
        expect(lintOffGrid([{ id: 'b', layoutId: 'G', rect: { x: 9001.5, y: 3499 } }], gridFor)).toEqual([]);
    });
});
