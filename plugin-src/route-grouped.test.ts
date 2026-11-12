import { describe, expect, test } from 'bun:test';

import { labelLimitBetween } from './grid-plan';
import { lintArrows } from './group-lint';
import { cellRectIn, type LayoutGrid } from './layout-grid';
import type { Pt, Rect, Route } from './route';
import { planRoutes, type Endpoints } from './route-plan';

const W = 393;
const H = 852;
const PITCH = { colWidth: 700, rowHeight: 1112 };
const SIZE = { width: W, height: H };
const A: LayoutGrid = { id: 'A', originX: 164, originY: 2174, ...PITCH };
const B: LayoutGrid = { id: 'B', originX: 164 + 3 * 700 + 640, originY: 2174 + 430, ...PITCH };
const C: LayoutGrid = { id: 'C', originX: 164, originY: 2174 + 3 * 1112 + 260, ...PITCH };

const a = (c: number, r: number): Rect => cellRectIn(A, c, r, SIZE);
const b = (c: number, r: number): Rect => cellRectIn(B, c, r, SIZE);
const c = (col: number, r: number): Rect => cellRectIn(C, col, r, SIZE);
const key = (r: Rect) => `${r.x}:${r.y}`;
const ends = (source: Rect, target: Rect): Endpoints => ({ source, target, trigger: null, triggerMissing: false, exit: 'side' });

const screens: Rect[] = [a(0, 0), a(1, 0), a(2, 0), a(2, 1), b(0, 0), b(1, 0), b(0, 1), c(0, 0), c(1, 0)];

const plan = (pairs: [string, Rect, Rect][]) => {
    const meta = { ...PITCH, screenW: W };
    const plans = planRoutes(
        { gutter: PITCH.colWidth - W, limits: pairs.map(([, s, t]) => labelLimitBetween(meta, s, t)), screens, rowGap: PITCH.rowHeight - H },
        pairs.map(([id, s, t]) => ({ id, ends: ends(s, t) })),
    );
    const route = (id: string): Route => {
        const r = plans.find((p) => p.id === id)?.route;
        if (!r) throw new Error(`no route for ${id}`);
        return r;
    };
    const issues = lintArrows(pairs.map(([id, s, t]) => ({ id, points: route(id).points, label: null, from: key(s), to: key(t) })), [], screens.map((r) => ({ id: key(r), rect: r })));
    return { route, issues };
};

describe('arrows between groups at unrelated offsets', () => {
    test('a screen to a screen of another group, 430px lower, routes into its left edge without crossing a screen', () => {
        const { route, issues } = plan([['ab', a(2, 0), b(0, 0)]]);
        const pts = route('ab').points;
        const end = pts.at(-1) as Pt;
        const target = b(0, 0);
        expect(end.x).toBe(target.x);
        expect(end.y).toBeGreaterThan(target.y);
        expect(end.y).toBeLessThan(target.y + H);
        expect(issues.issues.filter((i) => i.kind === 'line-crosses-screen' || i.kind === 'ends-wrong-side' || i.kind === 'starts-wrong-side')).toEqual([]);
    });

    test('the first jog stays in the base gutter beside the source, not in the group gap', () => {
        const { route } = plan([['ab', a(2, 0), b(0, 0)]]);
        const source = a(2, 0);
        const jogs = route('ab').points.slice(1, 3).map((p) => p.x);
        for (const x of jogs) expect(x).toBeLessThanOrEqual(source.x + W + (PITCH.colWidth - W));
    });

    test('two arrows into one group from different rows of another group keep their lines apart', () => {
        const { issues } = plan([
            ['ab0', a(2, 0), b(0, 0)],
            ['ab1', a(2, 1), b(0, 1)],
        ]);
        expect(issues.counts['lines-overlap']).toBeUndefined();
        expect(issues.counts['line-crosses-screen']).toBeUndefined();
    });

    test('an arrow down to a group at another x and y runs through clear space', () => {
        const { issues } = plan([['ac', a(2, 1), c(1, 0)]]);
        expect(issues.counts['line-crosses-screen']).toBeUndefined();
        expect(issues.counts['ends-wrong-side']).toBeUndefined();
    });

    test('an arrow back from a later group to an earlier one still ends on a left or top edge', () => {
        const { issues } = plan([['ba', b(1, 0), a(1, 0)]]);
        expect(issues.counts['ends-wrong-side']).toBeUndefined();
        expect(issues.counts['line-crosses-screen']).toBeUndefined();
    });

    test('a backwards arrow drops to a gap run that no screen of another group occupies', () => {
        const { route } = plan([['ba', b(1, 0), a(1, 0)]]);
        const pts = route('ba').points;
        const run = pts.find((p, i) => i > 0 && p.y === (pts[i - 1] as Pt).y && p.x !== (pts[i - 1] as Pt).x) as Pt;
        const from = pts[0] as Pt;
        const lo = Math.min(run.x, from.x);
        const hi = Math.max(run.x, from.x);
        for (const sc of screens) {
            if (sc.x + sc.width <= lo || sc.x >= hi) continue;
            expect(run.y <= sc.y || run.y >= sc.y + sc.height).toBe(true);
        }
    });

    test('two backwards arrows from one group to another keep apart', () => {
        const { issues } = plan([
            ['x0', b(1, 0), a(1, 0)],
            ['x1', b(0, 1), a(0, 0)],
        ]);
        expect(issues.counts['lines-overlap']).toBeUndefined();
        expect(issues.counts['line-crosses-screen']).toBeUndefined();
    });
});
