import type { JsonObject } from '../shared/protocol';
import { loadScreens } from './board-ops';
import { listArrows, rectOf, sceneById, type Board } from './flow';
import type { ConflictContent, ConflictGroup } from './flow-group';
import { footprintOf, loadGroups } from './flow-groups';
import { lintGroups } from './group-lint';

/** The group part of lint_flow_layout for one board: reads the drawn boxes (never repaints) and checks them against the board's content. */
export async function boardLayoutLint(board: Board): Promise<{ boardId: string; issues: JsonObject[]; counts: Record<string, number> } | null> {
    const loaded = (await loadGroups(board)).filter((g) => g.rect.visible);
    if (!loaded.length) return null;
    const { screens } = await loadScreens(board);
    const contents: ConflictContent[] = [];
    for (const s of screens) {
        const p = await footprintOf(s);
        contents.push({ kind: 'screen', id: s.node.id, rect: p.frame, ...(s.meta.flowGroupId ? { ownerGroupId: s.meta.flowGroupId } : {}) });
        if (p.route && s.meta.routeId) contents.push({ kind: 'route', id: s.meta.routeId, rect: p.route });
        if (p.badge && s.meta.badgeId) contents.push({ kind: 'badge', id: s.meta.badgeId, rect: p.badge });
    }
    for (const a of listArrows(board)) {
        const label = await sceneById(a.meta.labelId);
        if (label) contents.push({ kind: 'label', id: a.meta.labelId, rect: rectOf(label) });
    }
    const groups: ConflictGroup[] = loaded.map((g) => {
        const box = rectOf(g.rect);
        return { id: g.id, ...(g.meta.parentId ? { parentId: g.meta.parentId } : {}), box, title: g.title ? rectOf(g.title) : { x: box.x, y: box.y, width: 0, height: 0 } };
    });
    const r = lintGroups(groups, contents);
    return { boardId: board.node.id, issues: r.issues as unknown as JsonObject[], counts: r.counts };
}

