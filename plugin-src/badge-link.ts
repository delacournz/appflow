/** Pure matching of `Badge · {name}` pills to screens. No `figma` global. */
import type { Rect } from './rect';
import { badgeBelongsTo, ROUTE_ABOVE } from './screen-group';
import { badgeName } from './screen-status';

export type BadgeScreen = { id: string; name: string; rect: Rect };
export type BadgeCandidate = { id: string; name: string; rect: Rect };

/** How far a badge sits from where a frame's own badge would: right edges, then height above the frame. Smaller is closer. */
export function slotDistance(frame: Rect, badge: Rect): number {
    const dx = Math.abs(badge.x + badge.width - (frame.x + frame.width));
    const dy = Math.abs(badge.y + badge.height - (frame.y - ROUTE_ABOVE + badge.height / 2));
    return dx + dy;
}

const nearest = (screen: BadgeScreen, pool: readonly BadgeCandidate[]): BadgeCandidate | null =>
    [...pool].sort((a, b) => slotDistance(screen.rect, a.rect) - slotDistance(screen.rect, b.rect))[0] ?? null;

/**
 * Which badge belongs to which screen. Pass 1: the exact name `Badge · {screen name}`, wherever it is (a screen that was
 * shifted leaves its badge behind, so position cannot be trusted); with several same-named badges the one nearest the
 * screen's badge slot wins. Pass 2: a badge sitting in the screen's own slot (`badgeBelongsTo`), which covers a renamed
 * screen. A badge links to at most one screen; ids in `claimed` are never offered. Screens in `skip` are left alone.
 * Returns screen id -> badge id.
 */
export function linkBadges(
    screens: readonly BadgeScreen[],
    badges: readonly BadgeCandidate[],
    claimed: ReadonlySet<string> = new Set(),
    skip: ReadonlySet<string> = new Set(),
): Map<string, string> {
    const taken = new Set(claimed);
    const out = new Map<string, string>();
    const todo = screens.filter((s) => !skip.has(s.id));
    for (const s of todo) {
        const hit = nearest(s, badges.filter((b) => !taken.has(b.id) && b.name === badgeName(s.name)));
        if (!hit) continue;
        out.set(s.id, hit.id);
        taken.add(hit.id);
    }
    for (const s of todo) {
        if (out.has(s.id)) continue;
        const hit = nearest(s, badges.filter((b) => !taken.has(b.id) && badgeBelongsTo(s.rect, b.rect)));
        if (!hit) continue;
        out.set(s.id, hit.id);
        taken.add(hit.id);
    }
    return out;
}

/**
 * The text line a badge centres on: the first of `lines` (label, then route) that sits above `frame` at its x. A line left
 * behind by a shift (wrong x, or far from the frame) is ignored, so the badge falls back to the frame-relative offset.
 */
export function badgeLine(frame: Rect, lines: readonly Rect[]): Rect | null {
    return lines.find((r) => Math.abs(r.x - frame.x) <= 4 && r.y < frame.y && r.y >= frame.y - ROUTE_ABOVE - 200) ?? null;
}

/** The delta that puts a badge in its slot, or null when it is already within half a pixel. */
export function badgeSnap(frame: Rect, lines: readonly Rect[], badge: Rect, fallbackOffset: number): { dx: number; dy: number } | null {
    const line = badgeLine(frame, lines);
    const x = frame.x + frame.width - badge.width;
    const y = line ? line.y + (line.height - badge.height) / 2 : frame.y - fallbackOffset;
    const [dx, dy] = [x - badge.x, y - badge.y];
    return Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5 ? null : { dx, dy };
}

/** Badges inside `board` that no screen's meta points at: left behind by renames, duplicates or deletes. Ids, in input order. */
export function orphanBadges(badges: readonly BadgeCandidate[], referenced: ReadonlySet<string>, board: Rect): string[] {
    const inside = (r: Rect) => r.x >= board.x && r.y >= board.y && r.x + r.width <= board.x + board.width && r.y + r.height <= board.y + board.height;
    return badges.filter((b) => !referenced.has(b.id) && inside(b.rect)).map((b) => b.id);
}
