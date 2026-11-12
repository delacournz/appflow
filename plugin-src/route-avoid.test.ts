import { describe, expect, test } from 'bun:test';

import { GROUP_CLEAR, GROUP_PAD, GROUP_STROKE, fitBox } from './flow-group';
import { routeArrow, type Pt, type Rect, type Route } from './route';
import { lintArrows } from './group-lint';
import { boxEdges, clearLabel, labelObstacles, laneConflicts, screensCrossed, separateLabels, titleHitCount, titleTextRect, type GroupObstacle } from './route-avoid';
import { planRoutes, type Endpoints } from './route-plan';

const EDGE = GROUP_PAD + GROUP_STROKE;
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
        const t = { ...s, x: s.x + 800 + W };
        const gs = [group(s), group(t)];
        const plain = must(routeArrow({ source: s, target: t, trigger: null, gutter: 800, lane: 0 }));
        const r: Route = { ...plain, labelAnchor: { x: s.x + W + EDGE, y: plain.labelAnchor.y } };
        const obs = labelObstacles(gs);
        expect(clearOfAll(r.labelAnchor, obs)).toBe(false);
        const res = clearLabel(r, LABEL, obs);
        expect(res.ok && res.moved).toBe(true);
        const at = anchorOf(res);
        expect(at.y).toBe(r.labelAnchor.y);
        expect(at.x).toBeGreaterThan(s.x + W + EDGE + GROUP_CLEAR);
        expect(at.x).toBeLessThan(t.x - EDGE - GROUP_CLEAR);
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
        const tight = { padding: 64, strokeWeight: 4, titleSize: 96 };
        const boxes = [s, t].map((m) => ({ ...fitBox([m], [], tight).box, strokeWeight: 4 }));
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

const PITCH_Y = 1112;
const pill = (w: number) => ({ width: w, height: 31 });
const rectAt = (at: Pt, s: { width: number; height: number }): Rect => ({ x: at.x - s.width / 2, y: at.y - s.height / 2, width: s.width, height: s.height });
const gap = (a: Rect, b: Rect) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height));
const verticalX = (r: Route) => {
    const seg = r.points.slice(1).map((p, i) => [r.points[i] as Pt, p] as const).find(([a, b]) => a.x === b.x);
    return (seg as readonly [Pt, Pt])[0].x;
};

describe('opposite vertical arrows between one pair of screens', () => {
    const a: Rect = { x: 1000, y: 3000, width: W, height: H };
    const b: Rect = { x: 1000, y: 3000 + PITCH_Y, width: W, height: H };
    const cfg = { gutter: GUTTER, limits: [undefined, undefined] as (number | undefined)[] };
    const items = [
        { id: 'down', ends: ends(a, b) },
        { id: 'up', ends: ends(b, a) },
    ];

    test('A to B and B to A take lanes at least one LANE_STEP apart', () => {
        const [down, up] = planRoutes(cfg, items).map((p) => p.route as Route);
        expect(Math.abs(verticalX(down as Route) - verticalX(up as Route))).toBeGreaterThanOrEqual(24);
    });

    test('three arrows in one corridor all get distinct lanes; arrows in disjoint y ranges share lane 0', () => {
        const c: Rect = { x: 1000, y: 3000 + 2 * PITCH_Y, width: W, height: H };
        const d: Rect = { x: 1000, y: 3000 + 3 * PITCH_Y, width: W, height: H };
        const out = planRoutes({ gutter: GUTTER, limits: [undefined, undefined, undefined, undefined] }, [
            { id: 'ab', ends: ends(a, b) },
            { id: 'ba', ends: ends(b, a) },
            { id: 'cd', ends: ends(c, d) },
            { id: 'dc', ends: ends(d, c) },
        ]).map((p) => verticalX(p.route as Route));
        expect(out[0]).not.toBe(out[1]);
        expect(out[2]).not.toBe(out[3]);
        expect(out[0]).toBe(out[2]);
    });

    test('their labels, 24px apart in x, are staggered along y by the label pass', () => {
        const routes = planRoutes(cfg, items).map((p) => p.route as Route);
        const size = pill(180);
        const before = routes.map((r) => rectAt(r.labelAnchor, size));
        expect(hits(before[0] as Rect, before[1] as Rect)).toBe(true);
        const sep = separateLabels(routes.map((r, i) => ({ id: (items[i] as (typeof items)[number]).id, route: r, anchor: r.labelAnchor, size })), []);
        expect(sep.blocked).toEqual([]);
        const after = routes.map((r, i) => rectAt(sep.anchors.get((items[i] as (typeof items)[number]).id) as Pt, size));
        expect(gap(after[0] as Rect, after[1] as Rect)).toBeGreaterThanOrEqual(8);
        routes.forEach((r, i) => expect((sep.anchors.get((items[i] as (typeof items)[number]).id) as Pt).x).toBe(verticalX(r)));
    });
});

describe('separateLabels across a board', () => {
    test('three exits of one source: no two labels closer than 8px, each still on its own path, deterministic', () => {
        const s = screen(0, 3);
        const straight = { ...s, x: s.x + 1100 };
        const up = { ...s, x: s.x + 1100, y: s.y - 20 };
        const down2 = { ...s, x: s.x + 1100, y: s.y + 20 };
        const its = [
            { id: 'face', ends: ends(s, straight) },
            { id: 'pk', ends: ends(s, up) },
            { id: 'pk2', ends: ends(s, down2) },
        ];
        const routes = planRoutes({ gutter: GUTTER, limits: its.map(() => undefined) }, its).map((p) => p.route as Route);
        const sizes = [pill(110), pill(120), pill(330)];
        const mk = () => its.map((it, i) => ({ id: it.id, route: routes[i] as Route, anchor: (routes[i] as Route).labelAnchor, size: sizes[i] as { width: number; height: number } }));
        const sep = separateLabels(mk(), []);
        expect(sep.blocked).toEqual([]);
        const rects = its.map((it, i) => rectAt(sep.anchors.get(it.id) as Pt, sizes[i] as { width: number; height: number }));
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(gap(rects[i] as Rect, rects[j] as Rect)).toBeGreaterThanOrEqual(8);
        its.forEach((it, i) => {
            const p = sep.anchors.get(it.id) as Pt;
            const pts = (routes[i] as Route).points;
            const onPath = pts.slice(1).some((q, k) => {
                const o = pts[k] as Pt;
                return p.x >= Math.min(o.x, q.x) && p.x <= Math.max(o.x, q.x) && p.y >= Math.min(o.y, q.y) && p.y <= Math.max(o.y, q.y);
            });
            expect(onPath).toBe(true);
        });
        expect(separateLabels(mk(), []).anchors).toEqual(sep.anchors);
    });

    test('labels that already clear each other do not move; group obstacles stay respected', () => {
        const s = screen(0, 0);
        const t = { ...s, x: s.x + 1200 };
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const out = separateLabels([{ id: 'x', route: r, anchor: r.labelAnchor, size: LABEL }], []);
        expect(out.anchors.get('x')).toEqual(r.labelAnchor);
        const wall: Rect = { x: r.labelAnchor.x - 200, y: r.labelAnchor.y - 100, width: 400, height: 200 };
        const moved = separateLabels([{ id: 'x', route: r, anchor: r.labelAnchor, size: LABEL }], [wall]);
        expect(hits(rectAt(moved.anchors.get('x') as Pt, LABEL), wall)).toBe(false);
    });

    test('a label that cannot be placed is reported blocked and keeps its anchor', () => {
        const s = screen(0, 0);
        const t = { ...s, x: s.x + 1200 };
        const r = must(routeArrow({ source: s, target: t, trigger: null, gutter: GUTTER, lane: 0 }));
        const wall: Rect = { x: s.x - 10, y: s.y + H / 2 - 200, width: 4000, height: 400 };
        const out = separateLabels([{ id: 'x', route: r, anchor: r.labelAnchor, size: LABEL }], [wall]);
        expect(out.blocked).toEqual(['x']);
        expect(out.anchors.get('x')).toEqual(r.labelAnchor);
    });
});

describe('vertical arrows and group title text', () => {
    const lower: Rect = { x: 1000, y: 4000, width: W, height: H };
    const upper: Rect = { x: 1000, y: 4000 - PITCH_Y, width: W, height: H };
    const bar = (size: number, chars: number, padding = 24) => {
        const { box, title } = fitBox([lower], [], { padding, strokeWeight: 4, titleSize: size });
        return { box, title, titleChars: chars, strokeWeight: 4 } as GroupObstacle;
    };
    const run = (g: GroupObstacle) =>
        planRoutes({ gutter: GUTTER, limits: [undefined], boxes: [], titles: [titleTextRect(g) as Rect] }, [{ id: 'up', ends: ends(lower, upper) }])[0] as ReturnType<typeof planRoutes>[number];

    test('an upward line through the title text moves just right of the text', () => {
        const g = bar(64, 8);
        const text = titleTextRect(g) as Rect;
        const plain = planRoutes({ gutter: GUTTER, limits: [undefined] }, [{ id: 'up', ends: ends(lower, upper) }])[0]?.route as Route;
        expect(verticalX(plain)).toBeGreaterThan(text.x);
        expect(verticalX(plain)).toBeLessThan(text.x + text.width);
        const out = run(g);
        const x = verticalX(out.route as Route);
        expect(x).toBeGreaterThanOrEqual(text.x + text.width);
        expect(x).toBeLessThanOrEqual(lower.x + W - 8);
        expect(out.warning).toBeUndefined();
    });

    test('text spanning the whole screen: drops down the left gutter and enters the target from its left side', () => {
        const g = bar(96, 14, 64);
        const text = titleTextRect(g) as Rect;
        const out = run(g);
        const pts = (out.route as Route).points;
        expect(out.warning).toBeUndefined();
        expect(titleHitCount(pts, [text])).toBe(0);
        const last = pts[pts.length - 1] as Pt;
        const before = pts[pts.length - 2] as Pt;
        expect(last.x).toBe(upper.x);
        expect(before.y).toBe(last.y);
        expect(before.x).toBeLessThan(last.x);
        expect(last.y).toBeGreaterThan(upper.y);
        expect(last.y).toBeLessThan(upper.y + H);
        const gutterX = Math.min(...pts.map((p) => p.x));
        expect(gutterX).toBeGreaterThanOrEqual(upper.x - GUTTER);
        expect(gutterX).toBeLessThan(upper.x);
    });

    test('titles that the line misses leave the plan untouched', () => {
        const g = bar(64, 2);
        const out = run(g);
        expect(out.route).toEqual(planRoutes({ gutter: GUTTER, limits: [undefined] }, [{ id: 'up', ends: ends(lower, upper) }])[0]?.route);
        expect(out.warning).toBeUndefined();
    });
});

describe('arrow lanes on a uniform board', () => {
    const PITCH_X = 1140;
    const cell = (col: number, row: number): Rect => ({ x: 1000 + col * PITCH_X, y: 2000 + row * PITCH_Y, width: W, height: H });
    const plan = (pairs: [string, Rect, Rect][], titles: Rect[] = []) =>
        planRoutes({ gutter: PITCH_X - W, limits: pairs.map(() => undefined), titles }, pairs.map(([id, s, t]) => ({ id, ends: ends(s, t) })));
    const lint = (plans: ReturnType<typeof planRoutes>, titles: Rect[] = []) =>
        lintArrows(plans.map((p) => ({ id: p.id, points: (p.route as Route).points, label: null })), titles.map((text, i) => ({ id: `g${i}`, text }))).issues;

    test('two arrows leaving one source toward nearly the same height do not share a trunk', () => {
        const s = cell(0, 3);
        const plans = plan([
            ['face', s, cell(1, 3)],
            ['pk', s, { ...cell(1, 3), y: cell(1, 3).y - 20 }],
            ['pk2', s, { ...cell(1, 3), y: cell(1, 3).y + 20 }],
        ]);
        expect(lint(plans).filter((i) => i.kind === 'lines-overlap')).toEqual([]);
    });

    test('bottom-exit drops from vertically adjacent sources into one column get their own vertical lanes', () => {
        const mk = (id: string, s: Rect, t: Rect): [string, Rect, Rect] => [id, s, t];
        const withBottom = planRoutes(
            { gutter: PITCH_X - W, limits: [undefined, undefined] },
            [
                { id: 'a', ends: { ...ends(cell(0, 0), cell(1, 2)), exit: 'bottom' } },
                { id: 'b', ends: { ...ends(cell(0, 1), cell(1, 3)), exit: 'bottom' } },
            ],
        );
        expect(lint(withBottom).filter((i) => i.kind === 'lines-overlap')).toEqual([]);
        const dropA = lint(plan([mk('a', cell(0, 0), cell(0, 2)), mk('b', cell(0, 1), cell(0, 3))]));
        expect(dropA.filter((i) => i.kind === 'lines-overlap')).toEqual([]);
    });

    test('a straight drop and a bottom-exit elbow in one column do not share a line', () => {
        const plans = planRoutes(
            { gutter: PITCH_X - W, limits: [undefined, undefined] },
            [
                { id: 'down', ends: ends(cell(0, 0), cell(0, 2)) },
                { id: 'elbow', ends: { ...ends(cell(0, 1), cell(1, 3)), exit: 'bottom' } },
            ],
        );
        expect(lint(plans).filter((i) => i.kind === 'lines-overlap')).toEqual([]);
    });

    test('a long drop through a title: side entry keeps clear of the title and of other drops', () => {
        const target = cell(11, 9);
        const g = fitBox([target], [], { padding: 160, strokeWeight: 12, titleSize: 96 });
        const obstacle: GroupObstacle = { box: g.box, title: g.title, titleChars: 20, strokeWeight: 12 };
        const text = titleTextRect(obstacle) as Rect;
        const plans = planRoutes(
            { gutter: PITCH_X - W, limits: [undefined, undefined], titles: [text], boxes: [{ ...g.box, strokeWeight: 12 }] },
            [
                { id: 'home', ends: ends(cell(11, 0), target) },
                { id: 'other', ends: ends(cell(11, 1), cell(11, 8)) },
            ],
        );
        expect(plans.every((p) => p.warning === undefined)).toBe(true);
        const issues = lint(plans, [text]);
        expect(issues.filter((i) => i.kind === 'line-crosses-title')).toEqual([]);
        expect(issues.filter((i) => i.kind === 'lines-overlap')).toEqual([]);
        const home = (plans[0] as (typeof plans)[number]).route as Route;
        const end = home.points[home.points.length - 1] as Pt;
        expect(end.x).toBe(target.x);
    });

    test('side-exit drops from different sources in one column get distinct gutter lanes, the deeper target outermost', () => {
        const cellAt = (col: number, row: number): Rect => ({ x: 164 + col * PITCH_X, y: 2174 + row * PITCH_Y, width: W, height: H });
        const buttonOf = (s: Rect): Rect => ({ x: s.x + 20, y: s.y + 617, width: 353, height: 56 });
        const a = cellAt(1, 0);
        const b = cellAt(1, 1);
        const mk = (id: string, s: Rect, t: Rect) => ({ id, ends: { ...ends(s, t), trigger: buttonOf(s) } });
        const its = [mk('A', a, cellAt(2, 4)), mk('A2', a, cellAt(2, 1)), mk('B', b, cellAt(2, 3)), mk('B2', b, cellAt(2, 2))];
        const plans = planRoutes({ gutter: PITCH_X - W, limits: its.map(() => undefined) }, its);
        const pts = (id: string) => ((plans.find((p) => p.id === id) as (typeof plans)[number]).route as Route).points;
        const dropX = (id: string) => (pts(id)[1] as Pt).x;
        const xs = [...new Set(['A', 'A2', 'B', 'B2'].map(dropX))];
        expect(xs.length).toBe(4);
        for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) expect(Math.abs((xs[i] as number) - (xs[j] as number))).toBeGreaterThanOrEqual(24);
        expect(dropX('A')).toBeGreaterThan(dropX('B'));
        const cross = lint(plans).filter((i) => i.kind === 'lines-overlap' && i.arrowId[0] !== (i as { otherId: string }).otherId[0]);
        expect(cross).toEqual([]);
        const first = planRoutes({ gutter: PITCH_X - W, limits: [undefined, undefined] }, [mk('A', a, cellAt(2, 4)), mk('B', b, cellAt(2, 3))]);
        expect(lint(first).filter((i) => i.kind === 'lines-overlap')).toEqual([]);
    });
});

describe('same-row arrows across occupied cells and fan-in', () => {
    const cellAt = (col: number, row: number): Rect => ({ x: 164 + col * PITCH_X, y: 2174 + row * PITCH_Y, width: W, height: H });
    const PITCH_X = 1140;
    const board: Rect[] = [];
    for (let c = 0; c <= 11; c++) board.push(cellAt(c, 0));
    for (let c = 0; c <= 11; c++) board.push(cellAt(c, 1));
    const plan = (pairs: [string, Rect, Rect][]) =>
        planRoutes({ gutter: PITCH_X - W, limits: pairs.map(() => undefined), screens: board, rowGap: PITCH_Y - H }, pairs.map(([id, s, t]) => ({ id, ends: ends(s, t) })));
    const routeOf = (plans: ReturnType<typeof plan>, id: string) => ((plans.find((p) => p.id === id) as (typeof plans)[number]).route as Route).points;
    const noScreenHits = (plans: ReturnType<typeof plan>, pairs: [string, Rect, Rect][]) =>
        pairs.every(([id, s, t]) => screensCrossed(routeOf(plans, id), board, [s, t]) === 0);

    test('a straight run across occupied cells detours through a row gap and enters the target left edge', () => {
        const home = cellAt(11, 0);
        const pairs: [string, Rect, Rect][] = [['email', cellAt(4, 0), home]];
        const plans = plan(pairs);
        const pts = routeOf(plans, 'email');
        expect(noScreenHits(plans, pairs)).toBe(true);
        const last = pts[pts.length - 1] as Pt;
        const before = pts[pts.length - 2] as Pt;
        expect(last.x).toBe(home.x);
        expect(before.y).toBe(last.y);
        expect(before.x).toBeLessThan(last.x);
        const rises = pts.some((p) => p.y < home.y || p.y > home.y + H);
        expect(rises).toBe(true);
        expect(Math.min(...pts.map((p) => p.x))).toBeGreaterThanOrEqual(cellAt(4, 0).x + W);
    });

    test('with no screen in between the straight line is kept', () => {
        const pairs: [string, Rect, Rect][] = [['next', cellAt(4, 0), cellAt(5, 0)]];
        const plans = plan(pairs);
        expect(routeOf(plans, 'next')).toHaveLength(2);
    });

    test('four arrows into Home enter at distinct heights, share no line and cross no screen', () => {
        const home = cellAt(11, 0);
        const pairs: [string, Rect, Rect][] = [
            ['a', cellAt(4, 0), home],
            ['b', cellAt(9, 0), home],
            ['c', cellAt(10, 0), home],
            ['d', cellAt(8, 1), home],
        ];
        const plans = plan(pairs);
        expect(noScreenHits(plans, pairs)).toBe(true);
        const ys = pairs.map(([id]) => (routeOf(plans, id).at(-1) as Pt).y).sort((p, q) => p - q);
        for (let i = 1; i < ys.length; i++) expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(24);
        const issues = lintArrows(
            pairs.map(([id, s, t]) => ({ id, points: routeOf(plans, id), label: null, from: `${s.x}:${s.y}`, to: `${t.x}:${t.y}` })),
            [],
            board.map((r) => ({ id: `${r.x}:${r.y}`, rect: r })),
        ).issues;
        expect(issues.filter((i) => i.kind === 'lines-overlap' || i.kind === 'line-crosses-screen')).toEqual([]);
    });
});
