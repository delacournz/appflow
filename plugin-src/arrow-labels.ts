/** Pure rules for the per-board "Flow arrow labels" container that keeps every arrow label above every arrow line. No `figma` global. */

export const LABELS_PREFIX = 'Flow arrow labels · ';

/** Name of the labels container that goes with an arrows container named `Flow arrows · {board}`. */
export function labelsContainerName(arrowsName: string): string {
    const board = arrowsName.replace(/^Flow arrows\s*·?\s*/, '').trim();
    return `${LABELS_PREFIX}${board}`;
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
