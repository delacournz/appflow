/** Pure arrow planning: lanes, fans, label placement and group-stroke avoidance. No `figma` global, so it runs under bun test. */
import { boxEdges, laneConflicts, type Edge, type StrokedBox } from './route-avoid';
import { LANE_STEP, assignLanes, clearOfLanes, fanIndex, gutterKey, routeArrow, type Exit, type Pt, type Rect, type Route } from './route';

export type Endpoints = { source: Rect; target: Rect; trigger: Rect | null; triggerMissing: boolean; exit: Exit };
export type Plan = { id: string; route: Route | null; error: string | null };
export type PlanConfig = {
    gutter: number;
    /** Per item (same order as `items`): the absolute x past which its label must not sit; see `RouteInput.labelLimitX`. */
    limits: readonly (number | undefined)[];
    /** Group boxes on the board. Lanes running alongside a stroke step to the next lane. Empty or absent leaves the plan unchanged. */
    boxes?: readonly StrokedBox[];
};

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
    return items.map((it, i) => {
        const r = routes[i] as Routed;
        if (!r.ok) return { id: it.id, route: null, error: r.error };
        const route = r.kind === 'straight' ? clearOfLanes(r, fanLanes.get(edgeOf(it.ends)) ?? [], limits[i]) : r;
        return { id: it.id, route, error: null };
    });
}
