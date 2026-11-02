import { describe, expect, test } from 'bun:test';

import { parseRegion, unionRect } from './rect';

describe('unionRect', () => {
    test('single rect is itself', () => {
        expect(unionRect([{ x: 1, y: 2, width: 3, height: 4 }])).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    });
    test('covers disjoint rects', () => {
        expect(
            unionRect([
                { x: 0, y: 0, width: 10, height: 10 },
                { x: 100, y: 50, width: 20, height: 20 },
            ]),
        ).toEqual({ x: 0, y: 0, width: 120, height: 70 });
    });
    test('handles negative coordinates', () => {
        expect(
            unionRect([
                { x: -50, y: -10, width: 10, height: 10 },
                { x: 0, y: 0, width: 5, height: 5 },
            ]),
        ).toEqual({ x: -50, y: -10, width: 55, height: 15 });
    });
    test('empty list is null', () => {
        expect(unionRect([])).toBeNull();
    });
});

describe('parseRegion', () => {
    test('accepts a valid region', () => {
        expect(parseRegion({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    });
    test('rejects missing, non-numeric and non-positive sizes', () => {
        expect(parseRegion(undefined)).toBeNull();
        expect(parseRegion({ x: 1, y: 2, width: '3', height: 4 })).toBeNull();
        expect(parseRegion({ x: 1, y: 2, width: 0, height: 4 })).toBeNull();
        expect(parseRegion({ x: 1, y: 2, width: 3 })).toBeNull();
    });
});
