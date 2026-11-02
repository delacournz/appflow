import { describe, expect, test } from 'bun:test';
import { boardBounds, cellOf, cellRect, compactPlan, occupancy, planMove, shiftPlan, staleReason, type GridMeta } from './grid';

const meta: GridMeta = { originX: 100, originY: 200, colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852, labelOffset: 72, margin: 80 };
const s = (id: string, col: number, row: number) => ({ id, col, row });

describe('cellRect / cellOf', () => {
    test('cellRect places the screen frame on the grid', () => {
        expect(cellRect(meta, 0, 0)).toEqual({ x: 100, y: 200, width: 393, height: 852 });
        expect(cellRect(meta, 2, 1)).toEqual({ x: 1500, y: 1312, width: 393, height: 852 });
    });
    test('cellOf inverts cellRect and tolerates small drift', () => {
        expect(cellOf(cellRect(meta, 3, 1), meta)).toEqual({ col: 3, row: 1 });
        expect(cellOf({ x: 1503, y: 1310 }, meta)).toEqual({ col: 2, row: 1 });
    });
});

describe('occupancy', () => {
    test('maps cells to screen ids', () => {
        const o = occupancy([s('a', 0, 0), s('b', 1, 0)]);
        expect(o.cells.get('0,0')).toBe('a');
        expect(o.cells.get('1,0')).toBe('b');
        expect(o.collisions).toEqual([]);
    });
    test('reports collisions', () => {
        const o = occupancy([s('a', 0, 0), s('b', 0, 0), s('c', 1, 0)]);
        expect(o.collisions).toEqual([{ col: 0, row: 0, ids: ['a', 'b'] }]);
    });
});

describe('shiftPlan', () => {
    const screens = [s('a', 0, 0), s('b', 1, 0), s('c', 2, 1)];
    test('shifts columns after the insert point', () => {
        expect(shiftPlan(screens, 'col', 0, 2)).toEqual([
            { id: 'b', from: { col: 1, row: 0 }, to: { col: 3, row: 0 } },
            { id: 'c', from: { col: 2, row: 1 }, to: { col: 4, row: 1 } },
        ]);
    });
    test('shifts rows after the insert point', () => {
        expect(shiftPlan(screens, 'row', 0, 1)).toEqual([{ id: 'c', from: { col: 2, row: 1 }, to: { col: 2, row: 2 } }]);
    });
    test('after -1 shifts everything', () => {
        expect(shiftPlan(screens, 'col', -1, 1)).toHaveLength(3);
    });
    test('nothing to shift gives an empty plan', () => {
        expect(shiftPlan(screens, 'col', 5, 1)).toEqual([]);
    });
});

describe('compactPlan', () => {
    test('closes empty columns and rows, keeping the first used index', () => {
        const plan = compactPlan([s('a', 1, 0), s('b', 4, 0), s('c', 4, 3)]);
        expect(plan).toEqual([
            { id: 'b', from: { col: 4, row: 0 }, to: { col: 2, row: 0 } },
            { id: 'c', from: { col: 4, row: 3 }, to: { col: 2, row: 1 } },
        ]);
    });
    test('already dense gives no moves', () => {
        expect(compactPlan([s('a', 0, 0), s('b', 1, 0), s('c', 0, 1)])).toEqual([]);
    });
    test('empty board', () => {
        expect(compactPlan([])).toEqual([]);
    });
});

describe('planMove', () => {
    const screens = [s('a', 0, 0), s('b', 1, 0)];
    test('moves into a free cell', () => {
        expect(planMove(screens, 'a', 0, 1, false)).toEqual({ ok: true, moves: [{ id: 'a', from: { col: 0, row: 0 }, to: { col: 0, row: 1 } }] });
    });
    test('no-op when already there', () => {
        expect(planMove(screens, 'a', 0, 0, false)).toEqual({ ok: true, moves: [] });
    });
    test('refuses an occupied cell', () => {
        const r = planMove(screens, 'a', 1, 0, false);
        expect(r).toEqual({ ok: false, error: 'Cell (1,0) is occupied by b. Pass swap: true to trade places.' });
    });
    test('swaps when asked', () => {
        const r = planMove(screens, 'a', 1, 0, true);
        expect(r).toEqual({
            ok: true,
            moves: [
                { id: 'a', from: { col: 0, row: 0 }, to: { col: 1, row: 0 } },
                { id: 'b', from: { col: 1, row: 0 }, to: { col: 0, row: 0 } },
            ],
        });
    });
    test('rejects unknown ids and negative cells', () => {
        expect(planMove(screens, 'zz', 0, 1, false).ok).toBe(false);
        expect(planMove(screens, 'a', -1, 0, false).ok).toBe(false);
    });
});

describe('boardBounds', () => {
    test('covers the screens, the label offset and the margin', () => {
        expect(boardBounds(meta, [s('a', 0, 0)])).toEqual({ x: 20, y: 48, width: 393 + 160, height: 72 + 852 + 160 });
    });
    test('grows with the furthest cell', () => {
        const b = boardBounds(meta, [s('a', 0, 0), s('b', 3, 1)]);
        expect(b.width).toBe(3 * 700 + 393 + 160);
        expect(b.height).toBe(1112 + 72 + 852 + 160);
    });
    test('no screens still gives a one-cell board', () => {
        expect(boardBounds(meta, []).width).toBe(393 + 160);
    });
});

describe('staleReason', () => {
    const frame = { x: 1500, y: 1312 };
    test('valid when the label sits at the frame x and the cell matches', () => {
        expect(staleReason(meta, { col: 2, row: 1 }, frame, { x: 1500, y: 1240 }, true)).toBeNull();
    });
    test('label at another x means the meta was copied by a duplicate', () => {
        expect(staleReason(meta, { col: 2, row: 1 }, frame, { x: 800, y: 1240 }, true)).toBe('label-misplaced');
    });
    test('label id set but node gone', () => {
        expect(staleReason(meta, { col: 2, row: 1 }, frame, null, true)).toBe('label-missing');
    });
    test('no label id: only the cell is checked', () => {
        expect(staleReason(meta, { col: 2, row: 1 }, frame, null, false)).toBeNull();
        expect(staleReason(meta, { col: 0, row: 0 }, frame, null, false)).toBe('cell-mismatch');
    });
});
