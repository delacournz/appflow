import { addBands, hasDeficits, type Deficits } from './gap-fix';
import { growPitch, type Pitch } from './pitch';

/** What the settle loop needs to know about one fit of the group boxes. */
export type SettleFit = { active: boolean; extrasChanged: boolean; deficits: Deficits; boxes: unknown };
export type Bonus = Pick<Deficits, 'colExtra' | 'rowExtra'>;
export type Need = { col: number; row: number };
export type Growth = { more: Need; bonus: Bonus };

export type SettleOps<F extends SettleFit, R> = {
    uniform: boolean;
    base: Pitch;
    /** Bands already on the board (banded spacing only). */
    bonus: Bonus;
    setBonus(bonus: Bonus): void;
    /** Re-places the screens for this growth and measures the boxes against the arrows as they are drawn right now. */
    refit(growth: Growth): Promise<F>;
    /** Grows the board background and redraws every arrow at the current positions. */
    redraw(fit: F): Promise<R>;
    sameBoxes(a: F, b: F): boolean;
};

export const MAX_SETTLE = 6;

/**
 * Refits and redraws until the boxes stop changing, growing the grid by what the drawn boxes still lack. `first` is the
 * fit the caller's reroute was drawn against. Pitch growth always restarts from the base (`more` starts at zero) and is
 * only ever driven by a fit taken AFTER the arrows were redrawn at the current positions: a fit taken between moving the
 * screens and redrawing the arrows wraps lines still drawn at the old pitch, reads them as boxes that collide, and would
 * grow the pitch on every call. Returns the last fresh fit.
 */
export async function runSettle<F extends SettleFit, R>(ops: SettleOps<F, R>, first: F, reroute: R): Promise<{ fit: F; reroute: R; passes: number }> {
    let more: Need = { col: 0, row: 0 };
    let bonus = ops.bonus;
    let previous: Need | null = null;
    let frozen = false;
    let passes = 0;
    let last = reroute;
    let drawnAgainst: F = first;
    const growth = (): Growth => ({ more, bonus });
    let fit = await ops.refit(growth());
    while (fit.active && passes < MAX_SETTLE) {
        const short = hasDeficits(fit.deficits) && !frozen;
        if (short && ops.uniform) {
            const step = growPitch(ops.base, more, fit.deficits.uniform, previous);
            previous = fit.deficits.uniform;
            frozen = step.stop;
            more = step.more;
        } else if (short) {
            bonus = { colExtra: addBands(bonus.colExtra, fit.deficits.colExtra), rowExtra: addBands(bonus.rowExtra, fit.deficits.rowExtra) };
            ops.setBonus(bonus);
        }
        const again = short ? await ops.refit(growth()) : fit;
        passes++;
        const settled = !short && !again.extrasChanged && ops.sameBoxes(drawnAgainst, again);
        fit = again;
        if (settled && (frozen || !hasDeficits(again.deficits))) break;
        last = await ops.redraw(fit);
        drawnAgainst = fit;
        fit = await ops.refit(growth());
    }
    return { fit, reroute: last, passes };
}
