import { describe, expect, test } from 'bun:test';

import { inferRepairGrid } from './board-repair';

const s = (col: number, row: number, x: number, y: number) => ({ col, row, x, y, width: 393, height: 852 });

describe('inferRepairGrid', () => {
    test('base pitch is the tightest step between neighbouring tracks, origin from the first cell', () => {
        const g = inferRepairGrid([s(0, 0, 1000, 2000), s(1, 0, 1700, 2000), s(2, 0, 2600, 2000), s(0, 1, 1000, 3112), s(0, 2, 1000, 4500)]);
        expect(g).toEqual({ originX: 1000, originY: 2000, colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852 });
    });

    test('screens that never start at track 0 still place the origin', () => {
        const g = inferRepairGrid([s(2, 1, 2400, 3112), s(3, 1, 3100, 3112), s(2, 2, 2400, 4224)]);
        expect(g.originX).toBe(1000);
        expect(g.originY).toBe(2000);
    });

    test('a lone screen falls back to the default pitch', () => {
        const g = inferRepairGrid([s(1, 1, 1700, 3112)]);
        expect(g).toMatchObject({ colWidth: 700, rowHeight: 1112, originX: 1000, originY: 2000 });
    });

    test('banded offsets on other rows do not shrink the pitch', () => {
        const g = inferRepairGrid([s(11, 0, 7585, 0), s(12, 0, 8285, 0), s(11, 1, 7864, 1112), s(12, 1, 8564, 1112), s(13, 1, 9264, 1112)]);
        expect(g.colWidth).toBe(700);
    });

    test('pitch never drops below the screen size', () => {
        const g = inferRepairGrid([s(0, 0, 0, 0), s(1, 0, 200, 0)]);
        expect(g.colWidth).toBe(393);
    });
});
