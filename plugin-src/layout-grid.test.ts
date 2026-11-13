import { describe, expect, test } from 'bun:test';

import { cellRect, type GridMeta } from './grid';
import { BOARD_GRID, cellOfIn, cellRectIn, gridOfScreen, migrateToGrouped, nearestFreeCell, onGrid, type LayoutGrid, type MigrateScreen } from './layout-grid';

const SIZE = { width: 393, height: 852 };
const board = { originX: 164, originY: 2174, colWidth: 700, rowHeight: 1112 };

describe('cellRectIn / cellOfIn', () => {
    const grid: LayoutGrid = { id: 'g', originX: 1000, originY: 5000, colWidth: 700, rowHeight: 1112 };

    test('a cell rect sits at the grid origin plus the cell times the pitch', () => {
        expect(cellRectIn(grid, 0, 0, SIZE)).toEqual({ x: 1000, y: 5000, width: 393, height: 852 });
        expect(cellRectIn(grid, 3, 2, SIZE)).toEqual({ x: 1000 + 3 * 700, y: 5000 + 2 * 1112, width: 393, height: 852 });
    });

    test('cellOfIn is the inverse, nearest cell', () => {
        expect(cellOfIn(grid, { x: 1000 + 3 * 700 + 40, y: 5000 + 2 * 1112 - 30 })).toEqual({ col: 3, row: 2 });
        expect(cellOfIn(grid, { x: 1000, y: 5000 })).toEqual({ col: 0, row: 0 });
    });

    test('onGrid tells a screen sitting on a cell from one that is not', () => {
        expect(onGrid(grid, cellRectIn(grid, 4, 1, SIZE))).toBe(true);
        expect(onGrid(grid, { x: 1000 + 350, y: 5000 })).toBe(false);
    });
});

describe('gridOfScreen', () => {
    const groups = [{ id: 'A', layout: { originX: 9000, originY: 3000 } }, { id: 'B' }];

    test('a screen with no layoutId, or board, is on the board grid', () => {
        expect(gridOfScreen({ id: 's' }, groups, board)).toEqual({ id: BOARD_GRID, ...board });
        expect(gridOfScreen({ id: 's', layoutId: 'board' }, groups, board)).toEqual({ id: BOARD_GRID, ...board });
    });

    test('a screen on a group layout uses that origin with the board pitch', () => {
        expect(gridOfScreen({ id: 's', layoutId: 'A' }, groups, board)).toEqual({ id: 'A', originX: 9000, originY: 3000, colWidth: 700, rowHeight: 1112 });
    });

    test('a layoutId whose group has no layout, or is gone, falls back to the board grid', () => {
        expect(gridOfScreen({ id: 's', layoutId: 'B' }, groups, board).id).toBe(BOARD_GRID);
        expect(gridOfScreen({ id: 's', layoutId: 'gone' }, groups, board).id).toBe(BOARD_GRID);
    });
});

describe('migrateToGrouped: a banded board moves zero screens', () => {
    const meta: GridMeta = {
        originX: 164, originY: 2174, colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852, labelOffset: 80, margin: 80,
        colExtra: [{ at: 4, from: 0, to: 2, px: 440 }, { at: 8, from: 0, to: 2, px: 440 }],
        rowExtra: [{ at: 3, from: 0, to: 12, px: 652 }],
    };
    const cell = (c: number, r: number) => cellRect(meta, c, r);
    const mk = (id: string, c: number, r: number, group: string | null): MigrateScreen => {
        const rect = cell(c, r);
        return { id, flowGroupId: group, x: rect.x, y: rect.y };
    };
    const screens: MigrateScreen[] = [
        mk('a1', 0, 0, 'A'), mk('a2', 1, 0, 'A'), mk('a3', 2, 0, 'A'), mk('a4', 1, 1, 'A'), mk('a5', 2, 1, 'A'),
        mk('b1', 4, 0, 'B'), mk('b2', 5, 0, 'B'), mk('b3', 5, 1, 'B'),
        mk('k1', 8, 0, 'K'), mk('k2', 9, 0, 'K'), mk('k3', 9, 1, 'K'),
        mk('c1', 0, 3, 'C'), mk('c2', 1, 3, 'C'), mk('c3', 1, 4, 'C'),
        mk('u1', 4, 3, null), mk('u2', 5, 3, null),
    ];
    const groups = [{ id: 'A' }, { id: 'B' }, { id: 'K', parentId: 'B' }, { id: 'C' }];
    const result = migrateToGrouped(board, screens, groups);
    const gridOf = (id: string) => result.grids.find((g) => g.id === result.cells.get(id)?.layoutId) as LayoutGrid;

    test('every screen lands on exactly the position it has now', () => {
        for (const s of screens) {
            const c = result.cells.get(s.id);
            expect(c).toBeDefined();
            const rect = cellRectIn(gridOf(s.id), (c as { col: number }).col, (c as { row: number }).row, SIZE);
            expect([s.id, rect.x, rect.y]).toEqual([s.id, s.x, s.y]);
        }
        expect(result.offGrid).toEqual([]);
    });

    test('a group grid starts at its top-left member, so local cells start at 0', () => {
        for (const g of ['A', 'B', 'K', 'C']) {
            const cells = screens.filter((s) => s.flowGroupId === g).map((s) => result.cells.get(s.id) as { col: number; row: number });
            expect([g, Math.min(...cells.map((c) => c.col)), Math.min(...cells.map((c) => c.row))]).toEqual([g, 0, 0]);
        }
        const a = result.grids.find((g) => g.id === 'A') as LayoutGrid;
        expect([a.originX, a.originY]).toEqual([cell(0, 0).x, cell(0, 0).y]);
    });

    test('each group, nested ones included, has its own grid; ungrouped screens share the board grid', () => {
        expect(result.grids.map((g) => g.id).sort()).toEqual(['A', 'B', 'C', 'K', BOARD_GRID].sort());
        expect(result.cells.get('k2')?.layoutId).toBe('K');
        expect(result.cells.get('u1')?.layoutId).toBe(BOARD_GRID);
        expect(result.cells.get('u2')?.layoutId).toBe(BOARD_GRID);
    });

    test('every grid uses the board pitch', () => {
        for (const g of result.grids) expect([g.colWidth, g.rowHeight]).toEqual([700, 1112]);
    });

    test('a group screen off the pitch is snapped once to the nearest free cell and reported', () => {
        const off = [...screens, { id: 'odd', flowGroupId: 'A', x: cell(0, 0).x + 350 + 700 * 10, y: cell(0, 0).y }];
        const r = migrateToGrouped(board, off, groups);
        expect(r.offGrid).toEqual([]);
        expect(r.moves).toHaveLength(1);
        expect(r.moves[0]).toMatchObject({ id: 'odd', from: { x: cell(0, 0).x + 350 + 7000 }, to: { x: cell(0, 0).x + 7700 } });
    });

    test('nothing moves when every screen is on the pitch', () => {
        expect(migrateToGrouped(board, screens, groups).moves).toEqual([]);
    });

    test('a group with no direct screens gets no grid; a screen naming a missing group is on the board grid', () => {
        const r = migrateToGrouped(board, [mk('x', 0, 0, 'Z'), mk('y', 1, 0, 'P')], [{ id: 'P' }, { id: 'Empty' }]);
        expect(r.grids.map((g) => g.id).sort()).toEqual([BOARD_GRID, 'P'].sort());
        expect(r.cells.get('x')?.layoutId).toBe(BOARD_GRID);
    });
});

describe('migrateToGrouped: snap once (live Auth group)', () => {
    const live = { originX: 164, originY: 2174, colWidth: 700, rowHeight: 1112 };
    const pos: [string, number, number][] = [
        ['2019:6239', 164, 2174],
        ['2019:6316', 4104, 2174],
        ['2019:6326', 164, 3286],
        ['2019:6389', 4104, 3286],
        ['2019:6914', 6904, 2174],
        ['2019:6931', 6904, 3286],
        ['2019:7410', 864, 2174],
        ['2019:7704', 4104, 7846],
        ['2019:7781', 864, 3286],
        ['2019:7858', 4804, 2174],
        ['2019:7883', 4804, 3286],
        ['2019:7908', 6204, 7846],
        ['2019:7934', 5504, 3286],
        ['2019:7978', 5504, 6122],
        ['2019:8022', 6204, 6122],
        ['2019:8069', 6204, 3286],
    ];
    const screens: MigrateScreen[] = pos.map(([id, x, y]) => ({ id, flowGroupId: 'AUTH', x, y }));
    const m = migrateToGrouped(live, screens, [{ id: 'AUTH' }]);
    const at = (id: string) => m.moves.find((v) => v.id === id);

    test('one grid at the top-left member; the 12 shifted members snap, the 4 on the pitch stay', () => {
        expect(m.grids).toEqual([{ id: 'AUTH', originX: 164, originY: 2174, colWidth: 700, rowHeight: 1112 }]);
        expect(m.moves).toHaveLength(12);
        expect(m.moves.map((v) => v.id).sort()).toEqual(['2019:6316', '2019:6389', '2019:6914', '2019:6931', '2019:7704', '2019:7858', '2019:7883', '2019:7908', '2019:7934', '2019:7978', '2019:8022', '2019:8069']);
        expect(m.offGrid).toEqual([]);
    });

    test('the 440px class snaps right by 260 in x, keeping its row', () => {
        for (const id of ['2019:6316', '2019:6389', '2019:6914', '2019:6931', '2019:7858', '2019:7883', '2019:7934', '2019:8069']) {
            const v = at(id);
            expect((v?.to.x ?? 0) - (v?.from.x ?? 0)).toBe(260);
            expect(v?.to.y).toBe(v?.from.y);
        }
    });

    test('the lower classes snap to the nearest row: row 3 down 500, row 4 up 112', () => {
        expect(at('2019:7978')).toMatchObject({ from: { x: 5504, y: 6122 }, to: { x: 5764, y: 6622 } });
        expect(at('2019:7704')).toMatchObject({ from: { x: 4104, y: 7846 }, to: { x: 4364, y: 7734 } });
    });

    test('every screen ends on its grid in its own cell, and no two share one', () => {
        const grid = m.grids[0] as LayoutGrid;
        const seen = new Set<string>();
        for (const s of screens) {
            const cell = m.cells.get(s.id) as { layoutId: string; col: number; row: number };
            const r = cellRectIn(grid, cell.col, cell.row, SIZE);
            expect(onGrid(grid, r)).toBe(true);
            const moved = at(s.id);
            expect(r).toMatchObject({ x: moved ? moved.to.x : s.x, y: moved ? moved.to.y : s.y });
            expect(seen.has(`${cell.col},${cell.row}`)).toBe(false);
            seen.add(`${cell.col},${cell.row}`);
        }
    });
});

describe('nearestFreeCell', () => {
    const grid: LayoutGrid = { id: 'g', originX: 0, originY: 0, colWidth: 700, rowHeight: 1112 };

    test('a tie goes right, then down', () => {
        expect(nearestFreeCell(grid, { x: 350, y: 0 }, new Set())).toEqual({ col: 1, row: 0 });
        expect(nearestFreeCell(grid, { x: 0, y: 556 }, new Set())).toEqual({ col: 0, row: 1 });
    });

    test('never an occupied cell: the next nearest is taken', () => {
        expect(nearestFreeCell(grid, { x: 350, y: 0 }, new Set(['1,0']))).toEqual({ col: 0, row: 0 });
    });
});
