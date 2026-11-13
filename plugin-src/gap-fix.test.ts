import { describe, expect, test } from 'bun:test';

import { boundaryExtras } from './flow-group';
import { addBands, CONTENT_GAP, gapDeficits, GROUP_GAP, hasDeficits, type Block } from './gap-fix';
import type { Cell } from './flow-group';
import type { Rect } from './rect';

const cells = (c0: number, c1: number, r0: number, r1: number): Cell[] => {
    const out: Cell[] = [];
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) out.push({ col: c, row: r });
    return out;
};
const block = (id: string, rect: Rect, cs: Cell[], extra: Partial<Block> = {}): Block => ({ id, rect, cells: cs, grouped: true, ...extra });
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });

describe('gapDeficits', () => {
    test('groups whose cell ranges interleave on both axes are skipped: spacing cannot separate them', () => {
        const tabs = block('tabs', r(0, 0, 3600, 3500), [...cells(0, 4, 0, 0), { col: 4, row: 2 }]);
        const keys = block('keys', r(-200, 1300, 5000, 2300), [{ col: 4, row: 1 }, ...cells(6, 11, 2, 2)]);
        expect(gapDeficits([tabs, keys])).toEqual({ colExtra: [], rowExtra: [], uniform: { col: 0, row: 0 } });
    });

    test('live case: the upper box grew from internal arrows and touches the lower title bar (zero gap)', () => {
        const device = block('device', r(11632, 5678, 3537, 2000), cells(16, 20, 3, 6));
        const kyc = block('kyc', r(7000, 7678, 9000, 3000), cells(11, 25, 8, 12));
        expect(gapDeficits([device, kyc])).toEqual({ colExtra: [], rowExtra: [{ at: 8, from: 11, to: 25, px: GROUP_GAP }], uniform: { col: 0, row: GROUP_GAP / 2 } });
    });

    test('a gap that is already wide enough needs nothing', () => {
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 1, 0, 1));
        const b = block('b', r(0, 1000 + GROUP_GAP, 1000, 1000), cells(0, 1, 2, 3));
        expect(hasDeficits(gapDeficits([a, b]))).toBe(false);
    });

    test('a partial gap asks for the missing part only', () => {
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 1, 0, 1));
        const b = block('b', r(0, 1100, 1000, 1000), cells(0, 1, 2, 3));
        expect(gapDeficits([a, b]).rowExtra).toEqual([{ at: 2, from: 0, to: 1, px: GROUP_GAP - 100 }]);
    });

    test('side by side: the right block gets a column band over its rows', () => {
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 1, 0, 2));
        const b = block('b', r(1050, 0, 1000, 1000), cells(2, 3, 0, 2));
        expect(gapDeficits([a, b])).toEqual({ colExtra: [{ at: 2, from: 0, to: 2, px: GROUP_GAP - 50 }], rowExtra: [], uniform: { col: GROUP_GAP - 50, row: 0 } });
    });

    test('overlapping boxes are separated by the smaller overlap, gap plus overlap', () => {
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 1, 0, 1));
        const b = block('b', r(0, 980, 1000, 1000), cells(0, 1, 2, 3));
        expect(gapDeficits([a, b]).rowExtra).toEqual([{ at: 2, from: 0, to: 1, px: GROUP_GAP + 20 }]);
    });

    test('ungrouped content needs the smaller CONTENT_GAP, and two ungrouped blocks are ignored', () => {
        const g = block('g', r(0, 0, 1000, 1000), cells(0, 1, 0, 1));
        const u = block('u', r(0, 1040, 393, 852), [{ col: 0, row: 2 }], { grouped: false });
        expect(gapDeficits([g, u]).rowExtra).toEqual([{ at: 2, from: 0, to: 0, px: CONTENT_GAP - 40 }]);
        const u2 = block('u2', r(0, 1050, 393, 852), [{ col: 0, row: 2 }], { grouped: false });
        expect(hasDeficits(gapDeficits([u, u2]))).toBe(false);
    });

    test('uniform need is per boundary step: a pair two rows apart needs half as much pitch', () => {
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 1, 0, 0));
        const b = block('b', r(0, 1000, 1000, 1000), cells(0, 1, 2, 2));
        expect(gapDeficits([a, b]).uniform).toEqual({ col: 0, row: GROUP_GAP / 2 });
    });

    test('parent and child are not neighbours; diagonal pairs are skipped', () => {
        const p = block('p', r(0, 0, 2000, 2000), cells(0, 3, 0, 3));
        const k = block('k', r(100, 100, 500, 500), cells(0, 0, 0, 0), { parentId: 'p' });
        expect(hasDeficits(gapDeficits([p, k]))).toBe(false);
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 0, 0, 0));
        const d = block('d', r(1010, 1010, 1000, 1000), cells(1, 1, 1, 1));
        expect(hasDeficits(gapDeficits([a, d]))).toBe(false);
    });

    test('several pairs on the same boundary take the largest need, not the sum', () => {
        const lower = block('l', r(0, 1100, 3000, 1000), cells(0, 2, 2, 3));
        const a = block('a', r(0, 0, 1000, 1000), cells(0, 0, 0, 1));
        const b = block('b', r(1500, 0, 1000, 1050), cells(1, 2, 0, 1));
        expect(gapDeficits([a, b, lower]).rowExtra).toEqual([{ at: 2, from: 0, to: 2, px: GROUP_GAP - 50 }]);
    });
});

describe('bonus through boundaryExtras', () => {
    const base = { colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852 };
    const groups = [
        { id: 'A', cells: cells(0, 2, 0, 1) },
        { id: 'B', cells: cells(0, 2, 2, 3) },
    ];
    const rowPx = (bonus?: { colExtra: []; rowExtra: { at: number; from: number; to: number; px: number }[] }) =>
        boundaryExtras({ groups, ungrouped: [], base, laneBand: 160, ...(bonus ? { bonus } : {}) }).rowExtra.filter((b) => b.at === 2).reduce((s, b) => s + b.px, 0);

    test('a measured deficit adds on top of the planned extra', () => {
        const planned = rowPx();
        expect(rowPx({ colExtra: [], rowExtra: [{ at: 2, from: 0, to: 2, px: 160 }] })).toBe(planned + 160);
    });
    test('a bonus over part of a group is repaired so the group does not tear', () => {
        const e = boundaryExtras({ groups, ungrouped: [], base, laneBand: 160, bonus: { colExtra: [], rowExtra: [{ at: 2, from: 0, to: 0, px: 160 }] } }).rowExtra;
        const total = (line: number) => e.filter((b) => b.at <= 3 && line >= b.from && line <= b.to).reduce((s, b) => s + b.px, 0);
        expect(total(0)).toBe(total(1));
        expect(total(1)).toBe(total(2));
    });
});

describe('addBands', () => {
    test('overlapping bands on one track sum', () => {
        expect(addBands([{ at: 2, from: 0, to: 2, px: 100 }], [{ at: 2, from: 0, to: 2, px: 60 }]).reduce((s, b) => s + b.px, 0)).toBe(160);
    });
});
