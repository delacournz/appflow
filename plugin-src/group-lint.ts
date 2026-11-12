import { groupConflicts, validateNesting, type ConflictContent, type ConflictGroup, type GroupIssue, type NestingIssue } from './flow-group';

/** Pure group checks for lint_flow_layout. No `figma` global. */

export type LayoutIssue = (GroupIssue | NestingIssue) & { message: string };

export type GroupLint = { issues: LayoutIssue[]; counts: Record<string, number> };

function describe(i: GroupIssue | NestingIssue): string {
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
