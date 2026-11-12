/** Pure board-grid maths for the grid tools. No `figma` global. */
import { cellOfRect, type BoardMeta } from './flowmeta';
import { compactExtras, shiftExtras, shiftRanges, trackStart, type Extras } from './tracks';

export type GridMeta = Pick<BoardMeta, 'originX' | 'originY' | 'colWidth' | 'rowHeight' | 'colExtra' | 'rowExtra' | 'screenW' | 'screenH' | 'labelOffset' | 'margin'>;
export type Cell = { col: number; row: number };
export type CellScreen = { id: string; col: number; row: number };
export type Move = { id: string; from: Cell; to: Cell };
export type Bounds = { x: number; y: number; width: number; height: number };
export type StaleReason = 'label-misplaced' | 'label-missing' | 'cell-mismatch';

const key = (col: number, row: number) => `${col},${row}`;

/** The frame rect of a screen sitting in a grid cell. */
export function cellRect(meta: GridMeta, col: number, row: number): Bounds {
    return { x: meta.originX + trackStart(col, meta.colWidth, meta.colExtra, row), y: meta.originY + trackStart(row, meta.rowHeight, meta.rowExtra, col), width: meta.screenW, height: meta.screenH };
}

/** The grid cell nearest a frame's top-left corner. */
export function cellOf(rect: { x: number; y: number }, meta: GridMeta): Cell {
    return cellOfRect(rect, meta);
}

/** Cell → screen id, plus the cells holding more than one screen. */
export function occupancy(screens: readonly CellScreen[]): { cells: Map<string, string>; collisions: { col: number; row: number; ids: string[] }[] } {
    const cells = new Map<string, string>();
    const groups = new Map<string, { col: number; row: number; ids: string[] }>();
    for (const s of screens) {
        const k = key(s.col, s.row);
        const g = groups.get(k);
        if (g) g.ids.push(s.id);
        else groups.set(k, { col: s.col, row: s.row, ids: [s.id] });
        if (!cells.has(k)) cells.set(k, s.id);
    }
    return { cells, collisions: [...groups.values()].filter((g) => g.ids.length > 1) };
}

/** Moves that make room: every screen past `after` on the axis moves `count` further. */
export function shiftPlan(screens: readonly CellScreen[], axis: 'col' | 'row', after: number, count: number): Move[] {
    return screens
        .filter((s) => s[axis] > after)
        .map((s) => ({ id: s.id, from: { col: s.col, row: s.row }, to: axis === 'col' ? { col: s.col + count, row: s.row } : { col: s.col, row: s.row + count } }));
}

/** Moves that close empty columns and rows between screens. The first used column and row keep their index. */
export function compactPlan(screens: readonly CellScreen[]): Move[] {
    const rank = (values: number[]) => {
        const sorted = [...new Set(values)].sort((a, b) => a - b);
        const first = sorted[0] ?? 0;
        return new Map(sorted.map((v, i) => [v, first + i]));
    };
    const cols = rank(screens.map((s) => s.col));
    const rows = rank(screens.map((s) => s.row));
    const out: Move[] = [];
    for (const s of screens) {
        const to = { col: cols.get(s.col) ?? s.col, row: rows.get(s.row) ?? s.row };
        if (to.col !== s.col || to.row !== s.row) out.push({ id: s.id, from: { col: s.col, row: s.row }, to });
    }
    return out;
}

export type ExtrasPair = { colExtra: Extras; rowExtra: Extras };

/** The extras after an insert_columns / insert_rows of `count` tracks after `after`. */
export function shiftedExtras(meta: Pick<GridMeta, 'colExtra' | 'rowExtra'>, axis: 'col' | 'row', after: number, count: number): ExtrasPair {
    const colExtra = meta.colExtra ?? [];
    const rowExtra = meta.rowExtra ?? [];
    return axis === 'col'
        ? { colExtra: shiftExtras(colExtra, after, count), rowExtra: shiftRanges(rowExtra, after, count) }
        : { colExtra: shiftRanges(colExtra, after, count), rowExtra: shiftExtras(rowExtra, after, count) };
}

/** The extras after compact_board: boundaries follow the tracks screens actually use. */
export function compactedExtras(meta: Pick<GridMeta, 'colExtra' | 'rowExtra'>, screens: readonly CellScreen[]): ExtrasPair {
    const [cols, rows] = [screens.map((s) => s.col), screens.map((s) => s.row)];
    return { colExtra: compactExtras(meta.colExtra ?? [], cols, rows), rowExtra: compactExtras(meta.rowExtra ?? [], rows, cols) };
}

export type MovePlan = { ok: true; moves: Move[] } | { ok: false; error: string };

/** Plans moving one screen to a cell, refusing an occupied cell unless `swap` trades the two screens. */
export function planMove(screens: readonly CellScreen[], id: string, col: number, row: number, swap: boolean): MovePlan {
    const me = screens.find((s) => s.id === id);
    if (!me) return { ok: false, error: `${id} is not a screen on this board.` };
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return { ok: false, error: 'col and row must be whole numbers, 0 or more.' };
    if (me.col === col && me.row === row) return { ok: true, moves: [] };
    const occupant = screens.find((s) => s.id !== id && s.col === col && s.row === row);
    const mine: Move = { id, from: { col: me.col, row: me.row }, to: { col, row } };
    if (!occupant) return { ok: true, moves: [mine] };
    if (!swap) return { ok: false, error: `Cell (${col},${row}) is occupied by ${occupant.id}. Pass swap: true to trade places.` };
    return { ok: true, moves: [mine, { id: occupant.id, from: { col, row }, to: { col: me.col, row: me.row } }] };
}

/** The bounds a board background needs: screens, label offset above the first row, and the margin all round. */
export function boardBounds(meta: GridMeta, screens: readonly { col: number; row: number }[]): Bounds {
    const reachX = Math.max(0, ...screens.map((s) => trackStart(s.col, meta.colWidth, meta.colExtra, s.row)));
    const reachY = Math.max(0, ...screens.map((s) => trackStart(s.row, meta.rowHeight, meta.rowExtra, s.col)));
    return {
        x: meta.originX - meta.margin,
        y: meta.originY - meta.labelOffset - meta.margin,
        width: reachX + meta.screenW + 2 * meta.margin,
        height: reachY + meta.labelOffset + meta.screenH + 2 * meta.margin,
    };
}

const LABEL_TOLERANCE = 2;

/**
 * Why a screen's stored meta cannot be trusted, or null when it can. Duplicating a frame in Figma copies its
 * plugin data, so a copy points at the original's label: valid meta has its label text at the frame's x.
 */
export function staleReason(meta: GridMeta, stored: Cell, frame: { x: number; y: number }, label: { x: number; y: number } | null, hasLabelId: boolean): StaleReason | null {
    if (hasLabelId) {
        if (!label) return 'label-missing';
        if (Math.abs(label.x - frame.x) > LABEL_TOLERANCE) return 'label-misplaced';
    }
    const at = cellOf(frame, meta);
    return at.col !== stored.col || at.row !== stored.row ? 'cell-mismatch' : null;
}

/**
 * Whether the horizontal gap from `source` to `target` is wider than the plain grid makes it, measured on the cells
 * they sit in. With banded extras that depends on the rows of the two screens, so it reads their cell rects.
 */
export function widenedBetween(meta: GridMeta, source: { x: number; y: number }, target: { x: number; y: number }): boolean {
    if (!meta.colExtra?.length) return false;
    const [a, b] = [cellOf(source, meta), cellOf(target, meta)];
    const plain = (b.col - a.col) * meta.colWidth;
    return cellRect(meta, b.col, b.row).x - cellRect(meta, a.col, a.row).x - plain > 0;
}
