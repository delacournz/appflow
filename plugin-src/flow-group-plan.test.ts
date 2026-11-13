import { describe, expect, test } from 'bun:test';

import {
    extrasMoves,
    groupBoundaryExtras,
    holderIndex,
    mergeStyle,
    planAssign,
    hexToRgb,
    planCreateGroup,
    planDeleteGroup,
    planUpdateGroup,
    reconcileMembership,
    sameExtras,
    type GroupRec,
} from './flow-group-plan';

const g = (id: string, screenIds: string[], parentId?: string): GroupRec => ({ id, name: id.toUpperCase(), screenIds, ...(parentId ? { parentId } : {}) });
const onBoard = new Set(['a', 'b', 'c', 'd', 'e']);

describe('planCreateGroup', () => {
    test('accepts free screens, dedupes ids', () => {
        const r = planCreateGroup([], { name: ' Passkeys ', screenIds: ['a', 'b', 'a'] }, onBoard);
        expect(r).toEqual({ ok: true, name: 'Passkeys', screenIds: ['a', 'b'], parentId: undefined, takeFromParent: [] });
    });
    test('rejects empty name, no screens, unknown screens', () => {
        expect(planCreateGroup([], { name: ' ', screenIds: ['a'] }, onBoard).ok).toBe(false);
        expect(planCreateGroup([], { name: 'X', screenIds: [] }, onBoard).ok).toBe(false);
        const r = planCreateGroup([], { name: 'X', screenIds: ['zzz'] }, onBoard);
        expect(r.ok).toBe(false);
    });
    test('rejects a screen already in a group at the same level', () => {
        const r = planCreateGroup([g('p', ['a'])], { name: 'X', screenIds: ['a', 'b'] }, onBoard);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('already in');
    });
    test('child takes screens from its parent, but not from a sibling', () => {
        const parent = g('p', ['a', 'b']);
        const ok = planCreateGroup([parent], { name: 'X', screenIds: ['a'], parentId: 'p' }, onBoard);
        expect(ok).toMatchObject({ ok: true, parentId: 'p', takeFromParent: ['a'] });
        const sibling = g('s', ['c'], 'p');
        expect(planCreateGroup([parent, sibling], { name: 'X', screenIds: ['c'], parentId: 'p' }, onBoard).ok).toBe(false);
    });
    test('rejects missing parent and depth over one', () => {
        expect(planCreateGroup([], { name: 'X', screenIds: ['a'], parentId: 'nope' }, onBoard).ok).toBe(false);
        const r = planCreateGroup([g('p', ['b']), g('k', ['c'], 'p')], { name: 'X', screenIds: ['a'], parentId: 'k' }, onBoard);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('one level');
    });
});

describe('planUpdateGroup', () => {
    const groups = [g('p', ['a', 'b']), g('q', ['c'])];
    test('rename, add and remove', () => {
        const r = planUpdateGroup(groups, 'p', { name: 'New', add: ['d'], remove: ['a'] }, onBoard);
        expect(r).toMatchObject({ ok: true, name: 'New', screenIds: ['b', 'd'] });
    });
    test('cannot add a screen owned elsewhere or remove a non-member', () => {
        expect(planUpdateGroup(groups, 'p', { add: ['c'] }, onBoard).ok).toBe(false);
        expect(planUpdateGroup(groups, 'p', { remove: ['c'] }, onBoard).ok).toBe(false);
    });
    test('cannot empty a childless group', () => {
        const r = planUpdateGroup(groups, 'q', { remove: ['c'] }, onBoard);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('delete_flow_group');
    });
    test('may empty a parent that still has children', () => {
        const withKid = [g('p', ['a']), g('k', ['b'], 'p')];
        expect(planUpdateGroup(withKid, 'p', { remove: ['a'] }, onBoard).ok).toBe(true);
    });
    test('nest under a parent, promote with null, reject cycles and depth', () => {
        expect(planUpdateGroup(groups, 'q', { parentId: 'p' }, onBoard)).toMatchObject({ ok: true, parentId: 'p' });
        const nested = [g('p', ['a']), g('k', ['b'], 'p')];
        expect(planUpdateGroup(nested, 'k', { parentId: null }, onBoard)).toMatchObject({ ok: true, parentId: undefined });
        expect(planUpdateGroup(nested, 'k', { parentId: 'k' }, onBoard).ok).toBe(false);
        const three = [...nested, g('z', ['c'])];
        expect(planUpdateGroup(three, 'p', { parentId: 'z' }, onBoard).ok).toBe(false);
        expect(planUpdateGroup(three, 'z', { parentId: 'k' }, onBoard).ok).toBe(false);
    });
    test('a child may add screens its parent holds', () => {
        const nested = [g('p', ['a', 'b']), g('k', ['c'], 'p')];
        expect(planUpdateGroup(nested, 'k', { add: ['a'] }, onBoard)).toMatchObject({ ok: true, screenIds: ['c', 'a'], takeFromParent: ['a'] });
    });
    test('unknown group', () => {
        expect(planUpdateGroup(groups, 'nope', {}, onBoard).ok).toBe(false);
    });
});

describe('planDeleteGroup', () => {
    test('children are promoted, screens listed', () => {
        const r = planDeleteGroup([g('p', ['a']), g('k', ['b'], 'p'), g('x', ['c'])], 'p');
        expect(r).toEqual({ ok: true, screenIds: ['a'], promote: ['k'] });
        expect(planDeleteGroup([], 'p').ok).toBe(false);
    });
});

describe('reconcileMembership', () => {
    test('prunes missing screens, resolves duplicates, fixes screen flow ids and dangling parents', () => {
        const r = reconcileMembership(
            [g('p', ['a', 'gone', 'b']), g('q', ['b', 'c'], 'missing')],
            [
                { id: 'a', flowGroupId: 'p' },
                { id: 'b', flowGroupId: null },
                { id: 'c', flowGroupId: 'p' },
                { id: 'd', flowGroupId: 'p' },
            ],
        );
        expect(r.groups.map((x) => [x.id, x.screenIds, x.parentId])).toEqual([
            ['p', ['a', 'b'], undefined],
            ['q', ['c'], undefined],
        ]);
        expect(r.changedGroups.sort()).toEqual(['p', 'q']);
        expect(r.screenFixes).toEqual([
            { screenId: 'b', flowGroupId: 'p' },
            { screenId: 'c', flowGroupId: 'q' },
            { screenId: 'd', flowGroupId: null },
        ]);
    });
    test('consistent data changes nothing', () => {
        const r = reconcileMembership([g('p', ['a'])], [{ id: 'a', flowGroupId: 'p' }, { id: 'b' }]);
        expect(r.changedGroups).toEqual([]);
        expect(r.screenFixes).toEqual([]);
    });
});

describe('groupBoundaryExtras and extrasMoves', () => {
    const base = { colWidth: 700, rowHeight: 1112, screenW: 393, screenH: 852 };
    const screens = [
        { id: 'a', col: 0, row: 0 },
        { id: 'b', col: 1, row: 0 },
        { id: 'c', col: 0, row: 1 },
        { id: 'u', col: 2, row: 0 },
    ];
    test('no groups, no extras', () => {
        expect(groupBoundaryExtras([], screens, base)).toEqual({ colExtra: [], rowExtra: [] });
    });
    test('stacked groups widen the row boundary; the title fits', () => {
        const e = groupBoundaryExtras([g('p', ['a', 'b']), g('q', ['c'])], screens, base);
        expect(e.rowExtra.some((b) => b.at === 1 && b.px > 0)).toBe(true);
        expect(e.colExtra.some((b) => b.at === 2 && b.px > 0)).toBe(true);
        expect(e.colExtra.some((b) => b.at === 1)).toBe(false);
    });
    test('moves cover every screen whose track start changes', () => {
        const meta = { ...base, colExtra: undefined, rowExtra: undefined };
        const moves = extrasMoves(screens, meta, { colExtra: { 2: 100 }, rowExtra: { 1: 50 } });
        expect(moves.map((m) => m.id).sort()).toEqual(['c', 'u']);
        expect(moves.every((m) => m.from.col === m.to.col && m.from.row === m.to.row)).toBe(true);
        expect(extrasMoves(screens, { ...base, colExtra: { 2: 100 } }, { colExtra: { 2: 100 }, rowExtra: [] })).toEqual([]);
    });
    test('removing an extra moves the screens back', () => {
        const moves = extrasMoves(screens, { ...base, colExtra: { 2: 100 } }, { colExtra: [], rowExtra: [] });
        expect(moves.map((m) => m.id)).toEqual(['u']);
    });
});

describe('small helpers', () => {
    test('sameExtras ignores junk entries', () => {
        expect(sameExtras({ 1: 5 }, { 1: 5, 2: 0 })).toBe(true);
        expect(sameExtras(undefined, {})).toBe(true);
        expect(sameExtras({ 1: 5 }, { 1: 6 })).toBe(false);
    });
    test('holderIndex puts the holder just above the board background', () => {
        expect(holderIndex(['x', 'bg', 's1', 's2'], 'bg', null)).toBe(2);
        expect(holderIndex(['bg', 'h', 's1'], 'bg', 'h')).toBe(1);
        expect(holderIndex(['x', 'bg', 's1', 'h'], 'bg', 'h')).toBe(2);
        expect(holderIndex(['x'], 'bg', null)).toBe(1);
    });
    test('hexToRgb', () => {
        expect(hexToRgb('#FF8000')).toEqual({ r: 1, g: 128 / 255, b: 0 });
        expect(hexToRgb('nope')).toEqual({ r: 1, g: 1, b: 1 });
    });
});

describe('planAssign', () => {
    const groups = [g('p', ['a', 'b']), g('q', ['c'])];
    test('moves a screen between groups', () => {
        expect(planAssign(groups, 'a', 'q')).toEqual({ ok: true, changes: [{ id: 'p', screenIds: ['b'] }, { id: 'q', screenIds: ['c', 'a'] }] });
    });
    test('null leaves every group; same group is a no-op; unknown group fails', () => {
        expect(planAssign(groups, 'a', null)).toEqual({ ok: true, changes: [{ id: 'p', screenIds: ['b'] }] });
        expect(planAssign(groups, 'a', 'p')).toEqual({ ok: true, changes: [] });
        expect(planAssign(groups, 'a', 'zzz').ok).toBe(false);
    });
});

describe('mergeStyle', () => {
    const base = { color: '#FFFFFF', strokeWeight: 12, titleSize: 96, padding: 160, titleFill: '#2C2C2C', titleColor: '#FFFFFF' };
    test('overlays fields', () => {
        expect(mergeStyle(base, { color: '#FF0000', titleSize: 64 })).toEqual({ ok: true, style: { ...base, color: '#FF0000', titleSize: 64 } });
        expect(mergeStyle(base, undefined)).toEqual({ ok: true, style: base });
    });
    test('rejects junk', () => {
        expect(mergeStyle(base, { color: 'red' }).ok).toBe(false);
        expect(mergeStyle(base, { strokeWeight: 0 }).ok).toBe(false);
        expect(mergeStyle(base, { size: 3 }).ok).toBe(false);
        expect(mergeStyle(base, 'x').ok).toBe(false);
        expect(mergeStyle(base, { titleFill: 'dark' }).ok).toBe(false);
    });
    test('sets padding, title fill and colour; padding may not drop below the clearance', () => {
        expect(mergeStyle(base, { padding: 200, titleFill: '#101010', titleColor: '#EEEEEE' })).toEqual({ ok: true, style: { ...base, padding: 200, titleFill: '#101010', titleColor: '#EEEEEE' } });
        expect(mergeStyle(base, { padding: 10 }).ok).toBe(false);
    });
});
