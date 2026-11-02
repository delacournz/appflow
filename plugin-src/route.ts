/** Pure orthogonal arrow router for flow boards. No `figma` global, so it runs under bun test. */

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export type RouteKind = 'straight' | 'trigger' | 'gutter' | 'below' | 'above' | 'backwards' | 'elbow';

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
};

export type Route = { ok: true; kind: RouteKind; points: Pt[]; labelAnchor: Pt; dot: Pt; backwards: boolean };
export type RouteError = { ok: false; error: string };

export const ENTRY_OFFSET = 340;
export const DOT_GAP = 10;
export const LANE_STEP = 24;
export const BACKWARDS_DROP = 60;
export const FAN_STEP = 16;

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
const EDGE_MARGIN = 8;
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
        case 'below':
            return `v:${source.x}:${bottom(source)}`;
        case 'above':
            return `v:${source.x}:${source.y}`;
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

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function routeArrow(input: RouteInput): Route | RouteError {
    const { source, target, trigger, gutter, lane, exit = 'side', fan } = input;
    const off = laneOffset(lane);
    switch (relation(source, target)) {
        case 'overlap':
            return { ok: false, error: 'Source and target screens overlap; move one so they sit in separate cells.' };
        case 'right': {
            const tx = target.x;
            const ty = midY(target);
            const sx = right(source);
            if (exit === 'bottom' && target.y >= bottom(source)) {
                const x = clamp(source.x + ENTRY_OFFSET + off, source.x + EDGE_MARGIN, right(source) - EDGE_MARGIN);
                return done('elbow', [{ x, y: bottom(source) }, { x, y: ty + off }, { x: tx, y: ty + off }]);
            }
            if (!trigger && Math.abs(midY(source) - ty) <= ROW_TOLERANCE) {
                const y = midY(source);
                return done('straight', [{ x: sx, y }, { x: tx, y }]);
            }
            if (fan && fan.count > 1) {
                const base: Pt = trigger ? { x: right(trigger) + DOT_GAP, y: midY(trigger) } : { x: sx, y: midY(source) };
                const start: Pt = { x: base.x, y: base.y + fan.index * FAN_STEP };
                const fanX = sx + Math.min(gutter, tx - sx) / 2 + ((fan.count - 1) / 2 - fan.index) * LANE_STEP;
                return done(trigger ? 'trigger' : 'gutter', [start, { x: fanX, y: start.y }, { x: fanX, y: ty }, { x: tx, y: ty }]);
            }
            const toward = ty >= midY(source) ? Math.abs(off) : -Math.abs(off);
            const start: Pt = trigger ? { x: right(trigger) + DOT_GAP, y: midY(trigger) } : { x: sx, y: midY(source) + toward };
            const midX = sx + Math.min(gutter, tx - sx) / 2 + off;
            const ey = clamp(ty + (start.y <= ty ? -off : off), target.y + EDGE_MARGIN, bottom(target) - EDGE_MARGIN);
            return done(trigger ? 'trigger' : 'gutter', [start, { x: midX, y: start.y }, { x: midX, y: ey }, { x: tx, y: ey }]);
        }
        case 'below': {
            const x = clamp(source.x + ENTRY_OFFSET + off, Math.max(source.x, target.x) + EDGE_MARGIN, Math.min(right(source), right(target)) - EDGE_MARGIN);
            return done('below', [{ x, y: bottom(source) }, { x, y: target.y }]);
        }
        case 'above': {
            const x = clamp(source.x + ENTRY_OFFSET + off, Math.max(source.x, target.x) + EDGE_MARGIN, Math.min(right(source), right(target)) - EDGE_MARGIN);
            return done('above', [{ x, y: source.y }, { x, y: bottom(target) }]);
        }
        case 'left': {
            const sx = source.x + ENTRY_OFFSET;
            const tx = Math.max(target.x + EDGE_MARGIN, target.x + ENTRY_OFFSET - Math.max(0, lane) * LANE_STEP * 2);
            const dropY = Math.max(bottom(source), bottom(target)) + BACKWARDS_DROP + lane * LANE_STEP;
            return done('backwards', [{ x: sx, y: bottom(source) }, { x: sx, y: dropY }, { x: tx, y: dropY }, { x: tx, y: bottom(target) }], true);
        }
    }
}
