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
    /** Screens that were not on their grid's pitch and had to be snapped to a free cell of it: where each goes. Empty when nothing is off the pitch. */
    moves: { id: string; layoutId: string; col: number; row: number; from: { x: number; y: number }; to: { x: number; y: number } }[];
    /** Screens still not on their grid after snapping (none, unless the board grid could not place them). */
    offGrid: string[];
};

const SNAP_RADIUS = 8;

const onPitch = (d: number, pitch: number): boolean => Math.abs(d - Math.round(d / pitch) * pitch) <= POS_TOLERANCE;

/**
 * The members that share one pitch with the group's top-left member (the first by y, then x): positions a whole number of
 * pitches apart. That class defines the group's grid; the members outside it are snapped onto it.
 */
function mainClass(members: readonly MigrateScreen[], board: GridBoard): MigrateScreen[] {
    const first = [...members].sort((a, b) => a.y - b.y || a.x - b.x)[0] as MigrateScreen;
    return members.filter((m) => onPitch(m.x - first.x, board.colWidth) && onPitch(m.y - first.y, board.rowHeight));
}

/**
 * The free cell of a grid nearest a frame's top-left corner (cells at or right/below the grid origin only). Distance is measured
 * from the frame to the cell's rect; a tie goes right, then down. Never a cell in `taken`.
 */
export function nearestFreeCell(grid: LayoutGrid, at: { x: number; y: number }, taken: ReadonlySet<string>): { col: number; row: number } {
    const near = { col: Math.round((at.x - grid.originX) / grid.colWidth), row: Math.round((at.y - grid.originY) / grid.rowHeight) };
    let best: { col: number; row: number; d: number } | null = null;
    for (let col = Math.max(0, near.col - SNAP_RADIUS); col <= near.col + SNAP_RADIUS; col++) {
        for (let row = Math.max(0, near.row - SNAP_RADIUS); row <= near.row + SNAP_RADIUS; row++) {
            if (taken.has(`${col},${row}`)) continue;
            const d = Math.hypot(grid.originX + col * grid.colWidth - at.x, grid.originY + row * grid.rowHeight - at.y);
            const better = !best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && (col > best.col || (col === best.col && row > best.row)));
            if (better) best = { col, row, d };
        }
    }
    return best ? { col: best.col, row: best.row } : { col: Math.max(0, near.col), row: Math.max(0, near.row) };
}

/**
 * Converts a board with one shared grid (uniform or banded) to group-local grids without moving anything. A group with
 * direct screens gets a grid whose origin is the top-left of its members' frames, so its local cells start at 0 and every
 * member's cell rect is where the frame is now. Screens in no group, or in a group that does not exist, go on the board
 * grid at the board origin, or at their own top-left when banded extras left them off that origin. Every grid uses the board pitch.
 * Banded extras between groups simply disappear. A member that banded extras left off its group's pitch is snapped once to the
 * nearest free cell of the group's grid (`moves`); everything already on the pitch stays where it is.
 */
export function migrateToGrouped(board: GridBoard, screens: readonly MigrateScreen[], groups: readonly { id: string; parentId?: string }[]): Migration {
    const known = new Set(groups.map((g) => g.id));
    const layoutOf = (s: MigrateScreen): string => (s.flowGroupId && known.has(s.flowGroupId) ? s.flowGroupId : BOARD_GRID);
    const grids: LayoutGrid[] = [];
    for (const g of groups) {
        const members = screens.filter((s) => layoutOf(s) === g.id);
        if (!members.length) continue;
        const main = mainClass(members, board);
        grids.push({ id: g.id, originX: Math.min(...main.map((m) => m.x)), originY: Math.min(...main.map((m) => m.y)), colWidth: board.colWidth, rowHeight: board.rowHeight });
    }
    const loose = screens.filter((s) => layoutOf(s) === BOARD_GRID);
    if (loose.length) {
        const atBoard = boardGrid(board);
        const fits = loose.every((s) => onGrid(atBoard, s));
        grids.push(fits ? atBoard : { ...atBoard, originX: Math.min(...loose.map((s) => s.x)), originY: Math.min(...loose.map((s) => s.y)) });
    }
    const cells = new Map<string, { layoutId: string; col: number; row: number }>();
    const moves: Migration['moves'] = [];
    const taken = new Map<string, Set<string>>();
    const off: MigrateScreen[] = [];
    for (const s of screens) {
        const layoutId = layoutOf(s);
        const grid = grids.find((g) => g.id === layoutId) as LayoutGrid;
        if (!onGrid(grid, s)) {
            off.push(s);
            continue;
        }
        const cell = cellOfIn(grid, s);
        cells.set(s.id, { layoutId, ...cell });
        taken.set(layoutId, (taken.get(layoutId) ?? new Set()).add(`${cell.col},${cell.row}`));
    }
    for (const s of [...off].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1))) {
        const layoutId = layoutOf(s);
        const grid = grids.find((g) => g.id === layoutId) as LayoutGrid;
        const used = taken.get(layoutId) ?? new Set<string>();
        const cell = nearestFreeCell(grid, s, used);
        used.add(`${cell.col},${cell.row}`);
        taken.set(layoutId, used);
        cells.set(s.id, { layoutId, ...cell });
        moves.push({ id: s.id, layoutId, ...cell, from: { x: s.x, y: s.y }, to: { x: grid.originX + cell.col * grid.colWidth, y: grid.originY + cell.row * grid.rowHeight } });
    }
    return { grids, cells, moves, offGrid: [] };
}
