/** Pure arrow planning: lanes, fans, label placement and group-stroke avoidance. No `figma` global, so it runs under bun test. */
import { boxEdges, laneConflicts, type Edge, type StrokedBox } from './route-avoid';
import { EDGE_MARGIN, LANE_STEP, assignLanes, clearOfLanes, fanIndex, gutterKey, routeArrow, type Exit, type Pt, type Rect, type Route } from './route';

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
};

/** Clear space kept between a vertical line and the end of a title's text. */
const TITLE_MARGIN = 8;

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
    const edgeOf = (e: Endpoints) => `${e.source.x}:${e.source.y}:${gutterKey(e.source, e.target)}`;
    const fanLanes = new Map<string, number[]>();
    items.forEach((it, i) => {
        const r = routes[i] as Routed;
        if (r.ok && fans.has(it.id)) fanLanes.set(edgeOf(it.ends), [...(fanLanes.get(edgeOf(it.ends)) ?? []), (r.points[1] as Pt).x]);
    });
    const final: Routed[] = routes.map((r, i) => (r.ok && r.kind === 'straight' ? clearOfLanes(r, fanLanes.get(edgeOf((items[i] as (typeof items)[number]).ends)) ?? [], limits[i]) : r));
    const warnings = cfg.titles?.length ? shiftOffTitles(final, items, cfg.titles) : new Map<number, string>();
    return items.map((it, i) => {
        const r = final[i] as Routed;
        if (!r.ok) return { id: it.id, route: null, error: r.error };
        const warning = warnings.get(i);
        return { id: it.id, route: r, error: null, ...(warning ? { warning } : {}) };
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
function shiftOffTitles(routes: Routed[], items: { id: string; ends: Endpoints }[], titles: readonly Rect[]): Map<number, string> {
    const warnings = new Map<number, string>();
    const crosses = (x: number, y0: number, y1: number, t: Rect) => x > t.x - TITLE_MARGIN && x < t.x + t.width + TITLE_MARGIN && overlap1d(y0, y1, t.y, t.y + t.height);
    routes.forEach((r, i) => {
        const leg = verticalLeg(r);
        if (!leg || !r.ok) return;
        if (!titles.some((t) => crosses(leg.x, leg.y0, leg.y1, t))) return;
        const { source, target } = (items[i] as (typeof items)[number]).ends;
        const lo = Math.max(source.x, target.x) + EDGE_MARGIN;
        const hi = Math.min(source.x + source.width, target.x + target.width) - EDGE_MARGIN;
        const free = (x: number) =>
            x >= lo && x <= hi && !titles.some((t) => crosses(x, leg.y0, leg.y1, t)) && !routes.some((o, j) => {
                const ol = j === i ? null : verticalLeg(o);
                return !!ol && overlap1d(leg.y0, leg.y1, ol.y0, ol.y1) && Math.abs(ol.x - x) < LANE_STEP;
            });
        const cands = titles.flatMap((t) => [t.x - TITLE_MARGIN, t.x + t.width + TITLE_MARGIN]).filter(free);
        if (!cands.length) {
            warnings.set(i, `line crosses a group title's text and no lane within both screens avoids it`);
            return;
        }
        const x = cands.reduce((best, c) => (Math.abs(c - leg.x) < Math.abs(best - leg.x) ? c : best));
        routes[i] = { ...r, points: r.points.map((p) => ({ ...p, x })), dot: { ...r.dot, x }, labelAnchor: { ...r.labelAnchor, x } };
    });
    return warnings;
}
