import { describe, expect, test } from 'bun:test';

import { assignScreenTexts, distanceToRect, inferGrid, longestSegmentMid, matchScreenAt, matchTrigger, modeOf, nearestUnclaimed } from './adopt';
import type { Rect } from './route';

const W = 393;
const H = 852;
const cell = (col: number, row: number): Rect => ({ x: 1000 + col * 700, y: 5000 + row * 1112, width: W, height: H });

describe('modeOf', () => {
    test('returns the most common value, clustering within tolerance', () => {
        expect(modeOf([700, 700, 701, 1112, 700], 2)).toBe(700);
        expect(modeOf([], 2)).toBeNull();
    });
});

describe('inferGrid', () => {
    test('finds column width and row height from the most common spacing', () => {
        const screens = [cell(0, 0), cell(1, 0), cell(2, 0), cell(4, 0), cell(0, 1), cell(1, 1), cell(3, 2)];
        expect(inferGrid(screens)).toEqual({ originX: 1000, originY: 5000, colWidth: 700, rowHeight: 1112, screenW: W, screenH: H });
    });

    test('falls back to size plus a default gap when there is a single row and column', () => {
        const g = inferGrid([cell(0, 0)]);
        expect(g.colWidth).toBe(W + 307);
        expect(g.rowHeight).toBe(H + 260);
    });
});

describe('distanceToRect', () => {
    test('is zero inside and the euclidean gap outside', () => {
        const r: Rect = { x: 0, y: 0, width: 10, height: 10 };
        expect(distanceToRect({ x: 5, y: 5 }, r)).toBe(0);
        expect(distanceToRect({ x: 13, y: 5 }, r)).toBe(3);
        expect(distanceToRect({ x: 13, y: 14 }, r)).toBe(5);
    });
});

describe('matchScreenAt', () => {
    const screens = [
        { id: 'a', rect: cell(0, 0) },
        { id: 'b', rect: cell(1, 0) },
    ];
    test('matches a point on or near an edge, nearest first', () => {
        expect(matchScreenAt({ x: cell(0, 0).x + W, y: cell(0, 0).y + 400 }, screens)?.id).toBe('a');
        expect(matchScreenAt({ x: cell(1, 0).x - 3, y: cell(1, 0).y + 400 }, screens)?.id).toBe('b');
    });
    test('does not guess for a point in open space, and honours exclude', () => {
        expect(matchScreenAt({ x: cell(0, 0).x + W + 150, y: cell(0, 0).y + 400 }, screens)).toBeNull();
        expect(matchScreenAt({ x: cell(0, 0).x + W, y: cell(0, 0).y + 400 }, screens, 14, 'a')).toBeNull();
    });
});

describe('matchTrigger', () => {
    const s = cell(0, 0);
    const triggers = [
        { id: 't1', rect: { x: s.x + 20, y: s.y + 100, width: 340, height: 56 }, destinationId: 'x' },
        { id: 't2', rect: { x: s.x + 20, y: s.y + 700, width: 340, height: 56 }, destinationId: 'target' },
    ];
    test('picks the trigger level with the tail', () => {
        expect(matchTrigger({ x: s.x + W, y: s.y + 128 }, triggers, 'x')?.id).toBe('t1');
    });
    test('prefers the trigger whose reaction goes to the matched target when several are level', () => {
        const both = [triggers[1] as (typeof triggers)[number], { id: 't3', rect: { x: s.x + 20, y: s.y + 690, width: 100, height: 80 }, destinationId: 'other' }];
        expect(matchTrigger({ x: s.x + W, y: s.y + 728 }, both, 'target')?.id).toBe('t2');
    });
    test('returns null when nothing is level or too far', () => {
        expect(matchTrigger({ x: s.x + W, y: s.y + 400 }, triggers, 'x')).toBeNull();
        expect(matchTrigger({ x: s.x + W + 500, y: s.y + 128 }, triggers, 'x')).toBeNull();
    });
});

describe('nearestUnclaimed', () => {
    const items = [
        { id: 'a', center: { x: 0, y: 0 } },
        { id: 'b', center: { x: 10, y: 0 } },
        { id: 'c', center: { x: 100, y: 0 } },
    ];
    test('returns the nearest item within range that is not claimed', () => {
        expect(nearestUnclaimed({ x: 1, y: 0 }, items, 12, new Set())?.id).toBe('a');
        expect(nearestUnclaimed({ x: 1, y: 0 }, items, 12, new Set(['a']))?.id).toBe('b');
        expect(nearestUnclaimed({ x: 50, y: 0 }, items, 12, new Set())).toBeNull();
    });
});

describe('longestSegmentMid', () => {
    test('is the midpoint of the longest segment', () => {
        expect(longestSegmentMid([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 500 }, { x: 150, y: 500 }])).toEqual({ x: 100, y: 250 });
    });
});

describe('assignScreenTexts', () => {
    const s = cell(1, 1);
    const texts = [
        { id: 'l', name: 'Label · Step 1 · fix details', rect: { x: s.x, y: s.y - 72, width: 160, height: 28 } },
        { id: 'r', name: 'Route · Step 1 · fix details', rect: { x: s.x, y: s.y - 40, width: 260, height: 20 } },
        { id: 'far', name: 'Label · Other', rect: { x: s.x + 700, y: s.y - 72, width: 100, height: 28 } },
    ];
    test('finds the label and route above a screen by position, not name', () => {
        expect(assignScreenTexts(s, texts)).toEqual({ labelId: 'l', routeId: 'r' });
    });
    test('returns nulls when nothing sits above', () => {
        expect(assignScreenTexts(cell(0, 0), texts)).toEqual({ labelId: null, routeId: null });
    });
});
