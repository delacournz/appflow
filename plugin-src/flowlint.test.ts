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

describe('classifyArrow side-entry hop', () => {
    const side = [{ x: 1000, y: 3000 }, { x: 800, y: 3000 }, { x: 800, y: 9000 }, { x: 1000, y: 9400 - 400 }];
    const ok = [{ x: 1000, y: 3000 }, { x: 870, y: 3000 }, { x: 870, y: 9000 }, { x: 1000, y: 9000 }];

    test('a short first hop out of the source then a right-heading entry is accepted', () => {
        expect(classifyArrow(ok, 1, 187)).toEqual({ heading: 'right', issues: [] });
        expect(classifyArrow(ok, 1, 0).issues).toEqual(['runs-left']);
    });

    test('a hop longer than allowed, a later left run, or a non-right head still fails', () => {
        expect(classifyArrow(side, 1, 187).issues).toEqual(['runs-left']);
        const late = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: -60, y: 100 }, { x: -60, y: 500 }, { x: 40, y: 500 }];
        expect(classifyArrow(late, 1, 187).issues).toEqual(['runs-left']);
        const down = [{ x: 100, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 300 }];
        expect(classifyArrow(down, 1, 187).issues).toEqual(['runs-left']);
    });
});
