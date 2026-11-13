/**
 * repair_board: rebuilds a deleted board background. Screens, arrows, flow groups and the group holder still carry the old
 * board id, so a new background is drawn under them, given a uniform grid inferred from the screens, and everything is relinked
 * to the new node id. The usual settle (reroute_flow) then lays the board out again.
 */

import type { JsonObject } from '../shared/protocol';
import { findOrphans } from './board-missing';
import { inferRepairGrid, type RepairGrid } from './board-repair';
import { collectScreens, readMeta, rectOf, rerouteBoards, sceneById, type Board } from './flow';
import { ARROW_KEY, BOARD_KEY, FLOW_NAMESPACE, GROUP_KEY, GROUP_LAYER_KEY, SCREEN_KEY, parseArrowMeta, parseBoardMeta, parseGroupMeta, parseScreenMeta, type BoardMeta } from './flowmeta';
import { boardBounds } from './grid';
import { DARK_FILL, DEFAULT_ARROW_STYLE, findStyleBoard } from './gridtools';
import { bool, fail, ok, str, type Handler } from './types';

type Orphans = {
    screens: FrameNode[];
    holder: FrameNode | null;
    groupRects: SceneNode[];
    arrowGroups: SceneNode[];
    arrowsContainer: (SceneNode & ChildrenMixin) | null;
};

const norm = (id: string) => id.replace('-', ':');

function arrowGroupsIn(container: SceneNode & ChildrenMixin, boardId: string, depth = 0): SceneNode[] {
    const out: SceneNode[] = [];
    for (const c of container.children) {
        if (readMeta(c, ARROW_KEY, parseArrowMeta)?.boardId === boardId) out.push(c);
        else if ('children' in c && depth < 2) out.push(...arrowGroupsIn(c, boardId, depth + 1));
    }
    return out;
}

function findOrphanParts(boardId: string): Orphans {
    const page = figma.currentPage;
    const screens = collectScreens(page.children)
        .map((s) => s.frame)
        .filter((f) => readMeta(f, SCREEN_KEY, parseScreenMeta)?.boardId === boardId);
    const holder = page.children.find((c): c is FrameNode => c.type === 'FRAME' && c.getSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY) === boardId) ?? null;
    const groupRects = holder ? holder.children.filter((c) => readMeta(c, GROUP_KEY, parseGroupMeta)?.boardId === boardId) : [];
    let arrowsContainer: (SceneNode & ChildrenMixin) | null = null;
    let arrowGroups: SceneNode[] = [];
    for (const c of page.children) {
        if (!('children' in c) || !c.name.startsWith('Flow arrows')) continue;
        const found = arrowGroupsIn(c, boardId);
        if (found.length > arrowGroups.length) [arrowsContainer, arrowGroups] = [c, found];
    }
    return { screens, holder, groupRects, arrowGroups, arrowsContainer };
}

async function missingBoardIds(): Promise<string[]> {
    const ids = collectScreens(figma.currentPage.children).flatMap((s) => {
        const m = readMeta(s.frame, SCREEN_KEY, parseScreenMeta);
        return m ? [m.boardId] : [];
    });
    const existing = new Set<string>();
    for (const id of new Set(ids)) if (await sceneById(id)) existing.add(id);
    return findOrphans(ids, [], existing).map((o) => o.boardId);
}

function rewrite<T extends { boardId: string }>(node: BaseNode, key: string, parse: (raw: string) => T | null, boardId: string): void {
    const meta = readMeta(node, key, parse);
    if (meta) node.setSharedPluginData(FLOW_NAMESPACE, key, JSON.stringify({ ...meta, boardId }));
}

export const repairBoard: Handler = async (args) => {
    const asked = str(args, 'boardId');
    const dryRun = bool(args, 'dryRun', false);
    const missing = await missingBoardIds();
    const oldId = asked ? norm(asked) : missing.length === 1 ? (missing[0] as string) : null;
    if (!oldId) return fail(missing.length ? `Several boards are missing (${missing.join(', ')}). Pass boardId.` : 'No board on this page is missing its background.');
    if (await sceneById(oldId)) return fail(`Board ${oldId} still exists; nothing to repair.`);

    const parts = findOrphanParts(oldId);
    if (!parts.screens.length) return fail(`No screens on this page point at board ${oldId}.`);
    if (!parts.arrowsContainer) return fail(`No "Flow arrows" container holds arrows of board ${oldId}.`);

    const backupRaw = parts.holder?.getSharedPluginData(FLOW_NAMESPACE, 'board-backup') ?? '';
    const backup = backupRaw ? (JSON.parse(backupRaw) as { meta?: unknown; name?: string }) : null;
    const backupMeta = backup?.meta ? parseBoardMeta(JSON.stringify(backup.meta)) : null;
    const grid: RepairGrid = inferRepairGrid(
        parts.screens.flatMap((f) => {
            const m = readMeta(f, SCREEN_KEY, parseScreenMeta);
            const r = rectOf(f);
            return m ? [{ col: m.col, row: m.row, x: r.x, y: r.y, width: f.width, height: f.height }] : [];
        }),
    );
    const style = await findStyleBoard();
    const meta: BoardMeta = backupMeta
        ? { ...backupMeta, arrowsGroupId: parts.arrowsContainer.id }
        : {
              v: 1,
              kind: 'board',
              ...grid,
              spacing: 'uniform',
              baseColWidth: grid.colWidth,
              baseRowHeight: grid.rowHeight,
              labelOffset: style?.meta.labelOffset ?? 80,
              margin: style?.meta.margin ?? 80,
              headingId: null,
              arrowsGroupId: parts.arrowsContainer.id,
              arrowStyle: style?.meta.arrowStyle ?? DEFAULT_ARROW_STYLE,
          };
    const name = backup?.name ?? (parts.holder ? `Board background · ${parts.holder.name.replace(/^Flow groups\s*·\s*/, '')}` : 'Board background · repaired');
    const summary: JsonObject = {
        missingBoardId: oldId,
        name,
        fromBackup: !!backupMeta,
        grid: { originX: meta.originX, originY: meta.originY, colWidth: meta.colWidth, rowHeight: meta.rowHeight, screenW: meta.screenW, screenH: meta.screenH },
        screens: parts.screens.length,
        arrows: parts.arrowGroups.length,
        groups: parts.groupRects.length,
        holder: parts.holder?.id ?? null,
        arrowsContainer: parts.arrowsContainer.id,
    };
    if (dryRun) return ok({ dryRun, ...summary });

    const page = figma.currentPage;
    const bg = figma.createRectangle();
    const styleBg = style?.node;
    bg.fills = styleBg && 'fills' in styleBg && styleBg.fills !== figma.mixed ? styleBg.fills : [DARK_FILL];
    const lowest = Math.min(...[...parts.screens, parts.arrowsContainer, ...(parts.holder ? [parts.holder] : [])].map((n) => {
        let top: BaseNode = n;
        while (top.parent && top.parent.type !== 'PAGE') top = top.parent;
        return page.children.indexOf(top as SceneNode);
    }).filter((i) => i >= 0));
    page.insertChild(Number.isFinite(lowest) ? lowest : 0, bg);
    bg.name = name;
    const cells = parts.screens.flatMap((f) => {
        const m = readMeta(f, SCREEN_KEY, parseScreenMeta);
        return m ? [{ col: m.col, row: m.row }] : [];
    });
    const b = boardBounds(meta, cells);
    bg.x = b.x;
    bg.y = b.y;
    bg.resize(b.width, b.height);
    bg.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(meta));
    bg.locked = true;

    for (const f of parts.screens) rewrite(f, SCREEN_KEY, parseScreenMeta, bg.id);
    for (const a of parts.arrowGroups) rewrite(a, ARROW_KEY, parseArrowMeta, bg.id);
    for (const g of parts.groupRects) rewrite(g, GROUP_KEY, parseGroupMeta, bg.id);
    if (parts.holder) parts.holder.setSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY, bg.id);

    const board: Board = { node: bg, meta, arrows: parts.arrowsContainer };
    const settled = await rerouteBoards([board]);
    return ok({ boardId: bg.id, ...summary, settled });
};
