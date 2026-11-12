/** Pure helpers for rebuilding a deleted board background from the screens still pointing at it. No `figma` global. */

export type RepairScreen = { col: number; row: number; x: number; y: number; width: number; height: number };
export type RepairGrid = { originX: number; originY: number; colWidth: number; rowHeight: number; screenW: number; screenH: number };

const DEFAULT_COL = 700;
const DEFAULT_ROW = 1112;

const modeOf = (xs: readonly number[]): number => {
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(Math.round(x), (counts.get(Math.round(x)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
};

/** Smallest per-track step between screens on different tracks; extras only ever widen a step, so the minimum is the base pitch. */
const stepOf = (screens: readonly RepairScreen[], track: (s: RepairScreen) => number, pos: (s: RepairScreen) => number): number | null => {
    let best: number | null = null;
    for (const a of screens)
        for (const b of screens) {
            const dt = track(b) - track(a);
            if (dt <= 0) continue;
            const step = (pos(b) - pos(a)) / dt;
            if (step > 0 && (best === null || step < best)) best = step;
        }
    return best === null ? null : Math.round(best);
};

/**
 * The grid of a board whose background is gone, from its screens' stored cells and positions. The result is a uniform base
 * grid; the next settle grows the pitch to fit group boxes and moves every screen onto it.
 */
export function inferRepairGrid(screens: readonly RepairScreen[]): RepairGrid {
    const screenW = modeOf(screens.map((s) => s.width));
    const screenH = modeOf(screens.map((s) => s.height));
    const colWidth = Math.max(screenW, stepOf(screens, (s) => s.col, (s) => s.x) ?? DEFAULT_COL);
    const rowHeight = Math.max(screenH, stepOf(screens, (s) => s.row, (s) => s.y) ?? DEFAULT_ROW);
    const first = (track: (s: RepairScreen) => number) => [...screens].sort((a, b) => track(a) - track(b))[0] as RepairScreen;
    const left = first((s) => s.col);
    const top = first((s) => s.row);
    return { originX: Math.round(left.x - left.col * colWidth), originY: Math.round(top.y - top.row * rowHeight), colWidth, rowHeight, screenW, screenH };
}
