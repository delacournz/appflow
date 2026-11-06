import { fitRoute } from './anatomy';
import { ensureBadge } from './badge';
import { boardsFor, collectScreens, raiseArrows, readMeta, rectOf, sceneById, toLocal, type Board } from './flow';
import { FLOW_NAMESPACE, SCREEN_KEY, parseScreenMeta, type ScreenMeta } from './flowmeta';
import { planGrouping, planUngroup, routeSlot, upgradeScreenMeta } from './screen-group';
import { buildStatusOf } from './screen-status';
import { bool, fail, ok, type Handler } from './types';
import type { JsonObject } from '../shared/protocol';

type Detail = { frameId: string; name: string; status: 'grouped' | 'already' | 'skipped'; groupId: string | null; reason?: string };

/**
 * Groups one adopted screen's frame, label, route and badge into a `Screen · {name}` group and records the group id.
 * A grouped frame is no longer top-level, so it cannot be a prototype starting point or be played. Screens are
 * ungrouped by default (see `ungroupScreen`); this is for anyone who wants the group anyway.
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


type UngroupDetail = { frameId: string; name: string; status: 'ungrouped' | 'already' | 'skipped'; labelRemoved: boolean; reason?: string };

/** Moves a node to an absolute top-left, whatever its parent's own offset. */
function moveToAbs(node: SceneNode, at: { x: number; y: number }): void {
    const parent = node.parent;
    if (!parent) return;
    const local = toLocal(parent, at);
    node.x = local.x;
    node.y = local.y;
}

/**
 * Makes one adopted screen top-level: frame, route text and badge become loose siblings at the group's index (absolute
 * positions kept, group deleted by Figma once empty). The label text is deleted unless `keepLabels`. The route text
 * moves to y-72 and the badge is re-centred on it. Safe to run on an already ungrouped screen.
 */
export async function ungroupScreen(frame: FrameNode, stored: ScreenMeta, group: GroupNode | null, keepLabels: boolean, dryRun = false): Promise<UngroupDetail> {
    const plan = planUngroup({ inScreenGroup: !!group, labelId: stored.labelId, keepLabels });
    const base = { frameId: frame.id, name: frame.name, labelRemoved: !!plan.removeLabelId };
    if (dryRun) return { ...base, status: group || plan.removeLabelId ? 'ungrouped' : 'already' };
    const route = stored.routeId ? await sceneById(stored.routeId) : null;
    const label = plan.removeLabelId ? await sceneById(plan.removeLabelId) : null;
    if (label) label.remove();
    if (group) {
        const host = group.parent;
        if (!host || !('children' in host)) return { ...base, status: 'skipped', labelRemoved: !!label, reason: `${frame.name} sits in a ${(group.parent as BaseNode | null)?.type ?? 'missing'} parent that cannot hold loose screens.` };
        const absolute = new Map(group.children.map((k) => [k.id, { x: rectOf(k).x, y: rectOf(k).y }]));
        let at = host.children.indexOf(group);
        for (const k of [...group.children]) {
            host.insertChild(at++, k);
            const was = absolute.get(k.id);
            if (was) moveToAbs(k, was);
        }
        if (!group.removed) group.remove();
    }
    if (route && route.type === 'TEXT') {
        moveToAbs(route, routeSlot(rectOf(frame)));
        await fitRoute(route, frame.width, null);
    }
    const meta: ScreenMeta = { ...upgradeScreenMeta(stored, null), labelId: plan.labelId };
    frame.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(meta));
    const badge = meta.badgeId ? await sceneById(meta.badgeId) : null;
    if (badge) await ensureBadge(frame, meta, buildStatusOf(meta.build));
    return { ...base, status: group || label ? 'ungrouped' : 'already', labelRemoved: !!label };
}

export const ungroupScreens: Handler = async (args) => {
    const dryRun = bool(args, 'dryRun', false);
    const keepLabels = bool(args, 'keepLabels', false);
    const boards = await boardsFor(args);
    if (!boards.length) return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    const details: UngroupDetail[] = [];
    for (const board of boards) {
        const parent = board.node.parent;
        if (!parent || !('children' in parent)) continue;
        for (const { frame, group } of collectScreens(parent.children)) {
            const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
            if (!meta || meta.boardId !== board.node.id) continue;
            details.push(await ungroupScreen(frame, meta, group, keepLabels, dryRun));
        }
        if (!dryRun) raiseArrows(board);
    }
    return ok({
        dryRun,
        boards: boards.map((b) => b.node.id),
        ungrouped: details.filter((d) => d.status === 'ungrouped').length,
        already: details.filter((d) => d.status === 'already').length,
        skipped: details.filter((d) => d.status === 'skipped').length,
        labelsRemoved: details.filter((d) => d.labelRemoved).length,
        details: details as unknown as JsonObject[],
    });
};
