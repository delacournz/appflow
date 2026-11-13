/** Pure rules for rebuilding a board's lost arrows container. No `figma` global. */

/** `Flow arrows · {board}`, the board part taken from the board node's name (`Board background · X` or `Board · X`). */
export function arrowsContainerName(boardName: string): string {
    const board = boardName.replace(/^(Board background|Board)\s*·?\s*/, '').trim();
    return board && board !== boardName.trim() ? `Flow arrows · ${board}` : 'Flow arrows';
}

/** Node types that can hold arrow groups. A missing node or any other type means the container is lost. */
export const isArrowsContainerType = (type: string): boolean => type === 'FRAME' || type === 'GROUP' || type === 'SECTION';

/**
 * Index (in the parent's final child order) for a rebuilt arrows container: directly below the labels container when
 * there is one, else on top. `ids` are the parent's children bottom to top.
 */
export function recoveryIndex(ids: readonly string[], labelsId: string | null): number {
    const at = labelsId ? ids.indexOf(labelsId) : -1;
    return at >= 0 ? at : ids.length;
}

/** The nodes to gather into a rebuilt container: those carrying arrow data for this board, not already inside one. */
export function recoverableArrowIds(nodes: readonly { id: string; boardId: string | null }[], boardId: string): string[] {
    return nodes.filter((n) => n.boardId === boardId).map((n) => n.id);
}
