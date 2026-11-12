import { describe, expect, test } from 'bun:test';

import { boundsOfRects, compactGridPlan, groupOriginOf, placeJoiners, planBlockShifts, planGridMove, planRegrid, shiftGridPlan, type GridScreen, type RegridScreen } from './grid-plan';
import type { LayoutGrid } from './layout-grid';

const A: GridScreen[] = [
    { id: 'a1', layoutId: 'A', col: 0, row: 0 },
    { id: 'a2', layoutId: 'A', col: 1, row: 0 },
    { id: 'a3', layoutId: 'A', col: 1, row: 2 },
];
const B: GridScreen[] = [
    { id: 'b1', layoutId: 'B', col: 0, row: 0 },
    { id: 'b2', layoutId: 'B', col: 1, row: 1 },
];
const loose: GridScreen[] = [{ id: 'u1', layoutId: 'board', col: 0, row: 0 }];
const all = [...A, ...B, ...loose];

describe('planGridMove', () => {
    test('col/row are local to the screen own grid: the same cell in another grid is not an occupant', () => {
        const plan = planGridMove(all, 'a1', 1, 1, false);
        expect(plan).toEqual({ ok: true, moves: [{ id: 'a1', from: { layoutId: 'A', col: 0, row: 0 }, to: { layoutId: 'A', col: 1, row: 1 } }] });
        expect(planGridMove(all, 'a1', 0, 0, false)).toEqual({ ok: true, moves: [] });
    });

    test('an occupied cell is refused in the screen grid, swap trades places', () => {
        expect(planGridMove(all, 'a1', 1, 0, false).ok).toBe(false);
        const swapped = planGridMove(all, 'a1', 1, 0, true);
        expect(swapped.ok && swapped.moves.map((m) => [m.id, m.to.layoutId, m.to.col, m.to.row])).toEqual([
            ['a1', 'A', 1, 0],
            ['a2', 'A', 0, 0],
        ]);
    });

    test('a target layout moves the screen into that grid at the local cell', () => {
        const plan = planGridMove(all, 'a1', 2, 0, false, 'B');
        expect(plan).toEqual({ ok: true, moves: [{ id: 'a1', from: { layoutId: 'A', col: 0, row: 0 }, to: { layoutId: 'B', col: 2, row: 0 } }] });
    });

    test('moving into a taken cell of another grid is refused, swap sends the occupant to the old cell and grid', () => {
        expect(planGridMove(all, 'a1', 0, 0, false, 'B').ok).toBe(false);
        const swapped = planGridMove(all, 'a1', 0, 0, true, 'B');
        expect(swapped.ok && swapped.moves.map((m) => [m.id, m.to.layoutId, m.to.col, m.to.row])).toEqual([
            ['a1', 'B', 0, 0],
            ['b1', 'A', 0, 0],
        ]);
    });

    test('bad input is refused', () => {
        expect(planGridMove(all, 'nope', 0, 0, false).ok).toBe(false);
        expect(planGridMove(all, 'a1', -1, 0, false).ok).toBe(false);
        expect(planGridMove(all, 'a1', 0.5, 0, false).ok).toBe(false);
    });
});

describe('shiftGridPlan', () => {
    test('shifts only the named grid', () => {
        const moves = shiftGridPlan(all, 'A', 'row', 0, 1);
        expect(moves.map((m) => [m.id, m.to.layoutId, m.to.row])).toEqual([['a3', 'A', 3]]);
    });

    test('the board grid is its own grid', () => {
        const moves = shiftGridPlan(all, 'board', 'col', -1, 2);
        expect(moves.map((m) => [m.id, m.to.col])).toEqual([['u1', 2]]);
    });

    test('a grid with nothing past the line has nothing to move', () => {
        expect(shiftGridPlan(all, 'B', 'col', 5, 1)).toEqual([]);
    });
});

describe('compactGridPlan', () => {
    test('closes gaps inside each grid independently', () => {
        const moves = compactGridPlan(all);
        expect(moves.map((m) => [m.id, m.to.layoutId, m.to.col, m.to.row])).toEqual([['a3', 'A', 1, 1]]);
    });

    test('a column one grid uses does not keep it open in another', () => {
        const sparse: GridScreen[] = [
            { id: 'x1', layoutId: 'X', col: 0, row: 0 },
            { id: 'x2', layoutId: 'X', col: 3, row: 0 },
            { id: 'y1', layoutId: 'Y', col: 3, row: 0 },
        ];
        const moves = compactGridPlan(sparse);
        expect(moves.map((m) => [m.id, m.to.col])).toEqual([['x2', 1]]);
    });
});

describe('placeJoiners', () => {
    const grid: LayoutGrid = { id: 'G', originX: 1000, originY: 2000, colWidth: 700, rowHeight: 1112 };

    test('screens on the pitch take their cells and do not move', () => {
        const r = placeJoiners(grid, [{ id: 'a', x: 1000, y: 2000 }, { id: 'b', x: 1700, y: 2000 }], []);
        expect(r.cells.get('a')).toEqual({ col: 0, row: 0 });
        expect(r.cells.get('b')).toEqual({ col: 1, row: 0 });
        expect(r.snapped).toEqual([]);
    });

    test('a screen off the pitch snaps to the nearest cell and is reported', () => {
        const r = placeJoiners(grid, [{ id: 'a', x: 1000 + 700 + 40, y: 2000 + 10 }], []);
        expect(r.cells.get('a')).toEqual({ col: 1, row: 0 });
        expect(r.snapped).toEqual(['a']);
    });

    test('a cell already taken pushes the joiner down to the next free row', () => {
        const r = placeJoiners(grid, [{ id: 'a', x: 1000, y: 2000 }], [{ col: 0, row: 0 }]);
        expect(r.cells.get('a')).toEqual({ col: 0, row: 1 });
        expect(r.snapped).toEqual(['a']);
    });

    test('two joiners that land on one cell do not collide', () => {
        const r = placeJoiners(grid, [{ id: 'a', x: 1000, y: 2000 }, { id: 'b', x: 1020, y: 2000 }], []);
        expect(r.cells.get('a')).toEqual({ col: 0, row: 0 });
        expect(r.cells.get('b')).toEqual({ col: 0, row: 1 });
        expect(r.snapped).toEqual(['b']);
    });
});

describe('groupOriginOf', () => {
    test('is the top-left of the member frames', () => {
        expect(groupOriginOf([{ x: 900, y: 40 }, { x: 300, y: 700 }])).toEqual({ originX: 300, originY: 40 });
    });
});

describe('planBlockShifts', () => {
    const groups = [
        { id: 'P', screenIds: ['p1'], layout: { originX: 0, originY: 0 } },
        { id: 'K', parentId: 'P', screenIds: ['k1', 'k2'], layout: { originX: 700, originY: 0 } },
        { id: 'Q', screenIds: ['q1'], layout: { originX: 5000, originY: 0 } },
    ];

    test('a moved group shifts its own screens and layout origin', () => {
        const r = planBlockShifts([{ id: 'Q', dx: 0, dy: 300 }], groups);
        expect(r.screens).toEqual(new Map([['q1', { dx: 0, dy: 300 }]]));
        expect(r.layouts).toEqual(new Map([['Q', { originX: 5000, originY: 300 }]]));
    });

    test('a parent move that lists its child as well does not shift the child twice', () => {
        const r = planBlockShifts(
            [
                { id: 'P', dx: 100, dy: 0 },
                { id: 'K', dx: 100, dy: 0 },
            ],
            groups,
        );
        expect(r.screens.get('p1')).toEqual({ dx: 100, dy: 0 });
        expect(r.screens.get('k1')).toEqual({ dx: 100, dy: 0 });
        expect(r.layouts.get('K')).toEqual({ originX: 800, originY: 0 });
        expect(r.layouts.get('P')).toEqual({ originX: 100, originY: 0 });
    });

    test('a child pushed inside its parent shifts only its own screens', () => {
        const r = planBlockShifts([{ id: 'K', dx: 0, dy: 200 }], groups);
        expect([...r.screens.keys()].sort()).toEqual(['k1', 'k2']);
        expect(r.layouts.get('P')).toBeUndefined();
    });
});

describe('boundsOfRects', () => {
    const meta = { originX: 164, originY: 2174, labelOffset: 80, margin: 80 };

    test('matches the board bounds of the classic grid for screens on it', () => {
        const rects = [
            { x: 164, y: 2174, width: 393, height: 852 },
            { x: 164 + 3 * 700, y: 2174 + 2 * 1112, width: 393, height: 852 },
        ];
        expect(boundsOfRects(meta, rects)).toEqual({ x: 84, y: 2014, width: 3 * 700 + 393 + 160, height: 2 * 1112 + 852 + 80 + 160 });
    });

    test('a screen far from the origin, as a group block can be, stretches the board to it', () => {
        const b = boundsOfRects(meta, [{ x: 164 + 9000, y: 2174 + 40, width: 393, height: 852 }]);
        expect(b.width).toBe(9000 + 393 + 160);
    });
});

describe('planRegrid', () => {
    const board = { originX: 164, originY: 2174, colWidth: 700, rowHeight: 1112 };
    const at = (id: string, x: number, y: number, extra: Partial<RegridScreen> = {}): RegridScreen => ({ id, flowGroupId: null, col: 0, row: 0, x, y, ...extra });

    test('a group with screens but no grid gets one at its members top-left, and nothing moves', () => {
        const screens = [at('a', 9000, 3000, { flowGroupId: 'G' }), at('b', 9700, 3000, { flowGroupId: 'G' }), at('c', 9000, 4112, { flowGroupId: 'G' })];
        const r = planRegrid(board, screens, [{ id: 'G' }]);
        expect(r.layouts.get('G')).toEqual({ originX: 9000, originY: 3000 });
        expect(r.cells.get('a')).toEqual({ layoutId: 'G', col: 0, row: 0 });
        expect(r.cells.get('b')).toEqual({ layoutId: 'G', col: 1, row: 0 });
        expect(r.cells.get('c')).toEqual({ layoutId: 'G', col: 0, row: 1 });
        expect(r.snapped).toEqual([]);
    });

    test('a screen added to a group with a grid takes the nearest cell of that grid, keeping its place when on the pitch', () => {
        const screens = [at('a', 9000, 3000, { flowGroupId: 'G', layoutId: 'G' }), at('n', 9000 + 2 * 700, 3000, { flowGroupId: 'G', layoutId: 'board', col: 7, row: 7 })];
        const r = planRegrid(board, screens, [{ id: 'G', layout: { originX: 9000, originY: 3000 } }]);
        expect(r.cells.has('a')).toBe(false);
        expect(r.cells.get('n')).toEqual({ layoutId: 'G', col: 2, row: 0 });
        expect(r.snapped).toEqual([]);
    });

    test('a joiner off the grid is snapped and reported', () => {
        const screens = [at('n', 9000 + 350, 3000 + 30, { flowGroupId: 'G', layoutId: 'board' })];
        const r = planRegrid(board, screens, [{ id: 'G', layout: { originX: 9000, originY: 3000 } }]);
        expect(r.snapped).toEqual(['n']);
    });

    test('a screen that left its group goes to the board grid', () => {
        const screens = [at('u', 164 + 700, 2174, { flowGroupId: null, layoutId: 'G', col: 3, row: 3 })];
        const r = planRegrid(board, screens, [{ id: 'G', layout: { originX: 9000, originY: 3000 } }]);
        expect(r.cells.get('u')).toEqual({ layoutId: 'board', col: 1, row: 0 });
    });

    test('a screen already on its layout is left alone', () => {
        const screens = [at('u', 164, 2174, { layoutId: 'board' })];
        expect(planRegrid(board, screens, []).cells.size).toBe(0);
    });

    test('a group that is gone sends its screens to the board grid', () => {
        const screens = [at('u', 164, 2174, { flowGroupId: 'GONE', layoutId: 'GONE' })];
        expect(planRegrid(board, screens, []).cells.get('u')).toEqual({ layoutId: 'board', col: 0, row: 0 });
    });
});
