/** Uniform grid spacing: one column pitch and one row pitch for the whole board. Pure; no `figma` global. */

import { cellRect, type GridMeta } from './grid';

export type Spacing = 'uniform' | 'banded' | 'grouped';
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

export type ScreenPos = { col: number; row: number; x: number; y: number };
export type PitchCheck = { kind: 'ok' } | { kind: 'repair'; pitch: Pitch } | { kind: 'refuse'; reason: string };

const MISMATCH_SHARE = 0.3;
const AGREE_SHARE = 0.6;
const POS_TOLERANCE = 2;
const MIN_SCREENS = 3;

const median = (xs: readonly number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] as number;
};

/** The pitch most screens agree on along one axis (`at` = the cell index times the pitch from the origin), or null. */
function agreedPitch(samples: readonly { index: number; offset: number }[]): number | null {
    const usable = samples.filter((s) => s.index >= 1).map((s) => s.offset / s.index);
    if (usable.length < 2) return null;
    const mid = median(usable);
    const near = usable.filter((p) => Math.abs(p - mid) <= 1);
    return near.length >= AGREE_SHARE * usable.length ? Math.round(mid) : null;
}

/**
 * Whether the board's stored pitch still matches where its screens sit. A screen is off when its frame is not at the rect
 * its stored cell gives under the stored pitch. When under 30% are off, the screens were hand-moved: fine (they get
 * their cells re-derived one by one). When more are off, the pitch itself is wrong; deriving cells from positions would
 * stack screens on top of each other. A uniform board is repaired by the pitch most screens agree on, per axis; a banded
 * board, or screens that agree on nothing, is refused.
 */
export function checkPitch(meta: GridMeta & { spacing?: Spacing }, screens: readonly ScreenPos[]): PitchCheck {
    if (screens.length < MIN_SCREENS || meta.spacing === 'grouped') return { kind: 'ok' };
    const off = screens.filter((s) => {
        const want = cellRect(meta, s.col, s.row);
        return Math.abs(want.x - s.x) > POS_TOLERANCE || Math.abs(want.y - s.y) > POS_TOLERANCE;
    });
    if (off.length < MISMATCH_SHARE * screens.length) return { kind: 'ok' };
    const banded = !!(meta.colExtra?.length || meta.rowExtra?.length) || meta.spacing === 'banded';
    const pitchNow = `${meta.colWidth} x ${meta.rowHeight}`;
    if (banded) return { kind: 'refuse', reason: `pitch-mismatch: ${off.length} of ${screens.length} screens are not where their cells put them under the stored banded spacing (${pitchNow}). Restore the board or re-adopt it; reroute_flow will not re-derive cells from these positions.` };
    const col = agreedPitch(screens.map((s) => ({ index: s.col, offset: s.x - meta.originX })));
    const row = agreedPitch(screens.map((s) => ({ index: s.row, offset: s.y - meta.originY })));
    const colOk = screens.filter((s) => Math.abs(cellRect(meta, s.col, s.row).x - s.x) <= POS_TOLERANCE).length >= (1 - MISMATCH_SHARE) * screens.length;
    const rowOk = screens.filter((s) => Math.abs(cellRect(meta, s.col, s.row).y - s.y) <= POS_TOLERANCE).length >= (1 - MISMATCH_SHARE) * screens.length;
    const pitch = { colWidth: colOk ? meta.colWidth : col ?? Number.NaN, rowHeight: rowOk ? meta.rowHeight : row ?? Number.NaN };
    if (Number.isNaN(pitch.colWidth) || Number.isNaN(pitch.rowHeight)) {
        return { kind: 'refuse', reason: `pitch-mismatch: ${off.length} of ${screens.length} screens are not where their cells put them under the stored pitch (${pitchNow}) and their positions agree on no single pitch. reroute_flow will not re-derive cells from them; restore the board or pass colWidth and rowHeight.` };
    }
    if (pitch.colWidth === meta.colWidth && pitch.rowHeight === meta.rowHeight) return { kind: 'ok' };
    return { kind: 'repair', pitch };
}
