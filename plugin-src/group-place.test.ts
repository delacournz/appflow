import { describe, expect, test } from 'bun:test';

import { resolveOverlaps, type PlaceBox } from './group-place';

const CLEAR = 100;
const box = (id: string, x: number, y: number, w: number, h: number, parentId?: string): PlaceBox => ({ id, rect: { x, y, width: w, height: h }, ...(parentId ? { parentId } : {}) });
const moved = (boxes: PlaceBox[]) => Object.fromEntries(resolveOverlaps(boxes, CLEAR).map((m) => [m.id, [m.dx, m.dy]]));

describe('resolveOverlaps', () => {
    test('groups with room between them do not move', () => {
        expect(resolveOverlaps([box('a', 0, 0, 1000, 1000), box('b', 1100, 0, 1000, 1000), box('c', 0, 1100, 1000, 1000)], CLEAR)).toEqual([]);
    });

    test('a group that grew into its right neighbour pushes it right by exactly the missing room', () => {
        expect(moved([box('a', 0, 0, 1050, 1000), box('b', 1100, 0, 1000, 1000)])).toEqual({ b: [50, 0] });
    });

    test('a group that grew down pushes the group below down, never up or left', () => {
        const m = moved([box('a', 0, 0, 1000, 1080), box('b', 0, 1100, 1000, 1000)]);
        expect(m).toEqual({ b: [0, 80] });
    });

    test('the smaller push wins: a box overlapping only a little at the top is pushed down, not right', () => {
        expect(moved([box('a', 0, 0, 1000, 1000), box('b', 100, 950, 1000, 1000)])).toEqual({ b: [0, 150] });
    });

    test('pushes cascade: the pushed group pushes the next one', () => {
        const m = moved([box('a', 0, 0, 1050, 1000), box('b', 1100, 0, 1000, 1000), box('c', 2200, 0, 1000, 1000)]);
        expect(m).toEqual({ b: [50, 0], c: [50, 0] });
    });

    test('a group is never moved when it is the earlier one on the separating axis', () => {
        const m = moved([box('b', 1100, 0, 1000, 1000), box('a', 0, 0, 1050, 1000)]);
        expect(m).toEqual({ b: [50, 0] });
    });

    test('a pushed group takes its nested children along', () => {
        const m = moved([box('a', 0, 0, 1050, 1000), box('b', 1100, 0, 1500, 1000), box('k', 1200, 100, 500, 500, 'b')]);
        expect(m).toEqual({ b: [50, 0], k: [50, 0] });
    });

    test('a nested child inside its parent is not a conflict, and siblings are separated inside the parent', () => {
        expect(resolveOverlaps([box('p', 0, 0, 3000, 1000), box('k', 100, 100, 500, 500, 'p')], CLEAR)).toEqual([]);
        const m = moved([box('p', 0, 0, 3000, 1000), box('k1', 100, 100, 600, 500, 'p'), box('k2', 750, 100, 600, 500, 'p')]);
        expect(m).toEqual({ k2: [50, 0] });
    });

    test('boxes of different parents are not compared with each other', () => {
        expect(resolveOverlaps([box('p', 0, 0, 1000, 1000), box('q', 2000, 0, 1000, 1000), box('k', 900, 100, 500, 500, 'p'), box('j', 1000, 100, 500, 500, 'q')], CLEAR)).toEqual([]);
    });

    test('the result is deterministic and ordered by id', () => {
        const a = resolveOverlaps([box('a', 0, 0, 1050, 1000), box('b', 1100, 0, 1000, 1000), box('c', 0, 1050, 1000, 1000)], CLEAR);
        const b = resolveOverlaps([box('c', 0, 1050, 1000, 1000), box('b', 1100, 0, 1000, 1000), box('a', 0, 0, 1050, 1000)], CLEAR);
        expect(a).toEqual(b);
        expect(a.map((m) => m.id)).toEqual([...a.map((m) => m.id)].sort());
    });
});
