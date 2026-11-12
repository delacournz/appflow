import { describe, expect, test } from 'bun:test';

import { GROUP_CLEAR, fitBox } from './flow-group';
import { routeArrow, type Pt, type Rect, type Route } from './route';
import { boxEdges, clearLabel, labelObstacles, laneConflicts, type GroupObstacle } from './route-avoid';
import { planRoutes, type Endpoints } from './route-plan';

const W = 393;
const H = 852;
const GUTTER = 307;
const LABEL = { width: 120, height: 32 };
const screen = (col: number, row: number): Rect => ({ x: 1000 + col * 700 + (col > 0 ? 400 : 0), y: 2000 + row * 1400, width: W, height: H });

const must = (r: ReturnType<typeof routeArrow>): Route => {
    if (!r.ok) throw new Error(r.error);
    return r;
};
const group = (...members: Rect[]): GroupObstacle => fitBox(members);
const labelRectOf = (at: Pt) => ({ x: at.x - LABEL.width / 2, y: at.y - LABEL.height / 2, width: LABEL.width, height: LABEL.height });
const hits = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const clearOfAll = (at: Pt, obs: readonly Rect[]) => obs.every((o) => !hits(labelRectOf(at), o));
const anchorOf = (r: ReturnType<typeof clearLabel>): Pt => {
    if (!r.ok) throw new Error(r.blocked);
    return r.anchor;
};

describe('clearLabel', () => {
    test('a label already clear stays put', () => {
        const s = screen(0, 0);
        const t = { ...s, x: s.x + 1200 };
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const res = clearLabel(r, LABEL, labelObstacles([group(s), group(t)]));
        expect(res).toEqual({ ok: true, anchor: r.labelAnchor, moved: false });
    });

    test('side by side groups: a label on a stroke slides into the gap between both boxes', () => {
        const s = screen(0, 0);
        const t = { ...s, x: s.x + 500 + W };
        const gs = [group(s), group(t)];
        const plain = must(routeArrow({ source: s, target: t, trigger: null, gutter: 500, lane: 0 }));
        const r: Route = { ...plain, labelAnchor: { x: s.x + W + 68, y: plain.labelAnchor.y } };
        const obs = labelObstacles(gs);
        expect(clearOfAll(r.labelAnchor, obs)).toBe(false);
        const res = clearLabel(r, LABEL, obs);
        expect(res.ok && res.moved).toBe(true);
        const at = anchorOf(res);
        expect(at.y).toBe(r.labelAnchor.y);
        expect(at.x).toBeGreaterThan(s.x + W + 68 + GROUP_CLEAR);
        expect(at.x).toBeLessThan(t.x - 68 - GROUP_CLEAR);
        expect(clearOfAll(at, obs)).toBe(true);
    });

    test('stacked groups: a backwards label in the row gap leaves both bottom and top strokes', () => {
        const s = screen(1, 0);
        const t = screen(0, 1);
        const gs = [group(s), group(t)];
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const obs = labelObstacles(gs);
        const res = clearLabel(r, LABEL, obs);
        expect(res.ok).toBe(true);
        expect(clearOfAll(anchorOf(res), obs)).toBe(true);
    });

    test('a bottom-exit label that would hit a title moves off it', () => {
        const s = screen(0, 0);
        const t = { ...s, x: s.x + 800, y: s.y + 1400 };
        const g = group(t);
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0, exit: 'bottom' }));
        const title = { x: r.labelAnchor.x - 100, y: r.labelAnchor.y - 20, width: 200, height: 120 };
        const obs = labelObstacles([{ box: g.box, title }]);
        expect(clearOfAll(r.labelAnchor, obs)).toBe(false);
        const res = clearLabel(r, LABEL, obs);
        expect(res.ok).toBe(true);
        expect(clearOfAll(anchorOf(res), obs)).toBe(true);
    });

    test('blocked when every spot is covered', () => {
        const s = screen(0, 0);
        const t = { ...s, x: s.x + 1200 };
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const wall: Rect = { x: s.x, y: s.y + H / 2 - 200, width: 2000, height: 400 };
        expect(clearLabel(r, LABEL, [wall]).ok).toBe(false);
    });
});

describe('laneConflicts', () => {
    const box = group(screen(0, 0)).box;
    test('a vertical lane beside a vertical stroke conflicts; perpendicular crossing does not', () => {
        const edges = boxEdges(box);
        const x = box.x + box.width + 10;
        expect(laneConflicts([{ x, y: box.y + 100 }, { x, y: box.y + 400 }], edges)).toBe(true);
        expect(laneConflicts([{ x: box.x - 200, y: box.y + 100 }, { x: box.x + box.width + 200, y: box.y + 100 }], edges)).toBe(false);
        expect(laneConflicts([{ x: x + 200, y: box.y + 100 }, { x: x + 200, y: box.y + 400 }], edges)).toBe(false);
    });
});

const ends = (source: Rect, target: Rect): Endpoints => ({ source, target, trigger: null, triggerMissing: false, exit: 'side' });

describe('planRoutes with groups', () => {
    test('no groups: identical to the plain plan', () => {
        const a = screen(0, 0);
        const items = [
            { id: 'a', ends: ends(a, screen(1, 0)) },
            { id: 'b', ends: ends(a, { ...screen(1, 0), y: a.y + 1400 }) },
            { id: 'c', ends: ends(screen(1, 0), a) },
        ];
        const cfg = { gutter: GUTTER, limits: items.map(() => undefined) };
        expect(planRoutes({ ...cfg, boxes: [] }, items)).toEqual(planRoutes(cfg, items));
    });

    test('a backwards lane that runs along a bottom stroke steps to a clear lane', () => {
        const s = screen(1, 0);
        const t = screen(0, 1);
        const boxes = [group(s).box, group(t).box];
        const items = [{ id: 'back', ends: ends(s, t) }];
        const cfg = { gutter: GUTTER, limits: [undefined] };
        const plain = planRoutes(cfg, items)[0]?.route as Route;
        expect(laneConflicts(plain.points, boxes.flatMap(boxEdges))).toBe(true);
        const nudged = planRoutes({ ...cfg, boxes }, items)[0]?.route as Route;
        expect(laneConflicts(nudged.points, boxes.flatMap(boxEdges))).toBe(false);
    });

    test('a fan lane hugging a source stroke shifts right, all lanes together', () => {
        const s = screen(0, 0);
        const t1 = { ...s, x: s.x + 800, y: s.y - 300 };
        const t2 = { ...s, x: s.x + 800, y: s.y + 300 };
        const boxes = [group(s).box];
        const items = [
            { id: 'a', ends: ends(s, t1) },
            { id: 'b', ends: ends(s, t2) },
        ];
        const cfg = { gutter: GUTTER, limits: [undefined, undefined], boxes };
        const out = planRoutes(cfg, items);
        for (const p of out) expect(laneConflicts((p.route as Route).points, boxes.flatMap(boxEdges))).toBe(false);
    });
});
