import { describe, expect, test } from 'bun:test';

import {
    arrowGroupName,
    cellOfRect,
    parseArrowMeta,
    parseBoardMeta,
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
