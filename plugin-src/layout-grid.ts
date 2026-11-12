/**
 * Group-local layout grids. Pure; no `figma` global.
 *
 * Every group (nested ones included) lays its own screens on a grid of its own: the board pitch from an origin of its
 * own. Ungrouped screens share the implicit `board` grid. A screen's `col`/`row` are local to its grid, so screens in
 * different groups need not share rows or columns.
 */

import type { Rect } from './rect';

export const BOARD_GRID = 'board';

export type LayoutGrid = { id: string; originX: number; originY: number; colWidth: number; rowHeight: number };
export type GridBoard = { originX: number; originY: number; colWidth: number; rowHeight: number };

const POS_TOLERANCE = 2;

/** The frame rect of a screen in a cell of this grid. */
export function cellRectIn(grid: LayoutGrid, col: number, row: number, size: { width: number; height: number }): Rect {
    return { x: grid.originX + col * grid.colWidth, y: grid.originY + row * grid.rowHeight, width: size.width, height: size.height };
}

/** The cell of this grid nearest a frame's top-left corner. */
export function cellOfIn(grid: LayoutGrid, rect: { x: number; y: number }): { col: number; row: number } {
    return { col: Math.round((rect.x - grid.originX) / grid.colWidth) + 0, row: Math.round((rect.y - grid.originY) / grid.rowHeight) + 0 };
}

/** Whether a frame sits on a cell of the grid, within a couple of pixels. */
export function onGrid(grid: LayoutGrid, rect: { x: number; y: number }): boolean {
    const { col, row } = cellOfIn(grid, rect);
    return Math.abs(grid.originX + col * grid.colWidth - rect.x) <= POS_TOLERANCE && Math.abs(grid.originY + row * grid.rowHeight - rect.y) <= POS_TOLERANCE;
}

export const boardGrid = (board: GridBoard): LayoutGrid => ({ id: BOARD_GRID, originX: board.originX, originY: board.originY, colWidth: board.colWidth, rowHeight: board.rowHeight });

/**
 * The grid a screen's cell is local to: its `layoutId` group's layout (origin of its own, board pitch), else the board
 * grid. A layoutId whose group has no layout, or no longer exists, falls back to the board grid.
 */
export function gridOfScreen(screen: { id: string; layoutId?: string | null }, groups: readonly { id: string; layout?: { originX: number; originY: number } }[], board: GridBoard): LayoutGrid {
    if (!screen.layoutId || screen.layoutId === BOARD_GRID) return boardGrid(board);
    const group = groups.find((g) => g.id === screen.layoutId);
    if (!group?.layout) return boardGrid(board);
    return { id: group.id, originX: group.layout.originX, originY: group.layout.originY, colWidth: board.colWidth, rowHeight: board.rowHeight };
}

export type MigrateScreen = { id: string; flowGroupId: string | null; x: number; y: number };
export type Migration = {
    grids: LayoutGrid[];
    cells: Map<string, { layoutId: string; col: number; row: number }>;
    /** Screens whose position is not on their grid's pitch: their cell is the nearest one, and moving to it would move them. */
    offGrid: string[];
};

/**
 * Converts a board with one shared grid (uniform or banded) to group-local grids without moving anything. A group with
 * direct screens gets a grid whose origin is the top-left of its members' frames, so its local cells start at 0 and every
 * member's cell rect is where the frame is now. Screens in no group, or in a group that does not exist, go on the board
 * grid at the board origin, or at their own top-left when banded extras left them off that origin. Every grid uses the board pitch. Banded extras between groups simply disappear: each group's
 * screens already sit on a regular pitch inside it.
 */
export function migrateToGrouped(board: GridBoard, screens: readonly MigrateScreen[], groups: readonly { id: string; parentId?: string }[]): Migration {
    const known = new Set(groups.map((g) => g.id));
    const layoutOf = (s: MigrateScreen): string => (s.flowGroupId && known.has(s.flowGroupId) ? s.flowGroupId : BOARD_GRID);
    const grids: LayoutGrid[] = [];
    for (const g of groups) {
        const members = screens.filter((s) => layoutOf(s) === g.id);
        if (!members.length) continue;
        grids.push({ id: g.id, originX: Math.min(...members.map((m) => m.x)), originY: Math.min(...members.map((m) => m.y)), colWidth: board.colWidth, rowHeight: board.rowHeight });
    }
    const loose = screens.filter((s) => layoutOf(s) === BOARD_GRID);
    if (loose.length) {
        const atBoard = boardGrid(board);
        const fits = loose.every((s) => onGrid(atBoard, s));
        grids.push(fits ? atBoard : { ...atBoard, originX: Math.min(...loose.map((s) => s.x)), originY: Math.min(...loose.map((s) => s.y)) });
    }
    const cells = new Map<string, { layoutId: string; col: number; row: number }>();
    const offGrid: string[] = [];
    for (const s of screens) {
        const layoutId = layoutOf(s);
        const grid = grids.find((g) => g.id === layoutId) as LayoutGrid;
        cells.set(s.id, { layoutId, ...cellOfIn(grid, s) });
        if (!onGrid(grid, s)) offGrid.push(s.id);
    }
    return { grids, cells, offGrid };
}
