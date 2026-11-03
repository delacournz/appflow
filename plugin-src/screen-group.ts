/** Pure helpers for `Screen · {name}` groups. No `figma` global. */
import type { ScreenMeta } from './flowmeta';
import { badgeName } from './screen-status';

const PREFIX = 'Screen · ';

export const screenGroupName = (name: string): string => `${PREFIX}${name}`;
export const isScreenGroupName = (name: string): boolean => name.startsWith(PREFIX);

/** Every layer name of a screen: the group, the frame, the label text, the route text and the build badge. */
export function screenNames(name: string): { group: string; frame: string; label: string; route: string; badge: string } {
    return { group: screenGroupName(name), frame: name, label: `Label · ${name}`, route: `Route · ${name}`, badge: badgeName(name) };
}

export type GroupParent = { id: string; type: string; name: string; childIds: string[] };

export type GroupCandidate = { frameId: string; frameName: string; labelId: string | null; routeId: string | null; badgeId?: string | null; parent: GroupParent };

export type GroupPlan =
    | { kind: 'already'; groupId: string }
    | { kind: 'conflict'; reason: string }
    | { kind: 'group'; name: string; memberIds: string[]; index: number };

/**
 * Decides what grouping a screen needs. `memberIds` run bottom to top (frame, route, label, badge) so the texts sit above the
 * frame. `index` is where the group goes among the parent's other children: where the frame was.
 */
export function planGrouping(c: GroupCandidate): GroupPlan {
    const memberIds = [c.frameId, ...(c.routeId ? [c.routeId] : []), ...(c.labelId ? [c.labelId] : []), ...(c.badgeId ? [c.badgeId] : [])];
    const members = new Set(memberIds);
    const { parent } = c;
    if (parent.type === 'GROUP' && isScreenGroupName(parent.name)) {
        const inside = new Set(parent.childIds);
        if (parent.childIds.every((id) => members.has(id)) && memberIds.every((id) => inside.has(id))) return { kind: 'already', groupId: parent.id };
        return { kind: 'conflict', reason: `${parent.name} (${parent.id}) does not hold exactly this screen's frame, label, route and badge.` };
    }
    const at = parent.childIds.indexOf(c.frameId);
    const index = parent.childIds.slice(0, Math.max(0, at)).filter((id) => !members.has(id)).length;
    return { kind: 'group', name: screenGroupName(c.frameName), memberIds, index };
}

export const upgradeScreenMeta = (meta: ScreenMeta, groupId: string | null): ScreenMeta => ({ ...meta, groupId });

export type ShiftInput = {
    frameId: string;
    groupId: string | null | undefined;
    frameParentId: string | null;
    labelId: string | null;
    labelParentId: string | null;
    routeId: string | null;
    routeParentId: string | null;
    badgeId?: string | null;
    badgeParentId?: string | null;
};

/**
 * The nodes to move by a delta to move a screen. A frame still inside its group moves as the group (one move for
 * its layers), plus any label, route or badge that sits outside it. Otherwise the layers move one by one.
 */
export function shiftTargets(s: ShiftInput): string[] {
    const grouped = !!s.groupId && s.frameParentId === s.groupId;
    if (!grouped) return [s.frameId, ...(s.labelId ? [s.labelId] : []), ...(s.routeId ? [s.routeId] : []), ...(s.badgeId ? [s.badgeId] : [])];
    const loose = [
        ...(s.labelId && s.labelParentId !== s.groupId ? [s.labelId] : []),
        ...(s.routeId && s.routeParentId !== s.groupId ? [s.routeId] : []),
        ...(s.badgeId && s.badgeParentId !== s.groupId ? [s.badgeId] : []),
    ];
    return [s.groupId as string, ...loose];
}
