/** Pure arrow planning: lanes, fans, label placement and group-stroke avoidance. No `figma` global, so it runs under bun test. */
import { boxEdges, crowdedRunLength, laneConflicts, screensCrossed, sharedRunLength, titleHitCount, type Edge, type StrokedBox } from './route-avoid';
import { EDGE_MARGIN, LANE_STEP, assignLanes, clearOfLanes, fanIndex, gutterKey, routeArrow, relation, routeJoin, routeViaBand, routeViaGap, TRUNK_GAP, type Exit, type Pt, type Rect, type Route } from './route';

export type Endpoints = { source: Rect; target: Rect; trigger: Rect | null; triggerMissing: boolean; exit: Exit };
/** `warning` is set when a line could not be kept off a group title's text. */
export type Plan = { id: string; route: Route | null; error: string | null; warning?: string };
export type PlanConfig = {
    gutter: number;
    /** Per item (same order as `items`): the absolute x past which its label must not sit; see `RouteInput.labelLimitX`. */
    limits: readonly (number | undefined)[];
    /** Group boxes on the board. Lanes running alongside a stroke step to the next lane. Empty or absent leaves the plan unchanged. */
    boxes?: readonly StrokedBox[];
    /** Text rects of the group titles (`titleTextRect`). Straight vertical arrows shift sideways off them when they can. */
    titles?: readonly Rect[];
    /** Every screen on the board. A line that would pass through a screen other than its own ends detours through a row gap. */
    screens?: readonly Rect[];
    /** Space between a row's bottom and the next row's top (rowHeight - screenH); default 260. */
    rowGap?: number;
};

/** Clear space kept between a vertical line and the end of a title's text. */
const TITLE_MARGIN = 8;

/** Builder lanes from here up mean "gutter lane hugging the target" (`NEAR_EDGE` from its left edge, then one step further each), for gap routes. */
const NEAR_LANE = 100;
const NEAR_EDGE = 24;

/** How many lane steps a conflicting lane may move before the original is kept. */
const MAX_NUDGE = 8;

type Routed = ReturnType<typeof routeArrow>;

/** Routes arrows in the order given, giving each its own lane when it shares a corridor with an earlier one. */
export function planRoutes(cfg: PlanConfig, items: { id: string; ends: Endpoints }[]): Plan[] {
    const { gutter, limits } = cfg;
    const edges: Edge[] = (cfg.boxes ?? []).flatMap(boxEdges);
    const withLimit = <T extends object>(i: number, input: T): T & { labelLimitX?: number } => {
        const labelLimitX = limits[i];
        return labelLimitX === undefined ? input : { ...input, labelLimitX };
    };
    const first = items.map((it, i) => routeArrow(withLimit(i, { ...it.ends, gutter, lane: 0 })));
    const fanGroupOf = new Map<string, string>();
    const fans = fanIndex(
        items.flatMap((it, i) => {
            const r = first[i] as Routed;
            if (!r.ok) return [];
            const s = it.ends.source;
            if (r.kind === 'elbow') {
                const group = `bottom:${s.x}:${s.y}`;
                fanGroupOf.set(it.id, group);
                return [{ id: it.id, group, targetY: it.ends.target.y + it.ends.target.height / 2 }];
            }
            if (r.kind !== 'trigger' && r.kind !== 'gutter') return [];
            const startY = (r.points[0] as Pt).y;
            const targetY = it.ends.target.y + it.ends.target.height / 2;
            if (targetY < startY) return [];
            const group = `${s.x}:${s.y}:${gutterKey(s, it.ends.target)}`;
            fanGroupOf.set(it.id, group);
            return [{ id: it.id, group, targetY }];
        }),
    );
    const lanes = assignLanes(
        items.map((it, i) => {
            const r = first[i] as Routed;
            const ys = r.ok ? r.points.map((p) => p.y) : [0];
            const shared = r.ok && r.kind !== 'straight' && r.kind !== 'elbow' && !fans.has(it.id);
            return { key: shared ? gutterKey(it.ends.source, it.ends.target) : `solo:${it.id}`, yMin: Math.min(...ys), yMax: Math.max(...ys) };
        }),
    );
    const shifts = new Map<string, number>();
    if (edges.length) {
        const byGroup = new Map<string, number[]>();
        items.forEach((it, i) => {
            const g = fanGroupOf.get(it.id);
            if (g && fans.has(it.id) && (first[i] as Routed).ok && ((first[i] as Extract<Routed, { ok: true }>).kind !== 'elbow')) byGroup.set(g, [...(byGroup.get(g) ?? []), i]);
        });
        for (const [g, idx] of byGroup) {
            for (let k = 0; k <= MAX_NUDGE; k++) {
                const clean = idx.every((i) => {
                    const r = routeArrow(withLimit(i, { ...(items[i] as (typeof items)[number]).ends, gutter, lane: 0, fan: fans.get((items[i] as (typeof items)[number]).id), fanShift: k * LANE_STEP }));
                    return r.ok && !laneConflicts(r.points, edges);
                });
                if (clean) {
                    shifts.set(g, k * LANE_STEP);
                    break;
                }
            }
        }
    }
    const routes: Routed[] = items.map((it, i) => {
        const lane = lanes[i] as number;
        const fan = fans.get(it.id);
        if (fan) return routeArrow(withLimit(i, { ...it.ends, gutter, lane: 0, fan, fanShift: shifts.get(fanGroupOf.get(it.id) ?? '') ?? 0 }));
        return lane === 0 ? (first[i] as Routed) : routeArrow(withLimit(i, { ...it.ends, gutter, lane }));
    });
    if (edges.length) {
        const keys = items.map((it, i) => ((first[i] as Routed).ok && (first[i] as Extract<Routed, { ok: true }>).kind !== 'straight' && (first[i] as Extract<Routed, { ok: true }>).kind !== 'elbow' && !fans.has(it.id) ? gutterKey(it.ends.source, it.ends.target) : `solo:${it.id}`));
        const finalLane = [...lanes];
        const yRange = (r: Routed): [number, number] => (r.ok ? [Math.min(...r.points.map((p) => p.y)), Math.max(...r.points.map((p) => p.y))] : [0, 0]);
        items.forEach((it, i) => {
            const r = routes[i] as Routed;
            if (!r.ok || fans.has(it.id) || !laneConflicts(r.points, edges)) return;
            for (let k = 1; k <= MAX_NUDGE; k++) {
                const lane = (lanes[i] as number) + k;
                const cand = routeArrow(withLimit(i, { ...it.ends, gutter, lane }));
                if (!cand.ok || laneConflicts(cand.points, edges)) continue;
                const [lo, hi] = yRange(cand);
                const taken = items.some((_, j) => {
                    if (j === i || keys[j] !== keys[i] || keys[i]?.startsWith('solo:')) return false;
                    const [a, b] = yRange(routes[j] as Routed);
                    return finalLane[j] === lane && a <= hi && lo <= b;
                });
                if (taken) continue;
                routes[i] = cand;
                finalLane[i] = lane;
                return;
            }
        });
    }
    separateFans(routes, items, fans, fanGroupOf, shifts, edges, cfg.titles ?? [], (i, extra) => routeArrow(withLimit(i, { ...(items[i] as (typeof items)[number]).ends, gutter, lane: 0, fan: fans.get((items[i] as (typeof items)[number]).id), fanShift: extra })));
    const edgeOf = (e: Endpoints) => `${e.source.x}:${e.source.y}:${gutterKey(e.source, e.target)}`;
    const fanLanes = new Map<string, number[]>();
    items.forEach((it, i) => {
        const r = routes[i] as Routed;
        if (r.ok && fans.has(it.id)) fanLanes.set(edgeOf(it.ends), [...(fanLanes.get(edgeOf(it.ends)) ?? []), (r.points[1] as Pt).x]);
    });
    const final: Routed[] = routes.map((r, i) => (r.ok && r.kind === 'straight' ? clearOfLanes(r, fanLanes.get(edgeOf((items[i] as (typeof items)[number]).ends)) ?? [], limits[i]) : r));
    const titles = cfg.titles ?? [];
    const builders: (((lane: number) => Routed) | null)[] = items.map((it, i) => {
        const r = final[i] as Routed;
        if (!r.ok || r.kind === 'straight' || fans.has(it.id)) return null;
        const around = r.kind === 'around' || r.kind === 'backwards';
        const { source, target, trigger } = it.ends;
        return (lane: number) => {
            if (lane < NEAR_LANE) return routeArrow(withLimit(i, { ...it.ends, gutter, lane }));
            if (!around) return { ok: false, error: 'no near-column lane' };
            return routeViaGap(source, target, trigger, gutter, 0, { laneX: target.x - NEAR_EDGE - (lane - NEAR_LANE) * LANE_STEP, kind: r.kind, backwards: r.backwards });
        };
    });
    joinTargets(final, items, cfg.screens ?? [], cfg.rowGap ?? 260, titles, edges, builders, gutter);
    detourAroundScreens(final, items, cfg.screens ?? [], cfg.rowGap ?? 260, titles, edges, builders);
    const warnings = titles.length ? shiftOffTitles(final, items, titles, gutter, edges, builders) : new Map<number, string>();
    separateLines(final, builders, titles, edges);
    return items.map((it, i) => {
        const r = final[i] as Routed;
        if (!r.ok) return { id: it.id, route: null, error: r.error };
        const warning = warnings.get(i);
        return { id: it.id, route: { ...r, edge: it.ends.source.x + it.ends.source.width, bottomEdge: it.ends.source.y + it.ends.source.height }, error: null, ...(warning ? { warning } : {}) };
    });
}

const overlap1d = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0;

/** The single vertical leg of a straight 'below'/'above' route, or null. */
function verticalLeg(r: Routed): { x: number; y0: number; y1: number } | null {
    if (!r.ok || (r.kind !== 'below' && r.kind !== 'above')) return null;
    const [a, b] = r.points as [Pt, Pt];
    return { x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
}

/**
 * Moves each straight vertical arrow whose line runs through a title's text to the nearest x just outside it, within
 * the x range both screens allow and at least a lane step from other vertical lines that share its y range. When no x
 * qualifies the line stays and a warning is recorded for its index. Mutates `routes`.
 */
function shiftOffTitles(
    routes: Routed[],
    items: { id: string; ends: Endpoints }[],
    titles: readonly Rect[],
    gutter: number,
    edges: readonly Edge[],
    builders: (((lane: number) => Routed) | null)[],
): Map<number, string> {
    const warnings = new Map<number, string>();
    const crosses = (x: number, y0: number, y1: number, t: Rect) => x > t.x - TITLE_MARGIN && x < t.x + t.width + TITLE_MARGIN && overlap1d(y0, y1, t.y, t.y + t.height);
    routes.forEach((r, i) => {
        const leg = verticalLeg(r);
        if (!leg || !r.ok) return;
        if (!titles.some((t) => crosses(leg.x, leg.y0, leg.y1, t))) return;
        const { source, target, trigger } = (items[i] as (typeof items)[number]).ends;
        const lo = Math.max(source.x, target.x) + EDGE_MARGIN;
        const hi = Math.min(source.x + source.width, target.x + target.width) - EDGE_MARGIN;
        const free = (x: number) =>
            x >= lo && x <= hi && !titles.some((t) => crosses(x, leg.y0, leg.y1, t)) && !routes.some((o, j) => {
                const ol = j === i ? null : verticalLeg(o);
                return !!ol && overlap1d(leg.y0, leg.y1, ol.y0, ol.y1) && Math.abs(ol.x - x) < LANE_STEP;
            });
        const cands = titles.flatMap((t) => [t.x - TITLE_MARGIN, t.x + t.width + TITLE_MARGIN]).filter(free);
        if (!cands.length) {
            // No x inside both screens works: leave the source's bottom, run along the row gap into the left gutter and enter the target's left edge.
            for (let k = 0; k <= MAX_NUDGE; k++) {
                const dx = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * LANE_STEP;
                const side = routeViaGap(source, target, trigger, gutter, 0, { dx });
                if (side.ok && titleHitCount(side.points, titles) === 0 && !laneConflicts(side.points, edges)) {
                    routes[i] = side;
                    builders[i] = (lane) => routeViaGap(source, target, trigger, gutter, lane, { dx });
                    return;
                }
            }
            warnings.set(i, `line crosses a group title's text and no lane within both screens avoids it`);
            return;
        }
        const x = cands.reduce((best, c) => (Math.abs(c - leg.x) < Math.abs(best - leg.x) ? c : best));
        routes[i] = { ...r, points: r.points.map((p) => ({ ...p, x })), dot: { ...r.dot, x }, labelAnchor: { ...r.labelAnchor, x } };
    });
    return warnings;
}

/**
 * Last pass over every route: a line that shares a collinear stretch with another arrow (`lines-overlap`), runs through
 * a title's text, or runs along a group stroke tries the next lanes of its own builder and keeps the cheapest. Lines
 * that cannot move (straight, fanned, title-shifted) stay; the arrow they collide with moves instead. Mutates `routes`.
 */
function separateLines(routes: Routed[], builders: (((lane: number) => Routed) | null)[], titles: readonly Rect[], edges: readonly Edge[]): void {
    const cost = (i: number, pts: readonly Pt[]): number => {
        let c = 100 * titleHitCount(pts, titles) + (edges.length && laneConflicts(pts, edges) ? 50 : 0);
        routes.forEach((o, j) => {
            if (j === i || !o.ok) return;
            if (sharedRunLength(pts, o.points) > 1) c += 1000;
            else if (crowdedRunLength(pts, o.points, LANE_STEP) > 0) c += 0.5;
        });
        return c;
    };
    for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        routes.forEach((r, i) => {
            const build = builders[i];
            if (!r.ok || !build) return;
            const current = cost(i, r.points);
            if (current < 1) return;
            let best: { route: Routed; c: number } | null = null;
            for (const lane of [...Array.from({ length: MAX_NUDGE + 1 }, (_, n) => n), ...Array.from({ length: 5 }, (_, n) => NEAR_LANE + n)]) {
                const cand = build(lane);
                if (!cand.ok) continue;
                const c = cost(i, cand.points);
                if (c < current && (!best || c < best.c)) best = { route: cand, c };
                if (best && best.c < 1) break;
            }
            if (best) {
                routes[i] = best.route;
                moved = true;
            }
        });
        if (!moved) break;
    }
}

/**
 * Fan lanes of two different sources in one gutter start at the same x and would share a vertical line wherever their
 * y ranges overlap. Each fan group, the one reaching the shallowest target first so the deepest ends outermost (no crossings), moves out by whole lane steps (all its arrows together, so the
 * fan keeps its order) until no line of it shares a collinear stretch with another arrow, runs through a title or
 * along a group stroke. Mutates `routes`.
 */
function separateFans(
    routes: Routed[],
    items: { id: string; ends: Endpoints }[],
    fans: ReadonlyMap<string, unknown>,
    fanGroupOf: ReadonlyMap<string, string>,
    shifts: ReadonlyMap<string, number>,
    edges: readonly Edge[],
    titles: readonly Rect[],
    reroute: (i: number, fanShift: number) => Routed,
): void {
    const groups = new Map<string, number[]>();
    items.forEach((it, i) => {
        const g = fanGroupOf.get(it.id);
        const r = routes[i] as Routed;
        if (g && fans.has(it.id) && r.ok && r.kind !== 'elbow') groups.set(g, [...(groups.get(g) ?? []), i]);
    });
    const deepest = (idx: number[]) => Math.max(...idx.map((i) => (items[i] as (typeof items)[number]).ends.target.y));
    const pending = new Set([...groups.values()].flat());
    const ordered = [...groups].sort((a, b) => deepest(a[1]) - deepest(b[1]));
    for (const [g, idx] of ordered) {
        const members = new Set(idx);
        for (const i of idx) pending.delete(i);
        const costOf = (rs: Routed[]): number =>
            rs.reduce((sum, r, n) => {
                if (!r.ok) return sum;
                let c = 100 * titleHitCount(r.points, titles) + (edges.length && laneConflicts(r.points, edges) ? 50 : 0);
                routes.forEach((o, j) => {
                    if (members.has(j) || pending.has(j) || !o.ok) return;
                    if (sharedRunLength(r.points, o.points) > 1) c += 1000;
                    else if (crowdedRunLength(r.points, o.points, LANE_STEP) > 0) c += 0.5;
                });
                void n;
                return sum + c;
            }, 0);
        const base = shifts.get(g) ?? 0;
        let best: { rs: Routed[]; c: number } | null = null;
        for (let k = 0; k <= MAX_NUDGE; k++) {
            const rs = idx.map((i) => reroute(i, base + k * LANE_STEP));
            const c = costOf(rs);
            if (!best || c < best.c) best = { rs, c };
            if (c < 1) break;
        }
        if (best) idx.forEach((i, n) => (routes[i] = (best as { rs: Routed[] }).rs[n] as Routed));
    }
}

const SCREEN_COST = 10_000;

/**
 * A line that passes through a screen other than its source and target (a straight run across occupied cells, or a long
 * final leg along a row) is redrawn through a row gap: out of the source's right edge, into a band above or below the
 * target's row that no screen occupies, along it, and into the target's left edge. The band is the nearest height
 * that keeps clear of screens, other lines, titles and strokes. Replaces the route and its lane builder; mutates `routes`.
 */
function detourAroundScreens(
    routes: Routed[],
    items: { id: string; ends: Endpoints }[],
    screens: readonly Rect[],
    rowGap: number,
    titles: readonly Rect[],
    edges: readonly Edge[],
    builders: (((lane: number) => Routed) | null)[],
): void {
    if (!screens.length) return;
    routes.forEach((r, i) => {
        if (!r.ok) return;
        const { source, target, trigger } = (items[i] as (typeof items)[number]).ends;
        if (target.x < source.x + source.width) return;
        if (screensCrossed(r.points, screens, [source, target]) === 0) return;
        const cost = (pts: readonly Pt[]): number => {
            let c = SCREEN_COST * screensCrossed(pts, screens, [source, target]) + 100 * titleHitCount(pts, titles) + (edges.length && laneConflicts(pts, edges) ? 50 : 0);
            routes.forEach((o, j) => {
                if (j === i || !o.ok) return;
                if (sharedRunLength(pts, o.points) > 1) c += 1000;
                else if (crowdedRunLength(pts, o.points, LANE_STEP) > 0) c += 0.5;
            });
            return c;
        };
        const bands: number[] = [];
        for (let k = 0; k <= 8; k++) bands.push(target.y - 72 - 32 - k * LANE_STEP);
        for (let k = 0; k <= 8; k++) bands.push(target.y + target.height + 24 + k * LANE_STEP);
        const lo = target.y - rowGap + 8;
        const hi = target.y + target.height + rowGap - 8;
        let best: { route: Routed; c: number; y: number; lane: number } | null = null;
        for (let lane = 0; lane <= 4 && (!best || best.c >= 1); lane++) {
            for (const y of bands) {
                if (y < lo || y > hi) continue;
                const cand = routeViaBand(source, target, trigger, y, lane);
                const c = cost(cand.points);
                if (!best || c < best.c) best = { route: cand, c, y, lane };
            }
        }
        const chosen = best as { route: Routed; c: number; y: number; lane: number } | null;
        if (!chosen || chosen.c >= SCREEN_COST) return;
        routes[i] = chosen.route;
        builders[i] = (lane) => routeViaBand(source, target, trigger, chosen.y, lane);
    });
}

const bandsFor = (target: Rect, rowGap: number): number[] => {
    const out: number[] = [];
    const lo = target.y - rowGap + 8;
    const hi = target.y + target.height + rowGap - 8;
    for (let k = 0; k <= 8; k++) out.push(target.y - 72 - 32 - k * LANE_STEP);
    for (let k = 0; k <= 8; k++) out.push(target.y + target.height + 24 + k * LANE_STEP);
    return out.filter((y) => y >= lo && y <= hi);
};

/**
 * Arrows entering the same target from the left merge: each runs from its dot to one trunk lane in the gutter in front
 * of the target, along it to the entry height, and into the target on a final run they all share, so heads coincide.
 * A branch whose straight run to the trunk would cross a screen leaves through its source's gutter into a row-gap band
 * instead. The trunk moves out lane by lane until the whole group is clear of screens, titles, strokes and other lines
 * (the shared trunk and final run themselves are deliberate). Groups are handled lowest target first, so the lower
 * target's trunk sits nearest the column and the trunks of higher targets stack further out without crossing it. Merged routes have no lane builder: they stay put and
 * other arrows move around them. Replaces routes of arrows entering a target together with at least one other.
 */
function joinPass(
    order: 'lower' | 'upper',
    routes: Routed[],
    items: { id: string; ends: Endpoints }[],
    screens: readonly Rect[],
    rowGap: number,
    titles: readonly Rect[],
    edges: readonly Edge[],
    builders: (((lane: number) => Routed) | null)[],
    gutter: number,
    repair = false,
): { total: number; members: number[] } {
    const groups = new Map<string, number[]>();
    items.forEach((it, i) => {
        const r = routes[i] as Routed;
        const { source, target, exit } = it.ends;
        const rel = relation(source, target);
        if (!r.ok || exit === 'bottom' || (rel !== 'right' && rel !== 'above' && rel !== 'left')) return;
        const key = `${target.x}:${target.y}`;
        groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    const startY = (i: number) => {
        const { source, trigger } = (items[i] as (typeof items)[number]).ends;
        return trigger ? trigger.y + trigger.height / 2 : source.y + source.height / 2;
    };
    const joined = [...groups.values()].filter((g) => g.length >= 2);
    const pending = new Set(repair ? [] : joined.flat());
    const lowerFirst = (g: number[]) => (items[g[0] as number] as (typeof items)[number]).ends.target.y;
    let grand = 0;
    const done: number[] = [];
    for (const idx of [...joined].sort((p, q) => (order === 'lower' ? lowerFirst(q) - lowerFirst(p) : lowerFirst(p) - lowerFirst(q)))) {
        const ordered = [...idx].sort((a, b) => startY(a) - startY(b));
        const members = new Set(idx);
        for (const i of idx) pending.delete(i);
        const target = (items[idx[0] as number] as (typeof items)[number]).ends.target;
        const ey = target.y + target.height / 2;
        let best: { total: number; chosen: Routed[] } | null = null;
        for (let k = 0; k <= MAX_NUDGE; k++) {
            const trunkX = target.x - TRUNK_GAP - k * LANE_STEP;
            const trial = new Map<number, Routed>();
            let total = 0;
            for (const i of ordered) {
                const { source, trigger } = (items[i] as (typeof items)[number]).ends;
                const cost = (pts: readonly Pt[]): number => {
                    let c = SCREEN_COST * screensCrossed(pts, screens, [source, target]) + 100 * titleHitCount(pts, titles) + (edges.length && laneConflicts(pts, edges) ? 50 : 0);
                    const against = (o: Routed, ignore: { v?: number; h?: number }) => {
                        if (!o.ok) return;
                        if (sharedRunLength(pts, o.points, ignore) > 1) c += 1000;
                        else if (crowdedRunLength(pts, o.points, LANE_STEP) > 0) c += 0.5;
                    };
                    routes.forEach((o, j) => {
                        if (j !== i && !members.has(j) && !pending.has(j)) against(o, {});
                    });
                    for (const [j, o] of trial) if (j !== i) against(o, { v: trunkX, h: ey });
                    return c;
                };
                const around = relation(source, target) !== 'right';
                const plain = around ? routeViaGap(source, target, trigger, gutter, 0, { laneX: trunkX, shared: true, ...(relation(source, target) === 'left' ? { kind: 'backwards' as const, backwards: true } : {}) }) : routeJoin(source, target, trigger, trunkX, null);
                let pick: { route: Routed; c: number } = { route: plain, c: cost(plain.points) };
                if (pick.c >= 1 && around) {
                    for (let lane = 1; lane <= 4 && pick.c >= 1; lane++) {
                        const cand = routeViaGap(source, target, trigger, gutter, lane, { laneX: trunkX, shared: true, ...(relation(source, target) === 'left' ? { kind: 'backwards' as const, backwards: true } : {}) });
                        const c = cost(cand.points);
                        if (c < pick.c) pick = { route: cand, c };
                    }
                }
                if (pick.c >= SCREEN_COST && !around) {
                    for (let lane = 0; lane <= 4; lane++) {
                        for (const y of bandsFor(target, rowGap)) {
                            const cand = routeJoin(source, target, trigger, trunkX, y, lane);
                            const c = cost(cand.points);
                            if (c < pick.c) pick = { route: cand, c };
                        }
                        if (pick.c < 1) break;
                    }
                }
                trial.set(i, pick.route);
                total += pick.c;
            }
            if (!best || total < best.total) best = { total, chosen: ordered.map((i) => trial.get(i) as Routed) };
            if (total < 1) break;
        }
        const chosen = best as { total: number; chosen: Routed[] };
        grand += chosen.total;
        ordered.forEach((i, n) => {
            routes[i] = chosen.chosen[n] as Routed;
            done.push(i);
        });
    }
    return { total: grand, members: done };
}

/**
 * Runs `joinPass` with the lower targets first (their trunks nearest the column) and with the higher targets first, on
 * copies, and keeps the cheaper outcome, so groups whose trunks would collide in one column settle whichever way leaves
 * no shared line. The global choice can trade one group's collision for another's, so each group is then placed again
 * with every other route fixed (`repair`), which moves a group off a line a later group's trunk ended up on. Merged
 * routes get no lane builder. Mutates `routes` and `builders`.
 */
function joinTargets(
    routes: Routed[],
    items: { id: string; ends: Endpoints }[],
    screens: readonly Rect[],
    rowGap: number,
    titles: readonly Rect[],
    edges: readonly Edge[],
    builders: (((lane: number) => Routed) | null)[],
    gutter: number,
): void {
    const lower = routes.slice();
    const upper = routes.slice();
    const a = joinPass('lower', lower, items, screens, rowGap, titles, edges, builders, gutter);
    const b = joinPass('upper', upper, items, screens, rowGap, titles, edges, builders, gutter);
    const best = b.total < a.total ? { routes: upper, ...b } : { routes: lower, ...a };
    for (const i of best.members) {
        routes[i] = best.routes[i] as Routed;
        builders[i] = null;
    }
    for (let pass = 0; pass < 2; pass++) {
        const before = routes.slice();
        const r = joinPass('lower', routes, items, screens, rowGap, titles, edges, builders, gutter, true);
        if (r.total === 0 || routes.every((x, i) => x === before[i])) break;
    }
}
