import type { JsonObject } from '../shared/protocol';
import { isScene, requireNode, walk } from './nodes';
import { type Handler, num, ok, str } from './types';

/** Flow arrows must read left to right: right, down or up, never left. */

export type Pt = { x: number; y: number };
type Vertex = { x: number; y: number; strokeCap?: string };
type Segment = { start: number; end: number };
export type Heading = 'right' | 'left' | 'up' | 'down';
export type ArrowIssue = 'points-left' | 'runs-left';

const isHead = (v: Vertex) => typeof v.strokeCap === 'string' && v.strokeCap.startsWith('ARROW');

/**
 * The vertices of a single-line arrow, ordered from the tail to the
 * arrowhead. `null` when the vector has no single arrowhead or branches.
 */
export function orderPath(vertices: readonly Vertex[], segments: readonly Segment[]): Pt[] | null {
    const heads = vertices.map((v, i) => (isHead(v) ? i : -1)).filter((i) => i >= 0);
    if (heads.length !== 1) return null;
    const links = vertices.map(() => [] as number[]);
    for (const s of segments) {
        links[s.start]?.push(s.end);
        links[s.end]?.push(s.start);
    }
    if (links.some((l) => l.length > 2)) return null;
    const ends = links.map((l, i) => (l.length === 1 ? i : -1)).filter((i) => i >= 0);
    const head = heads[0] as number;
    const tail = ends.find((i) => i !== head);
    if (tail === undefined || !ends.includes(head)) return null;
    const order = [tail];
    let prev = -1;
    let at = tail;
    while (at !== head) {
        const next = (links[at] ?? []).find((n) => n !== prev);
        if (next === undefined) return null;
        prev = at;
        at = next;
        order.push(at);
    }
    return order.map((i) => {
        const v = vertices[i] as Vertex;
        return { x: v.x, y: v.y };
    });
}

/** Where the arrowhead points, and whether any part of the path travels left. */
export function classifyArrow(points: readonly Pt[], tolerance = 1): { heading: Heading; issues: ArrowIssue[] } {
    const a = points[points.length - 2] as Pt;
    const b = points[points.length - 1] as Pt;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const heading: Heading = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    const issues: ArrowIssue[] = [];
    if (heading === 'left' && dx < -tolerance) issues.push('points-left');
    else if (points.slice(1).some((p, i) => p.x - (points[i] as Pt).x < -tolerance)) issues.push('runs-left');
    return { heading, issues };
}

/** Reports every arrow vector under a node (or the current page) that points or runs left. */
export const lintFlowLayout: Handler = async (args: JsonObject) => {
    const id = str(args, 'nodeId');
    const root = id ? await requireNode(id) : figma.currentPage;
    const tolerance = num(args, 'tolerance') ?? 1;
    const issues: JsonObject[] = [];
    let checked = 0;
    for (const n of walk(root, 100_000)) {
        if (n.type !== 'VECTOR' || !isScene(n)) continue;
        const net = n.vectorNetwork;
        const local = orderPath(net.vertices, net.segments);
        if (!local) continue;
        checked++;
        const [[a, b, tx], [c, d, ty]] = n.absoluteTransform;
        const abs = local.map((p) => ({ x: Math.round(a * p.x + b * p.y + tx), y: Math.round(c * p.x + d * p.y + ty) }));
        const result = classifyArrow(abs, tolerance);
        if (result.issues.length) {
            issues.push({ id: n.id, name: n.name, heading: result.heading, issues: result.issues, from: abs[0] as Pt, to: abs[abs.length - 1] as Pt });
        }
    }
    return ok({
        checked,
        passed: issues.length === 0,
        issues,
        fix: issues.length
            ? 'Move the target screen right of (or directly below/above) its source, then redraw the arrow so every segment moves right, down or up.'
            : null,
    });
};
