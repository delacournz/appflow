import { describe, expect, test } from 'bun:test';

import { boundaryExtras, type BoundaryGroup, type Cell } from './flow-group';
import { groupBoundaryExtras, extrasMoves, sameExtras, type GroupRec } from './flow-group-plan';
import { boardBounds, cellOf, cellRect, compactedExtras, shiftedExtras, widenedBetween, type GridMeta } from './grid';
import { parseBoardMeta, cellOfRect } from './flowmeta';
import { cleanExtras, compactExtras, extrasFromPositions, FULL_SPAN, shiftExtras, shiftRanges, trackOf, trackStart, type Extras } from './tracks';

const W = 393;
const H = 852;
const COL = 700;
const ROW = 1112;
const BASE = { colWidth: COL, rowHeight: ROW, screenW: W, screenH: H };
const META: GridMeta = { originX: 1000, originY: 2000, ...BASE, labelOffset: 40, margin: 100 };

const range = (c0: number, c1: number, r0: number, r1: number): Cell[] => {
    const out: Cell[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ col: c, row: r });
    return out;
};
const idOf = (c: Cell) => `s${c.col}_${c.row}`;
const rec = (id: string, cells: Cell[], parentId?: string): GroupRec => ({ id, name: id, screenIds: cells.map(idOf), ...(parentId ? { parentId } : {}) });
const screensOf = (...sets: Cell[][]) => sets.flat().map((c) => ({ id: idOf(c), col: c.col, row: c.row }));

const xOf = (extras: { colExtra: Extras; rowExtra: Extras }, col: number, row: number) => cellRect({ ...META, ...extras }, col, row);

/** Every group sees one shift per column (and per row) across all its lines. */
function expectNoTear(e: { colExtra: Extras; rowExtra: Extras }, groups: GroupRec[]): void {
    for (const g of groups) {
        const cells = g.screenIds.map((id) => ({ col: Number(id.slice(1).split('_')[0]), row: Number(id.split('_')[1]) }));
        const [c0, c1] = [Math.min(...cells.map((c) => c.col)), Math.max(...cells.map((c) => c.col))];
        const [r0, r1] = [Math.min(...cells.map((c) => c.row)), Math.max(...cells.map((c) => c.row))];
        for (let c = c0; c <= c1; c++) expect(new Set(range(c, c, r0, r1).map((x) => trackStart(x.col, COL, e.colExtra, x.row))).size).toBe(1);
        for (let r = r0; r <= r1; r++) expect(new Set(range(c0, c1, r, r).map((x) => trackStart(x.row, ROW, e.rowExtra, x.col))).size).toBe(1);
    }
}

describe('banded trackStart', () => {
    test('a band only applies inside its cross range', () => {
        const e: Extras = [{ at: 2, from: 1, to: 3, px: 100 }];
        expect(trackStart(2, COL, e, 0)).toBe(1400);
        expect(trackStart(2, COL, e, 1)).toBe(1500);
        expect(trackStart(2, COL, e, 3)).toBe(1500);
        expect(trackStart(2, COL, e, 4)).toBe(1400);
        expect(trackStart(1, COL, e, 2)).toBe(700);
        expect(trackStart(5, COL, e, 2)).toBe(3600);
    });
    test('legacy Record extras act as a full-span band', () => {
        const legacy = { 2: 100, 4: 50 };
        for (const cross of [0, 7, 400]) expect(trackStart(4, COL, legacy, cross)).toBe(2950);
        expect(cleanExtras(legacy)).toEqual([
            { at: 2, from: 0, to: FULL_SPAN, px: 100 },
            { at: 4, from: 0, to: FULL_SPAN, px: 50 },
        ]);
    });
    test('trackOf inverts per cross index', () => {
        const e: Extras = [{ at: 2, from: 1, to: 3, px: 300 }];
        for (let i = 0; i < 7; i++) for (const cross of [0, 2, 5]) expect(trackOf(trackStart(i, COL, e, cross) + 3, COL, e, cross)).toBe(i);
    });
});

describe('cleanExtras', () => {
    test('drops junk and merges touching bands with the same at and px', () => {
        const e = cleanExtras([
            { at: 3, from: 1, to: 2, px: 50 },
            { at: 3, from: 3, to: 4, px: 50 },
            { at: 3, from: 9, to: 9, px: 50 },
            { at: 0, from: 0, to: 1, px: 50 },
            { at: 2, from: 0, to: 1, px: -5 },
            { at: 2, from: 3, to: 1, px: 5 },
        ]);
        expect(e).toEqual([
            { at: 3, from: 1, to: 4, px: 50 },
            { at: 3, from: 9, to: 9, px: 50 },
        ]);
    });
});

describe('parseBoardMeta accepts both extras forms', () => {
    const base = {
        v: 1, kind: 'board', arrowStyle: { color: { r: 0, g: 0, b: 0 }, strokeVariableId: null, weight: 2, cornerRadius: 8 },
        originX: 0, originY: 0, colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852, labelOffset: 40, margin: 100, headingId: null, arrowsGroupId: 'g',
    };
    test('old Record form', () => {
        const m = parseBoardMeta(JSON.stringify({ ...base, colExtra: { 2: 100 } }));
        expect(m?.colExtra).toEqual([{ at: 2, from: 0, to: FULL_SPAN, px: 100 }]);
    });
    test('banded form round-trips through JSON', () => {
        const colExtra: Extras = [{ at: 16, from: 0, to: 4, px: 232 }];
        const m = parseBoardMeta(JSON.stringify({ ...base, colExtra, rowExtra: [{ at: 3, from: 16, to: 20, px: 60 }] }));
        expect(m?.colExtra).toEqual(colExtra);
        expect(m?.rowExtra).toEqual([{ at: 3, from: 16, to: 20, px: 60 }]);
    });
    test('old Record form behaves as before in cellOfRect', () => {
        const m = parseBoardMeta(JSON.stringify({ ...base, colExtra: { 2: 100 } }));
        expect(cellOfRect({ x: 1500, y: 0 }, m as NonNullable<typeof m>)).toEqual({ col: 2, row: 0 });
    });
});

describe('cellOf with banded extras', () => {
    const meta: GridMeta = { ...META, colExtra: [{ at: 3, from: 2, to: 4, px: 400 }], rowExtra: [{ at: 2, from: 3, to: 3, px: 250 }] };
    test('every cell round-trips, with small drift', () => {
        for (let col = 0; col < 8; col++)
            for (let row = 0; row < 8; row++) {
                const r = cellRect(meta, col, row);
                expect(cellOf(r, meta)).toEqual({ col, row });
                expect(cellOf({ x: r.x + 5, y: r.y - 5 }, meta)).toEqual({ col, row });
            }
    });
});

describe('shift and compact keep bands aligned', () => {
    const e: Extras = [{ at: 3, from: 2, to: 4, px: 100 }];
    test('insert on the extras axis moves `at`; ranges untouched', () => {
        expect(shiftExtras(e, 1, 2)).toEqual([{ at: 5, from: 2, to: 4, px: 100 }]);
    });
    test('insert on the cross axis shifts and stretches ranges', () => {
        expect(shiftRanges(e, 0, 2)).toEqual([{ at: 3, from: 4, to: 6, px: 100 }]);
        expect(shiftRanges(e, 3, 2)).toEqual([{ at: 3, from: 2, to: 6, px: 100 }]);
        expect(shiftRanges(e, 4, 2)).toEqual([{ at: 3, from: 2, to: 4, px: 100 }]);
    });
    test('shiftedExtras applies both', () => {
        const meta = { colExtra: [{ at: 3, from: 2, to: 4, px: 100 }], rowExtra: [{ at: 1, from: 5, to: 6, px: 40 }] };
        expect(shiftedExtras(meta, 'col', 3, 1)).toEqual({ colExtra: [{ at: 3, from: 2, to: 4, px: 100 }], rowExtra: [{ at: 1, from: 6, to: 7, px: 40 }] });
        expect(shiftedExtras(meta, 'row', 0, 2)).toEqual({ colExtra: [{ at: 3, from: 4, to: 6, px: 100 }], rowExtra: [{ at: 3, from: 5, to: 6, px: 40 }] });
    });
    test('compact re-keys `at` and the cross ranges', () => {
        // cols 0,1,3,4 used (2 empty): at 3 -> 2. rows 2,4,5 used: from 2 -> 2, to 4 -> 3
        expect(compactExtras(e, [0, 1, 3, 4], [2, 4, 5])).toEqual([{ at: 2, from: 2, to: 3, px: 100 }]);
    });
    test('compact drops a band whose cross range lost every used track', () => {
        expect(compactExtras([{ at: 3, from: 6, to: 7, px: 10 }], [0, 3], [0, 1])).toEqual([]);
    });
    test('compactedExtras follows both axes', () => {
        const meta = { colExtra: [{ at: 3, from: 2, to: 4, px: 100 }], rowExtra: [] as Extras };
        const screens = [{ id: 'a', col: 0, row: 2 }, { id: 'b', col: 3, row: 4 }];
        expect(compactedExtras(meta, screens).colExtra).toEqual([{ at: 1, from: 2, to: 3, px: 100 }]);
    });
});

describe('extrasFromPositions (adopt keeps full-span inference)', () => {
    test('returns full-span bands', () => {
        expect(extrasFromPositions([0, 700, 1700], 700)).toEqual([{ at: 2, from: 0, to: FULL_SPAN, px: 300 }]);
    });
});

describe('band-scoped boundaryExtras: Passkeys beside Tabs & Account', () => {
    const tabs = range(11, 15, 0, 4);
    const passkeys = range(16, 21, 1, 2);
    const loose = range(16, 20, 3, 6);
    const kyc = range(11, 25, 8, 12);
    const groups: GroupRec[] = [rec('tabs', tabs), rec('passkeys', passkeys), rec('kyc', kyc)];
    const screens = screensOf(tabs, passkeys, loose, kyc);
    const before = groupBoundaryExtras([rec('tabs', tabs), rec('kyc', kyc)], screensOf(tabs, loose, kyc), BASE);
    const after = groupBoundaryExtras(groups, screens, BASE);

    test('the extra at column 16 covers only the rows beside the touching groups', () => {
        const bands = after.colExtra.filter((b) => b.at === 16);
        expect(bands.length).toBeGreaterThan(0);
        for (const b of bands) {
            expect(b.px).toBeGreaterThan(0);
            expect(b.to).toBeLessThanOrEqual(6);
            expect(b.from).toBeGreaterThanOrEqual(0);
        }
        const covered = (row: number) => bands.some((b) => row >= b.from && row <= b.to);
        expect(covered(1) && covered(2) && covered(3)).toBe(true);
        for (let r = 8; r <= 12; r++) expect(covered(r)).toBe(false);
    });
    test('adding Passkeys moves no KYC screen sideways, and KYC moves as one rigid block', () => {
        const kycIds = new Set(kyc.map(idOf));
        const xs = (e: typeof after) => kyc.map((c) => xOf(e, c.col, c.row).x);
        expect(xs(after)).toEqual(xs(before));
        const dys = new Set(kyc.map((c) => xOf(after, c.col, c.row).y - xOf(before, c.col, c.row).y));
        expect(dys.size).toBe(1);
        const moved = extrasMoves(screens, { ...META, ...before }, after).filter((m) => kycIds.has(m.id));
        expect(moved.length === 0 || moved.length === kyc.length).toBe(true);
    });
    test('screens beside the band move sideways; the loose rows 5-6 and everything left of col 16 do not', () => {
        const dx = (c: Cell) => xOf(after, c.col, c.row).x - xOf(before, c.col, c.row).x;
        expect(dx({ col: 16, row: 1 })).toBeGreaterThan(0);
        expect(dx({ col: 20, row: 3 })).toBeGreaterThan(0);
        expect(dx({ col: 16, row: 6 })).toBe(0);
        expect(dx({ col: 21, row: 7 })).toBe(0);
        for (const c of [...tabs, ...kyc]) expect(dx(c)).toBe(0);
    });
    test('no group is torn: every column of a group sees one shift on all its rows, and every row one on all its columns', () => {
        expectNoTear(after, groups);
    });
});

describe('band-scoped boundaryExtras: stacked groups', () => {
    const passkeys = range(16, 21, 1, 2);
    const device = range(16, 20, 3, 6);
    const tabs = range(11, 15, 0, 4);
    const kyc = range(11, 25, 8, 12);
    const groups: GroupRec[] = [rec('tabs', tabs), rec('passkeys', passkeys), rec('device', device), rec('kyc', kyc)];
    const e = groupBoundaryExtras(groups, screensOf(tabs, passkeys, device, kyc), BASE);

    test('the row boundary below Passkeys only spans its columns', () => {
        const bands = e.rowExtra.filter((b) => b.at === 3);
        expect(bands.length).toBeGreaterThan(0);
        for (const b of bands) {
            expect(b.from).toBeGreaterThanOrEqual(16);
            expect(b.to).toBeLessThanOrEqual(21);
        }
    });
    test('Tabs & Account (cols 11-15, rows 0-4) is never widened: no band touches its columns before its last row', () => {
        for (const b of e.rowExtra) expect(b.at <= 4 && b.from <= 15 && b.to >= 11).toBe(false);
        expect(e.colExtra.every((b) => b.at > 15)).toBe(true);
    });
    test('KYC below the stack gets a compensating band at its own first row, so it moves rigidly', () => {
        const comp = e.rowExtra.filter((b) => b.at === 8);
        expect(comp.length).toBeGreaterThan(0);
        for (const b of comp) expect(b.from >= 11 && b.to <= 25 && (b.to < 16 || b.from > 20)).toBe(true);
        const dy = new Set(kyc.map((c) => trackStart(c.row, ROW, e.rowExtra, c.col)));
        const perRow = (r: number) => new Set(kyc.filter((c) => c.row === r).map((c) => trackStart(c.row, ROW, e.rowExtra, c.col)));
        expect(dy.size).toBeGreaterThan(0);
        for (let r = 8; r <= 12; r++) expect(perRow(r).size).toBe(1);
    });
    test('no group tears', () => {
        expectNoTear(e, groups);
    });
});

describe('transitive expansion', () => {
    test('a band that reaches one group pulls in that group whole, and what it reaches next', () => {
        // left | A (rows 0-3, col 2). Trigger at col 2 only in row 0 (B above-right touches left only at row 0).
        const left = range(0, 1, 0, 0);
        const a = range(2, 3, 0, 3);
        const c = range(2, 3, 4, 6);
        const e = boundaryExtras({
            groups: [{ id: 'l', cells: left }, { id: 'a', cells: a }, { id: 'c', cells: c }],
            ungrouped: [],
            base: BASE,
            laneBand: 160,
        });
        const bands = e.colExtra.filter((b) => b.at === 2);
        expect(bands.length).toBe(1);
        expect(bands[0]?.from).toBe(0);
        expect(bands[0]?.to).toBe(3);
    });
});

describe('sameExtras and boardBounds', () => {
    test('sameExtras compares canonical bands', () => {
        expect(sameExtras([{ at: 2, from: 0, to: 1, px: 5 }, { at: 2, from: 2, to: 3, px: 5 }], [{ at: 2, from: 0, to: 3, px: 5 }])).toBe(true);
        expect(sameExtras([{ at: 2, from: 0, to: 1, px: 5 }], [{ at: 2, from: 0, to: 2, px: 5 }])).toBe(false);
        expect(sameExtras({ 2: 5 }, [{ at: 2, from: 0, to: FULL_SPAN, px: 5 }])).toBe(true);
    });
    test('boardBounds uses the farthest screen, not a whole grid line', () => {
        const meta: GridMeta = { ...META, colExtra: [{ at: 1, from: 0, to: 0, px: 500 }] };
        const b = boardBounds(meta, [{ col: 1, row: 0 }, { col: 1, row: 3 }]);
        expect(b.width).toBe(COL + 500 + W + 200);
        const narrow = boardBounds(meta, [{ col: 1, row: 3 }]);
        expect(narrow.width).toBe(COL + W + 200);
    });
});

describe('untearing', () => {
    test('a band that reaches into a group that straddles the boundary stretches over the group', () => {
        const kid = range(2, 3, 0, 0);
        const parent = [...range(0, 1, 0, 0), ...range(0, 3, 1, 1)];
        const groups = [rec('p', parent), rec('k', kid, 'p')];
        const e = groupBoundaryExtras(groups, screensOf(parent, kid), BASE);
        expect(e.colExtra.length).toBeGreaterThan(0);
        expectNoTear(e, [rec('p', [...parent, ...kid]), rec('k', kid, 'p')]);
        for (const b of e.colExtra) expect([b.from, b.to]).toEqual([0, 1]);
    });
    test('compensation chains: a group below a compensated group is made rigid too', () => {
        const top = range(0, 0, 0, 0);
        const wide = range(0, 2, 2, 2);
        const lower = range(1, 2, 4, 5);
        const side = range(1, 1, 0, 0);
        const groups = [rec('top', top), rec('side', side), rec('wide', wide), rec('lower', lower)];
        const e = groupBoundaryExtras(groups, screensOf(top, side, wide, lower), BASE);
        expectNoTear(e, groups);
    });
});

describe('widenedBetween (router label limit)', () => {
    const meta: GridMeta = { ...META, colExtra: [{ at: 3, from: 1, to: 2, px: 300 }] };
    test('depends on the rows of source and target, read from cell rects', () => {
        expect(widenedBetween(meta, cellRect(meta, 2, 1), cellRect(meta, 3, 1))).toBe(true);
        expect(widenedBetween(meta, cellRect(meta, 2, 5), cellRect(meta, 3, 5))).toBe(false);
        expect(widenedBetween(meta, cellRect(meta, 3, 1), cellRect(meta, 4, 1))).toBe(false);
        expect(widenedBetween(meta, cellRect(meta, 2, 5), cellRect(meta, 3, 1))).toBe(true);
    });
    test('uniform boards are never widened', () => {
        expect(widenedBetween(META, cellRect(META, 0, 0), cellRect(META, 5, 0))).toBe(false);
    });
});
