import { cellOfRect, type ArrowMeta, type BoardMeta } from './flowmeta';

/** Pure text renderer for an adopted flow board. No `figma` global. */

export type BoardScreen = { id: string; name: string; col: number; row: number; x: number; y: number; labelX: number | null };

export type BoardArrow = {
    from: string;
    to: string;
    label: string;
    mode: ArrowMeta['mode'];
    triggerName: string | null;
    exit: ArrowMeta['exit'];
};

export type BoardInput = {
    boardId: string;
    name: string;
    meta: Pick<BoardMeta, 'originX' | 'originY' | 'colWidth' | 'rowHeight'>;
    screens: BoardScreen[];
    arrows: BoardArrow[];
};

export type BoardDescription = {
    boardId: string;
    name: string;
    cols: number;
    rows: number;
    grid: string;
    arrows: string[];
    issues: string[];
};

const LABEL_TOLERANCE = 1;

const cell = (col: number, row: number) => `(c${col},r${row})`;

function fit(text: string, width: number): string {
    const w = Math.max(1, Math.floor(width));
    return text.length <= w ? text.padEnd(w) : `${text.slice(0, Math.max(0, w - 1))}…`.padEnd(w);
}

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
    const body = Array.from({ length: rows }, (_, r) => line(`r${r}`, Array.from({ length: cols }, (_, c) => fit(byCell.get(`${c},${r}`)?.name ?? '', w))));
    return [header, rule, ...body].join('\n');
}

export function renderBoard(input: BoardInput, width = 16): BoardDescription {
    const { screens, arrows, meta } = input;
    const byId = new Map(screens.map((s) => [s.id, s]));
    const cols = screens.length ? Math.max(...screens.map((s) => s.col)) + 1 : 0;
    const rows = screens.length ? Math.max(...screens.map((s) => s.row)) + 1 : 0;
    const issues: string[] = [];

    for (const s of screens) {
        const actual = cellOfRect(s, meta);
        if (actual.col !== s.col || actual.row !== s.row) issues.push(`${s.name}: meta says ${cell(s.col, s.row)} but it sits at ${cell(actual.col, actual.row)}`);
        if (s.labelX !== null && Math.abs(s.labelX - s.x) > LABEL_TOLERANCE) issues.push(`${s.name}: label is at x=${s.labelX} but the frame is at x=${s.x}`);
    }

    const cellKeys = new Map<string, BoardScreen[]>();
    for (const s of screens) cellKeys.set(`${s.col},${s.row}`, [...(cellKeys.get(`${s.col},${s.row}`) ?? []), s]);
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
        if (from && to && to.col < from.col) issues.push(`Arrow "${a.label}" points left: ${from.name} (c${from.col}) to ${to.name} (c${to.col})`);
    }

    return { boardId: input.boardId, name: input.name, cols, rows, grid: renderGrid(screens, cols, rows, width), arrows: lines, issues };
}
