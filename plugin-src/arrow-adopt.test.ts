import { describe, expect, test } from 'bun:test';

import { endpointsFromName, pairLooseParts, resolveArrowEnds, resolveEndpoint, type ScreenRef } from './arrow-adopt';

const W = 393;
const H = 852;
const sc = (id: string, name: string, x: number, y: number): ScreenRef => ({ id, name, rect: { x, y, width: W, height: H } });
const A = sc('a', 'Launch', 0, 0);
const B = sc('b', 'Email', 700, 0);
const C = sc('c', 'Email · code not sent', 1400, 0);
const D = sc('d', 'Welcome', 0, 1400);
const all = [A, B, C, D];

describe('resolveEndpoint', () => {
    test('an end on a screen is exact', () => {
        const r = resolveEndpoint({ x: W + 4, y: 300 }, all);
        expect(r.kind).toBe('exact');
    });
    test('an end shifted 300px off snaps to the one near screen', () => {
        const far = sc('b2', 'Far', 1400, 0);
        const r = resolveEndpoint({ x: 1100, y: 300 }, [A, far]);
        expect(r.kind === 'snapped' && r.screen.id).toBe('b2');
    });
    test('an end midway between two screens is ambiguous, not guessed', () => {
        const r = resolveEndpoint({ x: (W + 700) / 2, y: 300 }, [A, B]);
        expect(r).toEqual({ kind: 'ambiguous', candidates: ['a', 'b'] });
    });
    test('an end further than the reach is none', () => {
        expect(resolveEndpoint({ x: 5000, y: 5000 }, all)).toEqual({ kind: 'none' });
    });
    test('a one-screen name hint wins however far the end is', () => {
        const r = resolveEndpoint({ x: 5000, y: 5000 }, all, { hint: [C] });
        expect(r.kind === 'named' && r.screen.id).toBe('c');
    });
    test('hints with several same-named screens pick the nearest only when clearly nearer', () => {
        const near = sc('n', 'X', 100, 0);
        const far = sc('f', 'X', 3000, 0);
        const r = resolveEndpoint({ x: 500, y: 300 }, all, { hint: [near, far] });
        expect(r.kind === 'named' && r.screen.id).toBe('n');
        const tie = resolveEndpoint({ x: 1746, y: 300 }, all, { hint: [sc('t1', 'X', 1000, 0), sc('t2', 'X', 2100, 0)] });
        expect(tie.kind).toBe('ambiguous');
    });
    test('exclude drops the source screen', () => {
        const r = resolveEndpoint({ x: W - 5, y: 300 }, [A, B], { exclude: 'a' });
        expect(r.kind === 'snapped' && r.screen.id).toBe('b');
    });
});

describe('endpointsFromName', () => {
    test('splits on the arrow even when names contain a dot separator', () => {
        const e = endpointsFromName('Flow · Launch → Email · code not sent · Code can\'t send', all);
        expect(e.from.map((s) => s.id)).toEqual(['a']);
        expect(e.to.map((s) => s.id)).toEqual(['c']);
    });
    test('prefers the longest pair, so "Email" does not swallow "Email · code not sent"', () => {
        const e = endpointsFromName('Flow · Email → Email · code not sent · Code can\'t send', all);
        expect(e.from.map((s) => s.id)).toEqual(['b']);
        expect(e.to.map((s) => s.id)).toEqual(['c']);
    });
    test('an unknown name yields nothing', () => {
        expect(endpointsFromName('Flow · Nope → Gone · x', all)).toEqual({ from: [], to: [] });
        expect(endpointsFromName('Arrow group', all)).toEqual({ from: [], to: [] });
    });
});

describe('resolveArrowEnds', () => {
    test('exact ends: not stale', () => {
        const r = resolveArrowEnds({ x: W, y: 300 }, { x: 700, y: 300 }, all);
        expect(r.ok && [r.from.id, r.to.id, r.stale]).toEqual(['a', 'b', false]);
    });
    test('both ends shifted by 600px resolve through the group name and are stale', () => {
        const r = resolveArrowEnds({ x: W + 600, y: 300 }, { x: 700 + 600, y: 300 }, all, { groupName: 'Flow · Launch → Email · Code' });
        expect(r.ok && [r.from.id, r.to.id, r.stale]).toEqual(['a', 'b', true]);
    });
    test('remembered ids that still exist win over geometry', () => {
        const r = resolveArrowEnds({ x: 5000, y: 5000 }, { x: 5000, y: 5000 }, all, { from: 'd', to: 'a' });
        expect(r.ok && [r.from.id, r.to.id]).toEqual(['d', 'a']);
    });
    test('stale remembered ids (screens gone) fall back to geometry', () => {
        const r = resolveArrowEnds({ x: W, y: 300 }, { x: 700, y: 300 }, all, { from: 'x1', to: 'x2' });
        expect(r.ok && [r.from.id, r.to.id]).toEqual(['a', 'b']);
    });
    test('an ambiguous end is reported with its candidates', () => {
        const r = resolveArrowEnds({ x: W, y: 300 }, { x: (W + 700) / 2 + 700 + 20, y: 300 }, [A, B, C]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('ambiguous-target');
    });
    test('same screen at both ends is refused', () => {
        const r = resolveArrowEnds({ x: 10, y: 10 }, { x: 20, y: 20 }, [A]);
        expect(r.ok).toBe(false);
    });
    test('no screen in reach of the tail', () => {
        const r = resolveArrowEnds({ x: 9000, y: 9000 }, { x: 0, y: 0 }, all);
        expect(r).toEqual({ ok: false, reason: 'no-source-screen' });
    });
});

describe('pairLooseParts', () => {
    const v = (id: string, tx: number, ty: number) => ({ id, tail: { x: tx, y: ty }, mid: { x: tx + 100, y: ty + 40 } });
    test('pairs each vector with its own dot and label despite small offsets', () => {
        const vectors = [v('v1', 0, 0), v('v2', 0, 300)];
        const dots = [{ id: 'd2', at: { x: 4, y: 303 } }, { id: 'd1', at: { x: -3, y: 2 } }];
        const labels = [{ id: 'l2', at: { x: 90, y: 355 } }, { id: 'l1', at: { x: 110, y: 30 } }];
        const r = pairLooseParts(vectors, dots, labels);
        expect(r.unpaired).toEqual([]);
        expect(r.pairs).toEqual([{ vectorId: 'v1', dotId: 'd1', labelId: 'l1' }, { vectorId: 'v2', dotId: 'd2', labelId: 'l2' }]);
    });
    test('a dot serves one vector; the loser is reported', () => {
        const r = pairLooseParts([v('v1', 0, 0), v('v2', 20, 0)], [{ id: 'd', at: { x: 0, y: 0 } }], [{ id: 'l', at: { x: 100, y: 40 } }, { id: 'l2', at: { x: 120, y: 40 } }]);
        expect(r.pairs).toHaveLength(1);
        expect(r.unpaired).toEqual([{ vectorId: 'v2', reason: 'no-start-dot' }]);
    });
    test('a missing label is reported', () => {
        const r = pairLooseParts([v('v1', 0, 0)], [{ id: 'd', at: { x: 0, y: 0 } }], []);
        expect(r.unpaired).toEqual([{ vectorId: 'v1', reason: 'no-label' }]);
    });
});
