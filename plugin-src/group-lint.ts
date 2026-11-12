import type { Pt, Rect } from './route';
import { groupConflicts, validateNesting, type ConflictContent, type ConflictGroup, type GroupIssue, type NestingIssue } from './flow-group';

/** Pure group checks for lint_flow_layout. No `figma` global. */

/** Problems between arrows: labels on labels, shared stretches of line, and lines through title text. */
export type ArrowLayoutIssue =
    | { kind: 'label-overlaps-label'; arrowId: string; otherId: string }
    | { kind: 'lines-overlap'; arrowId: string; otherId: string; length: number }
    | { kind: 'line-crosses-title'; arrowId: string; groupId: string };

export type LayoutIssue = (GroupIssue | NestingIssue | ArrowLayoutIssue) & { message: string };

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
        case 'line-crosses-title':
            return `Arrow ${i.arrowId} crosses the title text of group ${i.groupId}`;
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

export type ArrowShape = { id: string; points: readonly Pt[]; label: Rect | null };
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

/**
 * Arrow-vs-arrow and arrow-vs-title checks for lint_flow_layout, in the order the arrows are given:
 * `label-overlaps-label` (label rects intersect), `lines-overlap` (collinear segments sharing more than
 * `LINES_OVERLAP_MIN` px) and `line-crosses-title` (any segment through a title's text area).
 */
export function lintArrows(arrows: readonly ArrowShape[], titles: readonly TitleText[]): GroupLint {
    const raw: ArrowLayoutIssue[] = [];
    const segs = arrows.map((a) => segmentsOf(a.points));
    for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i] as ArrowShape;
        for (let j = i + 1; j < arrows.length; j++) {
            const b = arrows[j] as ArrowShape;
            if (a.label && b.label && rectsIntersect(a.label, b.label)) raw.push({ kind: 'label-overlaps-label', arrowId: a.id, otherId: b.id });
            let shared = 0;
            for (const s of segs[i] as Seg[]) {
                for (const t of segs[j] as Seg[]) {
                    if (s.axis === t.axis && s.at === t.at) shared += Math.max(0, Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo));
                }
            }
            if (shared > LINES_OVERLAP_MIN) raw.push({ kind: 'lines-overlap', arrowId: a.id, otherId: b.id, length: Math.round(shared) });
        }
        for (const t of titles) {
            if ((segs[i] as Seg[]).some((s) => segHitsRect(s, t.text))) raw.push({ kind: 'line-crosses-title', arrowId: a.id, groupId: t.id });
        }
    }
    const issues = raw.map((i): LayoutIssue => ({ ...i, message: describe(i) }));
    const counts: Record<string, number> = {};
    for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return { issues, counts };
}
