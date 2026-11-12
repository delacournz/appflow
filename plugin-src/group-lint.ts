import type { Pt, Rect } from './route';
import type { PrototypeLintIssue } from './prototype-lint';
import type { LabelStackIssue } from './arrow-labels';
import { groupConflicts, validateNesting, type ConflictContent, type ConflictGroup, type GroupIssue, type NestingIssue } from './flow-group';

/** Pure group checks for lint_flow_layout. No `figma` global. */

/** Problems between arrows: labels on labels, shared stretches of line, and lines through title text. */
export type ArrowLayoutIssue =
    | { kind: 'label-overlaps-label'; arrowId: string; otherId: string }
    | { kind: 'lines-overlap'; arrowId: string; otherId: string; length: number }
    | { kind: 'shared-start'; arrowId: string; otherId: string; length: number }
    | { kind: 'line-crosses-title'; arrowId: string; groupId: string }
    | { kind: 'line-crosses-screen'; arrowId: string; screenId: string }
    | { kind: 'starts-wrong-side'; arrowId: string; screenId: string; side: 'left' | 'top' }
    | { kind: 'ends-wrong-side'; arrowId: string; screenId: string; side: 'right' | 'bottom' };

/** A build badge on the board that no screen points at. */
export type OrphanBadgeIssue = { kind: 'orphan-badge'; badgeId: string };

export type LayoutIssue = ((GroupIssue | NestingIssue | ArrowLayoutIssue) & { message: string }) | (OrphanBadgeIssue & { message: string }) | (LabelStackIssue & { message: string }) | PrototypeLintIssue;

export type GroupLint = { issues: LayoutIssue[]; counts: Record<string, number> };

function describe(i: GroupIssue | NestingIssue | ArrowLayoutIssue): string {
    switch (i.kind) {
        case 'group-crosses-content':
            return `Group ${i.groupId} stroke crosses ${i.contentKind} ${i.contentId}`;
        case 'group-crosses-label':
            return `Group ${i.groupId} stroke crosses arrow label ${i.labelId}`;
        case 'group-overlaps-group':
            return `Group ${i.groupId} overlaps group ${i.otherId}`;
        case 'group-encloses-foreign':
            return `Group ${i.groupId} encloses screen ${i.screenId} that is not a member`;
        case 'title-overlaps':
            return `Title of group ${i.groupId} overlaps ${i.withKind} ${i.withId}`;
        case 'nesting-too-deep':
            return `Group ${i.groupId} is nested more than one level`;
        case 'child-outside-parent':
            return `Group ${i.groupId} sticks out of its parent ${i.parentId}`;
        case 'parent-missing':
            return `Group ${i.groupId} has a missing parent ${i.parentId}`;
        case 'label-overlaps-label':
            return `Label of arrow ${i.arrowId} overlaps the label of arrow ${i.otherId}`;
        case 'lines-overlap':
            return `Arrow ${i.arrowId} runs on top of arrow ${i.otherId} for ${i.length}px`;
        case 'shared-start':
            return `Arrow ${i.arrowId} and arrow ${i.otherId} leave the same dot for different targets and share ${i.length}px of their first run; fork them into separate rows`;
        case 'line-crosses-title':
            return `Arrow ${i.arrowId} crosses the title text of group ${i.groupId}`;
        case 'starts-wrong-side':
            return `Arrow ${i.arrowId} starts on the ${i.side} edge of screen ${i.screenId}; arrows start on a screen's bottom or right edge`;
        case 'ends-wrong-side':
            return `Arrow ${i.arrowId} ends on the ${i.side} edge of screen ${i.screenId}; arrows end on a screen's left or top edge`;
        case 'line-crosses-screen':
            return `Arrow ${i.arrowId} runs through screen ${i.screenId}, which is neither its source nor its target`;
    }
}

/** Every group conflict and nesting problem, each with a message, plus a count per kind. */
export function lintGroups(groups: readonly ConflictGroup[], contents: readonly ConflictContent[]): GroupLint {
    const raw: (GroupIssue | NestingIssue)[] = [...groupConflicts(groups, contents), ...validateNesting(groups)];
    const issues = raw.map((i): LayoutIssue => ({ ...i, message: describe(i) }));
    const counts: Record<string, number> = {};
    for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return { issues, counts };
}

/** `from` and `to` are the arrow's screen ids: a line may touch its own ends but never pass through any other screen. */
export type ArrowShape = { id: string; points: readonly Pt[]; label: Rect | null; from?: string; to?: string };
export type ScreenBox = { id: string; rect: Rect };
/** `text` is the title's text area (`titleTextRect`), or the bar when the text is unknown. */
export type TitleText = { id: string; text: Rect };

/** Collinear stretches shorter than or equal to this are crossings or touches, not a shared lane. */
export const LINES_OVERLAP_MIN = 40;

const rectsIntersect = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

type Seg = { axis: 'v' | 'h'; at: number; lo: number; hi: number };

function segmentsOf(points: readonly Pt[]): Seg[] {
    const out: Seg[] = [];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1] as Pt;
        const b = points[i] as Pt;
        if (a.x === b.x && a.y !== b.y) out.push({ axis: 'v', at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
        else if (a.y === b.y && a.x !== b.x) out.push({ axis: 'h', at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
    }
    return out;
}

const segHitsRect = (s: Seg, r: Rect): boolean =>
    s.axis === 'v' ? s.at > r.x && s.at < r.x + r.width && s.hi > r.y && s.lo < r.y + r.height : s.at > r.y && s.at < r.y + r.height && s.hi > r.x && s.lo < r.x + r.width;

const SIDE_TOLERANCE = 2;

/** The longest first run two arrows from one dot to different targets may share: a fork stub, not a common line. */
export const SHARED_START_MAX = 48;

/** How far the first horizontal runs of two arrows that start on the same dot coincide, or 0 when they do not start together or share a target. */
function sharedStartLength(a: ArrowShape, b: ArrowShape): number {
    const [a0, a1, b0, b1] = [a.points[0], a.points[1], b.points[0], b.points[1]];
    if (!a0 || !a1 || !b0 || !b1 || a0.x !== b0.x || a0.y !== b0.y || (a.to !== undefined && a.to === b.to)) return 0;
    if (a1.y !== a0.y || b1.y !== b0.y) return 0;
    return Math.max(0, Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x)) - Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x)));
}

/** Which of `sides` of `r` the point lies on (within `SIDE_TOLERANCE`, inside the edge's span), or null. */
function edgeSide(p: Pt, r: Rect, sides: readonly ('left' | 'top' | 'right' | 'bottom')[]): 'left' | 'top' | 'right' | 'bottom' | null {
    const inX = p.x >= r.x - SIDE_TOLERANCE && p.x <= r.x + r.width + SIDE_TOLERANCE;
    const inY = p.y >= r.y - SIDE_TOLERANCE && p.y <= r.y + r.height + SIDE_TOLERANCE;
    for (const side of sides) {
        if (side === 'left' && inY && Math.abs(p.x - r.x) <= SIDE_TOLERANCE) return side;
        if (side === 'right' && inY && Math.abs(p.x - (r.x + r.width)) <= SIDE_TOLERANCE) return side;
        if (side === 'top' && inX && Math.abs(p.y - r.y) <= SIDE_TOLERANCE) return side;
        if (side === 'bottom' && inX && Math.abs(p.y - (r.y + r.height)) <= SIDE_TOLERANCE) return side;
    }
    return null;
}

/**
 * Lines two arrows deliberately share, which `lines-overlap` must not flag: for arrows into the same target, the merged
 * trunk (the vertical both turn off just before the target) and the final run into it; for arrows that start on the same
 * dot, the first horizontal stub.
 */
function mergedLines(a: ArrowShape, b: ArrowShape): { axis: 'v' | 'h'; at: number }[] {
    const out: { axis: 'v' | 'h'; at: number }[] = [];
    const pa = a.points;
    const pb = b.points;
    if (a.to !== undefined && a.to === b.to && pa.length >= 2 && pb.length >= 2) {
        const la = pa[pa.length - 1] as Pt;
        const lb = pb[pb.length - 1] as Pt;
        if (la.x === lb.x && la.y === lb.y) {
            out.push({ axis: 'h', at: la.y });
            const ca = pa[pa.length - 2] as Pt;
            const cb = pb[pb.length - 2] as Pt;
            const turnA = pa.length >= 3 && (pa[pa.length - 3] as Pt).x === ca.x;
            const turnB = pb.length >= 3 && (pb[pb.length - 3] as Pt).x === cb.x;
            if (turnA && turnB && ca.x === cb.x) out.push({ axis: 'v', at: ca.x });
        }
    }
    const sa = pa[0] as Pt | undefined;
    const sb = pb[0] as Pt | undefined;
    if (sa && sb && sa.x === sb.x && sa.y === sb.y) out.push({ axis: 'h', at: sa.y });
    return out;
}

/**
 * Arrow-vs-arrow and arrow-vs-title checks for lint_flow_layout, in the order the arrows are given:
 * `label-overlaps-label` (label rects intersect), `lines-overlap` (collinear segments sharing more than
 * `LINES_OVERLAP_MIN` px), `line-crosses-title` (any segment through a title's text area) and `line-crosses-screen`
 * (any segment through a screen that is not the arrow's source or target).
 */
export function lintArrows(arrows: readonly ArrowShape[], titles: readonly TitleText[], screens: readonly ScreenBox[] = []): GroupLint {
    const raw: ArrowLayoutIssue[] = [];
    const segs = arrows.map((a) => segmentsOf(a.points));
    for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i] as ArrowShape;
        for (let j = i + 1; j < arrows.length; j++) {
            const b = arrows[j] as ArrowShape;
            if (a.label && b.label && rectsIntersect(a.label, b.label)) raw.push({ kind: 'label-overlaps-label', arrowId: a.id, otherId: b.id });
            const merged = mergedLines(a, b);
            let shared = 0;
            for (const s of segs[i] as Seg[]) {
                if (merged.some((m) => m.axis === s.axis && m.at === s.at)) continue;
                for (const t of segs[j] as Seg[]) {
                    if (s.axis === t.axis && s.at === t.at) shared += Math.max(0, Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo));
                }
            }
            if (shared > LINES_OVERLAP_MIN) raw.push({ kind: 'lines-overlap', arrowId: a.id, otherId: b.id, length: Math.round(shared) });
            const together = sharedStartLength(a, b);
            if (together > SHARED_START_MAX) raw.push({ kind: 'shared-start', arrowId: a.id, otherId: b.id, length: Math.round(together) });
        }
        for (const t of titles) {
            if ((segs[i] as Seg[]).some((s) => segHitsRect(s, t.text))) raw.push({ kind: 'line-crosses-title', arrowId: a.id, groupId: t.id });
        }
        const first = a.points[0];
        const last = a.points[a.points.length - 1];
        const from = screens.find((sc) => sc.id === a.from);
        const to = screens.find((sc) => sc.id === a.to);
        if (first && from) {
            const side = edgeSide(first, from.rect, ['left', 'top']);
            if (side === 'left' || side === 'top') raw.push({ kind: 'starts-wrong-side', arrowId: a.id, screenId: from.id, side });
        }
        if (last && to) {
            const side = edgeSide(last, to.rect, ['right', 'bottom']);
            if (side === 'right' || side === 'bottom') raw.push({ kind: 'ends-wrong-side', arrowId: a.id, screenId: to.id, side });
        }
        for (const sc of screens) {
            if (sc.id === a.from || sc.id === a.to) continue;
            const inner = { x: sc.rect.x + 1, y: sc.rect.y + 1, width: sc.rect.width - 2, height: sc.rect.height - 2 };
            if ((segs[i] as Seg[]).some((s) => segHitsRect(s, inner))) raw.push({ kind: 'line-crosses-screen', arrowId: a.id, screenId: sc.id });
        }
    }
    const issues = raw.map((i): LayoutIssue => ({ ...i, message: describe(i) }));
    const counts: Record<string, number> = {};
    for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return { issues, counts };
}
