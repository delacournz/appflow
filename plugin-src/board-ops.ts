import { assignScreenTexts } from './adopt';
import { growBounds } from './duplicate-plan';
import { collectScreens, collectTexts, groupIdOf, readMeta, rectOf, sceneById, type Board } from './flow';
import { BOARD_KEY, FLOW_NAMESPACE, SCREEN_KEY, parseScreenMeta, type ScreenMeta } from './flowmeta';
import type { JsonObject } from '../shared/protocol';
import { boardBounds, cellOf, cellRect, staleReason, type ExtrasPair, type Move } from './grid';
import type { Rect } from './rect';
import { badgeBelongsTo, shiftTargets } from './screen-group';

/** Board plumbing shared by the grid tools and the flow group refit. Kept apart from both so neither imports the other. */

export type Screen = { node: FrameNode; meta: ScreenMeta };
export type StaleFix = { id: string; name: string; reason: string; fixedTo: { col: number; row: number } };

export const writeScreen = (node: SceneNode, meta: ScreenMeta): void => node.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(meta));

/**
 * The screens of a board. Duplicating a frame in Figma copies its plugin data, so a screen's meta is trusted only
 * when its label text sits at the frame's x and its cell matches its position. Anything else is re-derived from the
 * frame's position and the texts above it, written back, and reported.
 */
export async function loadScreens(board: Board): Promise<{ screens: Screen[]; stale: StaleFix[] }> {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return { screens: [], stale: [] };
    const texts = collectTexts(parent.children).map((t) => ({ id: t.id, name: t.name, rect: rectOf(t) }));
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
        const reason = staleReason(board.meta, stored, rect, anchor ? rectOf(anchor) : null, anchorId !== null);
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
        const cell = cellOf(rect, board.meta);
        const meta: ScreenMeta = { ...stored, ...cell, ...assignScreenTexts(rect, texts), groupId, ...(await ownBadge(stored, groupId, rect)) };
        writeScreen(c, meta);
        stale.push({ id: c.id, name: c.name, reason, fixedTo: cell });
        screens.push({ node: c, meta });
    }
    return { screens, stale };
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

export async function applyMoves(board: Board, screens: Screen[], moves: Move[]): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const m of moves) {
        const s = screens.find((x) => x.node.id === m.id);
        if (!s) continue;
        const want = cellRect(board.meta, m.to.col, m.to.row);
        const have = rectOf(s.node);
        const dx = want.x - have.x;
        const dy = want.y - have.y;
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
        s.meta = { ...s.meta, col: m.to.col, row: m.to.row };
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
    const b = boardBounds(board.meta, screens.map((s) => s.meta));
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

