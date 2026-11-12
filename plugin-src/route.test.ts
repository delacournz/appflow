import { describe, expect, test } from 'bun:test';

import { assignLanes, clearOfLanes, fanIndex, gutterKey, laneOffset, routeArrow, type Pt, type Rect, type Route } from './route';

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
        // The label sits on the leg entering the target, so arrows that share a drop keep their labels apart.
        expect(r.labelAnchor).toEqual({ x: (s.x + 340 + t.x) / 2, y: t.y + H / 2 });
    });

    test('exit bottom fan: each arrow drops in its own lane, the highest target rightmost, so the drops never cross', () => {
        const s = screen(0, 0);
        const targets = [screen(1, 2), screen(1, 3), screen(1, 4)];
        const routes = targets.map((t, index) =>
            must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0, exit: 'bottom', fan: { index, count: 3 } })),
        );
        const xs = routes.map((r) => (r.points[0] as Pt).x);
        expect(new Set(xs).size).toBe(3);
        expect(xs[0]).toBe(s.x + 340);
        expect(xs[0] as number).toBeGreaterThan(xs[1] as number);
        expect(xs[1] as number).toBeGreaterThan(xs[2] as number);
        for (const r of routes) {
            expect(r.kind).toBe('elbow');
            expect(orthogonal(r.points)).toBe(true);
            expect(noLeft(r.points)).toBe(true);
            expect((r.points[0] as Pt).x).toBeGreaterThan(s.x);
        }
        const labelYs = routes.map((r) => r.labelAnchor.y);
        expect(labelYs).toEqual(targets.map((t) => t.y + H / 2));
    });

    test('fanIndex groups bottom-exit elbows from one source', () => {
        const fans = fanIndex([
            { id: 'low', group: 'bottom:a', targetY: 300 },
            { id: 'high', group: 'bottom:a', targetY: 100 },
        ]);
        expect(fans.get('high')).toEqual({ index: 0, count: 2 });
        expect(fans.get('low')).toEqual({ index: 1, count: 2 });
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

describe('fan-out from one source', () => {
    const s = screen(0, 0);
    const banner: Rect = { x: s.x + 20, y: s.y + 120, width: 353, height: 80 };
    const route = (t: Rect, index: number, count: number) =>
        must(routeArrow({ source: s, target: t, trigger: banner, gutter: GUTTER, lane: 0, fan: { index, count } }));

    test('the arrow to the highest target starts on top and takes the rightmost lane', () => {
        const a = route(screen(1, 0), 0, 3);
        const b = route(screen(1, 1), 1, 3);
        const c = route(screen(1, 2), 2, 3);
        const startY = (r: Route) => (r.points[0] as Pt).y;
        const laneX = (r: Route) => (r.points[1] as Pt).x;
        expect(startY(a)).toBe(banner.y + banner.height / 2);
        expect(startY(b) - startY(a)).toBe(16);
        expect(startY(c) - startY(b)).toBe(16);
        expect(laneX(a) - laneX(b)).toBe(24);
        expect(laneX(b) - laneX(c)).toBe(24);
        expect(laneX(c)).toBe(s.x + W + 24);
    });

    test('fan arrows enter each target at its middle', () => {
        const t = screen(1, 2);
        expect(route(t, 2, 3).points.at(-1)).toEqual({ x: t.x, y: t.y + H / 2 });
    });

    test('each fan label sits on the segment entering its own target, so labels never stack', () => {
        const targets = [screen(1, 0), screen(1, 1), screen(1, 2)];
        for (const trigger of [banner, null]) {
            const routes = targets.map((t, i) => must(routeArrow({ source: s, target: t, trigger, gutter: GUTTER, lane: 0, fan: { index: i, count: 3 } })));
            routes.forEach((r, i) => {
                const t = targets[i] as Rect;
                const last = r.points.at(-2) as Pt;
                expect(r.labelAnchor.y).toBe(t.y + H / 2);
                expect(r.labelAnchor.x).toBe((last.x + t.x) / 2);
            });
            expect(new Set(routes.map((r) => r.labelAnchor.y)).size).toBe(3);
        }
    });

    test('a straight arrow beside a fan moves its label right of the fan lanes', () => {
        const t = screen(1, 0);
        const straight = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const lanes = [s.x + W + 140, s.x + W + 164];
        const moved = clearOfLanes(straight, lanes);
        expect(moved.labelAnchor).toEqual({ x: (s.x + W + 164 + t.x) / 2, y: straight.labelAnchor.y });
        expect(clearOfLanes(straight, [])).toBe(straight);
    });

    test('fan lanes hug the source edge, leaving room for a label right of them', () => {
        const lanes = [0, 1, 2].map((i) => (route(screen(1, i), i, 3).points[1] as Pt).x);
        const target = screen(1, 0);
        expect(target.x - Math.max(...lanes)).toBeGreaterThanOrEqual(220);
    });

    test('fanIndex orders arrows sharing a source and gutter by target height', () => {
        expect(
            fanIndex([
                { id: 'low', group: 'g', targetY: 300 },
                { id: 'top', group: 'g', targetY: 100 },
                { id: 'other', group: 'h', targetY: 50 },
                { id: 'mid', group: 'g', targetY: 200 },
            ]),
        ).toEqual(
            new Map([
                ['top', { index: 0, count: 3 }],
                ['mid', { index: 1, count: 3 }],
                ['low', { index: 2, count: 3 }],
            ]),
        );
    });
});

describe('labelLimitX (widened column boundary)', () => {
    const s0 = screen(0, 0);
    const EXTRA = 700;
    const farRight = (row: number): Rect => ({ ...screen(1, row), x: screen(1, row).x + EXTRA });
    const limit = s0.x + W + GUTTER;

    test('straight label centres on the base gutter, not the whole span', () => {
        const t = farRight(0);
        const plain = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const capped = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0, labelLimitX: limit }));
        expect(capped.points).toEqual(plain.points);
        expect(capped.labelAnchor.x).toBe(s0.x + W + GUTTER / 2);
        expect(plain.labelAnchor.x).toBeGreaterThan(limit);
    });
    test('gutter jog stays in the base gutter and its label sits left of the extra band', () => {
        const t = farRight(1);
        const r = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0, labelLimitX: limit }));
        expect((r.points[1] as Pt).x).toBe(s0.x + W + GUTTER / 2);
        expect(r.labelAnchor.x).toBeLessThanOrEqual(limit);
        expect(r.labelAnchor.x).toBeGreaterThan((r.points[1] as Pt).x);
    });
    test('elbow and fan labels stay left of the limit', () => {
        const t = farRight(1);
        const elbow = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0, exit: 'bottom', labelLimitX: limit }));
        expect(elbow.labelAnchor.x).toBeLessThanOrEqual(limit);
        const fan = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0, fan: { index: 0, count: 2 }, labelLimitX: limit }));
        expect(fan.labelAnchor.x).toBeLessThanOrEqual(limit);
    });
    test('no limit, or a limit past the target, changes nothing', () => {
        const t = screen(1, 1);
        const a = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const b = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0, labelLimitX: t.x + 50 }));
        expect(b).toEqual(a);
    });
    test('clearOfLanes honours the limit', () => {
        const t = farRight(0);
        const r = must(routeArrow({ source: s0, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const moved = clearOfLanes(r, [s0.x + W + 40], limit);
        expect(moved.labelAnchor.x).toBe((s0.x + W + 40 + limit) / 2);
    });
});
