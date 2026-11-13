import { describe, expect, test } from 'bun:test';

import type { Deficits } from './gap-fix';
import { runSettle, type Growth, type SettleFit } from './settle';

type Fit = SettleFit & { pitch: number };
const NONE: Deficits = { colExtra: [], rowExtra: [], uniform: { col: 0, row: 0 } };
const BASE = { colWidth: 700, rowHeight: 1112 };
const NEED = 440;

/**
 * A board whose boxes need `required` px of column pitch. Arrows keep the pitch they were last drawn at, and a fit taken
 * while they are wider than the grid reads as a collision of that size, like boxes wrapping lines drawn at an old pitch.
 */
const board = (required: number, pitch: number, drawn: number) => {
    const state = { pitch, drawn, refits: 0, redraws: 0 };
    const refit = async (g: Growth): Promise<Fit> => {
        state.refits++;
        state.pitch = BASE.colWidth + NEED + g.more.col;
        const fresh = Math.max(0, required - state.pitch);
        const stale = state.drawn > state.pitch ? state.drawn - state.pitch : 0;
        const col = state.drawn === state.pitch ? fresh : Math.max(fresh, stale);
        return { active: true, extrasChanged: false, deficits: col ? { ...NONE, uniform: { col, row: 0 } } : NONE, boxes: `${state.pitch}:${state.drawn}`, pitch: state.pitch };
    };
    const ops = {
        uniform: true,
        base: BASE,
        bonus: { colExtra: [], rowExtra: [] },
        setBonus: () => undefined,
        refit,
        redraw: async () => {
            state.redraws++;
            state.drawn = state.pitch;
        },
        sameBoxes: (a: Fit, b: Fit) => a.boxes === b.boxes,
    };
    /** What reroute_flow does: refit (screens move to the base pitch), redraw the arrows, then settle. */
    const reroute = async () => {
        const first = await refit({ more: { col: 0, row: 0 }, bonus: { colExtra: [], rowExtra: [] } });
        await ops.redraw();
        return runSettle(ops, first, undefined);
    };
    return { state, reroute };
};

describe('settle pitch', () => {
    test('a second reroute with nothing changed leaves the pitch where the first left it', async () => {
        const b = board(1500, 1140, 1140);
        const first = await b.reroute();
        const second = await b.reroute();
        expect(first.fit.pitch).toBe(1500);
        expect(second.fit.pitch).toBe(first.fit.pitch);
        expect(b.state.pitch).toBe(1500);
    });

    test('arrows still drawn at an old, wider pitch do not grow the pitch', async () => {
        const b = board(1000, 1704, 1704);
        const out = await b.reroute();
        expect(out.fit.pitch).toBe(1140);
        expect((await b.reroute()).fit.pitch).toBe(1140);
    });

    test('the pitch shrinks back when the need has dropped', async () => {
        const grown = board(1500, 1140, 1140);
        expect((await grown.reroute()).fit.pitch).toBe(1500);
        const dropped = board(900, grown.state.pitch, grown.state.drawn);
        expect((await dropped.reroute()).fit.pitch).toBe(1140);
    });

    test('growth never passes one base pitch, however much the boxes lack', async () => {
        const b = board(9000, 1140, 1140);
        expect((await b.reroute()).fit.pitch).toBe(BASE.colWidth + NEED + BASE.colWidth);
    });

    test('a board that needs nothing settles without a redraw beyond the caller one', async () => {
        const b = board(500, 1140, 1140);
        const out = await b.reroute();
        expect(out.passes).toBe(1);
        expect(b.state.redraws).toBe(1);
    });
});
