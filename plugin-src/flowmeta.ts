/** Shared plugin data model for flow boards, plus pure helpers. No `figma` global. */

export const FLOW_NAMESPACE = 'flowbridge';
export const BOARD_KEY = 'board';
export const SCREEN_KEY = 'screen';
export const ARROW_KEY = 'arrow';

export type Rgb = { r: number; g: number; b: number };

export type BoardMeta = {
    v: 1;
    kind: 'board';
    originX: number;
    originY: number;
    colWidth: number;
    rowHeight: number;
    screenW: number;
    screenH: number;
    labelOffset: number;
    margin: number;
    headingId: string | null;
    arrowsGroupId: string;
    arrowStyle: { strokeVariableId: string | null; color: Rgb; weight: number; cornerRadius: number };
};

export type ScreenMeta = {
    v: 1;
    kind: 'screen';
    boardId: string;
    col: number;
    row: number;
    labelId: string | null;
    routeId: string | null;
    /** The `Screen · {name}` group holding the label, route and frame. Absent or null on ungrouped screens. */
    groupId?: string | null;
};

export type ArrowMeta = {
    v: 1;
    kind: 'arrow';
    boardId: string;
    from: string;
    to: string;
    trigger: string | null;
    label: string;
    mode: 'trigger' | 'auto';
    exit?: 'side' | 'bottom';
    vectorId: string;
    dotId: string;
    labelId: string;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);

function parse(raw: string): Record<string, unknown> | null {
    if (!raw) return null;
    try {
        const v: unknown = JSON.parse(raw);
        return isObj(v) ? v : null;
    } catch {
        return null;
    }
}

export function parseBoardMeta(raw: string): BoardMeta | null {
    const o = parse(raw);
    if (!o || o.v !== 1 || o.kind !== 'board') return null;
    const s = o.arrowStyle;
    if (!isObj(s) || !isObj(s.color) || !strOrNull(s.strokeVariableId) || !isNum(s.weight) || !isNum(s.cornerRadius)) return null;
    if (!isNum(s.color.r) || !isNum(s.color.g) || !isNum(s.color.b)) return null;
    for (const k of ['originX', 'originY', 'colWidth', 'rowHeight', 'screenW', 'screenH', 'labelOffset', 'margin']) if (!isNum(o[k])) return null;
    if (!strOrNull(o.headingId) || !isStr(o.arrowsGroupId)) return null;
    return o as unknown as BoardMeta;
}

export function parseScreenMeta(raw: string): ScreenMeta | null {
    const o = parse(raw);
    if (!o || o.v !== 1 || o.kind !== 'screen') return null;
    if (!isStr(o.boardId) || !isNum(o.col) || !isNum(o.row) || !strOrNull(o.labelId) || !strOrNull(o.routeId)) return null;
    if (o.groupId !== undefined && !strOrNull(o.groupId)) return null;
    return o as unknown as ScreenMeta;
}

export function parseArrowMeta(raw: string): ArrowMeta | null {
    const o = parse(raw);
    if (!o || o.v !== 1 || o.kind !== 'arrow') return null;
    if (!isStr(o.boardId) || !isStr(o.from) || !isStr(o.to) || !strOrNull(o.trigger) || !isStr(o.label)) return null;
    if (o.mode !== 'trigger' && o.mode !== 'auto') return null;
    if (!isStr(o.vectorId) || !isStr(o.dotId) || !isStr(o.labelId)) return null;
    return o as unknown as ArrowMeta;
}

export const arrowGroupName = (fromName: string, toName: string, label: string): string => `Flow · ${fromName} → ${toName} · ${label}`;

export function cellOfRect(rect: { x: number; y: number }, board: Pick<BoardMeta, 'originX' | 'originY' | 'colWidth' | 'rowHeight'>): { col: number; row: number } {
    return { col: Math.round((rect.x - board.originX) / board.colWidth), row: Math.round((rect.y - board.originY) / board.rowHeight) };
}

/** Stable order for lane assignment: source column, then target row, then id. */
export function stableArrowOrder<T extends { id: string; sourceX: number; targetY: number }>(items: readonly T[]): T[] {
    return [...items].sort((a, b) => a.sourceX - b.sourceX || a.targetY - b.targetY || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type ActionLike = { type: string; [key: string]: unknown };
export type ReactionLike = { trigger: { type: string; [key: string]: unknown } | null; action?: ActionLike; actions?: ActionLike[] };

const isNavigate = (a: ActionLike | undefined): a is ActionLike => !!a && a.type === 'NODE' && a.navigation === 'NAVIGATE';

/**
 * Points the first navigate reaction at `to`, keeping its trigger, transition and any other fields.
 * Adds an on-click navigate when there is none.
 */
export function setNavigateTarget<R extends ReactionLike>(reactions: readonly R[], to: string): { reactions: ReactionLike[]; replaced: boolean } {
    const out: ReactionLike[] = reactions.map((r) => ({ ...r }));
    const idx = out.findIndex((r) => isNavigate(r.action) || (r.actions ?? []).some(isNavigate));
    if (idx === -1) {
        out.push({ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: to, navigation: 'NAVIGATE', transition: null }] });
        return { reactions: out, replaced: false };
    }
    const r = out[idx] as ReactionLike;
    if (isNavigate(r.action)) r.action = { ...r.action, destinationId: to };
    if (r.actions) {
        const first = r.actions.findIndex(isNavigate);
        r.actions = r.actions.map((a, i) => (i === first ? { ...a, destinationId: to } : a));
    }
    return { reactions: out, replaced: true };
}
