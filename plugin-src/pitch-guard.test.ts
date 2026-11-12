import { describe, expect, test } from 'bun:test';

import { checkPitch, type ScreenPos } from './pitch';

const meta = { originX: 164, originY: 2174, screenW: 393, screenH: 852, labelOffset: 80, margin: 80, colWidth: 1140, rowHeight: 1112 };
const at = (col: number, row: number, pitch: { col: number; row: number }): ScreenPos => ({ col, row, x: 164 + col * pitch.col, y: 2174 + row * pitch.row });
const grid = (pitch: { col: number; row: number }): ScreenPos[] => {
    const out: ScreenPos[] = [];
    for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) out.push(at(c, r, pitch));
    return out;
};

describe('checkPitch', () => {
    test('screens where their cells say they are: fine', () => {
        expect(checkPitch(meta, grid({ col: 1140, row: 1112 }))).toEqual({ kind: 'ok' });
    });

    test('a few hand-moved screens are not a pitch problem', () => {
        const screens = grid({ col: 1140, row: 1112 });
        screens[3] = { ...(screens[3] as ScreenPos), x: (screens[3] as ScreenPos).x + 500 };
        screens[7] = { ...(screens[7] as ScreenPos), y: (screens[7] as ScreenPos).y - 300 };
        expect(checkPitch(meta, screens)).toEqual({ kind: 'ok' });
    });

    test('a uniform board whose meta pitch is not the one the screens sit at is repaired from the positions', () => {
        const r = checkPitch(meta, grid({ col: 1724, row: 1112 }));
        expect(r).toEqual({ kind: 'repair', pitch: { colWidth: 1724, rowHeight: 1112 } });
    });

    test('only the axis that disagrees is repaired', () => {
        const r = checkPitch(meta, grid({ col: 1140, row: 1764 }));
        expect(r).toEqual({ kind: 'repair', pitch: { colWidth: 1140, rowHeight: 1764 } });
    });

    test('positions that agree on no pitch are refused, not guessed', () => {
        const wild = grid({ col: 1140, row: 1112 }).map((s, i) => ({ ...s, x: s.x + ((i * 397) % 900), y: s.y + ((i * 211) % 700) }));
        const r = checkPitch(meta, wild);
        expect(r.kind).toBe('refuse');
        if (r.kind === 'refuse') expect(r.reason).toContain('pitch-mismatch');
    });

    test('a banded board that does not match is refused: its bands cannot be recovered from positions', () => {
        const banded = { ...meta, spacing: 'banded' as const, colExtra: [{ at: 2, from: 0, to: 2, px: 300 }] };
        const r = checkPitch(banded, grid({ col: 1724, row: 1112 }));
        expect(r.kind).toBe('refuse');
    });

    test('too few screens to tell: fine', () => {
        expect(checkPitch(meta, [at(0, 0, { col: 1724, row: 1112 }), at(1, 0, { col: 1724, row: 1112 })])).toEqual({ kind: 'ok' });
    });

    test('the stacked-duplicates case: cells re-derived at the wrong pitch would collide, so it is caught before that', () => {
        const r = checkPitch({ ...meta, colWidth: 700 }, grid({ col: 1140, row: 1112 }));
        expect(r).toEqual({ kind: 'repair', pitch: { colWidth: 1140, rowHeight: 1112 } });
    });
});
