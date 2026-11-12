import { cellOfRect, type ArrowMeta, type BoardMeta, type BuildState } from './flowmeta';
import type { Rect } from './rect';
import { statusMark } from './screen-status';
import { BOARD_GRID, cellOfIn, onGrid, type LayoutGrid } from './layout-grid';

/** Pure text renderer for an adopted flow board. No `figma` global. */

export type BoardScreen = {
    id: string;
    name: string;
    col: number;
    row: number;
    x: number;
    y: number;
    labelX: number | null;
    /** Build status; when absent the grid shows no mark. */
    status?: BuildState;
    /** The route text (code path), or null when the screen has none. */
    route?: string | null;
    verifiedAt?: string | null;
    hasBadge?: boolean;
    /** The innermost flow group (id of its rect), when any. */
    flowGroupId?: string | null;
    /** Grouped boards: the layout grid `col`/`row` are local to (a group id, or `board`). */
    layoutId?: string;
};

export type ScreenStatusRow = { id: string; name: string; col: number; row: number; route: string | null; status: BuildState; verifiedAt: string | null };

export type BoardArrow = {
    from: string;
    to: string;
    label: string;
    mode: ArrowMeta['mode'];
    triggerName: string | null;
    exit: ArrowMeta['exit'];
};

export type BoardGroup = { id: string; name: string; parentId?: string; screenIds: string[]; box: Rect; visible: boolean };

export type GroupRow = { id: string; name: string; parentId: string | null; screens: string[]; box: Rect };

export type BoardInput = {
    boardId: string;
    name: string;
    meta: Pick<BoardMeta, 'originX' | 'originY' | 'colWidth' | 'rowHeight' | 'colExtra' | 'rowExtra'>;
    screens: BoardScreen[];
    arrows: BoardArrow[];
    groups?: BoardGroup[];
    /** Grouped boards: one entry per layout grid (the board grid, then each group's), with its name and origin. */
    layouts?: { id: string; name: string; originX: number; originY: number }[];
};

export type LayoutGridView = { id: string; name: string; originX: number; originY: number; cols: number; rows: number; grid: string };

export type BoardDescription = {
    boardId: string;
    name: string;
    cols: number;
    rows: number;
    grid: string;
    /** Grouped boards: the same grid split per layout. */
    grids?: LayoutGridView[];
    screens: ScreenStatusRow[];
    arrows: string[];
    groups: GroupRow[];
    /** Indented flow group tree, one line per group; empty without groups. */
    groupTree: string;
    issues: string[];
};

const LABEL_TOLERANCE = 1;

const cell = (col: number, row: number) => `(c${col},r${row})`;

function fit(text: string, width: number): string {
    const w = Math.max(1, Math.floor(width));
    return text.length <= w ? text.padEnd(w) : `${text.slice(0, Math.max(0, w - 1))}…`.padEnd(w);
}

const cellText = (s: BoardScreen | undefined): string => (!s ? '' : s.status ? `${statusMark(s.status)} ${s.name}` : s.name);

function renderGrid(screens: readonly BoardScreen[], cols: number, rows: number, width: number): string {
    if (!cols || !rows) return '';
    const byCell = new Map<string, BoardScreen>();
    for (const s of screens) {
        const key = `${s.col},${s.row}`;
        if (!byCell.has(key)) byCell.set(key, s);
    }
    const w = Math.max(2, Math.floor(width));
    const head = `r${rows - 1}`.length + 2;
    const line = (label: string, cells: string[]) => `${label.padStart(head - 1).padEnd(head)}| ${cells.join(' | ')}`.trimEnd();
    const header = line('', Array.from({ length: cols }, (_, c) => fit(`c${c}`, w)));
    const rule = `${'-'.repeat(head)}+${Array.from({ length: cols }, () => '-'.repeat(w + 2)).join('+')}`;
    const body = Array.from({ length: rows }, (_, r) => line(`r${r}`, Array.from({ length: cols }, (_, c) => fit(cellText(byCell.get(`${c},${r}`)), w))));
    return [header, rule, ...body].join('\n');
}

function statusRows(screens: readonly BoardScreen[]): ScreenStatusRow[] {
    return [...screens]
        .sort((a, b) => a.row - b.row || a.col - b.col)
        .map((s) => ({ id: s.id, name: s.name, col: s.col, row: s.row, route: s.route ?? null, status: s.status ?? 'not-built', verifiedAt: s.verifiedAt ?? null }));
}

function renderGroups(groups: readonly BoardGroup[], screens: readonly BoardScreen[]): { rows: GroupRow[]; tree: string; issues: string[] } {
    const names = new Map(screens.map((s) => [s.id, s.name]));
    const byId = new Map(groups.map((g) => [g.id, g]));
    const issues: string[] = [];
    const rows: GroupRow[] = groups.map((g) => ({ id: g.id, name: g.name, parentId: g.parentId ?? null, screens: g.screenIds.flatMap((id) => names.get(id) ?? []), box: g.box }));
    const hasKids = new Set(groups.flatMap((g) => (g.parentId ? [g.parentId] : [])));
    for (const g of groups) {
        for (const id of g.screenIds) {
            const s = screens.find((x) => x.id === id);
            if (!s) issues.push(`Group "${g.name}" lists ${id}, which is not a screen on this board`);
            else if ((s.flowGroupId ?? null) !== g.id) issues.push(`Group "${g.name}" lists ${s.name}, whose flow group is not it`);
        }
        if (!g.screenIds.length && !hasKids.has(g.id)) issues.push(`Group "${g.name}" has no screens`);
        else if (!g.visible) issues.push(`Group "${g.name}" is hidden but has screens`);
        if (g.parentId && !byId.has(g.parentId)) issues.push(`Group "${g.name}" has a missing parent ${g.parentId}`);
    }
    for (const s of screens) if (s.flowGroupId && !byId.has(s.flowGroupId)) issues.push(`${s.name}: flow group ${s.flowGroupId} no longer exists`);
    const line = (g: BoardGroup, depth: number): string => {
        const members = rows.find((r) => r.id === g.id)?.screens.join(', ') ?? '';
        return `${'  '.repeat(depth)}${g.name} (${g.id})${members ? `: ${members}` : ''}`;
    };
    const lines: string[] = [];
    for (const g of groups.filter((x) => !x.parentId || !byId.has(x.parentId))) {
        lines.push(line(g, 0));
        for (const k of groups.filter((x) => x.parentId === g.id)) lines.push(line(k, 1));
    }
    return { rows, tree: lines.join('\n'), issues };
}

export function renderBoard(input: BoardInput, width = 16): BoardDescription {
    const { screens, arrows, meta } = input;
    const byId = new Map(screens.map((s) => [s.id, s]));
    const layouts = input.layouts;
    const layoutOf = (s: BoardScreen): string => s.layoutId ?? BOARD_GRID;
    const gridOf = (id: string): LayoutGrid | null => {
        const l = layouts?.find((x) => x.id === id);
        return l ? { id: l.id, originX: l.originX, originY: l.originY, colWidth: meta.colWidth, rowHeight: meta.rowHeight } : null;
    };
    const cols = screens.length ? Math.max(...screens.map((s) => s.col)) + 1 : 0;
    const rows = screens.length ? Math.max(...screens.map((s) => s.row)) + 1 : 0;
    const issues: string[] = [];

    for (const s of screens) {
        const grid = layouts ? gridOf(layoutOf(s)) : null;
        if (layouts && !grid) issues.push(`${s.name}: layout ${layoutOf(s)} has no grid`);
        else if (grid) {
            const actual = cellOfIn(grid, s);
            if (!onGrid(grid, s)) issues.push(`${s.name}: ${Math.round(s.x - (grid.originX + actual.col * grid.colWidth))}px, ${Math.round(s.y - (grid.originY + actual.row * grid.rowHeight))}px off cell ${cell(actual.col, actual.row)} of its grid`);
            else if (actual.col !== s.col || actual.row !== s.row) issues.push(`${s.name}: meta says ${cell(s.col, s.row)} but it sits at ${cell(actual.col, actual.row)}`);
        } else {
            const actual = cellOfRect(s, meta);
            if (actual.col !== s.col || actual.row !== s.row) issues.push(`${s.name}: meta says ${cell(s.col, s.row)} but it sits at ${cell(actual.col, actual.row)}`);
        }
        if (s.labelX !== null && Math.abs(s.labelX - s.x) > LABEL_TOLERANCE) issues.push(`${s.name}: label is at x=${s.labelX} but the frame is at x=${s.x}`);
        if (s.hasBadge === false) issues.push(`${s.name}: no build badge (run badge_screens)`);
        if (s.status === 'built' && !s.route) issues.push(`${s.name}: marked built but has no route text`);
    }

    const cellKeys = new Map<string, BoardScreen[]>();
    const keyOf = (s: BoardScreen) => `${layoutOf(s)}:${s.col},${s.row}`;
    for (const s of screens) cellKeys.set(keyOf(s), [...(cellKeys.get(keyOf(s)) ?? []), s]);
    for (const group of cellKeys.values()) {
        const first = group[0];
        if (group.length > 1 && first) issues.push(`Cell ${cell(first.col, first.row)} holds ${group.length} screens: ${group.map((g) => g.name).join(', ')}`);
    }

    const order = (a: BoardArrow, b: BoardArrow): number => {
        const fa = byId.get(a.from);
        const fb = byId.get(b.from);
        const ta = byId.get(a.to);
        const tb = byId.get(b.to);
        return (fa?.col ?? 1e9) - (fb?.col ?? 1e9) || (fa?.row ?? 1e9) - (fb?.row ?? 1e9) || (ta?.col ?? 1e9) - (tb?.col ?? 1e9) || (ta?.row ?? 1e9) - (tb?.row ?? 1e9) || a.label.localeCompare(b.label);
    };

    const lines: string[] = [];
    const point = (id: string, s: BoardScreen | undefined) => (s ? `${s.name} ${cell(s.col, s.row)}` : `${id} (missing)`);
    for (const a of [...arrows].sort(order)) {
        const from = byId.get(a.from);
        const to = byId.get(a.to);
        const tail = `${a.mode === 'trigger' ? `[trigger: ${a.triggerName ?? '?'}]` : '[auto]'}${a.exit === 'bottom' ? ' [bottom exit]' : ''}`;
        lines.push(`${point(a.from, from)} --${a.label}--> ${point(a.to, to)} ${tail}`);
        if (!from) issues.push(`Arrow "${a.label}": source ${a.from} is missing`);
        if (!to) issues.push(`Arrow "${a.label}": target ${a.to} is missing`);
        if (from && to && (layouts ? to.x < from.x : to.col < from.col)) issues.push(`Arrow "${a.label}" points left: ${from.name} (c${from.col}) to ${to.name} (c${to.col})`);
    }

    const g = renderGroups(input.groups ?? [], screens);
    issues.push(...g.issues);

    const views: LayoutGridView[] | undefined = layouts?.map((l) => {
        const own = screens.filter((s) => layoutOf(s) === l.id);
        const c = own.length ? Math.max(...own.map((s) => s.col)) + 1 : 0;
        const r = own.length ? Math.max(...own.map((s) => s.row)) + 1 : 0;
        return { id: l.id, name: l.name, originX: l.originX, originY: l.originY, cols: c, rows: r, grid: renderGrid(own, c, r, width) };
    });
    const grid = views ? views.filter((v) => v.cols).map((v) => `${v.name} (origin ${v.originX},${v.originY})\n${v.grid}`).join('\n\n') : renderGrid(screens, cols, rows, width);
    return { boardId: input.boardId, name: input.name, cols, rows, grid, ...(views ? { grids: views } : {}), screens: statusRows(screens), arrows: lines, groups: g.rows, groupTree: g.tree, issues };
}
