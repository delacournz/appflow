import { GROUP_CLEAR, type Cell } from './flow-group';
import type { Rect } from './rect';
import { cleanExtras, type Band } from './tracks';

/**
 * Measures the gaps between what was actually drawn and says how much more room each boundary needs. No `figma` global.
 * `boundaryExtras` plans from cell estimates; boxes also wrap internal arrow labels and lanes, so they can end up bigger than
 * planned. This works from the real rects, so it always sees the truth.
 */

/** Wanted gap between two group visuals (box and title bar), px: generous, well over 2 x `GROUP_CLEAR`. */
export const GROUP_GAP = 160;
/** Wanted gap between a group visual and content that is in no group. */
export const CONTENT_GAP = 2 * GROUP_CLEAR;

/** A group's box plus title bar, or one ungrouped screen's footprint, with the grid cells it occupies. */
export type Block = { id: string; rect: Rect; cells: readonly Cell[]; grouped: boolean; parentId?: string };

export type Deficits = { colExtra: Band[]; rowExtra: Band[] };

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const span = (cells: readonly Cell[], key: 'col' | 'row'): [number, number] => [Math.min(...cells.map((c) => c[key])), Math.max(...cells.map((c) => c[key]))];

/** The wanted gap for a pair, or null when they are not neighbours. */
const wanted = (a: Block, b: Block): number | null => {
    if (!a.grouped && !b.grouped) return null;
    if (a.parentId === b.id || b.parentId === a.id) return null;
    return a.grouped && b.grouped ? GROUP_GAP : CONTENT_GAP;
};

/**
 * Extra px each boundary needs so every pair of neighbouring blocks keeps its wanted gap. A pair is stacked when their x ranges
 * overlap (the lower block's rows get a row band, over that block's columns) or side by side when their y ranges overlap (the
 * right block's columns get a column band, over that block's rows). Bands cover the whole span of the moving block, so it
 * shifts as one piece and no group tears. Diagonal pairs and pairs the cells cannot separate (rows or columns shared) are skipped.
 * The result is what to ADD on top of the extras already in place; bands sharing a track and lines take the largest need.
 */
export function gapDeficits(blocks: readonly Block[]): Deficits {
    const need = new Map<string, Band>();
    const raise = (axis: 'c' | 'r', at: number, from: number, to: number, px: number) => {
        const key = `${axis}:${at}:${from}:${to}`;
        const prev = need.get(key);
        if (!prev || prev.px < px) need.set(key, { at, from, to, px });
    };
    for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
            const [a, b] = [blocks[i] as Block, blocks[j] as Block];
            const gap = wanted(a, b);
            if (gap === null || !a.cells.length || !b.cells.length) continue;
            const overlapX = Math.min(right(a.rect), right(b.rect)) - Math.max(a.rect.x, b.rect.x);
            const overlapY = Math.min(bottom(a.rect), bottom(b.rect)) - Math.max(a.rect.y, b.rect.y);
            if (overlapX > 0 && overlapY > 0 ? overlapY <= overlapX : overlapX > 0) {
                const [upper, lower] = a.rect.y <= b.rect.y ? [a, b] : [b, a];
                const have = lower.rect.y - bottom(upper.rect);
                const [r0] = span(lower.cells, 'row');
                if (have >= gap || span(upper.cells, 'row')[1] >= r0) continue;
                const [c0, c1] = span(lower.cells, 'col');
                raise('r', r0, c0, c1, Math.ceil(gap - have));
            } else if (overlapY > 0) {
                const [left, rightB] = a.rect.x <= b.rect.x ? [a, b] : [b, a];
                const have = rightB.rect.x - right(left.rect);
                const [c0] = span(rightB.cells, 'col');
                if (have >= gap || span(left.cells, 'col')[1] >= c0) continue;
                const [r0, r1] = span(rightB.cells, 'row');
                raise('c', c0, r0, r1, Math.ceil(gap - have));
            }
        }
    }
    const pick = (axis: 'c' | 'r') => cleanExtras([...need].filter(([k]) => k.startsWith(axis)).map(([, v]) => v));
    return { colExtra: pick('c'), rowExtra: pick('r') };
}

/** Bands added together: overlapping bands on one track sum, which is how extras accumulate. */
export const addBands = (a: readonly Band[], b: readonly Band[]): Band[] => cleanExtras([...a, ...b]);

export const hasDeficits = (d: Deficits): boolean => d.colExtra.length > 0 || d.rowExtra.length > 0;
