import { describe, expect, test } from 'bun:test';

import { classifyArrow, orderPath } from './flowlint';

const caps = (n: number, arrowAt: number) => Array.from({ length: n }, (_, i) => (i === arrowAt ? 'ARROW_LINES' : 'NONE'));

describe('orderPath', () => {
    test('walks from the tail to the arrowhead, whatever order the vertices are stored in', () => {
        const vertices = [
            { x: 10, y: 0, strokeCap: 'ARROW_LINES' },
            { x: 0, y: 0, strokeCap: 'NONE' },
            { x: 5, y: 0, strokeCap: 'NONE' },
        ];
        const segments = [
            { start: 2, end: 0 },
            { start: 1, end: 2 },
        ];
        expect(orderPath(vertices, segments)).toEqual([
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            { x: 10, y: 0 },
        ]);
    });

    test('returns null when there is no single arrowhead or the path branches', () => {
        const pts = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
        ];
        expect(orderPath(pts.map((p, i) => ({ ...p, strokeCap: caps(2, -1)[i] ?? 'NONE' })), [{ start: 0, end: 1 }])).toBeNull();
        const branch = [
            { x: 0, y: 0, strokeCap: 'NONE' },
            { x: 1, y: 0, strokeCap: 'NONE' },
            { x: 2, y: 0, strokeCap: 'ARROW_LINES' },
            { x: 1, y: 1, strokeCap: 'NONE' },
        ];
        expect(
            orderPath(branch, [
                { start: 0, end: 1 },
                { start: 1, end: 2 },
                { start: 1, end: 3 },
            ]),
        ).toBeNull();
    });
});

describe('classifyArrow', () => {
    test('right, down and up arrows that never move left are fine', () => {
        expect(classifyArrow([{ x: 0, y: 0 }, { x: 300, y: 0 }])).toEqual({ heading: 'right', issues: [] });
        expect(classifyArrow([{ x: 0, y: 0 }, { x: 0, y: 260 }])).toEqual({ heading: 'down', issues: [] });
        expect(classifyArrow([{ x: 0, y: 260 }, { x: 0, y: 0 }])).toEqual({ heading: 'up', issues: [] });
        expect(
            classifyArrow([
                { x: 0, y: 0 },
                { x: 150, y: 0 },
                { x: 150, y: 900 },
                { x: 300, y: 900 },
            ]),
        ).toEqual({ heading: 'right', issues: [] });
    });

    test('an arrowhead pointing left is flagged', () => {
        expect(classifyArrow([{ x: 300, y: 0 }, { x: 0, y: 0 }])).toEqual({ heading: 'left', issues: ['points-left'] });
    });

    test('a path that runs left before turning is flagged even when the head points down', () => {
        expect(
            classifyArrow([
                { x: 1000, y: 0 },
                { x: 1000, y: 100 },
                { x: 0, y: 100 },
                { x: 0, y: 300 },
            ]),
        ).toEqual({ heading: 'down', issues: ['runs-left'] });
    });

    test('jitter under the tolerance is ignored', () => {
        expect(classifyArrow([{ x: 0, y: 0 }, { x: -0.5, y: 200 }])).toEqual({ heading: 'down', issues: [] });
    });
});
