import { describe, expect, test } from 'bun:test';

import { cellRect } from './grid';
import { basePitchOf, pitchFromNeeds, samePitch, spacingOf, uniformFields } from './pitch';
import { groupBoundaryNeeds, type GroupRec } from './flow-group-plan';
import { EDGE_FOR_TEST } from './pitch-fixtures';

const BASE = { colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852 };
const sc = (id: string, col: number, row: number) => ({ id, col, row });
const rec = (id: string, screenIds: string[]): GroupRec => ({ id, name: id, screenIds });

describe('pitch', () => {
    test('spacing defaults to uniform; banded only when asked', () => {
        expect(spacingOf({})).toBe('uniform');
        expect(spacingOf({ spacing: 'banded' })).toBe('banded');
    });

    test('pitchFromNeeds adds the needs to the base, clamping negatives', () => {
        expect(pitchFromNeeds({ colWidth: 700, rowHeight: 1112 }, { col: 293, row: 652 })).toEqual({ colWidth: 993, rowHeight: 1764 });
        expect(pitchFromNeeds({ colWidth: 700, rowHeight: 1112 }, { col: -5, row: 0 })).toEqual({ colWidth: 700, rowHeight: 1112 });
    });

    test('the base survives a round trip: refits do not compound', () => {
        const base = { colWidth: 700, rowHeight: 1112 };
        let meta = { ...base, ...uniformFields(base, pitchFromNeeds(base, { col: 293, row: 652 })) };
        for (let i = 0; i < 3; i++) {
            const again = pitchFromNeeds(basePitchOf(meta), { col: 293, row: 652 });
            meta = { ...meta, ...uniformFields(basePitchOf(meta), again) };
        }
        expect(meta.colWidth).toBe(993);
        expect(meta.rowHeight).toBe(1764);
    });

    test('the pitch shrinks back to the base when the needs drop', () => {
        const base = { colWidth: 700, rowHeight: 1112 };
        const grown = { ...base, ...uniformFields(base, pitchFromNeeds(base, { col: 293, row: 652 })) };
        const shrunk = pitchFromNeeds(basePitchOf(grown), { col: 0, row: 0 });
        expect(samePitch(shrunk, base)).toBe(true);
    });

    test('an old board without a stored base uses its own pitch as the base', () => {
        expect(basePitchOf({ colWidth: 700, rowHeight: 1112 })).toEqual({ colWidth: 700, rowHeight: 1112 });
    });
});

describe('needs from groups', () => {
    test('stacked and side-by-side groups give the largest need per axis', () => {
        const screens = [sc('a', 0, 0), sc('b', 1, 0), sc('c', 0, 1), sc('d', 1, 1)];
        const needs = groupBoundaryNeeds([rec('top', ['a', 'b']), rec('bottom', ['c', 'd'])], screens, BASE);
        expect(needs.row).toBeGreaterThan(0);
        expect(needs.col).toBe(0);
        const side = groupBoundaryNeeds([rec('l', ['a', 'c']), rec('r', ['b', 'd'])], screens, BASE);
        expect(side.col).toBeGreaterThan(0);
        expect(side.row).toBe(0);
    });

    test('numbers for the default style: columns need 440, rows 652 (pitch 1140 x 1764)', () => {
        const screens = [sc('a', 0, 0), sc('b', 1, 0), sc('c', 0, 1)];
        const needs = groupBoundaryNeeds([rec('g1', ['a']), rec('g2', ['b']), rec('g3', ['c'])], screens, BASE);
        expect(needs.col).toBe(2 * EDGE_FOR_TEST + 2 * 48);
        expect(pitchFromNeeds(BASE, needs)).toEqual({ colWidth: 1140, rowHeight: 1764 });
        expect(needs.row).toBe(2 * EDGE_FOR_TEST + 2 * 48 + 212 + 100 + (BASE.rowHeight - BASE.screenH - 100) - (BASE.rowHeight - BASE.screenH));
    });
});

describe('uniform grid positions', () => {
    const base = { colWidth: 700, rowHeight: 1112 };
    const meta = { originX: 1000, originY: 2000, screenW: 393, screenH: 852, ...pitchFromNeeds(base, { col: 293, row: 652 }) };

    test('live case: column 15 of rows 0-2 (Tabs) and rows 3-4 (Trusted Devices) share one x', () => {
        const xs = [0, 1, 2, 3, 4].map((row) => cellRect(meta, 15, row).x);
        expect(new Set(xs).size).toBe(1);
        expect(xs[0]).toBe(1000 + 15 * 993);
    });

    test('every column gap is equal and every row gap is equal', () => {
        const gapsX = [0, 1, 2, 3].map((c) => cellRect(meta, c + 1, 0).x - cellRect(meta, c, 0).x);
        const gapsY = [0, 1, 2, 3].map((r) => cellRect(meta, 0, r + 1).y - cellRect(meta, 0, r).y);
        expect(new Set(gapsX).size).toBe(1);
        expect(new Set(gapsY).size).toBe(1);
    });
});
