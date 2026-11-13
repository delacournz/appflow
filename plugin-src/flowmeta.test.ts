import { describe, expect, test } from 'bun:test';
import { FULL_SPAN } from './tracks';

import {
    arrowGroupName,
    cellOfRect,
    destinationsOf,
    parseArrowMeta,
    parseBoardMeta,
    parseGroupMeta,
    parseScreenMeta,
    setNavigateTarget,
    stableArrowOrder,
    type ArrowMeta,
    type BoardMeta,
    type ReactionLike,
    type ScreenMeta,
} from './flowmeta';

const board: BoardMeta = {
    v: 1,
    kind: 'board',
    originX: 100,
    originY: 200,
    colWidth: 700,
    rowHeight: 1112,
    screenW: 393,
    screenH: 852,
    labelOffset: 72,
    margin: 0,
    headingId: null,
    arrowsGroupId: '1:2',
    arrowStyle: { strokeVariableId: 'VariableID:21:3765', color: { r: 0.5, g: 0.8, b: 0.9 }, weight: 4, cornerRadius: 20 },
};
const screenMeta: ScreenMeta = { v: 1, kind: 'screen', boardId: '1:1', col: 2, row: 1, labelId: '3:1', routeId: null };
const arrow: ArrowMeta = { v: 1, kind: 'arrow', boardId: '1:1', from: 'a', to: 'b', trigger: null, label: 'Continue', mode: 'auto', vectorId: 'v', dotId: 'd', labelId: 'l' };

describe('meta parsing', () => {
    test('round-trips each kind through JSON', () => {
        expect(parseBoardMeta(JSON.stringify(board))).toEqual(board);
        expect(parseScreenMeta(JSON.stringify(screenMeta))).toEqual(screenMeta);
        expect(parseArrowMeta(JSON.stringify(arrow))).toEqual(arrow);
    });

    test('keeps an optional labelsGroupId and drops a malformed one', () => {
        expect(parseBoardMeta(JSON.stringify({ ...board, labelsGroupId: '9:9' }))?.labelsGroupId).toBe('9:9');
        expect(parseBoardMeta(JSON.stringify({ ...board, labelsGroupId: 5 }))?.labelsGroupId).toBeUndefined();
        expect(parseBoardMeta(JSON.stringify(board))?.labelsGroupId).toBeUndefined();
    });

    test('rejects empty, malformed, wrong-kind and wrong-version data', () => {
        expect(parseBoardMeta('')).toBeNull();
        expect(parseBoardMeta('{not json')).toBeNull();
        expect(parseBoardMeta(JSON.stringify(screenMeta))).toBeNull();
        expect(parseScreenMeta(JSON.stringify({ ...screenMeta, v: 2 }))).toBeNull();
        expect(parseArrowMeta(JSON.stringify({ ...arrow, mode: 'sideways' }))).toBeNull();
        expect(parseArrowMeta(JSON.stringify({ ...arrow, from: 5 }))).toBeNull();
        expect(parseBoardMeta(JSON.stringify({ ...board, arrowStyle: { weight: 4 } }))).toBeNull();
    });
});

describe('names and cells', () => {
    test('arrowGroupName', () => {
        expect(arrowGroupName('Home', 'Step 1', 'Continue')).toBe('Flow · Home → Step 1 · Continue');
    });

    test('cellOfRect rounds to the nearest grid cell', () => {
        expect(cellOfRect({ x: 100 + 1400 + 3, y: 200 + 1112 - 2, width: 393, height: 852 }, board)).toEqual({ col: 2, row: 1 });
    });
});

describe('stableArrowOrder', () => {
    test('sorts by source column, then target row, then id', () => {
        const items = [
            { id: 'c', sourceX: 1400, targetY: 0 },
            { id: 'b', sourceX: 700, targetY: 1112 },
            { id: 'a', sourceX: 700, targetY: 0 },
            { id: 'd', sourceX: 700, targetY: 0 },
        ];
        expect(stableArrowOrder(items).map((i) => i.id)).toEqual(['a', 'd', 'b', 'c']);
    });
});

describe('setNavigateTarget', () => {
    const nav = (dest: string, transition: string | null = 'SMART_ANIMATE'): ReactionLike => ({
        trigger: { type: 'ON_CLICK' },
        actions: [{ type: 'NODE', destinationId: dest, navigation: 'NAVIGATE', transition: transition ? { type: transition } : null }],
    });

    test('replaces the destination of an existing navigate reaction and keeps trigger and transition', () => {
        const r = setNavigateTarget([nav('old')], 'new');
        expect(r.replaced).toBe(true);
        expect(r.reactions).toEqual([nav('new')]);
    });

    test('keeps unknown fields and other reactions untouched', () => {
        const other: ReactionLike = { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'URL', url: 'x' }] };
        const first: ReactionLike = { trigger: { type: 'ON_PRESS' }, actions: [{ type: 'NODE', destinationId: 'old', navigation: 'NAVIGATE', transition: null, resetScrollPosition: true }] };
        const r = setNavigateTarget([other, first], 'new');
        expect(r.reactions[0]).toEqual(other);
        expect(r.reactions[1]).toEqual({ trigger: { type: 'ON_PRESS' }, actions: [{ type: 'NODE', destinationId: 'new', navigation: 'NAVIGATE', transition: null, resetScrollPosition: true }] });
    });

    test('handles the deprecated single `action` field', () => {
        const legacy: ReactionLike = { trigger: { type: 'ON_CLICK' }, action: { type: 'NODE', destinationId: 'old', navigation: 'NAVIGATE', transition: null } };
        const r = setNavigateTarget([legacy], 'new');
        expect(r.reactions).toEqual([{ trigger: { type: 'ON_CLICK' }, action: { type: 'NODE', destinationId: 'new', navigation: 'NAVIGATE', transition: null } }]);
    });

    test('adds an on-click navigate when there is none', () => {
        const r = setNavigateTarget([], 'new');
        expect(r.replaced).toBe(false);
        expect(r.reactions).toEqual([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'new', navigation: 'NAVIGATE', transition: null }] }]);
    });

    test('only the first navigate reaction is replaced', () => {
        const r = setNavigateTarget([nav('a'), nav('b')], 'new');
        expect(r.reactions).toEqual([nav('new'), nav('b')]);
    });
});

describe('screen build data', () => {
    const old: ScreenMeta = { v: 1, kind: 'screen', boardId: '1:1', col: 0, row: 0, labelId: null, routeId: null };
    test('old meta still parses', () => expect(parseScreenMeta(JSON.stringify(old))).toEqual(old));
    test('round-trips build and badgeId', () => {
        const next: ScreenMeta = { ...old, badgeId: '5:5', build: { status: 'drift', verifiedAt: '2026-11-03', commit: 'abc', notes: 'Copy' } };
        expect(parseScreenMeta(JSON.stringify(next))).toEqual(next);
    });
    test('rejects a bad build or badgeId', () => {
        expect(parseScreenMeta(JSON.stringify({ ...old, build: { status: 'nope' } }))).toBeNull();
        expect(parseScreenMeta(JSON.stringify({ ...old, badgeId: 3 }))).toBeNull();
    });
});

describe('destinationsOf', () => {
    test('lists every node destination once, from actions and the legacy action field', () => {
        const reactions: ReactionLike[] = [
            { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: 'a', navigation: 'NAVIGATE' }, { type: 'URL', url: 'x' }] },
            { trigger: { type: 'ON_HOVER' }, action: { type: 'NODE', destinationId: 'b', navigation: 'OVERLAY' } },
            { trigger: { type: 'ON_PRESS' }, actions: [{ type: 'NODE', destinationId: 'a', navigation: 'NAVIGATE' }, { type: 'NODE', destinationId: null }] },
        ];
        expect(destinationsOf(reactions)).toEqual(['a', 'b']);
    });
});

describe('board extras', () => {
    const base = { v: 1, kind: 'board', originX: 0, originY: 0, colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852, labelOffset: 80, margin: 80, headingId: null, arrowsGroupId: 'a', arrowStyle: { strokeVariableId: null, color: { r: 0, g: 0, b: 0 }, weight: 2, cornerRadius: 20 } };
    test('old boards without extras parse unchanged', () => {
        const m = parseBoardMeta(JSON.stringify(base));
        expect(m?.colExtra).toBeUndefined();
        expect(m?.rowExtra).toBeUndefined();
    });
    test('extras round-trip and junk is dropped', () => {
        const m = parseBoardMeta(JSON.stringify({ ...base, colExtra: { 2: 100, 3: -1 }, rowExtra: 'x' }));
        expect(m?.colExtra).toEqual([{ at: 2, from: 0, to: FULL_SPAN, px: 100 }]);
        expect(m?.rowExtra).toBeUndefined();
    });
    test('gapExtra round-trips and empty or junk is dropped', () => {
        const gap = { colExtra: [], rowExtra: [{ at: 8, from: 11, to: 25, px: 160 }] };
        expect(parseBoardMeta(JSON.stringify({ ...base, gapExtra: gap }))?.gapExtra).toEqual(gap);
        expect(parseBoardMeta(JSON.stringify({ ...base, gapExtra: { colExtra: [], rowExtra: [] } }))?.gapExtra).toBeUndefined();
        expect(parseBoardMeta(JSON.stringify({ ...base, gapExtra: 'x' }))?.gapExtra).toBeUndefined();
    });
    test('cellOfRect reads widened boundaries', () => {
        expect(cellOfRect({ x: 1500, y: 0 }, { ...base, colExtra: { 2: 100 } })).toEqual({ col: 2, row: 0 });
        expect(cellOfRect({ x: 1400, y: 0 }, base)).toEqual({ col: 2, row: 0 });
    });
});

describe('flow group meta', () => {
    const ok = { boardId: 'b', name: 'Passkeys', screenIds: ['1:1', '1:2', '1:1'], rectId: 'r', titleId: 't', style: { color: '#FFFFFF', strokeWeight: 4, titleSize: 96 } };
    test('round-trips, dedupes screen ids and keeps parentId', () => {
        const m = parseGroupMeta(JSON.stringify({ ...ok, parentId: 'p' }));
        expect(m?.screenIds).toEqual(['1:1', '1:2']);
        expect(m?.parentId).toBe('p');
        expect(parseGroupMeta(JSON.stringify(ok))?.parentId).toBeUndefined();
    });
    test('a legacy style (no padding) migrates: 4px stroke becomes 12, padding and title bar defaults fill in', () => {
        const m = parseGroupMeta(JSON.stringify(ok));
        expect(m?.style).toEqual({ color: '#FFFFFF', strokeWeight: 12, titleSize: 96, padding: 160, titleFill: '#2C2C2C', titleColor: '#FFFFFF' });
        const custom = parseGroupMeta(JSON.stringify({ ...ok, style: { ...ok.style, strokeWeight: 6 } }));
        expect(custom?.style.strokeWeight).toBe(6);
    });
    test('a full style keeps its values, even a 4px stroke', () => {
        const style = { color: '#FF0000', strokeWeight: 4, titleSize: 50, padding: 90, titleFill: '#111111', titleColor: '#EEEEEE' };
        expect(parseGroupMeta(JSON.stringify({ ...ok, style }))?.style).toEqual(style);
    });
    test('rejects a bad title fill or padding', () => {
        expect(parseGroupMeta(JSON.stringify({ ...ok, style: { ...ok.style, titleFill: 'dark' } }))).toBeNull();
        expect(parseGroupMeta(JSON.stringify({ ...ok, style: { ...ok.style, padding: 0 } }))).toBeNull();
    });
    test('rejects malformed data', () => {
        expect(parseGroupMeta('')).toBeNull();
        expect(parseGroupMeta('nope')).toBeNull();
        expect(parseGroupMeta(JSON.stringify({ ...ok, screenIds: [1] }))).toBeNull();
        expect(parseGroupMeta(JSON.stringify({ ...ok, style: { ...ok.style, color: 'white' } }))).toBeNull();
        expect(parseGroupMeta(JSON.stringify({ ...ok, style: { ...ok.style, titleSize: 0 } }))).toBeNull();
        expect(parseGroupMeta(JSON.stringify({ ...ok, parentId: 3 }))).toBeNull();
    });
    test('screen meta accepts flowGroupId and rejects a non-string', () => {
        const s = { v: 1, kind: 'screen', boardId: 'b', col: 0, row: 0, labelId: null, routeId: null };
        expect(parseScreenMeta(JSON.stringify({ ...s, flowGroupId: 'g' }))?.flowGroupId).toBe('g');
        expect(parseScreenMeta(JSON.stringify({ ...s, flowGroupId: null }))).not.toBeNull();
        expect(parseScreenMeta(JSON.stringify({ ...s, flowGroupId: 5 }))).toBeNull();
    });
});

describe('layout grid meta', () => {
    test('spacing grouped is a valid board mode; unknown modes are dropped', () => {
        expect(parseBoardMeta(JSON.stringify({ ...board, spacing: 'grouped' }))?.spacing).toBe('grouped');
        expect(parseBoardMeta(JSON.stringify({ ...board, spacing: 'wobbly' }))?.spacing).toBeUndefined();
    });

    test('a screen keeps its layoutId; a non-string one is refused; old screens without it still parse', () => {
        expect(parseScreenMeta(JSON.stringify({ ...screenMeta, layoutId: 'g1' }))?.layoutId).toBe('g1');
        expect(parseScreenMeta(JSON.stringify({ ...screenMeta, layoutId: 4 }))).toBeNull();
        expect(parseScreenMeta(JSON.stringify(screenMeta))?.layoutId).toBeUndefined();
    });

    test('a group keeps its layout origin; a malformed one is dropped, not fatal', () => {
        const ok = { boardId: 'b', name: 'Passkeys', screenIds: ['1:1'], rectId: 'r', titleId: 't', style: { color: '#FFFFFF', strokeWeight: 12, titleSize: 96 } };
        expect(parseGroupMeta(JSON.stringify({ ...ok, layout: { originX: 900, originY: 40 } }))?.layout).toEqual({ originX: 900, originY: 40 });
        expect(parseGroupMeta(JSON.stringify({ ...ok, layout: { originX: 'a', originY: 40 } }))?.layout).toBeUndefined();
        expect(parseGroupMeta(JSON.stringify(ok))?.layout).toBeUndefined();
    });
});
