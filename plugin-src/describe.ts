import type { JsonObject } from '../shared/protocol';
import { renderBoard, type BoardArrow, type BoardDescription, type BoardGroup, type BoardScreen } from './board-text';
import { collectScreens, loadBoard, readMeta, rectOf, sceneById, type Board } from './flow';
import { loadGroups } from './flow-groups';
import { ARROW_KEY, BOARD_KEY, SCREEN_KEY, parseArrowMeta, parseBoardMeta, parseScreenMeta } from './flowmeta';
import { findOrphans } from './board-missing';
import { GROUP_LAYER_KEY, FLOW_NAMESPACE } from './flowmeta';
import { buildStatusOf } from './screen-status';
import { fail, num, ok, str, type Handler } from './types';

const DEFAULT_WIDTH = 16;

async function screensOf(board: Board): Promise<BoardScreen[]> {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return [];
    const out: BoardScreen[] = [];
    for (const { frame: c } of collectScreens(parent.children)) {
        const meta = readMeta(c, SCREEN_KEY, parseScreenMeta);
        if (!meta || meta.boardId !== board.node.id) continue;
        const [label, route, badge] = await Promise.all([
            meta.labelId ? sceneById(meta.labelId) : null,
            meta.routeId ? sceneById(meta.routeId) : null,
            meta.badgeId ? sceneById(meta.badgeId) : null,
        ]);
        const r = rectOf(c);
        const build = buildStatusOf(meta.build);
        out.push({
            id: c.id,
            name: c.name,
            col: meta.col,
            row: meta.row,
            x: r.x,
            y: r.y,
            labelX: label ? rectOf(label).x : null,
            status: build.status,
            route: route?.type === 'TEXT' ? route.characters.trim() || null : null,
            verifiedAt: build.status === 'not-built' ? null : build.verifiedAt,
            hasBadge: !!badge,
            flowGroupId: meta.flowGroupId ?? null,
            ...(board.meta.spacing === 'grouped' ? { layoutId: meta.flowGroupId ?? 'board' } : {}),
        });
    }
    return out;
}

async function arrowsOf(board: Board): Promise<BoardArrow[]> {
    const out: BoardArrow[] = [];
    for (const g of board.arrows.children) {
        if (g.type !== 'GROUP') continue;
        const meta = readMeta(g, ARROW_KEY, parseArrowMeta);
        if (!meta || meta.boardId !== board.node.id) continue;
        const trigger = meta.trigger ? await sceneById(meta.trigger) : null;
        out.push({ from: meta.from, to: meta.to, label: meta.label, mode: meta.mode, triggerName: trigger?.name ?? null, exit: meta.exit });
    }
    return out;
}

async function groupsOf(board: Board): Promise<BoardGroup[]> {
    return (await loadGroups(board)).map((g) => ({
        id: g.id,
        name: g.meta.name,
        ...(g.meta.parentId ? { parentId: g.meta.parentId } : {}),
        screenIds: g.meta.screenIds,
        box: rectOf(g.rect),
        visible: g.rect.visible,
    }));
}

async function describeOne(board: Board, width: number): Promise<BoardDescription> {
    const [screens, arrows, groups] = await Promise.all([screensOf(board), arrowsOf(board), groupsOf(board)]);
    const layouts =
        board.meta.spacing === 'grouped'
            ? [
                  { id: 'board', name: 'Board', originX: board.meta.originX, originY: board.meta.originY },
                  ...(await loadGroups(board)).flatMap((g) => (g.meta.layout ? [{ id: g.id, name: g.meta.name, originX: g.meta.layout.originX, originY: g.meta.layout.originY }] : [])),
              ]
            : undefined;
    return renderBoard({ boardId: board.node.id, name: board.node.name, meta: board.meta, screens, arrows, groups, ...(layouts ? { layouts } : {}) }, width);
}

/** Boards that screens and group holders on this page still point at, whose background is gone. */
async function missingBoards() {
    const screenBoards: string[] = [];
    for (const { frame } of collectScreens(figma.currentPage.children)) {
        const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
        if (meta) screenBoards.push(meta.boardId);
    }
    const groupBoards: string[] = [];
    for (const n of figma.currentPage.children) {
        const board = n.type === 'FRAME' ? n.getSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY) : '';
        if (board && n.type === 'FRAME') groupBoards.push(...n.children.filter((c) => c.type === 'RECTANGLE').map(() => board));
    }
    const existing = new Set<string>();
    for (const bid of new Set([...screenBoards, ...groupBoards])) if (await sceneById(bid)) existing.add(bid);
    return findOrphans(screenBoards, groupBoards, existing);
}

export const describeBoard: Handler = async (args: JsonObject) => {
    const width = num(args, 'width') ?? DEFAULT_WIDTH;
    const id = str(args, 'boardId');
    const boards: Board[] = [];
    if (id) {
        boards.push(await loadBoard(id));
    } else {
        for (const n of figma.currentPage.children) {
            if (readMeta(n, BOARD_KEY, parseBoardMeta)) boards.push(await loadBoard(n.id));
        }
    }
    const issues = id ? [] : await missingBoards();
    if (!boards.length) {
        if (issues.length) return ok({ boards: [], issues: issues as unknown as JsonObject[] });
        return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    }
    const described = await Promise.all(boards.map((b) => describeOne(b, width)));
    return ok({ boards: described as unknown as JsonObject[], ...(issues.length ? { issues: issues as unknown as JsonObject[] } : {}) });
};
