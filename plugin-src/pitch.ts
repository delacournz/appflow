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

type Need = { col: number; row: number };

/**
 * One settle step of uniform pitch growth: add what the drawn boxes still lack. Stops (and keeps the previous growth) when the
 * deficit did not shrink since the last pass, which means spacing cannot fix it, and caps growth at one base pitch per axis so
 * an unsolvable layout never balloons the board.
 */
export function growPitch(base: Pitch, more: Need, deficit: Need, previous: Need | null): { more: Need; stop: boolean } {
    const total = (n: Need) => Math.max(0, n.col) + Math.max(0, n.row);
    if (previous && total(deficit) >= total(previous)) return { more, stop: true };
    const col = more.col + Math.max(0, deficit.col);
    const row = more.row + Math.max(0, deficit.row);
    const capped = { col: Math.min(col, base.colWidth), row: Math.min(row, base.rowHeight) };
    return { more: capped, stop: capped.col !== col || capped.row !== row };
}
