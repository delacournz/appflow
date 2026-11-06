import { boardsFor, collectScreens, raiseArrows, readMeta, sceneById, type Board } from './flow';
import { FLOW_NAMESPACE, SCREEN_KEY, parseScreenMeta, type ScreenMeta } from './flowmeta';
import { planGrouping, upgradeScreenMeta } from './screen-group';
import { bool, fail, ok, type Handler } from './types';
import type { JsonObject } from '../shared/protocol';

type Detail = { frameId: string; name: string; status: 'grouped' | 'already' | 'skipped'; groupId: string | null; reason?: string };

/**
 * Groups one adopted screen's frame, label, route and badge into a `Screen · {name}` group and records the group id.
 * Grouping also hides the frame title Figma draws above a top-level frame, so the label text is the only name shown.
 */
export async function groupScreen(frame: FrameNode, meta: ScreenMeta, dryRun = false): Promise<Detail & { missingLabel: boolean }> {
    const [label, route, badge] = await Promise.all([
        meta.labelId ? sceneById(meta.labelId) : null,
        meta.routeId ? sceneById(meta.routeId) : null,
        meta.badgeId ? sceneById(meta.badgeId) : null,
    ]);
    const base = { frameId: frame.id, name: frame.name, missingLabel: !label };
    const holder = frame.parent;
    if (!holder || !('children' in holder)) {
        return { ...base, status: 'skipped', groupId: null, reason: `${frame.name} sits in a ${(frame.parent as BaseNode | null)?.type ?? 'missing'} parent that cannot hold a group.` };
    }
    const plan = planGrouping({
        frameId: frame.id,
        frameName: frame.name,
        labelId: label?.id ?? null,
        routeId: route?.id ?? null,
        badgeId: badge?.id ?? null,
        parent: { id: holder.id, type: holder.type, name: 'name' in holder ? holder.name : '', childIds: holder.children.map((k) => k.id) },
    });
    if (plan.kind === 'conflict') return { ...base, status: 'skipped', groupId: null, reason: plan.reason };
    if (plan.kind === 'already') {
        if (!dryRun && meta.groupId !== plan.groupId) frame.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(upgradeScreenMeta(meta, plan.groupId)));
        return { ...base, status: 'already', groupId: plan.groupId };
    }
    if (dryRun) return { ...base, status: 'grouped', groupId: null };
    const nodes = plan.memberIds.map((id) => [frame, label, route, badge].find((n) => n?.id === id)).filter((n): n is SceneNode => !!n);
    const group = figma.group(nodes, holder as BaseNode & ChildrenMixin);
    group.name = plan.name;
    for (const n of nodes) group.appendChild(n);
    holder.insertChild(plan.index, group);
    frame.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(upgradeScreenMeta(meta, group.id)));
    return { ...base, status: 'grouped', groupId: group.id };
}

async function groupBoard(board: Board, dryRun: boolean, missingLabel: string[]): Promise<Detail[]> {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return [];
    const out: Detail[] = [];
    for (const { frame } of collectScreens(parent.children)) {
        const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
        if (!meta || meta.boardId !== board.node.id) continue;
        const { missingLabel: noLabel, ...detail } = await groupScreen(frame, meta, dryRun);
        if (noLabel) missingLabel.push(frame.id);
        out.push(detail);
    }
    if (!dryRun) raiseArrows(board);
    return out;
}

export const groupScreens: Handler = async (args) => {
    const dryRun = bool(args, 'dryRun', false);
    const boards = await boardsFor(args);
    if (!boards.length) return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    const missingLabel: string[] = [];
    const details: Detail[] = [];
    for (const b of boards) details.push(...(await groupBoard(b, dryRun, missingLabel)));
    return ok({
        dryRun,
        boards: boards.map((b) => b.node.id),
        grouped: details.filter((d) => d.status === 'grouped').length,
        skipped: details.filter((d) => d.status !== 'grouped').length,
        missingLabel,
        details: details as unknown as JsonObject[],
    });
};
