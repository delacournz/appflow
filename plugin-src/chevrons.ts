/** Pure placement of direction chevrons along flow arrows. No `figma` global, so it runs under bun test. */

import type { Pt, Rect } from './route';

/**
 * Chevron spacing in px. A run shorter than `minRun` gets none. A run with room for one `inset` from each end gets
 * one there, with more every `spacing` counted back from its end, so arrows that share a trunk into one target draw
 * their chevrons on top of each other. `minGap` is the least gap between the start chevron and the next one. `size`
 * is half the chevron's width across the line. The last run keeps `2 * inset` clear of the arrowhead.
 */
export const CHEVRON = { minRun: 400, inset: 160, spacing: 1200, minGap: 400, size: 9 } as const;

/** One chevron: a wing, the tip pointing along the run, and the other wing. */
export type Chevron = readonly [Pt, Pt, Pt];

/** Distances from a run's start where its chevrons sit. `last` drops any too close to the arrowhead. */
export function chevronOffsets(length: number, opts: { last?: boolean } = {}): number[] {
    const { minRun, inset, spacing, minGap } = CHEVRON;
    if (length < minRun) return [];
    let offsets: number[];
    if (length - 2 * inset < minGap) {
        offsets = [length / 2];
    } else {
        const fromEnd: number[] = [];
        for (let at = length - inset; at >= inset + minGap; at -= spacing) fromEnd.push(at);
        offsets = [inset, ...fromEnd.reverse()];
    }
    return opts.last ? offsets.filter((o) => o <= length - 2 * inset) : offsets;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function boundsOf(c: Chevron, pad: number): Rect {
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

/**
 * Chevrons along an arrow's path (tail to head) pointing the way it flows, so a long line shows its direction where
 * it starts and where it ends. Chevrons that would sit under a rect in `avoid` (arrow labels) are left out.
 */
export function chevronMarks(points: readonly Pt[], avoid: readonly Rect[] = [], pad = 6): Chevron[] {
    const { size } = CHEVRON;
    const marks: Chevron[] = [];
    const last = points.length - 2;
    for (let i = 0; i <= last; i++) {
        const a = points[i] as Pt;
        const b = points[i + 1] as Pt;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length === 0) continue;
        const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
        const n = { x: -d.y, y: d.x };
        for (const off of chevronOffsets(length, { last: i === last })) {
            const p = { x: a.x + d.x * off, y: a.y + d.y * off };
            const back = { x: p.x - (d.x * size) / 2, y: p.y - (d.y * size) / 2 };
            const mark: Chevron = [
                { x: back.x - n.x * size, y: back.y - n.y * size },
                { x: p.x + (d.x * size) / 2, y: p.y + (d.y * size) / 2 },
                { x: back.x + n.x * size, y: back.y + n.y * size },
            ];
            if (!avoid.some((r) => overlaps(boundsOf(mark, pad), r))) marks.push(mark);
        }
    }
    return marks;
}
