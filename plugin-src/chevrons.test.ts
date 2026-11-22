import { describe, expect, test } from 'bun:test';

import { CHEVRON, chevronMarks, chevronOffsets } from './chevrons';

const { inset, spacing, minRun, size } = CHEVRON;

describe('chevronOffsets', () => {
    test('a run shorter than minRun gets no chevron', () => {
        expect(chevronOffsets(minRun - 1)).toEqual([]);
    });

    test('a run too short for one near each end gets one in the middle', () => {
        const length = minRun + 10;
        expect(chevronOffsets(length)).toEqual([length / 2]);
    });

    test('a long run gets one near its start and one near its end', () => {
        const length = 2 * inset + spacing / 2;
        expect(chevronOffsets(length)).toEqual([inset, length - inset]);
    });

    test('a very long run repeats every spacing, counted back from its end so shared trunks line up', () => {
        const length = 2 * inset + 2.5 * spacing;
        expect(chevronOffsets(length)).toEqual([inset, length - inset - 2 * spacing, length - inset - spacing, length - inset]);
    });

    test('the last run keeps clear of the arrowhead', () => {
        const length = 2 * inset + spacing / 2;
        expect(chevronOffsets(length, { last: true })).toEqual([inset]);
    });
});

describe('chevronMarks', () => {
    test('each chevron is a V whose tip points along the run', () => {
        const right = chevronMarks([
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
            { x: 1000, y: 20 },
        ]);
        expect(right.length).toBeGreaterThan(0);
        for (const [a, tip, b] of right) {
            expect(tip.x).toBeGreaterThan(a.x);
            expect(tip.x).toBeGreaterThan(b.x);
            expect(a.y).toBe(-size);
            expect(b.y).toBe(size);
            expect(tip.y).toBe(0);
        }
    });

    test('runs going up get chevrons pointing up', () => {
        const up = chevronMarks([
            { x: 0, y: 1000 },
            { x: 0, y: 0 },
            { x: 20, y: 0 },
        ]);
        expect(up.length).toBeGreaterThan(0);
        for (const [a, tip, b] of up) {
            expect(tip.y).toBeLessThan(a.y);
            expect(tip.y).toBeLessThan(b.y);
            expect(tip.x).toBe(0);
        }
    });

    test('skips a chevron that would sit under a label', () => {
        const path = [
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
            { x: 1000, y: 20 },
        ];
        const all = chevronMarks(path);
        const first = all[0];
        if (!first) throw new Error('expected a chevron');
        const tip = first[1];
        const label = { x: tip.x - 40, y: -15, width: 80, height: 30 };
        const kept = chevronMarks(path, [label]);
        expect(kept.length).toBe(all.length - 1);
        expect(kept.some(([, t]) => t.x === tip.x)).toBe(false);
    });

    test('short stubs and corners get none', () => {
        expect(
            chevronMarks([
                { x: 0, y: 0 },
                { x: 8, y: 0 },
                { x: 8, y: -48 },
                { x: 100, y: -48 },
            ]),
        ).toEqual([]);
    });
});
