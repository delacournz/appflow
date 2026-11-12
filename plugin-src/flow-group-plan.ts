/** Pure planning for flow group tools: membership and nesting rules, extras moves, z-order. No `figma` global. */
import { boundaryExtras, type BoundaryExtras } from './flow-group';
import { ROUTE_TOP } from './flow-group';
import type { Move } from './grid';
import type { GroupStyle } from './flowmeta';
import { cleanExtras, trackStart, type Extras, type ExtrasInput } from './tracks';

/** The group fields the rules need. A group's `screenIds` are its own screens only; a child's screens are not repeated on its parent. */
export type GroupRec = { id: string; name: string; parentId?: string; screenIds: string[] };

type Fail = { ok: false; error: string };

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];
const ownerOf = (groups: readonly GroupRec[], screenId: string): GroupRec | undefined => groups.find((g) => g.screenIds.includes(screenId));

export type CreatePlan = { ok: true; name: string; screenIds: string[]; parentId: string | undefined; takeFromParent: string[] } | Fail;

/**
 * Membership rules for a new group. A screen is in at most one group, so every screen must be free, except that a
 * child may take screens from its parent (they move down into the child; the parent's box still wraps them).
 * Nesting is one level deep.
 */
export function planCreateGroup(existing: readonly GroupRec[], req: { name: string; screenIds: readonly string[]; parentId?: string }, onBoard: ReadonlySet<string>): CreatePlan {
    const name = req.name.trim();
    if (!name) return { ok: false, error: 'A flow group needs a name.' };
    const ids = unique(req.screenIds);
    if (!ids.length) return { ok: false, error: 'A flow group needs at least one screen.' };
    const unknown = ids.filter((id) => !onBoard.has(id));
    if (unknown.length) return { ok: false, error: `Not screens on this board: ${unknown.join(', ')}.` };
    const parent = req.parentId ? existing.find((g) => g.id === req.parentId) : undefined;
    if (req.parentId) {
        if (!parent) return { ok: false, error: `No parent flow group ${req.parentId}.` };
        if (parent.parentId) return { ok: false, error: `Nesting is one level: "${parent.name}" (${parent.id}) is already a child.` };
    }
    const takeFromParent: string[] = [];
    for (const id of ids) {
        const owner = ownerOf(existing, id);
        if (!owner) continue;
        if (parent && owner.id === parent.id) takeFromParent.push(id);
        else return { ok: false, error: `${id} is already in "${owner.name}" (${owner.id}). Remove it there first.` };
    }
    return { ok: true, name, screenIds: ids, parentId: parent?.id, takeFromParent };
}

export type UpdatePlan = { ok: true; name: string; screenIds: string[]; parentId: string | undefined; takeFromParent: string[]; removed: string[] } | Fail;

/** Membership and nesting rules for update_flow_group. `parentId: null` promotes a child to the top level. */
export function planUpdateGroup(
    existing: readonly GroupRec[],
    groupId: string,
    req: { name?: string; add?: readonly string[]; remove?: readonly string[]; parentId?: string | null },
    onBoard: ReadonlySet<string>,
): UpdatePlan {
    const group = existing.find((g) => g.id === groupId);
    if (!group) return { ok: false, error: `No flow group ${groupId}.` };
    const name = req.name === undefined ? group.name : req.name.trim();
    if (!name) return { ok: false, error: 'A flow group needs a name.' };

    let parentId = group.parentId;
    if (req.parentId === null) parentId = undefined;
    else if (typeof req.parentId === 'string') {
        const parent = existing.find((g) => g.id === req.parentId);
        if (!parent) return { ok: false, error: `No parent flow group ${req.parentId}.` };
        if (parent.id === group.id) return { ok: false, error: 'A flow group cannot be its own parent.' };
        if (parent.parentId) return { ok: false, error: `Nesting is one level: "${parent.name}" (${parent.id}) is already a child.` };
        if (existing.some((k) => k.parentId === group.id)) return { ok: false, error: `Nesting is one level: "${group.name}" has children, so it cannot become a child.` };
        parentId = parent.id;
    }

    const remove = unique(req.remove ?? []);
    const notMembers = remove.filter((id) => !group.screenIds.includes(id));
    if (notMembers.length) return { ok: false, error: `Not in "${group.name}": ${notMembers.join(', ')}.` };

    const add = unique(req.add ?? []).filter((id) => !group.screenIds.includes(id) || remove.includes(id));
    const unknown = add.filter((id) => !onBoard.has(id));
    if (unknown.length) return { ok: false, error: `Not screens on this board: ${unknown.join(', ')}.` };
    const takeFromParent: string[] = [];
    for (const id of add) {
        const owner = ownerOf(existing, id);
        if (!owner || owner.id === group.id) continue;
        if (parentId && owner.id === parentId) takeFromParent.push(id);
        else return { ok: false, error: `${id} is already in "${owner.name}" (${owner.id}). Remove it there first.` };
    }

    const screenIds = unique([...group.screenIds.filter((id) => !remove.includes(id)), ...add]);
    const hasChildren = existing.some((k) => k.parentId === group.id);
    if (!screenIds.length && !hasChildren) return { ok: false, error: `That would leave "${group.name}" empty. Use delete_flow_group to remove it.` };
    return { ok: true, name, screenIds, parentId, takeFromParent, removed: remove.filter((id) => !add.includes(id)) };
}

export type DeletePlan = { ok: true; screenIds: string[]; promote: string[] } | Fail;

/** Deleting a group frees its screens and promotes its children to the top level. */
export function planDeleteGroup(existing: readonly GroupRec[], groupId: string): DeletePlan {
    const group = existing.find((g) => g.id === groupId);
    if (!group) return { ok: false, error: `No flow group ${groupId}.` };
    return { ok: true, screenIds: [...group.screenIds], promote: existing.filter((k) => k.parentId === groupId).map((k) => k.id) };
}

export type AssignPlan = { ok: true; changes: { id: string; screenIds: string[] }[] } | Fail;

/**
 * Moves one screen into group `target` (null = no group), leaving whichever group held it. Used by move_screen and
 * duplicate_screen, so unlike `planUpdateGroup` it may leave the old group empty (it is then hidden, not deleted).
 */
export function planAssign(existing: readonly GroupRec[], screenId: string, target: string | null): AssignPlan {
    if (target !== null && !existing.some((g) => g.id === target)) return { ok: false, error: `No flow group ${target}.` };
    const changes: { id: string; screenIds: string[] }[] = [];
    for (const g of existing) {
        const has = g.screenIds.includes(screenId);
        if (g.id === target && !has) changes.push({ id: g.id, screenIds: [...g.screenIds, screenId] });
        else if (g.id !== target && has) changes.push({ id: g.id, screenIds: g.screenIds.filter((id) => id !== screenId) });
    }
    return { ok: true, changes };
}

export type StyleResult = { ok: true; style: GroupStyle } | Fail;

/** `base` with the fields of a user-supplied style object laid over it. Unknown or ill-typed fields are errors. */
export function mergeStyle(base: GroupStyle, raw: unknown): StyleResult {
    if (raw === undefined) return { ok: true, style: base };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'style must be an object.' };
    const o = raw as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => k !== 'color' && k !== 'strokeWeight' && k !== 'titleSize');
    if (unknown.length) return { ok: false, error: `Unknown style fields: ${unknown.join(', ')}.` };
    const style = { ...base };
    if (o.color !== undefined) {
        if (typeof o.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.color)) return { ok: false, error: 'style.color must be #RRGGBB.' };
        style.color = o.color;
    }
    for (const k of ['strokeWeight', 'titleSize'] as const) {
        const v = o[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return { ok: false, error: `style.${k} must be a positive number.` };
        style[k] = v;
    }
    return { ok: true, style };
}

export type ScreenFlowRef = { id: string; flowGroupId?: string | null };
export type Reconciled = { groups: GroupRec[]; changedGroups: string[]; screenFixes: { screenId: string; flowGroupId: string | null }[] };

/**
 * Group metas are the truth for membership; a screen's `flowGroupId` is a copy. Drops screens that are gone from a group,
 * keeps a screen in the first group that lists it, un-nests a child whose parent is missing or itself nested, and reports
 * which screens' `flowGroupId` must be rewritten (a hand-duplicated frame carries its source's).
 */
export function reconcileMembership(groups: readonly GroupRec[], screens: readonly ScreenFlowRef[]): Reconciled {
    const present = new Set(screens.map((s) => s.id));
    const byId = new Map(groups.map((g) => [g.id, g]));
    const claimed = new Set<string>();
    const owner = new Map<string, string>();
    const changed = new Set<string>();
    const out: GroupRec[] = groups.map((g) => {
        const screenIds = unique(g.screenIds).filter((id) => {
            if (!present.has(id) || claimed.has(id)) return false;
            claimed.add(id);
            owner.set(id, g.id);
            return true;
        });
        const parent = g.parentId ? byId.get(g.parentId) : undefined;
        const parentId = parent && !parent.parentId && parent.id !== g.id ? g.parentId : undefined;
        if (screenIds.length !== g.screenIds.length || parentId !== g.parentId) changed.add(g.id);
        return { id: g.id, name: g.name, screenIds, ...(parentId ? { parentId } : {}) };
    });
    const screenFixes = screens.flatMap((s) => {
        const want = owner.get(s.id) ?? null;
        return (s.flowGroupId ?? null) === want ? [] : [{ screenId: s.id, flowGroupId: want }];
    });
    return { groups: out, changedGroups: [...changed], screenFixes };
}

export type BaseGrid = { colWidth: number; rowHeight: number; screenW: number; screenH: number };
export type CellScreen = { id: string; col: number; row: number };

/**
 * Extras the board needs for its groups, from the screens' cells. Columns keep the whole base gutter for arrow lanes
 * and labels (the router never leaves it). Rows keep the base gap less `ROUTE_TOP`, because the lower screen's route
 * text already sits in that gap and `boundaryExtras` counts it separately.
 */
export function groupBoundaryExtras(groups: readonly GroupRec[], screens: readonly CellScreen[], base: BaseGrid): BoundaryExtras {
    const owner = new Map<string, string>();
    for (const g of groups) for (const id of g.screenIds) if (!owner.has(id)) owner.set(id, g.id);
    const cellOf = new Map(screens.map((s) => [s.id, { col: s.col, row: s.row }]));
    const cellsOf = (id: string) => screens.filter((s) => owner.get(s.id) === id).map((s) => ({ col: s.col, row: s.row }));
    const boundary = groups.map((g) => ({ id: g.id, ...(g.parentId ? { parentId: g.parentId } : {}), cells: cellsOf(g.id) }));
    const ungrouped = screens.filter((s) => !owner.has(s.id)).map((s) => cellOf.get(s.id) as { col: number; row: number });
    if (!boundary.some((b) => b.cells.length)) return { colExtra: [], rowExtra: [] };
    const colGap = base.colWidth - base.screenW;
    const rowGap = base.rowHeight - base.screenH;
    const cols = boundaryExtras({ groups: boundary, ungrouped, base, laneBand: colGap });
    const rows = boundaryExtras({ groups: boundary, ungrouped, base, laneBand: Math.max(0, rowGap - ROUTE_TOP) });
    return { colExtra: cols.colExtra, rowExtra: rows.rowExtra };
}

export const sameExtras = (a: ExtrasInput | undefined, b: ExtrasInput | undefined): boolean => {
    const [x, y] = [cleanExtras(a), cleanExtras(b)];
    return x.length === y.length && x.every((b, i) => b.at === y[i]?.at && b.from === y[i]?.from && b.to === y[i]?.to && b.px === y[i]?.px);
};

/**
 * One move (cell to the same cell) for every screen whose position changes when the board's extras change: only screens
 * at or after a changed boundary AND inside its band. `applyMoves` shifts it by the difference between its new cell rect and where it is.
 */
export function extrasMoves(
    screens: readonly CellScreen[],
    meta: BaseGrid & { colExtra?: ExtrasInput; rowExtra?: ExtrasInput },
    next: { colExtra: ExtrasInput; rowExtra: ExtrasInput },
): Move[] {
    return screens
        .filter(
            (s) =>
                trackStart(s.col, meta.colWidth, meta.colExtra, s.row) !== trackStart(s.col, meta.colWidth, next.colExtra, s.row) ||
                trackStart(s.row, meta.rowHeight, meta.rowExtra, s.col) !== trackStart(s.row, meta.rowHeight, next.rowExtra, s.col),
        )
        .map((s) => ({ id: s.id, from: { col: s.col, row: s.row }, to: { col: s.col, row: s.row } }));
}

/**
 * Where the group layer goes among the page's children so it sits just above the board background (below every screen).
 * `childIds` are the siblings in z-order, bottom first; the holder itself may be among them. The result is its final index.
 */
export function holderIndex(childIds: readonly string[], boardId: string, holderId: string | null): number {
    const rest = childIds.filter((id) => id !== holderId);
    const at = rest.indexOf(boardId);
    return at === -1 ? rest.length : at + 1;
}

/** `#RRGGBB` as 0-1 channels. Anything else reads as white. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return { r: 1, g: 1, b: 1 };
    const n = parseInt(m[1] as string, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export const holderName = (boardName: string): string => `Flow groups · ${boardName}`;
export const rectName = (name: string): string => `Group · ${name}`;
export const titleName = (name: string): string => `Group title · ${name}`;
