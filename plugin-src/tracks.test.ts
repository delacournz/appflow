import { describe, expect, test } from 'bun:test';

import { FULL_SPAN, cleanExtras, compactExtras, extraBetween, extrasFromPositions, shiftExtras, trackOf, trackStart } from './tracks';

/** Old Record form as full-span bands. */
const full = (r: Record<number, number>) => Object.entries(r).map(([k, v]) => ({ at: Number(k), from: 0, to: FULL_SPAN, px: v }));

describe('trackStart', () => {
    test('no extras is index * size', () => {
        expect(trackStart(0, 700, {})).toBe(0);
        expect(trackStart(3, 700, {})).toBe(2100);
        expect(trackStart(3, 700)).toBe(2100);
    });
    test('extras are cumulative for later tracks', () => {
        const e = { 2: 100, 4: 50 };
        expect(trackStart(1, 700, e)).toBe(700);
        expect(trackStart(2, 700, e)).toBe(1500);
        expect(trackStart(3, 700, e)).toBe(2200);
        expect(trackStart(4, 700, e)).toBe(2950);
        expect(trackStart(5, 700, e)).toBe(3650);
    });
    test('extras before track 0 and negative keys are ignored', () => {
        expect(trackStart(2, 700, { 0: 99, [-1]: 99 })).toBe(1400);
    });
});

describe('trackOf', () => {
    test('with no extras rounds like Math.round(pos / size)', () => {
        for (const pos of [-1000, -350, -349, 0, 349, 350, 351, 1400, 2999]) expect(trackOf(pos, 700, {})).toBe(Math.round(pos / 700) + 0);
    });
    test('inverts trackStart with extras and tolerates drift', () => {
        const e = { 2: 100, 4: 300 };
        for (let i = 0; i < 9; i++) {
            expect(trackOf(trackStart(i, 700, e), 700, e)).toBe(i);
            expect(trackOf(trackStart(i, 700, e) + 3, 700, e)).toBe(i);
            expect(trackOf(trackStart(i, 700, e) - 3, 700, e)).toBe(i);
        }
    });
    test('far past the last extra uses the shifted grid', () => {
        expect(trackOf(trackStart(20, 700, { 2: 100 }), 700, { 2: 100 })).toBe(20);
    });
    test('positions before the origin keep the plain grid', () => {
        expect(trackOf(-700, 700, { 2: 100 })).toBe(-1);
    });
});

describe('shiftExtras', () => {
    test('moves extras after the insertion point and keeps earlier ones', () => {
        expect(shiftExtras({ 1: 10, 3: 30 }, 1, 2)).toEqual(full({ 1: 10, 5: 30 }));
    });
    test('-1 inserts before the first track', () => {
        expect(shiftExtras({ 1: 10 }, -1, 1)).toEqual(full({ 2: 10 }));
    });
    test('empty stays empty', () => {
        expect(shiftExtras({}, 0, 3)).toEqual([]);
    });
});

describe('compactExtras', () => {
    test('re-keys extras to the compacted index of the next used track', () => {
        expect(compactExtras({ 3: 100 }, [0, 1, 3])).toEqual(full({ 2: 100 }));
    });
    test('an extra on an emptied track moves to the next used track', () => {
        expect(compactExtras({ 2: 100 }, [0, 1, 3])).toEqual(full({ 2: 100 }));
    });
    test('collapsing extras keep the larger one', () => {
        expect(compactExtras({ 2: 100, 3: 150 }, [0, 1, 3])).toEqual(full({ 2: 150 }));
    });
    test('extras at or before the first used track and past the last are dropped', () => {
        expect(compactExtras({ 1: 10, 2: 20, 9: 90 }, [2, 3])).toEqual([]);
    });
    test('first used track keeps its index', () => {
        expect(compactExtras({ 5: 40 }, [2, 5])).toEqual(full({ 3: 40 }));
    });
});

describe('extraBetween / cleanExtras', () => {
    test('sums extras in (from, to]', () => {
        expect(extraBetween({ 1: 10, 2: 20, 3: 30 }, 1, 3)).toBe(50);
        expect(extraBetween({ 1: 10 }, 1, 2)).toBe(0);
        expect(extraBetween({}, 0, 5)).toBe(0);
    });
    test('cleanExtras drops junk', () => {
        expect(cleanExtras({ 1: 10, 2: 0, 3: -5, 4: Number.NaN })).toEqual(full({ 1: 10 }));
        expect(cleanExtras(undefined)).toEqual([]);
    });
});

describe('extrasFromPositions', () => {
    test('uniform spacing has no extras', () => {
        expect(extrasFromPositions([0, 700, 1400], 700)).toEqual([]);
    });
    test('a missing column is not an extra', () => {
        expect(extrasFromPositions([0, 700, 2100], 700)).toEqual([]);
    });
    test('a wider boundary is recorded before the track after it', () => {
        expect(extrasFromPositions([0, 700, 1700, 2400], 700)).toEqual(full({ 2: 300 }));
    });
    test('small wobble is ignored', () => {
        expect(extrasFromPositions([0, 710, 1400], 700)).toEqual([]);
    });
});
