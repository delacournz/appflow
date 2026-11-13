/** Pure rules for the per-board "Flow arrow labels" container that keeps every arrow label above every arrow line. No `figma` global. */

export const LABELS_PREFIX = 'Flow arrow labels · ';

/**
 * Name of a board's labels container: `Flow arrow labels · {board}`. The board part comes from the board node's name
 * (`Board background · X` or `Board · X`), else from the arrows container's (`Flow arrows · X`), else is left out.
 */
export function labelsContainerName(boardName: string, arrowsName = ''): string {
    const strip = (n: string, re: RegExp) => n.replace(re, '').trim();
    const fromBoard = strip(boardName, /^(Board background|Board)\s*·?\s*/);
    const fromArrows = strip(arrowsName, /^Flow arrows\s*·?\s*/);
    const board = fromBoard && fromBoard !== boardName.trim() ? fromBoard : fromArrows || fromBoard;
    return board ? `${LABELS_PREFIX}${board}` : LABELS_PREFIX.trim().replace(/\s*·$/, '');
}

export const isLabelsContainerName = (name: string): boolean => name.startsWith('Flow arrow labels');

/** Labels not yet in the labels container, to be moved out of their arrow groups. Idempotent: a migrated arrow yields nothing. */
export function labelsToMigrate(arrows: readonly { labelId: string; labelParentId: string | null }[], labelsId: string): string[] {
    return arrows.filter((a) => a.labelParentId !== labelsId).map((a) => a.labelId);
}

/**
 * What a stacking pass must do. `ids` are the parent's children bottom to top. The arrows container must sit above every
 * screen (`raiseArrows`), and the labels container, when there is one, directly above the arrows container.
 */
export function stackingNeeds(ids: readonly string[], isScreen: (id: string) => boolean, arrowsId: string, labelsId: string | null): { raiseArrows: boolean; placeLabels: boolean } {
    const at = ids.indexOf(arrowsId);
    const raiseArrows = at >= 0 && ids.some((id, i) => i > at && isScreen(id));
    const placeLabels = labelsId !== null && (raiseArrows || ids.indexOf(labelsId) !== at + 1);
    return { raiseArrows, placeLabels };
}

/**
 * The `insertChild` index that puts the labels container directly above the arrows container. Always the slot right
 * after the arrows, whether the labels start below or above them (`ids` bottom to top).
 */
export function labelsInsertIndex(ids: readonly string[], arrowsId: string): number {
    return ids.indexOf(arrowsId) + 1;
}

export type LabelStackIssue = { kind: 'labels-under-lines'; arrowsId: string; labelsId: string };

/** `labels-under-lines`: the labels container paints below the arrows container, so lines cut through label text. */
export function labelStackIssue(ids: readonly string[], arrowsId: string, labelsId: string | null): LabelStackIssue | null {
    if (labelsId === null) return null;
    const a = ids.indexOf(arrowsId);
    const l = ids.indexOf(labelsId);
    if (a < 0 || l < 0 || l > a) return null;
    return { kind: 'labels-under-lines', arrowsId, labelsId };
}
