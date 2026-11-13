/** Pure helpers for a deleted board background. No `figma` global. */

export const boardMissingMessage = (boardId: string): string =>
    `Board background ${boardId} is missing (probably deleted). Run repair_board to rebuild it from the screens, arrows and groups that still point at it (or restore it with Cmd+Z / File → Show version history).`;

export type OrphanIssue = { kind: 'board-background-missing'; boardId: string; screens: number; groups: number; message: string };

/**
 * Boards that screens and flow-group holders still point at but whose background node is gone, with how many screens and
 * groups are orphaned. `screenBoardIds` has one entry per screen, `groupBoardIds` one per group; `existing` is the set of
 * board ids that still resolve.
 */
export function findOrphans(screenBoardIds: readonly string[], groupBoardIds: readonly string[], existing: ReadonlySet<string>): OrphanIssue[] {
    const count = (ids: readonly string[]) => ids.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>());
    const [screens, groups] = [count(screenBoardIds), count(groupBoardIds)];
    return [...new Set([...screens.keys(), ...groups.keys()])]
        .filter((id) => !existing.has(id))
        .sort()
        .map((boardId) => ({ kind: 'board-background-missing', boardId, screens: screens.get(boardId) ?? 0, groups: groups.get(boardId) ?? 0, message: boardMissingMessage(boardId) }));
}
