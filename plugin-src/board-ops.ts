import { assignScreenTexts } from './adopt';
import { badgeSnap, linkBadges } from './badge-link';
import { growBounds } from './duplicate-plan';
import { collectBadges, collectScreens, collectTexts, groupIdOf, readMeta, rectOf, sceneById, type Board } from './flow';
import { BOARD_KEY, FLOW_NAMESPACE, GROUP_KEY, GROUP_LAYER_KEY, SCREEN_KEY, parseGroupMeta, parseScreenMeta, type ScreenMeta } from './flowmeta';
import type { JsonObject } from '../shared/protocol';
import { boardBounds, cellOf, cellRect, staleReason, type ExtrasPair, type GridMeta, type Move } from './grid';
import { boundsOfRects } from './grid-plan';
import { BOARD_GRID, cellOfIn, cellRectIn, gridOfScreen, type LayoutGrid } from './layout-grid';
import type { Rect } from './rect';
import { checkPitch, uniformFields, type Pitch, type Spacing } from './pitch';
import { badgeBelongsTo, badgeFallbackOffset, shiftTargets } from './screen-group';

/** Board plumbing shared by the grid tools and the flow group refit. Kept apart from both so neither imports the other. */

export type Screen = { node: FrameNode; meta: ScreenMeta };
export type StaleFix = { id: string; name: string; reason: string; fixedTo: { col: number; row: number } };

export const writeScreen = (node: SceneNode, meta: ScreenMeta): void => node.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(meta));

/**
 * Before any cell is re-derived from a position: checks the board's stored pitch against where its screens sit
 * (`checkPitch`). A uniform board whose pitch is wrong is repaired from the positions (the meta is rewritten, no screen
 * moves); anything else that does not match throws a `pitch-mismatch` error, because re-deriving cells from positions at
 * the wrong pitch stacks screens in the same cell.
 */
function guardPitch(board: Board, entries: { frame: FrameNode }[]): { from: Pitch; to: Pitch } | null {
    const screens = entries.flatMap((e) => {
        const stored = readMeta(e.frame, SCREEN_KEY, parseScreenMeta);
        if (!stored || stored.boardId !== board.node.id) return [];
        const r = rectOf(e.frame);
        return [{ col: stored.col, row: stored.row, x: r.x, y: r.y }];
    });
    const verdict = checkPitch(board.meta, screens);
    if (verdict.kind === 'ok') return null;
    if (verdict.kind === 'refuse') throw new Error(verdict.reason);
    const from = { colWidth: board.meta.colWidth, rowHeight: board.meta.rowHeight };
    const base = board.meta.baseColWidth !== undefined && board.meta.baseRowHeight !== undefined && board.meta.baseColWidth <= verdict.pitch.colWidth && board.meta.baseRowHeight <= verdict.pitch.rowHeight;
    const { baseColWidth: _bc, baseRowHeight: _br, ...rest } = board.meta;
    board.meta = { ...(base ? board.meta : rest), colWidth: verdict.pitch.colWidth, rowHeight: verdict.pitch.rowHeight };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
    return { from, to: verdict.pitch };
}

export type GroupLayout = { id: string; layout?: { originX: number; originY: number } };
/** Resolves a layout id (`board` or a group id) to its grid. */
export type GridLookup = (layoutId: string) => LayoutGrid;

export const isGrouped = (board: Board): boolean => board.meta.spacing === 'grouped';

/** The layout origin stored on each flow group of the board. Read straight from the group rectangles. */
export function readGroupLayouts(board: Board): GroupLayout[] {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return [];
    const holder = parent.children.find((c) => c.type === 'FRAME' && c.getSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY) === board.node.id);
    if (!holder || !('children' in holder)) return [];
    const out: GroupLayout[] = [];
    for (const c of holder.children) {
        if (c.type !== 'RECTANGLE') continue;
        const meta = parseGroupMeta(c.getSharedPluginData(FLOW_NAMESPACE, GROUP_KEY));
        if (meta && meta.boardId === board.node.id) out.push({ id: c.id, ...(meta.layout ? { layout: meta.layout } : {}) });
    }
    return out;
}

export const gridLookup = (board: Board, layouts: readonly GroupLayout[]): GridLookup => (layoutId) => gridOfScreen({ id: '', layoutId }, layouts, board.meta);

/** The layout a screen belongs to on a grouped board: its flow group, else the board grid. */
export const layoutOfScreen = (meta: ScreenMeta): string => meta.flowGroupId ?? BOARD_GRID;

/** A grid as the `GridMeta` the cell maths (`cellOf`, `staleReason`) expects: no extras, the grid's own origin and pitch. */
export const gridMetaOf = (meta: GridMeta, grid: LayoutGrid): GridMeta => {
    const { colExtra: _c, rowExtra: _r, ...rest } = meta;
    return { ...rest, originX: grid.originX, originY: grid.originY, colWidth: grid.colWidth, rowHeight: grid.rowHeight };
};

/**
 * The screens of a board. Duplicating a frame in Figma copies its plugin data, so a screen's meta is trusted only
 * when its label text sits at the frame's x and its cell matches its position. Anything else is re-derived from the
 * frame's position and the texts above it, written back, and reported.
 */
export async function loadScreens(board: Board): Promise<{ screens: Screen[]; stale: StaleFix[]; pitchRepaired?: { from: Pitch; to: Pitch } }> {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return { screens: [], stale: [] };
    const pitchRepaired = guardPitch(board, collectScreens(parent.children));
    const texts = collectTexts(parent.children).map((t) => ({ id: t.id, name: t.name, rect: rectOf(t) }));
    const grouped = isGrouped(board);
    const layouts = grouped ? readGroupLayouts(board) : [];
    const lookup = gridLookup(board, layouts);
    const hasGrid = (stored: ScreenMeta): boolean => !stored.flowGroupId || layouts.some((g) => g.id === stored.flowGroupId && !!g.layout);
    const screens: Screen[] = [];
    const stale: StaleFix[] = [];
    for (const entry of collectScreens(parent.children)) {
        const c = entry.frame;
        const stored = readMeta(c, SCREEN_KEY, parseScreenMeta);
        if (!stored || stored.boardId !== board.node.id) continue;
        const groupId = groupIdOf(entry);
        const anchorId = stored.labelId ?? stored.routeId;
        const anchor = anchorId ? await sceneById(anchorId) : null;
        const rect = rectOf(c);
        const grid = grouped && hasGrid(stored) ? lookup(layoutOfScreen({ ...stored, flowGroupId: stored.flowGroupId ?? null })) : null;
        const against: GridMeta = !grouped ? board.meta : grid ? gridMetaOf(board.meta, grid) : gridMetaOf(board.meta, { id: BOARD_GRID, originX: rect.x - stored.col * board.meta.colWidth, originY: rect.y - stored.row * board.meta.rowHeight, colWidth: board.meta.colWidth, rowHeight: board.meta.rowHeight });
        const reason = staleReason(against, stored, rect, anchor ? rectOf(anchor) : null, anchorId !== null);
        if (!reason) {
            if ((stored.groupId ?? null) === groupId) {
                screens.push({ node: c, meta: stored });
            } else {
                const meta: ScreenMeta = { ...stored, groupId };
                writeScreen(c, meta);
                screens.push({ node: c, meta });
            }
            continue;
        }
        const cell = grouped && grid ? cellOfIn(grid, rect) : cellOf(rect, board.meta);
        const meta: ScreenMeta = { ...stored, ...cell, ...assignScreenTexts(rect, texts), groupId, ...(await ownBadge(stored, groupId, rect)) };
        writeScreen(c, meta);
        stale.push({ id: c.id, name: c.name, reason, fixedTo: cell });
        screens.push({ node: c, meta });
    }
    await healBadges(screens, collectBadges(parent.children));
    return { screens, stale, ...(pitchRepaired ? { pitchRepaired } : {}) };
}

/**
 * Links screens that lost their badge id (adopt never stored it, or a copy dropped it) to the `Badge · {name}` pill with
 * the screen's exact name, falling back to a pill sitting in the screen's own slot. Writes the repaired meta back.
 */
async function healBadges(screens: Screen[], badgeNodes: readonly GroupNode[]): Promise<void> {
    if (!badgeNodes.length) return;
    const missing: Screen[] = [];
    const claimed = new Set<string>();
    for (const s of screens) {
        const live = s.meta.badgeId ? await sceneById(s.meta.badgeId) : null;
        if (live) claimed.add(live.id);
        else missing.push(s);
    }
    if (!missing.length) return;
    const links = linkBadges(
        missing.map((s) => ({ id: s.node.id, name: s.node.name, rect: rectOf(s.node) })),
        badgeNodes.map((n) => ({ id: n.id, name: n.name, rect: rectOf(n) })),
        claimed,
    );
    for (const s of missing) {
        const badgeId = links.get(s.node.id);
        if (!badgeId) continue;
        s.meta = { ...s.meta, badgeId };
        writeScreen(s.node, s.meta);
    }
}

/**
 * Puts every screen's badge back in its slot: right edge flush with the frame, centred on the text line above it. Badges that
 * were left behind when a screen shifted snap back. Only moves badges more than half a pixel out. Returns how many moved.
 */
export async function snapBadges(screens: readonly Screen[]): Promise<number> {
    let moved = 0;
    for (const s of screens) {
        const badge = s.meta.badgeId ? await sceneById(s.meta.badgeId) : null;
        if (!badge || !('width' in badge)) continue;
        const frame = rectOf(s.node);
        const [label, route] = await Promise.all([s.meta.labelId ? sceneById(s.meta.labelId) : null, s.meta.routeId ? sceneById(s.meta.routeId) : null]);
        const lines = [label, route].flatMap((n) => (n ? [rectOf(n)] : []));
        const delta = badgeSnap(frame, lines, rectOf(badge), badgeFallbackOffset(badge.height));
        if (!delta) continue;
        shiftNode(badge, delta.dx, delta.dy);
        moved++;
    }
    return moved;
}

/**
 * A hand copy of a screen keeps the original's badge id and build status. Keep them only when the badge is this
 * screen's own: inside its group, or (ungrouped) sitting flush with the frame's right edge just above it. Otherwise
 * the copy reads as not built with no badge.
 */
async function ownBadge(stored: ScreenMeta, groupId: string | null, frame: Rect): Promise<Pick<ScreenMeta, 'badgeId' | 'build'>> {
    const badge = stored.badgeId ? await sceneById(stored.badgeId) : null;
    const own = badge && (groupId ? badge.parent?.id === groupId : badgeBelongsTo(frame, rectOf(badge)));
    if (own) return { badgeId: stored.badgeId ?? null, build: stored.build };
    return { badgeId: null, build: { status: 'not-built' } };
}

export const cellsOf = (screens: Screen[]) => screens.map((s) => ({ id: s.node.id, col: s.meta.col, row: s.meta.row }));

function shiftNode(node: SceneNode | null, dx: number, dy: number): void {
    if (!node || !('x' in node)) return;
    node.x += dx;
    node.y += dy;
}

/** Shifts a screen's frame, label, route and badge by the same delta, and snaps the badge back into its slot. */
export async function shiftScreen(s: Screen, dx: number, dy: number): Promise<void> {
    if (dx === 0 && dy === 0) return;
    const [label, route, badge] = await Promise.all([
        s.meta.labelId ? sceneById(s.meta.labelId) : null,
        s.meta.routeId ? sceneById(s.meta.routeId) : null,
        s.meta.badgeId ? sceneById(s.meta.badgeId) : null,
    ]);
    const targets = shiftTargets({
        frameId: s.node.id,
        groupId: s.meta.groupId,
        frameParentId: s.node.parent?.id ?? null,
        labelId: label?.id ?? null,
        labelParentId: label?.parent?.id ?? null,
        routeId: route?.id ?? null,
        routeParentId: route?.parent?.id ?? null,
        badgeId: badge?.id ?? null,
        badgeParentId: badge?.parent?.id ?? null,
    });
    for (const id of targets) shiftNode(await sceneById(id), dx, dy);
    await snapBadges([s]);
}

/**
 * Moves screens to the cells in `moves`. A move whose target names a layout (`to.layoutId`) lands on that grid via `grids`;
 * any other cell is on the board's single shared grid. The screen's `layoutId` follows the move.
 */
export async function applyMoves(board: Board, screens: Screen[], moves: Move[], grids?: GridLookup): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const m of moves) {
        const s = screens.find((x) => x.node.id === m.id);
        if (!s) continue;
        const want = m.to.layoutId !== undefined && grids ? cellRectIn(grids(m.to.layoutId), m.to.col, m.to.row, { width: board.meta.screenW, height: board.meta.screenH }) : cellRect(board.meta, m.to.col, m.to.row);
        const have = rectOf(s.node);
        await shiftScreen(s, want.x - have.x, want.y - have.y);
        s.meta = { ...s.meta, col: m.to.col, row: m.to.row, ...(m.to.layoutId !== undefined ? { layoutId: m.to.layoutId } : {}) };
        writeScreen(s.node, s.meta);
        out.push({ id: s.node.id, name: s.node.name, from: { ...m.from }, to: { ...m.to } });
    }
    return out;
}

/**
 * Resizes the board background to hold its screens. Growth only, unless `shrink` (compact) wants it tight. `extent` is the
 * union of the flow-group boxes and titles: the background always grows (up and left too) to hold it plus the board margin,
 * and the board heading moves with the top-left corner so it stays above the topmost title.
 */
export async function resizeBoard(board: Board, screens: Screen[], shrink: boolean, extent: Rect | null = null): Promise<{ width: number; height: number }> {
    const bg = board.node;
    const rect = rectOf(bg);
    if (!('resize' in bg)) return { width: rect.width, height: rect.height };
    const b = isGrouped(board) ? boundsOfRects(board.meta, screens.map((s) => rectOf(s.node))) : boardBounds(board.meta, screens.map((s) => s.meta));
    const needW = b.x + b.width - rect.x;
    const needH = b.y + b.height - rect.y;
    const width = Math.max(1, shrink ? needW : Math.max(rect.width, needW));
    const height = Math.max(1, shrink ? needH : Math.max(rect.height, needH));
    if (Math.abs(width - rect.width) > 0.5 || Math.abs(height - rect.height) > 0.5) bg.resize(width, height);
    if (!extent) return { width, height };
    const have = rectOf(bg);
    const grown = growBounds(have, [extent], board.meta.margin);
    const [dx, dy] = [grown.x - have.x, grown.y - have.y];
    if (dx !== 0 || dy !== 0) {
        bg.x += dx;
        bg.y += dy;
        const heading = board.meta.headingId ? await sceneById(board.meta.headingId) : null;
        if (heading) shiftNode(heading, dx, dy);
    }
    if (Math.abs(grown.width - have.width) > 0.5 || Math.abs(grown.height - have.height) > 0.5) bg.resize(grown.width, grown.height);
    return { width: grown.width, height: grown.height };
}

/** Stores new column/row extras on the board (empty maps are dropped) so moves and bounds use them. */
export function applyExtras(board: Board, extras: ExtrasPair): void {
    const { colExtra: _c, rowExtra: _r, ...rest } = board.meta;
    board.meta = { ...rest, ...(extras.colExtra.length ? { colExtra: extras.colExtra } : {}), ...(extras.rowExtra.length ? { rowExtra: extras.rowExtra } : {}) };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
}


/** Stores the measured gap extras on the board (empty = cleared). */
export function setGapExtra(board: Board, gap: ExtrasPair | null): void {
    const { gapExtra: _drop, ...rest } = board.meta;
    board.meta = { ...rest, ...(gap && (gap.colExtra.length || gap.rowExtra.length) ? { gapExtra: gap } : {}) };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
}

/**
 * Switches the board to a pitch: uniform spacing stores the effective pitch with its base and drops every band; a board with
 * nothing to add (`keepBase` false) goes back to the plain base pitch with no stored base. Callers move the screens after.
 */
export function applyPitch(board: Board, base: Pitch, effective: Pitch, keepBase: boolean): void {
    const { colExtra: _c, rowExtra: _r, gapExtra: _g, baseColWidth: _bc, baseRowHeight: _br, ...rest } = board.meta;
    board.meta = keepBase
        ? { ...rest, ...uniformFields(base, effective) }
        : { ...rest, colWidth: base.colWidth, rowHeight: base.rowHeight, spacing: 'uniform' };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
}

/** Back to banded spacing: the base pitch is the pitch again and the stored base goes away. Extras are applied by the caller. */
export function applyBanded(board: Board): boolean {
    const { baseColWidth, baseRowHeight, ...rest } = board.meta;
    const had = baseColWidth !== undefined || baseRowHeight !== undefined || board.meta.spacing !== 'banded';
    board.meta = { ...rest, colWidth: baseColWidth ?? board.meta.colWidth, rowHeight: baseRowHeight ?? board.meta.rowHeight, spacing: 'banded' };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
    return had;
}

/** Sets the spacing mode on the board. The next refit converts the pitch, bands and screen positions. */
export function setSpacing(board: Board, mode: Spacing): void {
    board.meta = { ...board.meta, spacing: mode };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
}
