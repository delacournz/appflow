/**
 * Pure variable-gap track maths for board columns and rows. No `figma` global.
 *
 * A board axis is a list of tracks of equal `size` (colWidth / rowHeight). Extra space is stored as BANDS:
 * `{ at, from, to, px }` adds `px` before track `at`, and it carries into every later track, but only for the
 * lines of the OTHER axis from `from` to `to` inclusive (rows for a column band, columns for a row band). So a gap
 * can be widened beside one group without moving screens elsewhere on the board.
 *
 * Boards saved before bands stored `Record<boundaryIndex, px>`. Those still parse: each entry is a band spanning
 * every line (`from` 0 to `FULL_SPAN`).
 */

export type Band = { at: number; from: number; to: number; px: number };
export type Extras = Band[];
/** The pre-band form: extra px before track `i`, for every line of the other axis. */
export type LegacyExtras = Record<number, number>;
export type ExtrasInput = readonly Band[] | LegacyExtras;

/** Upper end of a band that spans every line of the other axis (JSON-safe, unlike Infinity). */
export const FULL_SPAN = 1_000_000;

/** Smallest extra worth recording when inferring a grid from hand-placed screens. */
export const MIN_EXTRA = 48;

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const validBand = (b: Band): boolean => isInt(b.at) && b.at >= 1 && isInt(b.from) && b.from >= 0 && isInt(b.to) && b.to >= b.from && typeof b.px === 'number' && Number.isFinite(b.px) && b.px > 0;

/** The bands of either form, unsorted and unchecked. */
function rawBands(input: ExtrasInput | undefined): Band[] {
    if (!input) return [];
    if (Array.isArray(input)) {
        return (input as readonly unknown[]).flatMap((b): Band[] => {
            if (typeof b !== 'object' || b === null) return [];
            const o = b as Record<string, unknown>;
            return [{ at: o.at as number, from: o.from as number, to: o.to as number, px: o.px as number }];
        });
    }
    return Object.entries(input as LegacyExtras).map(([k, v]): Band => ({ at: Number(k), from: 0, to: FULL_SPAN, px: v }));
}

/**
 * Canonical bands: junk dropped (`at` and `from` whole numbers, `at` 1 or more, `to` >= `from`, `px` positive),
 * sorted by `at`, `from`, then merged where two bands share `at` and `px` and sit side by side (overlapping bands add up, so they stay apart). Accepts the old
 * Record form too.
 */
export function cleanExtras(input: ExtrasInput | undefined): Extras {
    const sorted = rawBands(input)
        .filter(validBand)
        .sort((a, b) => a.at - b.at || a.from - b.from || a.to - b.to);
    const out: Band[] = [];
    for (const b of sorted) {
        const prev = out.find((o) => o.at === b.at && o.px === b.px && b.from === o.to + 1);
        if (prev) {
            prev.from = Math.min(prev.from, b.from);
            prev.to = Math.max(prev.to, b.to);
        } else out.push({ ...b });
    }
    return out.sort((a, b) => a.at - b.at || a.from - b.from || a.to - b.to);
}

/** The bands that apply to line `cross` of the other axis. */
const forLine = (extras: ExtrasInput | undefined, cross: number): Band[] => cleanExtras(extras).filter((b) => cross >= b.from && cross <= b.to);

/** The offset of track `i` from the axis origin, along line `cross` of the other axis. */
export function trackStart(i: number, size: number, extras: ExtrasInput = [], cross = 0): number {
    let sum = 0;
    for (const b of forLine(extras, cross)) if (b.at <= i) sum += b.px;
    return i * size + sum;
}

/**
 * The track nearest `pos` (an offset from the axis origin) along line `cross` of the other axis. Equals
 * Math.round(pos / size) when no band applies.
 */
export function trackOf(pos: number, size: number, extras: ExtrasInput = [], cross = 0): number {
    const bands = forLine(extras, cross);
    if (bands.length === 0 || pos < 0) return Math.round(pos / size) + 0;
    const ats = [...new Set(bands.map((b) => b.at))];
    const sumAt = (i: number) => bands.reduce((s, b) => (b.at <= i ? s + b.px : s), 0);
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    const consider = (i: number) => {
        if (i < 0) return;
        const d = Math.abs(pos - (i * size + sumAt(i)));
        if (d < bestDist || (d === bestDist && i > best)) {
            best = i;
            bestDist = d;
        }
    };
    const starts = [0, ...ats];
    starts.forEach((lo, k) => {
        const hi = k + 1 < starts.length ? (starts[k + 1] as number) - 1 : Number.POSITIVE_INFINITY;
        const guess = Math.round((pos - sumAt(lo)) / size);
        consider(Math.min(Math.max(guess, lo), hi));
        consider(lo);
        if (Number.isFinite(hi)) consider(hi);
    });
    return best;
}

/**
 * The cell nearest a point, given an offset from the board origin. Column positions depend on the row (and row
 * positions on the column) once bands exist, so this tries, for every row, the best column on that row, and for
 * every column the best row on that column, and keeps the cell whose origin is nearest the point. A point exactly
 * on a cell origin always returns that cell.
 */
export function cellOfPoint(
    dx: number,
    dy: number,
    colSize: number,
    rowSize: number,
    colExtra: ExtrasInput | undefined,
    rowExtra: ExtrasInput | undefined,
): { col: number; row: number } {
    const colBands = cleanExtras(colExtra);
    const rowBands = cleanExtras(rowExtra);
    if ((colBands.length === 0 && rowBands.length === 0) || dx < 0 || dy < 0) return { col: Math.round(dx / colSize) + 0, row: Math.round(dy / rowSize) + 0 };
    let best = { col: 0, row: 0 };
    let bestDist = Number.POSITIVE_INFINITY;
    const consider = (col: number, row: number) => {
        const ex = dx - trackStart(col, colSize, colBands, row);
        const ey = dy - trackStart(row, rowSize, rowBands, col);
        const d = ex * ex + ey * ey;
        if (d < bestDist || (d === bestDist && col + row > best.col + best.row)) {
            best = { col, row };
            bestDist = d;
        }
    };
    const maxRow = Math.round(dy / rowSize) + 1;
    const maxCol = Math.round(dx / colSize) + 1;
    for (let r = 0; r <= maxRow; r++) consider(trackOf(dx, colSize, colBands, r), r);
    for (let c = 0; c <= maxCol; c++) consider(c, trackOf(dy, rowSize, rowBands, c));
    return best;
}

/**
 * Extras after inserting `count` tracks after track `at` on THIS axis (-1 = before the first). Boundaries after `at`
 * move with the screens they precede, so a widened gap stays on the far side of the new empty tracks. Band ranges
 * (which index the other axis) are untouched; see `shiftRanges`.
 */
export function shiftExtras(extras: ExtrasInput, at: number, count: number): Extras {
    return cleanExtras(cleanExtras(extras).map((b) => ({ ...b, at: b.at > at ? b.at + count : b.at })));
}

/**
 * Extras after `count` tracks were inserted after track `after` on the OTHER axis: band ranges after the insertion
 * move with their screens, and a range that straddles it stretches over the new tracks.
 */
export function shiftRanges(extras: ExtrasInput, after: number, count: number): Extras {
    const grow = (n: number) => (n >= FULL_SPAN ? n : n > after ? n + count : n);
    return cleanExtras(cleanExtras(extras).map((b) => ({ ...b, from: grow(b.from), to: grow(b.to) })));
}

/**
 * Extras after compacting. `used` are the occupied tracks of THIS axis before compaction; `usedCross` those of the
 * other axis (omit to leave band ranges alone). The first used track keeps its index and the rest close up behind
 * it. A boundary lands before the next used track; bands that collapse onto the same `at` and range keep the larger
 * px; boundaries at or before the first used track, or after the last, are dropped. A range shrinks to the used
 * lines it still contains, and a band with none left is dropped.
 */
export function compactExtras(extras: ExtrasInput, used: readonly number[], usedCross?: readonly number[]): Extras {
    const sorted = [...new Set(used)].sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    const first = sorted[0] as number;
    const cross = usedCross ? [...new Set(usedCross)].sort((a, b) => a - b) : null;
    const crossFirst = cross?.[0] ?? 0;
    const out: Band[] = [];
    for (const b of cleanExtras(extras)) {
        const rank = sorted.findIndex((u) => u >= b.at);
        if (rank <= 0) continue;
        let { from, to } = b;
        if (cross) {
            const inside = cross.map((u, i) => ({ u, i })).filter(({ u }) => u >= b.from && u <= b.to);
            if (inside.length === 0) continue;
            from = crossFirst + (inside[0] as { i: number }).i;
            to = to >= FULL_SPAN ? to : crossFirst + (inside[inside.length - 1] as { i: number }).i;
        }
        const at = first + rank;
        const same = out.find((o) => o.at === at && o.from === from && o.to === to);
        if (same) same.px = Math.max(same.px, b.px);
        else out.push({ at, from, to, px: b.px });
    }
    return cleanExtras(out);
}

/** Total extra between track `from` and track `to` along line `cross` (boundaries after `from`, up to and including `to`). */
export function extraBetween(extras: ExtrasInput, from: number, to: number, cross = 0): number {
    return forLine(extras, cross).reduce((s, b) => (b.at > from && b.at <= to ? s + b.px : s), 0);
}

/**
 * Full-span extras implied by sorted, distinct track origins whose most common spacing is `base`. A gap of n*base plus
 * a remainder of at least MIN_EXTRA records that remainder before the track after the gap. Missing tracks (gaps of
 * whole multiples of base) record nothing. Adopting hand-placed screens only ever infers full-span bands: a single
 * list of origins cannot say which rows a widened column gap belongs to.
 */
export function extrasFromPositions(positions: readonly number[], base: number): Extras {
    const out: Band[] = [];
    if (base <= 0) return out;
    let idx = 0;
    positions.slice(1).forEach((p, i) => {
        const gap = p - (positions[i] as number);
        const n = Math.max(1, Math.round(gap / base));
        idx += n;
        const extra = Math.round(gap - n * base);
        if (extra >= MIN_EXTRA) out.push({ at: idx, from: 0, to: FULL_SPAN, px: extra });
    });
    return cleanExtras(out);
}
