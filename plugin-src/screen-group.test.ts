import { describe, expect, test } from 'bun:test';
import { parseScreenMeta, type ScreenMeta } from './flowmeta';
import { badgeBelongsTo, badgeFallbackOffset, isScreenGroupName, planGrouping, planUngroup, routeSlot, routeWidth, screenGroupName, screenNames, shiftTargets, upgradeScreenMeta, type GroupCandidate } from './screen-group';

const candidate = (over: Partial<GroupCandidate> = {}): GroupCandidate => ({
    frameId: 'f',
    frameName: 'Verified',
    labelId: 'l',
    routeId: 'r',
    parent: { id: 'page', type: 'PAGE', name: 'Page', childIds: ['bg', 'a', 'f', 'l', 'r', 'z', 'arrows'] },
    ...over,
});

describe('names', () => {
    test('group name', () => expect(screenGroupName('Verified')).toBe('Screen · Verified'));
    test('detects group names', () => {
        expect(isScreenGroupName('Screen · Verified')).toBe(true);
        expect(isScreenGroupName('Screen Verified')).toBe(false);
        expect(isScreenGroupName('Group 1')).toBe(false);
    });
    test('all five layer names', () => {
        expect(screenNames('New')).toEqual({ group: 'Screen · New', frame: 'New', label: 'Label · New', route: 'Route · New', badge: 'Badge · New' });
    });
});

describe('planGrouping', () => {
    test('groups page-level layers, label and route above the frame', () => {
        const plan = planGrouping(candidate());
        expect(plan).toEqual({ kind: 'group', name: 'Screen · Verified', memberIds: ['f', 'r', 'l'], index: 2 });
    });
    test('index counts only non-members before the frame', () => {
        const plan = planGrouping(candidate({ parent: { id: 'p', type: 'PAGE', name: 'P', childIds: ['l', 'r', 'a', 'f', 'z'] } }));
        expect(plan).toMatchObject({ kind: 'group', index: 1 });
    });
    test('missing label or route are left out', () => {
        const plan = planGrouping(candidate({ labelId: null, routeId: null }));
        expect(plan).toMatchObject({ kind: 'group', memberIds: ['f'] });
    });
    test('skips when already in an exact screen group', () => {
        const parent = { id: 'g', type: 'GROUP', name: 'Screen · Verified', childIds: ['f', 'r', 'l'] };
        expect(planGrouping(candidate({ parent }))).toEqual({ kind: 'already', groupId: 'g' });
    });
    test('already when the group lacks a layer the screen no longer has', () => {
        const parent = { id: 'g', type: 'GROUP', name: 'Screen · Verified', childIds: ['f', 'r'] };
        expect(planGrouping(candidate({ parent, labelId: null }))).toEqual({ kind: 'already', groupId: 'g' });
    });
    test('conflict when a screen group holds extra layers', () => {
        const parent = { id: 'g', type: 'GROUP', name: 'Screen · Verified', childIds: ['f', 'r', 'l', 'x'] };
        expect(planGrouping(candidate({ parent }))).toMatchObject({ kind: 'conflict' });
    });
    test('conflict when the label sits outside its screen group', () => {
        const parent = { id: 'g', type: 'GROUP', name: 'Screen · Verified', childIds: ['f', 'r'] };
        expect(planGrouping(candidate({ parent }))).toMatchObject({ kind: 'conflict' });
    });
    test('an unrelated group is nested into, not skipped', () => {
        const parent = { id: 'g', type: 'GROUP', name: 'Group 4', childIds: ['f', 'l', 'r'] };
        expect(planGrouping(candidate({ parent }))).toMatchObject({ kind: 'group', index: 0 });
    });
});

describe('upgradeScreenMeta', () => {
    const old: ScreenMeta = { v: 1, kind: 'screen', boardId: '1:1', col: 2, row: 1, labelId: '3:1', routeId: null };
    test('old meta parses without groupId', () => {
        const parsed = parseScreenMeta(JSON.stringify(old));
        expect(parsed).toEqual(old);
        expect(parsed?.groupId).toBeUndefined();
    });
    test('adds the group id and keeps the rest', () => {
        expect(upgradeScreenMeta(old, '9:9')).toEqual({ ...old, groupId: '9:9' });
    });
    test('round-trips through the parser', () => {
        const next = upgradeScreenMeta(old, '9:9');
        expect(parseScreenMeta(JSON.stringify(next))).toEqual(next);
    });
    test('parser rejects a non-string groupId', () => {
        expect(parseScreenMeta(JSON.stringify({ ...old, groupId: 4 }))).toBeNull();
        expect(parseScreenMeta(JSON.stringify({ ...old, groupId: null }))).toEqual({ ...old, groupId: null });
    });
});

describe('shiftTargets', () => {
    test('moves the group once when everything is inside it', () => {
        expect(shiftTargets({ frameId: 'f', groupId: 'g', frameParentId: 'g', labelId: 'l', labelParentId: 'g', routeId: 'r', routeParentId: 'g' })).toEqual(['g']);
    });
    test('moves loose label and route beside the group', () => {
        expect(shiftTargets({ frameId: 'f', groupId: 'g', frameParentId: 'g', labelId: 'l', labelParentId: 'page', routeId: null, routeParentId: null })).toEqual(['g', 'l']);
    });
    test('falls back to the parts when the frame left its group', () => {
        expect(shiftTargets({ frameId: 'f', groupId: 'g', frameParentId: 'page', labelId: 'l', labelParentId: 'page', routeId: 'r', routeParentId: 'page' })).toEqual(['f', 'l', 'r']);
    });
    test('ungrouped screens move the three layers', () => {
        expect(shiftTargets({ frameId: 'f', groupId: null, frameParentId: 'page', labelId: 'l', labelParentId: 'page', routeId: null, routeParentId: null })).toEqual(['f', 'l']);
    });
});

describe('badges', () => {
    test('screenNames includes the badge', () => {
        expect(screenNames('New').badge).toBe('Badge · New');
    });
    test('badge joins the group on top', () => {
        expect(planGrouping(candidate({ badgeId: 'b' }))).toMatchObject({ kind: 'group', memberIds: ['f', 'r', 'l', 'b'] });
    });
    test('a group holding the badge is already grouped', () => {
        const parent = { id: 'g', type: 'GROUP', name: 'Screen · Verified', childIds: ['f', 'r', 'l', 'b'] };
        expect(planGrouping(candidate({ parent, badgeId: 'b' }))).toEqual({ kind: 'already', groupId: 'g' });
    });
    test('moves a loose badge beside the group', () => {
        expect(shiftTargets({ frameId: 'f', groupId: 'g', frameParentId: 'g', labelId: null, labelParentId: null, routeId: null, routeParentId: null, badgeId: 'b', badgeParentId: 'page' })).toEqual(['g', 'b']);
    });
    test('ungrouped screens move the badge too', () => {
        expect(shiftTargets({ frameId: 'f', groupId: null, frameParentId: 'page', labelId: null, labelParentId: null, routeId: null, routeParentId: null, badgeId: 'b', badgeParentId: 'page' })).toEqual(['f', 'b']);
    });
});

describe('ungrouped anatomy', () => {
    const frame = { x: 1000, y: 500, width: 393, height: 852 };
    test('route slot is the old label line, 72 above the frame at its x', () => {
        expect(routeSlot(frame)).toEqual({ x: 1000, y: 428 });
    });
    test('badge fallback centres a 20 high pill on the 28 high line', () => {
        expect(badgeFallbackOffset(20)).toBe(68);
    });
    test('ungrouped screens without a label move frame, route and badge', () => {
        expect(shiftTargets({ frameId: 'f', groupId: null, frameParentId: 'page', labelId: null, labelParentId: null, routeId: 'r', routeParentId: 'page', badgeId: 'b', badgeParentId: 'page' })).toEqual(['f', 'r', 'b']);
    });
});

describe('planUngroup', () => {
    test('a grouped screen moves out and loses its label', () => {
        expect(planUngroup({ inScreenGroup: true, labelId: 'l', keepLabels: false })).toEqual({ moveOut: true, removeLabelId: 'l', labelId: null });
    });
    test('keepLabels keeps the label and its id', () => {
        expect(planUngroup({ inScreenGroup: true, labelId: 'l', keepLabels: true })).toEqual({ moveOut: true, removeLabelId: null, labelId: 'l' });
    });
    test('an ungrouped screen does not move but still drops a stray label', () => {
        expect(planUngroup({ inScreenGroup: false, labelId: 'l', keepLabels: false })).toEqual({ moveOut: false, removeLabelId: 'l', labelId: null });
    });
    test('idempotent on a clean ungrouped screen', () => {
        expect(planUngroup({ inScreenGroup: false, labelId: null, keepLabels: false })).toEqual({ moveOut: false, removeLabelId: null, labelId: null });
    });
});

describe('badgeBelongsTo', () => {
    const frame = { x: 1000, y: 500, width: 393, height: 852 };
    test('right-aligned pill on the line above the frame', () => {
        expect(badgeBelongsTo(frame, { x: 1393 - 60, y: 428, width: 60, height: 20 })).toBe(true);
    });
    test('another screen\'s pill does not', () => {
        expect(badgeBelongsTo(frame, { x: 1393 + 700 - 60, y: 428, width: 60, height: 20 })).toBe(false);
        expect(badgeBelongsTo(frame, { x: 1393 - 60, y: 428 + 1112, width: 60, height: 20 })).toBe(false);
    });
});

describe('routeWidth', () => {
    test('full frame width without a badge', () => expect(routeWidth(393, null)).toBe(393));
    test('stops 12 short of the badge', () => expect(routeWidth(393, 60)).toBe(321));
});
