/**
 * Independent group placement. Pure; no `figma` global.
 *
 * Groups stay where they are. When a group's box has grown into a neighbour, the neighbour moves right or down by the least
 * amount that restores the clearance, and what it pushes moves in turn. Nothing ever moves up or left. Only boxes with the
 * same parent are compared: a nested child inside its parent is not a conflict, and a child moves with its parent. The
 * caller fits parent boxes around their children first (a sibling push can grow a parent), then calls again for the next level.
 */

import type { Rect } from './rect';

export type PlaceBox = { id: string; rect: Rect; parentId?: string };
export type PlaceMove = { id: string; dx: number; dy: number };

const MAX_PASSES = 1000;

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

/** The least shift along each axis that separates `a` from `b` with `clear` between them, in either direction. */
function separation(a: Rect, b: Rect, clear: number): { x: number; y: number } | null {
    const inX = Math.min(right(a), right(b)) - Math.max(a.x, b.x) + clear;
    const inY = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y) + clear;
    if (inX <= 0 || inY <= 0) return null;
    const toX = Math.min(right(a) + clear - b.x, right(b) + clear - a.x);
    const toY = Math.min(bottom(a) + clear - b.y, bottom(b) + clear - a.y);
    return { x: toX, y: toY };
}

/** Moves (relative to the given rects) that keep every pair of sibling boxes at least `clear` apart. Empty when none is needed. */
export function resolveOverlaps(boxes: readonly PlaceBox[], clear: number): PlaceMove[] {
    const sorted = [...boxes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const at = new Map(sorted.map((b) => [b.id, { ...b.rect }]));
    const kidsOf = (id: string): string[] => sorted.filter((b) => b.parentId === id).flatMap((b) => [b.id, ...kidsOf(b.id)]);
    const shift = (id: string, dx: number, dy: number) => {
        for (const k of [id, ...kidsOf(id)]) {
            const r = at.get(k) as Rect;
            at.set(k, { ...r, x: r.x + dx, y: r.y + dy });
        }
    };
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let changed = false;
        for (let i = 0; i < sorted.length && !changed; i++) {
            for (let j = i + 1; j < sorted.length && !changed; j++) {
                const [a, b] = [sorted[i] as PlaceBox, sorted[j] as PlaceBox];
                if (a.parentId !== b.parentId) continue;
                const ra = at.get(a.id) as Rect;
                const rb = at.get(b.id) as Rect;
                const sep = separation(ra, rb, clear);
                if (!sep) continue;
                const alongX = sep.x <= sep.y;
                const [fixed, mover] = alongX ? (ra.x + ra.width / 2 <= rb.x + rb.width / 2 ? [ra, b] : [rb, a]) : ra.y + ra.height / 2 <= rb.y + rb.height / 2 ? [ra, b] : [rb, a];
                const fixedRect = fixed as Rect;
                const moverRect = at.get((mover as PlaceBox).id) as Rect;
                const need = alongX ? right(fixedRect) + clear - moverRect.x : bottom(fixedRect) + clear - moverRect.y;
                shift((mover as PlaceBox).id, alongX ? need : 0, alongX ? 0 : need);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return sorted.flatMap((b) => {
        const now = at.get(b.id) as Rect;
        const dx = now.x - b.rect.x;
        const dy = now.y - b.rect.y;
        return dx === 0 && dy === 0 ? [] : [{ id: b.id, dx, dy }];
    });
}
