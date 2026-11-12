import type { Rect } from './rect';
import { unionRect } from './rect';
import { trackStart, type Extras } from './tracks';

/** Pure planning helpers for duplicate_screen. No `figma` global. */

export type GridBoard = { originX: number; originY: number; colWidth: number; rowHeight: number; colExtra?: Extras; rowExtra?: Extras; screenW: number; screenH: number };

export function cellRect(board: GridBoard, col: number, row: number): Rect {
    return { x: board.originX + trackStart(col, board.colWidth, board.colExtra), y: board.originY + trackStart(row, board.rowHeight, board.rowExtra), width: board.screenW, height: board.screenH };
}

/** Index of the first rect that overlaps `target` (touching edges do not count), or -1. */
export function overlapsAny(target: Rect, others: readonly Rect[]): number {
    return others.findIndex(
        (o) => target.x < o.x + o.width && o.x < target.x + target.width && target.y < o.y + o.height && o.y < target.y + target.height,
    );
}

/** `bounds` grown to hold every rect plus `margin` on each side. Never shrinks. */
export function growBounds(bounds: Rect, rects: readonly Rect[], margin: number): Rect {
    const padded = rects.map((r) => ({ x: r.x - margin, y: r.y - margin, width: r.width + margin * 2, height: r.height + margin * 2 }));
    return unionRect([bounds, ...padded]) ?? bounds;
}

export const frameName = (name: string): string => name;
export const labelName = (name: string): string => `Label · ${name}`;
export const routeName = (name: string): string => `Route · ${name}`;
export const bannerName = (title: string): string => `ListGroup.Item · ${title}`;

export type TreeNode = { name: string; children?: TreeNode[] };

/** First descendant (depth-first, root excluded) that passes the test. */
export function findDescendant<T extends TreeNode>(root: T, test: (n: T) => boolean): T | null {
    for (const c of (root.children ?? []) as T[]) {
        if (test(c)) return c;
        const deeper = findDescendant(c, test);
        if (deeper) return deeper;
    }
    return null;
}

/** The banner row: the first "KycEntryRow" frame, else the first "ListGroup.Item*" frame. Leaf nodes never match. */
export function pickBanner<T extends TreeNode>(root: T): T | null {
    const isFrame = (n: T) => n.children !== undefined;
    return findDescendant(root, (n) => isFrame(n) && n.name === 'KycEntryRow') ?? findDescendant(root, (n) => isFrame(n) && n.name.startsWith('ListGroup.Item'));
}
