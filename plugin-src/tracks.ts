/**
 * Pure variable-gap track maths for board columns and rows. No `figma` global.
 *
 * A board axis is a list of tracks of equal `size` (colWidth / rowHeight). `extras[i]` is extra px added BEFORE
 * track i, and it carries into every later track. Absent or `{}` is the plain uniform grid.
 */

export type Extras = Record<number, number>;

/** Smallest extra worth recording when inferring a grid from hand-placed screens. */
export const MIN_EXTRA = 48;

const entries = (extras: Extras): [number, number][] =>
    Object.entries(extras)
        .map(([k, v]): [number, number] => [Number(k), v])
        .filter(([k, v]) => Number.isInteger(k) && k >= 1 && Number.isFinite(v) && v > 0)
        .sort((a, b) => a[0] - b[0]);

/** Only whole-number keys of 1 or more with positive finite values survive. */
export function cleanExtras(extras: Extras | undefined): Extras {
    return Object.fromEntries(entries(extras ?? {}));
}

/** The offset of track `i` from the axis origin. */
export function trackStart(i: number, size: number, extras: Extras = {}): number {
    let sum = 0;
    for (const [k, v] of entries(extras)) if (k <= i) sum += v;
    return i * size + sum;
}

/** The track nearest `pos` (an offset from the axis origin). Equals Math.round(pos / size) when extras are empty. */
export function trackOf(pos: number, size: number, extras: Extras = {}): number {
    const list = entries(extras);
    if (list.length === 0 || pos < 0) return Math.round(pos / size) + 0;
    const last = list[list.length - 1] as [number, number];
    let best = Math.round(pos / size);
    let bestDist = Number.POSITIVE_INFINITY;
    const consider = (i: number) => {
        const d = Math.abs(pos - trackStart(i, size, extras));
        if (d < bestDist || (d === bestDist && i > best)) {
            best = i;
            bestDist = d;
        }
    };
    for (let i = 0; i <= last[0]; i++) consider(i);
    const total = list.reduce((s, [, v]) => s + v, 0);
    consider(Math.max(last[0], Math.round((pos - total) / size)));
    return best;
}

/**
 * Extras after inserting `count` tracks after track `at` (-1 = before the first). Boundaries after `at` move with
 * the screens they precede, so a widened gap stays on the far side of the new empty tracks.
 */
export function shiftExtras(extras: Extras, at: number, count: number): Extras {
    return Object.fromEntries(entries(extras).map(([k, v]) => [k > at ? k + count : k, v]));
}

/**
 * Extras after compacting: `used` are the occupied track indexes before compaction. The first used track keeps its
 * index and the rest close up behind it. A boundary lands before the next used track; boundaries that collapse onto
 * one keep the larger extra; boundaries at or before the first used track, or after the last, are dropped.
 */
export function compactExtras(extras: Extras, used: readonly number[]): Extras {
    const sorted = [...new Set(used)].sort((a, b) => a - b);
    if (sorted.length === 0) return {};
    const first = sorted[0] as number;
    const out: Extras = {};
    for (const [k, v] of entries(extras)) {
        const rank = sorted.findIndex((u) => u >= k);
        if (rank <= 0) continue;
        const to = first + rank;
        out[to] = Math.max(out[to] ?? 0, v);
    }
    return out;
}

/** Total extra between track `from` and track `to` (boundaries after `from`, up to and including `to`). */
export function extraBetween(extras: Extras, from: number, to: number): number {
    return entries(extras).reduce((s, [k, v]) => (k > from && k <= to ? s + v : s), 0);
}

/**
 * Extras implied by sorted, distinct track origins whose most common spacing is `base`. A gap of n*base plus a
 * remainder of at least MIN_EXTRA records that remainder before the track after the gap. Missing tracks (gaps of
 * whole multiples of base) record nothing.
 */
export function extrasFromPositions(positions: readonly number[], base: number): Extras {
    const out: Extras = {};
    if (base <= 0) return out;
    let idx = 0;
    positions.slice(1).forEach((p, i) => {
        const gap = p - (positions[i] as number);
        const n = Math.max(1, Math.round(gap / base));
        idx += n;
        const extra = Math.round(gap - n * base);
        if (extra >= MIN_EXTRA) out[idx] = extra;
    });
    return out;
}
