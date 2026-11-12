/**
 * Pure plans for the grid tools on group-local layout grids. No `figma` global.
 *
 * A screen's `col`/`row` are local to its layout grid (`layoutId`, `board` for ungrouped screens), so every plan here
 * works inside one grid: a cell taken in another grid is not an occupant, an insert shifts one grid, compact closes gaps
 * grid by grid.
 */

import { compactPlan, planMove, shiftPlan, type Bounds, type CellScreen, type GridMeta, type Move } from './grid';
import { BOARD_GRID, cellOfIn, cellRectIn, gridOfScreen, type GridBoard, type LayoutGrid } from './layout-grid';

export type GridScreen = { id: string; layoutId: string; col: number; row: number };
export type LayoutMove = Move & { from: Move['from'] & { layoutId: string }; to: Move['to'] & { layoutId: string } };
export type LayoutMovePlan = { ok: true; moves: LayoutMove[] } | { ok: false; error: string };

const inGrid = (screens: readonly GridScreen[], layoutId: string): CellScreen[] => screens.filter((s) => s.layoutId === layoutId).map(({ id, col, row }) => ({ id, col, row }));

const tag = (moves: Move[], from: string, to: string): LayoutMove[] =>
    moves.map((m) => ({ id: m.id, from: { ...m.from, layoutId: from }, to: { ...m.to, layoutId: to } }));

/**
 * Plans moving one screen to a local cell, in its own grid or (with `toLayoutId`) in another one. An occupied cell is
 * refused unless `swap` trades the two screens: the occupant takes the mover's old cell in the mover's old grid.
 */
export function planGridMove(screens: readonly GridScreen[], id: string, col: number, row: number, swap: boolean, toLayoutId?: string): LayoutMovePlan {
    const me = screens.find((s) => s.id === id);
    if (!me) return { ok: false, error: `${id} is not a screen on this board.` };
    const target = toLayoutId ?? me.layoutId;
    if (target === me.layoutId) {
        const plan = planMove(inGrid(screens, target), id, col, row, swap);
        return plan.ok ? { ok: true, moves: tag(plan.moves, target, target) } : plan;
    }
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return { ok: false, error: 'col and row must be whole numbers, 0 or more.' };
    const occupant = screens.find((s) => s.layoutId === target && s.col === col && s.row === row);
    const mine: LayoutMove = { id, from: { layoutId: me.layoutId, col: me.col, row: me.row }, to: { layoutId: target, col, row } };
    if (!occupant) return { ok: true, moves: [mine] };
    if (!swap) return { ok: false, error: `Cell (${col},${row}) of that group is occupied by ${occupant.id}. Pass swap: true to trade places.` };
    return { ok: true, moves: [mine, { id: occupant.id, from: { layoutId: target, col, row }, to: { layoutId: me.layoutId, col: me.col, row: me.row } }] };
}

/** insert_rows / insert_columns inside one grid: every screen of that grid past `after` moves `count` further. */
export function shiftGridPlan(screens: readonly GridScreen[], layoutId: string, axis: 'col' | 'row', after: number, count: number): LayoutMove[] {
    return tag(shiftPlan(inGrid(screens, layoutId), axis, after, count), layoutId, layoutId);
}

/** compact_board: each grid closes its own empty columns and rows. */
export function compactGridPlan(screens: readonly GridScreen[]): LayoutMove[] {
    const ids = [...new Set(screens.map((s) => s.layoutId))];
    return ids.flatMap((layoutId) => tag(compactPlan(inGrid(screens, layoutId)), layoutId, layoutId));
}

export type JoinResult = {
    cells: Map<string, { col: number; row: number }>;
    /** Screens that did not land on the grid (or on a free cell): they take the cell in `cells` and have to move to it. */
    snapped: string[];
};

/**
 * Screens joining a grid keep their places: each takes the cell its position is nearest. One that is off the pitch, or
 * whose cell is taken (by a screen already there or an earlier joiner), is snapped: a taken cell moves down to the next free
 * row. `taken` is the cells the grid's current screens occupy.
 */
export function placeJoiners(grid: LayoutGrid, members: readonly { id: string; x: number; y: number }[], taken: readonly { col: number; row: number }[]): JoinResult {
    const used = new Set(taken.map((c) => `${c.col},${c.row}`));
    const cells = new Map<string, { col: number; row: number }>();
    const snapped: string[] = [];
    for (const m of members) {
        const near = cellOfIn(grid, m);
        const rect = cellRectIn(grid, near.col, near.row, { width: 0, height: 0 });
        let moved = Math.abs(rect.x - m.x) > 2 || Math.abs(rect.y - m.y) > 2;
        let row = near.row;
        while (used.has(`${near.col},${row}`)) {
            row++;
            moved = true;
        }
        used.add(`${near.col},${row}`);
        cells.set(m.id, { col: near.col, row });
        if (moved) snapped.push(m.id);
    }
    return { cells, snapped };
}

/** A new group's grid starts where its members start: the top-left of their frames, so no member moves. */
export function groupOriginOf(members: readonly { x: number; y: number }[]): { originX: number; originY: number } {
    return { originX: Math.min(...members.map((m) => m.x)), originY: Math.min(...members.map((m) => m.y)) };
}

export type BlockGroup = { id: string; parentId?: string; screenIds: readonly string[]; layout?: { originX: number; originY: number } };
export type BlockShifts = { screens: Map<string, { dx: number; dy: number }>; layouts: Map<string, { originX: number; originY: number }> };

/**
 * Turns box moves (`resolveOverlaps`, which already lists a moved group's descendants) into the work to do: each moved group
 * shifts its own direct screens and its own layout origin. Nothing is shifted twice, because each id is a different group.
 */
export function planBlockShifts(moves: readonly { id: string; dx: number; dy: number }[], groups: readonly BlockGroup[]): BlockShifts {
    const screens = new Map<string, { dx: number; dy: number }>();
    const layouts = new Map<string, { originX: number; originY: number }>();
    for (const m of moves) {
        const g = groups.find((x) => x.id === m.id);
        if (!g) continue;
        for (const id of g.screenIds) screens.set(id, { dx: m.dx, dy: m.dy });
        if (g.layout) layouts.set(g.id, { originX: g.layout.originX + m.dx, originY: g.layout.originY + m.dy });
    }
    return { screens, layouts };
}

/**
 * The board background a grouped board needs: from the board origin to the far edge of every screen frame, with the label
 * offset above the first row and the margin all round. Local cells say nothing about where a screen is, so it reads the rects.
 */
export function boundsOfRects(meta: Pick<GridMeta, 'originX' | 'originY' | 'labelOffset' | 'margin'>, rects: readonly { x: number; y: number; width: number; height: number }[]): Bounds {
    const reachX = Math.max(0, ...rects.map((r) => r.x + r.width - meta.originX));
    const reachY = Math.max(0, ...rects.map((r) => r.y + r.height - meta.originY));
    return { x: meta.originX - meta.margin, y: meta.originY - meta.labelOffset - meta.margin, width: reachX + 2 * meta.margin, height: reachY + meta.labelOffset + 2 * meta.margin };
}

export type RegridScreen = { id: string; flowGroupId: string | null; layoutId?: string; col: number; row: number; x: number; y: number };
export type Regrid = {
    /** Layouts created for groups that had screens but no grid yet: the top-left of their members. */
    layouts: Map<string, { originX: number; originY: number }>;
    /** Screens whose layout or cell changed, with the cell they now hold. Screens not listed keep theirs. */
    cells: Map<string, { layoutId: string; col: number; row: number }>;
    /** The joiners that had to move to reach their cell: off the pitch, or the cell was taken. */
    snapped: string[];
};

/**
 * Brings a grouped board's cells in line with group membership, moving nothing that sits on a grid. A screen's layout is its
 * flow group (the board grid when it has none). Screens already on their layout keep their cells. A screen that joined a
 * layout (its group changed, or it was added to a group) takes the cell its position is nearest (`placeJoiners`), and a
 * group with screens but no grid gets one starting at its members' top-left.
 */
export function planRegrid(board: GridBoard, screens: readonly RegridScreen[], groups: readonly { id: string; layout?: { originX: number; originY: number } }[]): Regrid {
    const known = new Set(groups.map((g) => g.id));
    const layoutOf = (s: RegridScreen): string => (s.flowGroupId && known.has(s.flowGroupId) ? s.flowGroupId : BOARD_GRID);
    const layouts = new Map<string, { originX: number; originY: number }>();
    for (const g of groups) {
        if (g.layout) continue;
        const members = screens.filter((s) => layoutOf(s) === g.id);
        if (members.length) layouts.set(g.id, groupOriginOf(members));
    }
    const withLayouts = groups.map((g) => ({ id: g.id, layout: g.layout ?? layouts.get(g.id) }));
    const cells = new Map<string, { layoutId: string; col: number; row: number }>();
    const snapped: string[] = [];
    for (const layoutId of [BOARD_GRID, ...groups.map((g) => g.id)]) {
        const members = screens.filter((s) => layoutOf(s) === layoutId);
        const joiners = members.filter((s) => (s.layoutId ?? BOARD_GRID) !== layoutId);
        if (!joiners.length) continue;
        const grid = gridOfScreen({ id: '', layoutId }, withLayouts, board);
        const taken = members.filter((s) => (s.layoutId ?? BOARD_GRID) === layoutId);
        const placed = placeJoiners(grid, joiners, taken);
        for (const [id, cell] of placed.cells) cells.set(id, { layoutId, ...cell });
        snapped.push(...placed.snapped);
    }
    return { layouts, cells, snapped };
}
