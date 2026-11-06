/** Pure helpers for `Screen · {name}` groups. No `figma` global. */
import type { ScreenMeta } from './flowmeta';
import type { Rect } from './rect';
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

/** Screens are top-level frames so prototyping works. The route text sits this far above the frame, clear of Figma's frame title. */
export const ROUTE_ABOVE = 72;
/** Height of the line the route text and the badge share above the frame. */
export const LINE_HEIGHT = 28;

/** Absolute top-left of a screen's route text: the frame's x, `ROUTE_ABOVE` above it. */
export const routeSlot = (frame: Rect): { x: number; y: number } => ({ x: frame.x, y: frame.y - ROUTE_ABOVE });

/** Distance above the frame for a badge with no route text to centre on: centred on the shared line. */
export const badgeFallbackOffset = (badgeHeight: number): number => ROUTE_ABOVE - (LINE_HEIGHT - badgeHeight) / 2;

const SLOT_TOLERANCE = 2;

/**
 * Whether a badge sits where this frame's own badge would: right edge flush with the frame, just above it.
 * A hand copy of a screen keeps the original's badge id, so loose badges are told apart by position.
 */
export function badgeBelongsTo(frame: Rect, badge: Rect): boolean {
    const flush = Math.abs(badge.x + badge.width - (frame.x + frame.width)) <= SLOT_TOLERANCE;
    const above = badge.y + badge.height <= frame.y + SLOT_TOLERANCE && badge.y >= frame.y - ROUTE_ABOVE - LINE_HEIGHT;
    return flush && above;
}

export type UngroupCandidate = { inScreenGroup: boolean; labelId: string | null; keepLabels: boolean };
export type UngroupPlan = { moveOut: boolean; removeLabelId: string | null; labelId: string | null };

/** What ungrouping a screen needs: move it out of its group, and drop the label text unless asked to keep it. */
export function planUngroup(c: UngroupCandidate): UngroupPlan {
    if (c.keepLabels) return { moveOut: c.inScreenGroup, removeLabelId: null, labelId: c.labelId };
    return { moveOut: c.inScreenGroup, removeLabelId: c.labelId, labelId: null };
}

export const ROUTE_BADGE_GAP = 12;

/** Width of the route text: the frame's width less the badge and a gap, so a long route never runs under the badge. */
export const routeWidth = (frameWidth: number, badgeWidth: number | null): number => (badgeWidth === null ? frameWidth : Math.max(1, frameWidth - badgeWidth - ROUTE_BADGE_GAP));
