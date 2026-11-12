/** Shared plugin data model for flow boards, plus pure helpers. No `figma` global. */

import { cellOfPoint, cleanExtras, type Extras, type ExtrasInput } from './tracks';

export const FLOW_NAMESPACE = 'flowbridge';
export const BOARD_KEY = 'board';
export const SCREEN_KEY = 'screen';
export const ARROW_KEY = 'arrow';
export const GROUP_KEY = 'group';
/** Plugin data key on the per-board `Flow groups · {board}` holder frame; the value is the board's node id. */
export const GROUP_LAYER_KEY = 'groups-layer';

export type Rgb = { r: number; g: number; b: number };

export type BoardMeta = {
    v: 1;
    kind: 'board';
    originX: number;
    originY: number;
    colWidth: number;
    rowHeight: number;
    /** Extra px added before column `at`, for the rows `from`..`to` only (cumulative). Absent = uniform columns. */
    colExtra?: Extras;
    /** Extra px added before row `at`, for the columns `from`..`to` only (cumulative). Absent = uniform rows. */
    rowExtra?: Extras;
    /**
     * 'uniform' (default): one column pitch and one row pitch for the whole board; `colWidth`/`rowHeight` are the effective
     * pitch and no extras apply. 'banded': base pitch plus per-region extras.
     */
    spacing?: 'uniform' | 'banded';
    /** The pitch without group needs (uniform spacing only); `colWidth`/`rowHeight` are base plus the largest need. */
    baseColWidth?: number;
    baseRowHeight?: number;
    /** Extra room measured from the drawn group boxes (gap-fix.ts), added to the planned extras; kept so refits do not undo it. */
    gapExtra?: { colExtra: Extras; rowExtra: Extras };
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
    /** Whether the screen exists in code and matches the design. Absent reads as not built. */
    build?: BuildStatus;
    /** The `Badge · {name}` pill showing `build`. */
    badgeId?: string | null;
    /** The flow group (labelled box) this screen belongs to: the id of the group's rect. Distinct from the legacy `groupId`. */
    flowGroupId?: string | null;
};

/**
 * How a flow group's box and title bar are drawn. Colours are `#RRGGBB`. `color` is the box line, `titleFill` the title bar
 * fill, `titleColor` the title text. `padding` is the gap from member content to the line's inner edge.
 */
export type GroupStyle = { color: string; strokeWeight: number; titleSize: number; padding: number; titleFill: string; titleColor: string };

/** Defaults for style fields; mirrors the constants in flow-group.ts (kept here so this module stays dependency-free). */
export const STYLE_DEFAULTS = { strokeWeight: 12, padding: 160, titleFill: '#2C2C2C', titleColor: '#FFFFFF' } as const;
/** Stroke weight old groups (drawn before padding existed) were created with; they migrate to the new default. */
const LEGACY_STROKE = 4;

/** Stored on a flow group's rectangle node. The group's id is that node's id (`rectId`). */
export type GroupMeta = {
    boardId: string;
    name: string;
    /** The screens directly in this group. A screen is in at most one group; a parent's box also wraps its children's. */
    screenIds: string[];
    rectId: string;
    titleId: string;
    /** Set on a nested child. One level only. */
    parentId?: string;
    style: GroupStyle;
};

export type BuildStatus =
    | { status: 'not-built' }
    | { status: 'built'; verifiedAt: string; commit: string | null; confidence: 'static' | 'runtime'; notes: string | null }
    | { status: 'drift'; verifiedAt: string; commit: string | null; notes: string };

export type BuildState = BuildStatus['status'];

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

export function parseBuildStatus(v: unknown): BuildStatus | null {
    if (!isObj(v)) return null;
    if (v.status === 'not-built') return { status: 'not-built' };
    if (!isStr(v.verifiedAt) || !strOrNull(v.commit)) return null;
    if (v.status === 'built') {
        if (v.confidence !== 'static' && v.confidence !== 'runtime') return null;
        if (!strOrNull(v.notes)) return null;
        return { status: 'built', verifiedAt: v.verifiedAt, commit: v.commit, confidence: v.confidence, notes: v.notes };
    }
    if (v.status === 'drift') {
        if (!isStr(v.notes) || !v.notes) return null;
        return { status: 'drift', verifiedAt: v.verifiedAt, commit: v.commit, notes: v.notes };
    }
    return null;
}

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
    const meta = o as unknown as BoardMeta;
    for (const k of ['colExtra', 'rowExtra'] as const) {
        const raw = o[k];
        if (raw === undefined) continue;
        const clean = isObj(raw) || Array.isArray(raw) ? cleanExtras(raw as ExtrasInput) : [];
        if (clean.length) meta[k] = clean;
        else delete meta[k];
    }
    if (o.spacing !== undefined && o.spacing !== 'uniform' && o.spacing !== 'banded') delete meta.spacing;
    for (const k of ['baseColWidth', 'baseRowHeight'] as const) if (o[k] !== undefined && !(isNum(o[k]) && (o[k] as number) > 0)) delete meta[k];
    const gap = o.gapExtra;
    if (gap !== undefined) {
        const clean = (v: unknown) => (isObj(v) || Array.isArray(v) ? cleanExtras(v as ExtrasInput) : []);
        const [colExtra, rowExtra] = isObj(gap) ? [clean(gap.colExtra), clean(gap.rowExtra)] : [[], []];
        if (colExtra.length || rowExtra.length) meta.gapExtra = { colExtra, rowExtra };
        else delete meta.gapExtra;
    }
    return meta;
}

export function parseScreenMeta(raw: string): ScreenMeta | null {
    const o = parse(raw);
    if (!o || o.v !== 1 || o.kind !== 'screen') return null;
    if (!isStr(o.boardId) || !isNum(o.col) || !isNum(o.row) || !strOrNull(o.labelId) || !strOrNull(o.routeId)) return null;
    if (o.groupId !== undefined && !strOrNull(o.groupId)) return null;
    if (o.badgeId !== undefined && !strOrNull(o.badgeId)) return null;
    if (o.flowGroupId !== undefined && !strOrNull(o.flowGroupId)) return null;
    if (o.build !== undefined && !parseBuildStatus(o.build)) return null;
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

export function parseGroupMeta(raw: string): GroupMeta | null {
    const o = parse(raw);
    if (!o) return null;
    if (!isStr(o.boardId) || !isStr(o.name) || !isStr(o.rectId) || !isStr(o.titleId)) return null;
    if (!Array.isArray(o.screenIds) || !o.screenIds.every(isStr)) return null;
    if (o.parentId !== undefined && !isStr(o.parentId)) return null;
    const s = o.style;
    if (!isObj(s) || !isStr(s.color) || !/^#[0-9a-fA-F]{6}$/.test(s.color) || !isNum(s.strokeWeight) || !isNum(s.titleSize)) return null;
    if (s.strokeWeight <= 0 || s.titleSize <= 0) return null;
    const hex = (v: unknown, d: string): string | null => (v === undefined ? d : isStr(v) && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
    const titleFill = hex(s.titleFill, STYLE_DEFAULTS.titleFill);
    const titleColor = hex(s.titleColor, STYLE_DEFAULTS.titleColor);
    if (!titleFill || !titleColor) return null;
    if (s.padding !== undefined && (!isNum(s.padding) || s.padding <= 0)) return null;
    const legacy = s.padding === undefined;
    return {
        boardId: o.boardId,
        name: o.name,
        screenIds: [...new Set(o.screenIds)],
        rectId: o.rectId,
        titleId: o.titleId,
        ...(o.parentId ? { parentId: o.parentId } : {}),
        style: {
            color: s.color,
            strokeWeight: legacy && s.strokeWeight === LEGACY_STROKE ? STYLE_DEFAULTS.strokeWeight : s.strokeWeight,
            titleSize: s.titleSize,
            padding: isNum(s.padding) ? s.padding : STYLE_DEFAULTS.padding,
            titleFill,
            titleColor,
        },
    };
}

export const arrowGroupName = (fromName: string, toName: string, label: string): string => `Flow · ${fromName} → ${toName} · ${label}`;

export function cellOfRect(
    rect: { x: number; y: number },
    board: Pick<BoardMeta, 'originX' | 'originY' | 'colWidth' | 'rowHeight' | 'colExtra' | 'rowExtra'>,
): { col: number; row: number } {
    return cellOfPoint(rect.x - board.originX, rect.y - board.originY, board.colWidth, board.rowHeight, board.colExtra, board.rowExtra);
}

/** Stable order for lane assignment: source column, then target row, then id. */
export function stableArrowOrder<T extends { id: string; sourceX: number; targetY: number }>(items: readonly T[]): T[] {
    return [...items].sort((a, b) => a.sourceX - b.sourceX || a.targetY - b.targetY || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type ActionLike = { type: string; [key: string]: unknown };
export type ReactionLike = { trigger: { type: string; [key: string]: unknown } | null; action?: ActionLike; actions?: ActionLike[] };

const isNavigate = (a: ActionLike | undefined): a is ActionLike => !!a && a.type === 'NODE' && a.navigation === 'NAVIGATE';

/** Every node a set of reactions points at, once each, in order. */
export function destinationsOf(reactions: readonly ReactionLike[]): string[] {
    const ids = reactions.flatMap((r) => [...(r.action ? [r.action] : []), ...(r.actions ?? [])]).flatMap((a) => (a.type === 'NODE' && typeof a.destinationId === 'string' ? [a.destinationId] : []));
    return [...new Set(ids)];
}

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
