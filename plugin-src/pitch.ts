/** Uniform grid spacing: one column pitch and one row pitch for the whole board. Pure; no `figma` global. */

export type Spacing = 'uniform' | 'banded';
export type Pitch = { colWidth: number; rowHeight: number };

export type PitchMeta = { colWidth: number; rowHeight: number; baseColWidth?: number; baseRowHeight?: number; spacing?: Spacing };

/** Boards default to uniform spacing; 'banded' is the older per-region extras. */
export const spacingOf = (m: Pick<PitchMeta, 'spacing'>): Spacing => m.spacing ?? 'uniform';

/**
 * The pitch before any group needs were added. Stored separately from the effective pitch (`colWidth`/`rowHeight`), so
 * growing and shrinking the effective pitch never compounds across refits.
 */
export const basePitchOf = (m: PitchMeta): Pitch => ({ colWidth: m.baseColWidth ?? m.colWidth, rowHeight: m.baseRowHeight ?? m.rowHeight });

/** The effective pitch: base plus the largest boundary need on each axis. Needs below zero count as none. */
export const pitchFromNeeds = (base: Pitch, needs: { col: number; row: number }): Pitch => ({
    colWidth: base.colWidth + Math.max(0, Math.ceil(needs.col)),
    rowHeight: base.rowHeight + Math.max(0, Math.ceil(needs.row)),
});

export const samePitch = (a: Pitch, b: Pitch): boolean => a.colWidth === b.colWidth && a.rowHeight === b.rowHeight;

/** The meta fields for a uniform board: effective pitch, remembered base, no bands. Returns only what changes. */
export function uniformFields(base: Pitch, effective: Pitch): { colWidth: number; rowHeight: number; baseColWidth: number; baseRowHeight: number; spacing: 'uniform' } {
    return { colWidth: effective.colWidth, rowHeight: effective.rowHeight, baseColWidth: base.colWidth, baseRowHeight: base.rowHeight, spacing: 'uniform' };
}
