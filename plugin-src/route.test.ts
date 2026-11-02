import { describe, expect, test } from 'bun:test';

import { assignLanes, gutterKey, laneOffset, routeArrow, type Pt, type Rect, type Route } from './route';

const W = 393;
const H = 852;
const GUTTER = 307;
const screen = (col: number, row: number): Rect => ({ x: 1000 + col * 700, y: 2000 + row * 1112, width: W, height: H });

const must = (r: ReturnType<typeof routeArrow>): Route => {
    if (!r.ok) throw new Error(r.error);
    return r;
};

const noLeft = (points: Pt[]) => points.slice(1).every((p, i) => p.x >= (points[i] as Pt).x);
const orthogonal = (points: Pt[]) => points.slice(1).every((p, i) => p.x === (points[i] as Pt).x || p.y === (points[i] as Pt).y);

describe('laneOffset', () => {
    test('alternates right and left in 24px steps', () => {
        expect([0, 1, 2, 3, 4].map(laneOffset)).toEqual([0, 24, -24, 48, -48]);
    });
});

describe('routeArrow', () => {
    test('1: same row, no trigger, is a straight horizontal line at the row centre', () => {
        const s = screen(0, 0);
        const t = screen(1, 0);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const y = s.y + H / 2;
        expect(r.kind).toBe('straight');
        expect(r.points).toEqual([
            { x: s.x + W, y },
            { x: t.x, y },
        ]);
        expect(r.dot).toEqual({ x: s.x + W, y });
        expect(r.labelAnchor).toEqual({ x: s.x + W + GUTTER / 2, y });
        expect(r.backwards).toBe(false);
    });

    test('2: with a trigger, starts 10px right of it, jogs in the middle of the gutter, enters the left edge', () => {
        const s = screen(0, 0);
        const t = screen(1, 0);
        const trigger: Rect = { x: s.x + 20, y: s.y + 700, width: 353, height: 56 };
        const r = must(routeArrow({ source: s, target: t, trigger, gutter: GUTTER, lane: 0 }));
        const sy = trigger.y + 28;
        const midX = s.x + W + GUTTER / 2;
        const ty = t.y + H / 2;
        expect(r.kind).toBe('trigger');
        expect(r.points).toEqual([
            { x: trigger.x + trigger.width + 10, y: sy },
            { x: midX, y: sy },
            { x: midX, y: ty },
            { x: t.x, y: ty },
        ]);
        expect(r.dot).toEqual(r.points[0] as Pt);
        expect(noLeft(r.points)).toBe(true);
    });

    test('2: a trigger already level with the target collapses to a straight line', () => {
        const s = screen(0, 0);
        const t = screen(1, 0);
        const trigger: Rect = { x: s.x + 20, y: s.y + H / 2 - 28, width: 300, height: 56 };
        const r = must(routeArrow({ source: s, target: t, trigger, gutter: GUTTER, lane: 0 }));
        expect(r.points.length).toBe(2);
    });

    test('3: another row, no trigger, leaves the source right edge and turns in the source gutter', () => {
        const s = screen(1, 0);
        const t = screen(2, 1);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const midX = s.x + W + GUTTER / 2;
        expect(r.kind).toBe('gutter');
        expect(r.points).toEqual([
            { x: s.x + W, y: s.y + H / 2 },
            { x: midX, y: s.y + H / 2 },
            { x: midX, y: t.y + H / 2 },
            { x: t.x, y: t.y + H / 2 },
        ]);
        expect(noLeft(r.points)).toBe(true);
    });

    test('3: a target two columns away still turns in the source gutter', () => {
        const s = screen(0, 0);
        const t = screen(2, 1);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        expect((r.points[1] as Pt).x).toBe(s.x + W + GUTTER / 2);
    });

    test('4: directly below goes from the bottom edge at x+340 to the top edge', () => {
        const s = screen(0, 0);
        const t = screen(0, 1);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        expect(r.kind).toBe('below');
        expect(r.points).toEqual([
            { x: s.x + 340, y: s.y + H },
            { x: s.x + 340, y: t.y },
        ]);
        expect(r.labelAnchor).toEqual({ x: s.x + 340, y: (s.y + H + t.y) / 2 });
    });

    test('4: a trigger does not change the geometry of a vertical route', () => {
        const s = screen(0, 0);
        const t = screen(0, 1);
        const trigger: Rect = { x: s.x + 20, y: s.y + 700, width: 100, height: 40 };
        const a = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const b = must(routeArrow({ source: s, target: t, trigger, gutter: GUTTER, lane: 0 }));
        expect(b.points).toEqual(a.points);
    });

    test('5: directly above goes from the top edge at x+340 up to the bottom edge', () => {
        const s = screen(0, 1);
        const t = screen(0, 0);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        expect(r.kind).toBe('above');
        expect(r.points).toEqual([
            { x: s.x + 340, y: s.y },
            { x: s.x + 340, y: t.y + H },
        ]);
        expect(r.backwards).toBe(false);
    });

    test('6: a target to the left routes below the lowest row, flags backwards, and enters the bottom edge', () => {
        const s = screen(2, 0);
        const t = screen(0, 0);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const dropY = s.y + H + 60;
        expect(r.kind).toBe('backwards');
        expect(r.backwards).toBe(true);
        expect(r.points).toEqual([
            { x: s.x + 340, y: s.y + H },
            { x: s.x + 340, y: dropY },
            { x: t.x + 340, y: dropY },
            { x: t.x + 340, y: t.y + H },
        ]);
        expect(orthogonal(r.points)).toBe(true);
        expect(r.labelAnchor).toEqual({ x: (s.x + t.x) / 2 + 340, y: dropY });
    });

    test('6: the drop clears the lower of the two screens', () => {
        const s = screen(2, 0);
        const t = screen(0, 1);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        expect((r.points[1] as Pt).y).toBe(t.y + H + 60);
    });

    test('forward routes never move left and are orthogonal', () => {
        const cases: [Rect, Rect, Rect | null][] = [
            [screen(0, 0), screen(1, 0), null],
            [screen(0, 0), screen(3, 2), null],
            [screen(0, 0), screen(1, 1), { x: screen(0, 0).x + 10, y: screen(0, 0).y + 600, width: 200, height: 50 }],
            [screen(1, 1), screen(2, 0), { x: screen(1, 1).x + 10, y: screen(1, 1).y + 600, width: 200, height: 50 }],
            [screen(0, 0), screen(0, 2), null],
            [screen(0, 2), screen(0, 0), null],
        ];
        for (const [source, target, trigger] of cases) {
            for (const lane of [0, 1, 2]) {
                const r = must(routeArrow({ source, target, trigger, gutter: GUTTER, lane }));
                expect(noLeft(r.points)).toBe(true);
                expect(orthogonal(r.points)).toBe(true);
            }
        }
    });

    test('lanes offset the gutter jog by 24px per lane', () => {
        const s = screen(0, 0);
        const t = screen(1, 1);
        const x = (lane: number) => (must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points[1] as Pt).x;
        expect(x(1) - x(0)).toBe(24);
        expect(x(2) - x(0)).toBe(-24);
    });

    test('exit bottom: a target below and right leaves the bottom edge, then turns right into the target', () => {
        const s = screen(0, 0);
        const t = screen(1, 2);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0, exit: 'bottom' }));
        expect(r.kind).toBe('elbow');
        expect(r.points).toEqual([
            { x: s.x + 340, y: s.y + H },
            { x: s.x + 340, y: t.y + H / 2 },
            { x: t.x, y: t.y + H / 2 },
        ]);
        expect(r.labelAnchor.x).toBe(s.x + 340);
    });

    test('exit bottom is ignored when the target is not below the source', () => {
        const s = screen(0, 0);
        const r = must(routeArrow({ source: s, target: screen(1, 0), trigger: null, gutter: GUTTER, lane: 0, exit: 'bottom' }));
        expect(r.kind).toBe('straight');
    });

    test('lanes shift an edge start toward the target so it does not share a line with a neighbour', () => {
        const s = screen(0, 0);
        const start = (t: Rect, lane: number) => must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points[0] as Pt;
        expect(start(screen(1, 1), 0)).toEqual({ x: s.x + W, y: s.y + H / 2 });
        expect(start(screen(1, 1), 1)).toEqual({ x: s.x + W, y: s.y + H / 2 + 24 });
        expect(start(screen(1, -1), 1)).toEqual({ x: s.x + W, y: s.y + H / 2 - 24 });
    });

    test('lanes give arrows sharing a target their own arrowhead without crossing', () => {
        const s = screen(0, 0);
        const t = screen(1, 1);
        const head = (lane: number) => must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points.at(-1) as Pt;
        const mid = t.y + H / 2;
        expect(head(0)).toEqual({ x: t.x, y: mid });
        expect(head(1)).toEqual({ x: t.x, y: mid - 24 });
        expect(head(2)).toEqual({ x: t.x, y: mid + 24 });
        const up = (lane: number) => must(routeArrow({ source: screen(0, 2), target: t, trigger: null, gutter: GUTTER, lane })).points.at(-1) as Pt;
        expect(up(1)).toEqual({ x: t.x, y: mid + 24 });
    });

    test('lanes offset a vertical entry and stay inside both frames', () => {
        const s = screen(0, 0);
        const t = screen(0, 1);
        const x = (lane: number) => (must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points[0] as Pt).x;
        expect(x(1)).toBe(s.x + 364);
        expect(x(2)).toBe(s.x + 316);
        expect(x(40)).toBeLessThanOrEqual(s.x + W - 8);
    });

    test('lanes push a backwards sweep further below', () => {
        const s = screen(2, 0);
        const t = screen(0, 0);
        const y = (lane: number) => (must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points[1] as Pt).y;
        expect(y(1) - y(0)).toBe(24);
    });

    test('lanes give each backwards arrow its own arrowhead on the target', () => {
        const s = screen(2, 0);
        const t = screen(0, 0);
        const head = (lane: number) => must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points.at(-1) as Pt;
        expect(head(0)).toEqual({ x: t.x + 340, y: t.y + H });
        expect(head(1)).toEqual({ x: t.x + 340 - 48, y: t.y + H });
        expect(head(2)).toEqual({ x: t.x + 340 - 96, y: t.y + H });
    });

    test('overlapping screens are an error', () => {
        const s = screen(0, 0);
        const r = routeArrow({ source: s, target: { ...s, y: s.y + 100 }, trigger: null, gutter: GUTTER, lane: 0 });
        expect(r.ok).toBe(false);
    });
});

describe('gutterKey', () => {
    test('arrows leaving the same column to the right share a key regardless of row', () => {
        expect(gutterKey(screen(0, 0), screen(1, 1))).toBe(gutterKey(screen(0, 1), screen(2, 0)));
        expect(gutterKey(screen(0, 0), screen(1, 0))).not.toBe(gutterKey(screen(1, 0), screen(2, 0)));
    });

    test('vertical and horizontal arrows from one screen do not share a key', () => {
        expect(gutterKey(screen(0, 0), screen(0, 1))).not.toBe(gutterKey(screen(0, 0), screen(1, 0)));
    });
});

describe('assignLanes', () => {
    test('only items that share a key and overlap in y get different lanes', () => {
        const lanes = assignLanes([
            { key: 'a', yMin: 0, yMax: 100 },
            { key: 'a', yMin: 50, yMax: 200 },
            { key: 'a', yMin: 300, yMax: 400 },
            { key: 'b', yMin: 0, yMax: 100 },
            { key: 'a', yMin: 60, yMax: 90 },
        ]);
        expect(lanes).toEqual([0, 1, 0, 0, 2]);
    });
});
