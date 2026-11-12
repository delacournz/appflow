/** Pure orthogonal arrow router for flow boards. No `figma` global, so it runs under bun test. */

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type RouteKind = 'straight' | 'trigger' | 'gutter' | 'below' | 'above' | 'backwards' | 'elbow' | 'around';

/** Where an arrow leaves a source whose target is right of it: the side (through the gutter) or the bottom edge. */
export type Exit = 'side' | 'bottom';

export type RouteInput = {
    source: Rect;
    target: Rect;
    trigger: Rect | null;
    /** Width of the gap between screen columns. */
    gutter: number;
    /** 0 for the first arrow through a gutter; see `assignLanes`. */
    lane: number;
    /** 'bottom' drops out of the source's bottom edge and turns right, keeping the arrow out of a busy gutter. */
    exit?: Exit;
    /** Position among arrows leaving one source through one gutter, ordered by target height; see `fanIndex`. */
    fan?: Fan;
    /**
     * Absolute x past which labels must not sit. Set when a widened column boundary (an extra band, see tracks.ts)
     * lies between source and target: the lane jog already uses the base `gutter` next to the source, and the label
     * is centred on the base gutter portion (source right edge to `limit`), never in the extra band.
     */
    labelLimitX?: number;
    /** Extra px added to the fan's vertical lanes, to keep them clear of a group stroke; see `planRoutes`. */
    fanShift?: number;
};

/**
 * `edge` and `bottomEdge` are the source screen's right edge x and bottom edge y (set by the planner), where the first
 * segment leaves the screen.
 * `trunkFrom` is the index of the first point of the part shared with other arrows into the same target (`routeJoin`);
 * labels never sit past it. Absent = nothing is shared.
 * `lead` is the index of the point where the segment that carries the label starts (default 0): arrows forked off a
 * shared dot put the label on their own branch, not on the shared stub.
 */
export type Route = { ok: true; kind: RouteKind; points: Pt[]; labelAnchor: Pt; dot: Pt; backwards: boolean; edge?: number; bottomEdge?: number; trunkFrom?: number; lead?: number };
export type RouteError = { ok: false; error: string };

export const ENTRY_OFFSET = 340;
export const DOT_GAP = 10;
/** A trigger narrower than this fraction of its screen's width is a tab or icon: the dot sits at its horizontal centre. */
export const NARROW_TRIGGER = 0.4;
/** Wide triggers (rows, buttons) put the dot this far inside their right edge. */
export const DOT_INSET = 12;

/** Where an arrow starts on its trigger: always the trigger's vertical centre, never shifted for lane separation. */
export function triggerDot(trigger: Rect, source: Rect): Pt {
    const narrow = trigger.width < NARROW_TRIGGER * source.width;
    return { x: narrow ? trigger.x + trigger.width / 2 : right(trigger) - DOT_INSET, y: midY(trigger) };
}
export const LANE_STEP = 24;
export const BACKWARDS_DROP = 60;
export const FAN_STEP = 16;
/** Gap between a source's edge and its nearest fan lane. */
export const FAN_EDGE = 24;
/** Vertical distance between the rows of arrows forked off one dot: a label height plus a gap. */
export const FORK_ROW = 48;
/** Where the first fork turn sits right of the source edge, and how much further each inner branch turns. */
export const FORK_X0 = 8;
export const FORK_STEP = 8;

export type Fan = { index: number; count: number };

/**
 * Arrows that leave the same source through the same gutter fan out without crossing:
 * the one to the highest target starts on top and takes the rightmost lane.
 */
export function fanIndex(items: { id: string; group: string; targetY: number }[]): Map<string, Fan> {
    const groups = new Map<string, { id: string; targetY: number }[]>();
    for (const it of items) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
    const out = new Map<string, Fan>();
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const sorted = [...list].sort((a, b) => a.targetY - b.targetY);
        sorted.forEach((it, index) => out.set(it.id, { index, count: sorted.length }));
    }
    return out;
}
export const EDGE_MARGIN = 8;
const ROW_TOLERANCE = 2;

/** Lane 0 is centred, then +24, -24, +48, -48 ... */
export const laneOffset = (lane: number): number => (lane <= 0 ? 0 : (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2) * LANE_STEP);

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const midY = (r: Rect) => r.y + r.height / 2;

export type Relation = 'right' | 'left' | 'below' | 'above' | 'overlap';

export function relation(source: Rect, target: Rect): Relation {
    const overlapX = Math.min(right(source), right(target)) - Math.max(source.x, target.x);
    if (overlapX > 0) {
        if (target.y >= bottom(source) - 0.5) return 'below';
        if (bottom(target) <= source.y + 0.5) return 'above';
        return 'overlap';
    }
    return target.x >= right(source) - 0.5 ? 'right' : 'left';
}

/** Arrows with the same key compete for the same corridor and need separate lanes. */
export function gutterKey(source: Rect, target: Rect): string {
    switch (relation(source, target)) {
        case 'right':
            return `h:${right(source)}`;
        // Both directions between stacked screens share one corridor, so A to B and B to A never sit on the same lane.
        case 'below':
        case 'above':
            return `v:${Math.max(source.x, target.x)}`;
        case 'left':
            return `b:${Math.max(bottom(source), bottom(target))}`;
        case 'overlap':
            return `o:${source.x}:${source.y}`;
    }
}

/** Lowest lane per item such that no earlier item with the same key overlaps it in y. */
export function assignLanes(items: { key: string; yMin: number; yMax: number }[]): number[] {
    const lanes: number[] = [];
    items.forEach((item, i) => {
        const taken = new Set<number>();
        for (let j = 0; j < i; j++) {
            const other = items[j] as (typeof items)[number];
            if (other.key === item.key && other.yMin <= item.yMax && item.yMin <= other.yMax) taken.add(lanes[j] as number);
        }
        let lane = 0;
        while (taken.has(lane)) lane++;
        lanes.push(lane);
    });
    return lanes;
}

function dedupe(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && last.x === p.x && last.y === p.y) continue;
        out.push(p);
    }
    let i = 1;
    while (i < out.length - 1) {
        const a = out[i - 1] as Pt;
        const b = out[i] as Pt;
        const c = out[i + 1] as Pt;
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
        else i++;
    }
    return out;
}

/** The middle of the longest segment along the flow: vertical for vertical routes, horizontal otherwise. */
function labelAnchorOf(points: Pt[], vertical: boolean): Pt {
    let best: { len: number; at: Pt } | null = null;
    points.slice(1).forEach((p, i) => {
        const a = points[i] as Pt;
        const isVertical = a.x === p.x;
        if (isVertical !== vertical) return;
        const len = Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
        if (!best || len > best.len) best = { len, at: { x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 } };
    });
    const found = best as { len: number; at: Pt } | null;
    if (found) return found.at;
    const a = points[0] as Pt;
    const b = points[points.length - 1] as Pt;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const done = (kind: RouteKind, raw: Pt[], backwards = false): Route => {
    const points = dedupe(raw);
    return { ok: true, kind, points, dot: points[0] as Pt, labelAnchor: labelAnchorOf(points, kind === 'below' || kind === 'above' || kind === 'elbow'), backwards };
};

/** A straight arrow's label, moved right of the vertical lanes of arrows fanning out beside it, so lines never cross it. */
export function clearOfLanes(route: Route, laneXs: readonly number[], labelLimitX?: number): Route {
    if (laneXs.length === 0) return route;
    const end = route.points[route.points.length - 1] as Pt;
    const endX = labelLimitX !== undefined && labelLimitX < end.x ? Math.max(labelLimitX, Math.max(...laneXs)) : end.x;
    return { ...route, labelAnchor: { x: (Math.max(...laneXs) + endX) / 2, y: route.labelAnchor.y } };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function routeArrow(input: RouteInput): Route | RouteError {
    const { source, target, trigger, gutter, lane, exit = 'side', fan, labelLimitX, fanShift = 0 } = input;
    const off = laneOffset(lane);
    switch (relation(source, target)) {
        case 'overlap':
            return { ok: false, error: 'Source and target screens overlap; move one so they sit in separate cells.' };
        case 'right': {
            const tx = target.x;
            const ty = midY(target);
            const sx = right(source);
            const bx = labelLimitX !== undefined && labelLimitX < tx ? Math.max(labelLimitX, sx) : tx;
            if (exit === 'bottom' && target.y >= bottom(source)) {
                // Fanned drops step left from the highest target's lane, so a lower drop never crosses a higher turn.
                const step = fan && fan.count > 1 ? -fan.index * LANE_STEP : off;
                const x = clamp(source.x + ENTRY_OFFSET + step, source.x + EDGE_MARGIN, right(source) - EDGE_MARGIN);
                const y = fan && fan.count > 1 ? ty : ty + off;
                const r = done('elbow', [{ x, y: bottom(source) }, { x, y }, { x: tx, y }]);
                // The label sits on the leg entering the target, so drops that run side by side keep their labels apart.
                return { ...r, labelAnchor: { x: (x + bx) / 2, y } };
            }
            if (!trigger && Math.abs(midY(source) - ty) <= ROW_TOLERANCE) {
                const y = midY(source);
                const straight = done('straight', [{ x: sx, y }, { x: tx, y }]);
                return bx < tx ? { ...straight, labelAnchor: { x: (sx + bx) / 2, y } } : straight;
            }
            if (fan && fan.count > 1) {
                const base: Pt = trigger ? triggerDot(trigger, source) : { x: sx, y: midY(source) };
                const start: Pt = trigger ? base : { x: base.x, y: base.y + fan.index * FAN_STEP };
                // Lanes hug the source edge so the labels, which sit right of them, get most of the gutter.
                const fanX = Math.min(sx + FAN_EDGE + (fan.count - 1 - fan.index) * LANE_STEP + fanShift, tx - EDGE_MARGIN);
                const r = done(trigger ? 'trigger' : 'gutter', [start, { x: fanX, y: start.y }, { x: fanX, y: ty }, { x: tx, y: ty }]);
                // Fanned arrows share their first stretch, so each label goes on the segment entering its own target.
                const last = r.points[r.points.length - 2] as Pt;
                return { ...r, labelAnchor: { x: (last.x + bx) / 2, y: ty } };
            }
            const toward = ty >= midY(source) ? Math.abs(off) : -Math.abs(off);
            const start: Pt = trigger ? triggerDot(trigger, source) : { x: sx, y: midY(source) + toward };
            const midX = sx + Math.min(gutter, tx - sx) / 2 + off;
            const ey = clamp(ty + (start.y <= ty ? -off : off), target.y + EDGE_MARGIN, bottom(target) - EDGE_MARGIN);
            const jog = done(trigger ? 'trigger' : 'gutter', [start, { x: midX, y: start.y }, { x: midX, y: ey }, { x: tx, y: ey }]);
            return bx < tx && bx > midX ? { ...jog, labelAnchor: { x: (midX + bx) / 2, y: ey } } : jog;
        }
        case 'below': {
            const x = clamp(source.x + ENTRY_OFFSET + off, Math.max(source.x, target.x) + EDGE_MARGIN, Math.min(right(source), right(target)) - EDGE_MARGIN);
            return done('below', [{ x, y: bottom(source) }, { x, y: target.y }]);
        }
        case 'above':
            return routeViaGap(source, target, trigger, gutter, lane, { kind: 'around' });
        case 'left':
            return routeViaGap(source, target, trigger, gutter, lane, { kind: 'backwards', backwards: true });
    }
}

export type GapOptions = { kind?: RouteKind; backwards?: boolean; laneX?: number; dx?: number; shared?: boolean; gapY?: number };

/**
 * Route for a target that is above, beside-left or far below in the same column, so a straight line would start on the
 * source's top or end on the target's bottom. Leaves the source's BOTTOM edge (at the trigger's x, else the centre),
 * drops into the row gap below the source, runs left along the gap into the gutter lane left of the target, runs up or
 * down it to the target's entry height and enters the target's LEFT edge heading right. The run left stays inside the
 * gap. `gapY` fixes the height of the run (default: just below the source), for boards whose rows are not shared. `lane` moves the gap run down and the lane left one step each; `laneX` fixes the lane (a shared trunk, with
 * `shared` marking where it begins); `dx` shifts it sideways.
 */
export function routeViaGap(source: Rect, target: Rect, trigger: Rect | null, gutter: number, lane: number, opts: GapOptions = {}): Route {
    const start: Pt = trigger ? triggerDot(trigger, source) : { x: source.x + source.width / 2, y: bottom(source) };
    const gapY = (opts.gapY ?? bottom(source) + BACKWARDS_DROP) + lane * LANE_STEP;
    const x = opts.laneX ?? Math.min(source.x, target.x) - gutter / 2 - lane * LANE_STEP + (opts.dx ?? 0);
    const ey = clamp(midY(target), target.y + EDGE_MARGIN, bottom(target) - EDGE_MARGIN);
    const r = done(opts.kind ?? 'around', [start, { x: start.x, y: gapY }, { x, y: gapY }, { x, y: ey }, { x: target.x, y: ey }], opts.backwards ?? false);
    const at = opts.shared ? r.points.findIndex((p) => p.x === x && p.y === gapY) : -1;
    const first = r.points[0] as Pt;
    const second = r.points[1] as Pt;
    return { ...r, ...(at >= 0 ? { trunkFrom: at } : {}), labelAnchor: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } };
}

/**
 * Route that leaves the source's right edge, drops or rises in the gutter beside it into a horizontal band at `bandY`
 * (a row gap, clear of every screen), runs along the band to the gutter in front of the target, then enters the target's
 * left edge at `entryY`. `lane` moves both vertical legs one lane step further from the screens.
 */
export function routeViaBand(source: Rect, target: Rect, trigger: Rect | null, bandY: number, lane: number): Route {
    const start: Pt = trigger ? triggerDot(trigger, source) : { x: right(source), y: midY(source) };
    const x1 = right(source) + FAN_EDGE + lane * LANE_STEP;
    const x2 = target.x - FAN_EDGE - lane * LANE_STEP;
    const ey = clamp(midY(target), target.y + EDGE_MARGIN, bottom(target) - EDGE_MARGIN);
    const r = done('gutter', [start, { x: x1, y: start.y }, { x: x1, y: bandY }, { x: x2, y: bandY }, { x: x2, y: ey }, { x: target.x, y: ey }]);
    return { ...r, labelAnchor: { x: (x2 + target.x) / 2, y: ey } };
}

/** How far in front of the target's left edge the shared trunk lane sits. */
export const TRUNK_GAP = 48;
/** Gap between the source's right edge and the start of a label on the first segment. */
export const LABEL_GAP = 8;

/**
 * Arrow into a target that other arrows also enter: runs from its dot to the trunk lane at `trunkX` (in the gutter
 * before the target), along the trunk to the target's entry height, and into the left edge on the final run all merged
 * arrows share. With `bandY` it first leaves through the source's gutter into that row-gap band, so it crosses no
 * screen. `trunkFrom` marks where the shared part begins.
 */
export function routeJoin(source: Rect, target: Rect, trigger: Rect | null, trunkX: number, bandY: number | null, lane = 0): Route {
    const start: Pt = trigger ? triggerDot(trigger, source) : { x: right(source), y: midY(source) };
    const ey = clamp(midY(target), target.y + EDGE_MARGIN, bottom(target) - EDGE_MARGIN);
    const joinY = bandY ?? start.y;
    const x1 = right(source) + FAN_EDGE + lane * LANE_STEP;
    const pts: Pt[] =
        bandY === null
            ? [start, { x: trunkX, y: start.y }, { x: trunkX, y: ey }, { x: target.x, y: ey }]
            : [start, { x: x1, y: start.y }, { x: x1, y: bandY }, { x: trunkX, y: bandY }, { x: trunkX, y: ey }, { x: target.x, y: ey }];
    const r = done('gutter', pts);
    const at = r.points.findIndex((p) => p.x === trunkX && p.y === joinY);
    const first = r.points[0] as Pt;
    const second = r.points[1] as Pt;
    return { ...r, trunkFrom: at >= 0 ? at : r.points.length - 1, labelAnchor: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } };
}

/**
 * Where an arrow's label goes: on its first segment (its `lead` segment, for an arrow forked off a shared dot), just right of the source screen's right edge (after the dot's stub
 * crosses it), centred on the line. A first segment that runs vertically puts the label just past its start.
 */
export function startLabelAnchor(route: Route, size: { width: number; height: number }): Pt {
    const from = route.lead ?? 0;
    const a = route.points[from] as Pt;
    const b = route.points[from + 1] as Pt;
    if (a.y === b.y) return { x: Math.max(a.x, route.edge ?? a.x) + LABEL_GAP + size.width / 2, y: a.y };
    if (b.y >= a.y) return { x: a.x, y: Math.max(a.y, route.bottomEdge ?? a.y) + LABEL_GAP + size.height / 2 };
    return { x: a.x, y: a.y - LABEL_GAP - size.height / 2 };
}

/** The part of a route a label may sit on: everything before the shared trunk (`trunkFrom`), anchored at `anchor`. */
export function leadRoute(route: Route, anchor: Pt): Route {
    const end = Math.max(1, route.trunkFrom ?? route.points.length - 1);
    return { ...route, points: route.points.slice(0, end + 1), labelAnchor: anchor };
}
