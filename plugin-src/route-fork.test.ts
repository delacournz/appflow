import { describe, expect, test } from 'bun:test';

import { lintArrows } from './group-lint';
import { startLabelAnchor, type Pt, type Rect, type Route } from './route';
import { planRoutes, type Endpoints } from './route-plan';

const W = 393;
const H = 852;
const PITCH_X = 1140;
const PITCH_Y = 1112;
const cellAt = (col: number, row: number): Rect => ({ x: 164 + col * PITCH_X, y: 2174 + row * PITCH_Y, width: W, height: H });
const key = (r: Rect) => `${r.x}:${r.y}`;
const ends = (source: Rect, target: Rect, trigger: Rect | null = null): Endpoints => ({ source, target, trigger, triggerMissing: false, exit: 'side' });

type Pair = [string, Rect, Rect, Rect?];
const plan = (pairs: Pair[]) => {
    const screens: Rect[] = [];
    for (let c = 0; c <= 6; c++) for (let r = 0; r <= 5; r++) screens.push(cellAt(c, r));
    const plans = planRoutes({ gutter: PITCH_X - W, limits: pairs.map(() => undefined), screens, rowGap: PITCH_Y - H }, pairs.map(([id, s, t, tr]) => ({ id, ends: ends(s, t, tr ?? null) })));
    const route = (id: string): Route => {
        const r = plans.find((p) => p.id === id)?.route;
        if (!r) throw new Error(`no route for ${id}`);
        return r;
    };
    const issues = lintArrows(pairs.map(([id, s, t]) => ({ id, points: route(id).points, label: null, from: key(s), to: key(t) })), [], screens.map((r) => ({ id: key(r), rect: r })));
    return { route, issues };
};

const rowOf = (pts: readonly Pt[]): number => (pts[2] as Pt).y;

describe('arrows from one source to different targets fork', () => {
    const src = cellAt(2, 2);
    const mid = src.y + H / 2;
    const up = cellAt(3, 0);
    const down = cellAt(4, 3);

    test('one up and one down start on the same dot, then split to rows above and below the centre', () => {
        const { route, issues } = plan([['up', src, up], ['down', src, down]]);
        const u = route('up').points;
        const d = route('down').points;
        expect(u[0]).toEqual({ x: src.x + W, y: mid });
        expect(d[0]).toEqual(u[0]);
        expect(rowOf(u)).toBeLessThan(mid);
        expect(rowOf(d)).toBeGreaterThan(mid);
        expect(mid - rowOf(u)).toBe(24);
        expect(rowOf(d) - mid).toBe(24);
        expect(issues.counts['shared-start']).toBeUndefined();
        expect(issues.counts['lines-overlap']).toBeUndefined();
        expect(issues.counts['line-crosses-screen']).toBeUndefined();
    });

    test('the shared stub is short and every branch turns before reaching its own lane', () => {
        const { route } = plan([['up', src, up], ['down', src, down]]);
        for (const id of ['up', 'down']) {
            const p = route(id).points;
            expect((p[1] as Pt).x - src.x - W).toBeLessThanOrEqual(24);
            expect((p[1] as Pt).y).toBe(mid);
            expect((p[1] as Pt).x).toBe((p[2] as Pt).x);
            expect((p[3] as Pt).y).toBe((p[2] as Pt).y);
            expect((p[3] as Pt).x).toBeGreaterThan((p[2] as Pt).x);
        }
    });

    test('each label goes on its own branch row, so the two labels never share a line', () => {
        const { route } = plan([['up', src, up], ['down', src, down]]);
        const size = { width: 120, height: 32 };
        const a = startLabelAnchor(route('up'), size);
        const b = startLabelAnchor(route('down'), size);
        expect(a.y).toBe(rowOf(route('up').points));
        expect(b.y).toBe(rowOf(route('down').points));
        expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(size.height + 8);
        expect(a.x).toBeGreaterThan(src.x + W);
    });

    test('a straight arrow keeps the centre row; the other two take the rows next to it', () => {
        const right = cellAt(3, 2);
        const { route, issues } = plan([['up', src, up], ['straight', src, right], ['down', src, down]]);
        expect(route('straight').points).toEqual([{ x: src.x + W, y: mid }, { x: right.x, y: mid }]);
        expect(mid - rowOf(route('up').points)).toBe(48);
        expect(rowOf(route('down').points) - mid).toBe(48);
        expect(issues.counts['shared-start']).toBeUndefined();
    });

    test('two arrows going up nest: the outer row has the lane further left, so nothing crosses', () => {
        const farUp = cellAt(4, 0);
        const nearUp = cellAt(3, 1);
        const button: Rect = { x: src.x + 20, y: src.y + 617, width: 353, height: 56 };
        const { route, issues } = plan([['far', src, farUp, button], ['near', src, nearUp, button]]);
        expect(issues.counts['lines-overlap']).toBeUndefined();
        expect(route('far').points[0]).toEqual(route('near').points[0]);
        const far = route('far').points;
        const near = route('near').points;
        const [outer, inner] = far.length > near.length ? [far, near] : [near, far];
        expect(inner).toHaveLength(4);
        expect((outer[0] as Pt).y - rowOf(outer)).toBe(48);
        const laneOf = (p: readonly Pt[]) => (p.length > 4 ? (p[3] as Pt).x : (p[1] as Pt).x);
        expect(laneOf(outer)).toBeLessThan(laneOf(inner));
    });

    test('triggered arrows from one control to two targets fork too', () => {
        const button: Rect = { x: src.x + 20, y: src.y + 617, width: 353, height: 56 };
        const { route, issues } = plan([['up', src, up, button], ['down', src, down, button]]);
        expect(route('up').points[0]).toEqual(route('down').points[0]);
        expect(rowOf(route('up').points)).toBeLessThan(rowOf(route('down').points));
        expect(issues.counts['shared-start']).toBeUndefined();
        expect(issues.counts['line-crosses-screen']).toBeUndefined();
    });

    test('a lone arrow is not forked', () => {
        const { route } = plan([['up', src, up]]);
        expect(route('up').points).toHaveLength(4);
    });
});
