import { describe, expect, test } from 'bun:test';

import { assignLanes, clearOfLanes, fanIndex, gutterKey, laneOffset, leadRoute, routeArrow, routeJoin, startLabelAnchor, TRUNK_GAP, type Pt, type Rect, type Route } from './route';

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

    test('2: with a wide trigger, the dot sits 12px inside its right edge, jogs in the middle of the gutter, enters the left edge', () => {
        const s = screen(0, 0);
        const t = screen(1, 0);
        const trigger: Rect = { x: s.x + 20, y: s.y + 700, width: 353, height: 56 };
        const r = must(routeArrow({ source: s, target: t, trigger, gutter: GUTTER, lane: 0 }));
        const sy = trigger.y + 28;
        const midX = s.x + W + GUTTER / 2;
        const ty = t.y + H / 2;
        expect(r.kind).toBe('trigger');
        expect(r.points).toEqual([
            { x: trigger.x + trigger.width - 12, y: sy },
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

    test('5: directly above leaves the source bottom, runs left along the row gap, up the left gutter, and enters the target left edge', () => {
        const s = screen(0, 1);
        const t = screen(0, 0);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const gapY = s.y + H + 60;
        const laneX = s.x - GUTTER / 2;
        expect(r.kind).toBe('around');
        expect(r.points).toEqual([
            { x: s.x + W / 2, y: s.y + H },
            { x: s.x + W / 2, y: gapY },
            { x: laneX, y: gapY },
            { x: laneX, y: t.y + H / 2 },
            { x: t.x, y: t.y + H / 2 },
        ]);
        expect(r.backwards).toBe(false);
    });

    test('a trigger starts the drop at its dot, below the source bottom', () => {
        const s = screen(0, 1);
        const t = screen(0, 0);
        const trigger: Rect = { x: s.x + 20, y: s.y + 700, width: 98, height: 40 };
        const r = must(routeArrow({ source: s, target: t, trigger, gutter: GUTTER, lane: 0 }));
        expect(r.points[0]).toEqual({ x: trigger.x + 49, y: trigger.y + 20 });
        expect((r.points[1] as Pt).x).toBe(trigger.x + 49);
        expect((r.points[1] as Pt).y).toBe(s.y + H + 60);
    });

    test('6: a target to the left leaves the bottom, runs left in the row gap, and enters the target left edge', () => {
        const s = screen(2, 0);
        const t = screen(0, 0);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const gapY = s.y + H + 60;
        const laneX = t.x - GUTTER / 2;
        expect(r.kind).toBe('backwards');
        expect(r.backwards).toBe(true);
        expect(r.points).toEqual([
            { x: s.x + W / 2, y: s.y + H },
            { x: s.x + W / 2, y: gapY },
            { x: laneX, y: gapY },
            { x: laneX, y: t.y + H / 2 },
            { x: t.x, y: t.y + H / 2 },
        ]);
        expect(orthogonal(r.points)).toBe(true);
    });

    test('lanes push the gap run further below and the gutter lane further left', () => {
        const s = screen(2, 0);
        const t = screen(0, 0);
        const at = (lane: number) => must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane })).points;
        expect((at(1)[1] as Pt).y - (at(0)[1] as Pt).y).toBe(24);
        expect((at(0)[2] as Pt).x - (at(1)[2] as Pt).x).toBe(24);
        expect(at(2).at(-1)).toEqual(at(0).at(-1));
    });

    test('every route starts on a bottom or right edge and ends on a left or top edge', () => {
        const cases: [Rect, Rect][] = [
            [screen(0, 0), screen(1, 0)],
            [screen(0, 0), screen(0, 1)],
            [screen(0, 1), screen(0, 0)],
            [screen(2, 0), screen(0, 0)],
            [screen(0, 0), screen(3, 2)],
        ];
        for (const [s, t] of cases) {
            const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
            const a = r.points[0] as Pt;
            const b = r.points.at(-1) as Pt;
            expect(a.y === s.y + H || a.x === s.x + W).toBe(true);
            expect(b.x === t.x || b.y === t.y).toBe(true);
        }
    });

    test('forward routes never move left and are orthogonal', () => {
        const cases: [Rect, Rect, Rect | null][] = [
            [screen(0, 0), screen(1, 0), null],
            [screen(0, 0), screen(3, 2), null],
            [screen(0, 0), screen(1, 1), { x: screen(0, 0).x + 10, y: screen(0, 0).y + 600, width: 200, height: 50 }],
            [screen(1, 1), screen(2, 0), { x: screen(1, 1).x + 10, y: screen(1, 1).y + 600, width: 200, height: 50 }],
            [screen(0, 0), screen(0, 2), null],
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

    test('fanned arrows from one trigger all start at its centre (never shifted) and the highest target takes the rightmost lane', () => {
        const a = route(screen(1, 0), 0, 3);
        const b = route(screen(1, 1), 1, 3);
        const c = route(screen(1, 2), 2, 3);
        const startY = (r: Route) => (r.points[0] as Pt).y;
        const laneX = (r: Route) => (r.points[1] as Pt).x;
        expect(startY(a)).toBe(banner.y + banner.height / 2);
        expect(startY(b)).toBe(startY(a));
        expect(startY(c)).toBe(startY(a));
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

describe('start dot on a trigger', () => {
    const s = screen(0, 0);
    const t = screen(1, 0);
    const dotOf = (trigger: Rect, fan?: { index: number; count: number }, target: Rect = t) =>
        must(routeArrow({ source: s, target, trigger, gutter: GUTTER, lane: 0, ...(fan ? { fan } : {}) })).dot;

    test('a narrow tab hotspot puts the dot at its horizontal centre, on its vertical centre', () => {
        const tab: Rect = { x: s.x + 100, y: s.y + 780, width: 98, height: 60 };
        expect(dotOf(tab)).toEqual({ x: tab.x + 49, y: tab.y + 30 });
    });

    test('a wide row or button puts the dot 12px inside its right edge', () => {
        const row: Rect = { x: s.x + 36, y: s.y + 300, width: 321, height: 64 };
        expect(dotOf(row)).toEqual({ x: row.x + row.width - 12, y: row.y + 32 });
        const button: Rect = { x: s.x + 20, y: s.y + 700, width: 353, height: 56 };
        expect(dotOf(button)).toEqual({ x: button.x + 353 - 12, y: button.y + 28 });
    });

    test('fan index never shifts a dot off its trigger centre', () => {
        const rows = [0, 1, 2].map((i): Rect => ({ x: s.x + 36, y: s.y + 300 + i * 70, width: 321, height: 64 }));
        rows.forEach((row, i) => {
            const d = dotOf(row, { index: i, count: 3 }, screen(1, i));
            expect(d.y).toBe(row.y + 32);
            expect(d.x).toBe(row.x + row.width - 12);
        });
    });
});

describe('start labels', () => {
    const s = screen(0, 0);
    const size = { width: 120, height: 32 };
    test('sit on the first segment just right of the source edge, centred on the line', () => {
        const r = must(routeArrow({ source: s, target: screen(1, 0), trigger: null, gutter: GUTTER, lane: 0 }));
        const at = startLabelAnchor({ ...r, edge: s.x + W }, size);
        expect(at).toEqual({ x: s.x + W + 8 + 60, y: s.y + H / 2 });
    });
    test('a trigger dot inside the screen still puts the label past the screen edge', () => {
        const trigger: Rect = { x: s.x + 20, y: s.y + 700, width: 353, height: 56 };
        const r = must(routeArrow({ source: s, target: screen(1, 3), trigger, gutter: GUTTER, lane: 0 }));
        const at = startLabelAnchor({ ...r, edge: s.x + W }, size);
        expect(at.x).toBe(s.x + W + 8 + 60);
        expect(at.y).toBe(trigger.y + 28);
    });
    test('leadRoute stops at the shared trunk', () => {
        const r = routeJoin(s, screen(1, 2), null, screen(1, 2).x - TRUNK_GAP, null);
        const lead = leadRoute(r, { x: 0, y: 0 });
        expect(lead.points.length).toBe((r.trunkFrom as number) + 1);
        expect(lead.points.at(-1)).toEqual({ x: screen(1, 2).x - TRUNK_GAP, y: s.y + H / 2 });
    });
});
