import { describe, expect, test } from 'bun:test';

import { isInformational, lintPrototype as lint, TAB_ARROW_LABEL, TAB_BAR_NAME, type ProtoArrow, type ProtoReaction } from './prototype-lint';

const lintPrototype = (...args: Parameters<typeof lint>) => lint(...args).issues;

const screens = [
    { id: 's1', name: 'Setting up this device' },
    { id: 's2', name: "What's your name?" },
    { id: 's3', name: 'Passkeys · none' },
    { id: 's4', name: 'Device list' },
];
const click = (nodeId: string, screenId: string, destinationId: string): ProtoReaction => ({ nodeId, screenId, trigger: 'ON_CLICK', destinationId });
const timer = (screenId: string, destinationId: string): ProtoReaction => ({ nodeId: screenId, screenId, trigger: 'AFTER_TIMEOUT', destinationId });
const arrow = (id: string, from: string, to: string, trigger: string | null): ProtoArrow => ({ id, from, to, trigger });
const kinds = (r: ReturnType<typeof lintPrototype>) => r.map((i) => i.kind);

describe('lintPrototype', () => {
    test('matching trigger and reaction, no stray reactions: clean', () => {
        expect(lintPrototype(screens, [arrow('a1', 's1', 's2', 'b1')], [click('b1', 's1', 's2')])).toEqual([]);
    });

    test('a trigger that navigates elsewhere is a mismatch carrying both destinations', () => {
        const r = lintPrototype(screens, [arrow('a1', 's4', 's2', 'btn')], [click('btn', 's4', 's3'), click('btn', 's4', 's2')].slice(0, 1));
        expect(kinds(r)).toContain('prototype-mismatch');
        const m = r.find((i) => i.kind === 'prototype-mismatch');
        expect(m).toMatchObject({ arrowId: 'a1', sourceName: 'Device list', targetName: "What's your name?", reactionNodeId: 'btn', destinationId: 's3' });
    });

    test('a trigger with no navigate reaction at all is a mismatch with a null destination', () => {
        const r = lintPrototype(screens, [arrow('a1', 's1', 's2', 'b1')], []);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ kind: 'prototype-mismatch', destinationId: null });
    });

    test('a reaction to another board screen with no arrow is reported, including a screen-level timer', () => {
        const r = lintPrototype(screens, [], [timer('s1', 's2'), click('inner', 's1', 's3')]);
        expect(kinds(r)).toEqual(['prototype-without-arrow', 'prototype-without-arrow']);
        expect(r[0]).toMatchObject({ sourceName: 'Setting up this device', targetName: "What's your name?", reactionNodeId: 's1', destinationId: 's2' });
        expect(r[1]).toMatchObject({ reactionNodeId: 'inner', destinationId: 's3' });
    });

    test('the Remove device button linked to Passkeys is caught when no arrow covers that pair', () => {
        const r = lintPrototype(screens, [arrow('a1', 's4', 's2', 'cta')], [click('cta', 's4', 's2'), click('remove', 's4', 's3')]);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ kind: 'prototype-without-arrow', reactionNodeId: 'remove', targetName: 'Passkeys · none' });
    });

    test('reactions to nodes that are not board screens, and to the same screen, are ignored', () => {
        expect(lintPrototype(screens, [], [click('x', 's1', 'overlay'), click('y', 's1', 's1')])).toEqual([]);
    });

    test('an auto arrow needs a frame timer or a reaction to its target; otherwise it is informational', () => {
        const a = [arrow('a1', 's1', 's2', null)];
        expect(lintPrototype(screens, a, [timer('s1', 's2')])).toEqual([]);
        expect(lintPrototype(screens, a, [timer('s1', 's3')]).map((i) => i.kind)).toEqual(['prototype-without-arrow']);
        expect(lintPrototype(screens, a, [click('deep', 's1', 's2')])).toEqual([]);
        const r = lintPrototype(screens, a, []);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ kind: 'auto-arrow-no-prototype', severity: 'info', arrowId: 'a1' });
        expect(isInformational(r[0] as { severity: string })).toBe(true);
    });
});

describe('lint dedupe and tab-bar exemptions', () => {
    const tab = (nodeId: string, screenId: string, destinationId: string, ancestors: string[], name = 'Tab'): ProtoReaction => ({
        nodeId,
        screenId,
        trigger: 'ON_CLICK',
        destinationId,
        nodeName: name,
        ancestorNames: ancestors,
    });

    test('the same node and destination is reported once, however often it was read', () => {
        const dup = [click('b', 's1', 's2'), click('b', 's1', 's2'), click('b', 's1', 's2'), click('b', 's1', 's2')];
        expect(lint(screens, [], dup).issues).toHaveLength(1);
        expect(lint(screens, [], [click('b', 's1', 's2'), click('b', 's1', 's3')]).issues).toHaveLength(2);
    });

    test('a copy inside an instance (I{instance};{inner}) is dropped when the instance holds the same reaction', () => {
        const r = lint(screens, [], [click('9:1', 's1', 's2'), click('I9:1;4:4', 's1', 's2')]);
        expect(r.issues.map((i) => i.reactionNodeId)).toEqual(['9:1']);
        const lone = lint(screens, [], [click('I9:1;4:4', 's1', 's2')]);
        expect(lone.issues.map((i) => i.reactionNodeId)).toEqual(['I9:1;4:4']);
    });

    test('a reaction on a tab bar, or inside one, is exempt and counted', () => {
        expect(TAB_BAR_NAME.test('Tab bar')).toBe(true);
        expect(TAB_BAR_NAME.test('bottom-nav')).toBe(false);
        expect(TAB_BAR_NAME.test('Bottom Nav')).toBe(true);
        expect(TAB_BAR_NAME.test('Navigation bar')).toBe(true);
        expect(TAB_BAR_NAME.test('Button')).toBe(false);
        const r = lint(screens, [], [tab('t1', 's1', 's3', ['Frame', 'Tab bar']), tab('t2', 's1', 's2', [], 'TabBar')]);
        expect(r.issues).toEqual([]);
        expect(r.exemptCount).toBe(2);
    });

    test('a reaction to a tab root is exempt when the board\'s own tab arrows reach it', () => {
        expect(TAB_ARROW_LABEL.test('Tap Pay')).toBe(true);
        expect(TAB_ARROW_LABEL.test('Tap Continue')).toBe(false);
        const byLabel = [{ ...arrow('x', 's4', 's3', 'tabbtn'), label: 'Tap Pay' }];
        const r = lint(screens, byLabel, [click('tabbtn', 's4', 's3'), click('other', 's1', 's3'), click('c', 's1', 's2')]);
        expect(r.issues.map((i) => i.reactionNodeId)).toEqual(['c']);
        expect(r.exemptCount).toBe(1);
        const byPlace = [{ ...arrow('y', 's4', 's2', 'tb'), triggerAncestorNames: ['Account', 'Tab bar'] }];
        const q = lint(screens, byPlace, [click('tb', 's4', 's2'), click('z', 's1', 's2')]);
        expect(q.issues).toEqual([]);
        expect(q.exemptCount).toBe(1);
    });

    test('issues carry the name of the control holding the reaction', () => {
        const r = lint(screens, [], [{ ...click('b', 's1', 's2'), nodeName: 'Remove device' }]);
        expect(r.issues[0]).toMatchObject({ triggerName: 'Remove device' });
        const m = lint(screens, [{ ...arrow('a', 's1', 's2', 'btn'), triggerName: 'Continue' }], []);
        expect(m.issues[0]).toMatchObject({ kind: 'prototype-mismatch', triggerName: 'Continue' });
    });

    test('fixture: a Home variant with duplicated tab links reports only the real strays', () => {
        const names = [{ id: 'home', name: 'Home' }, { id: 'home2', name: 'Home · loaded' }, { id: 'pay', name: 'Pay' }, { id: 'act', name: 'Activity' }, { id: 'acct', name: 'Account' }, { id: 'det', name: 'Device details' }];
        const arrows: ProtoArrow[] = [
            { id: 'a1', from: 'home', to: 'pay', trigger: 'tab-pay', label: 'Tap Pay' },
            { id: 'a2', from: 'home', to: 'acct', trigger: 'tab-acct', label: 'Tap Account' },
            { id: 'a3', from: 'home', to: 'det', trigger: 'row', label: 'Open device' },
        ];
        const home2Tabs = ['pay', 'act', 'acct', 'home'].flatMap((dest) => [
            tab(`bar-${dest}`, 'home2', dest, ['Tab bar']),
            tab(`bar-${dest}`, 'home2', dest, ['Tab bar']),
            tab(`Ibar-${dest};4:4`, 'home2', dest, ['Tab bar']),
        ]);
        const reactions: ProtoReaction[] = [
            click('tab-pay', 'home', 'pay'),
            click('tab-acct', 'home', 'acct'),
            click('row', 'home', 'det'),
            ...home2Tabs,
            click('stray', 'home2', 'det'),
            click('stray', 'home2', 'det'),
        ];
        const r = lint(names, arrows, reactions);
        expect(r.issues.map((i) => [i.kind, i.reactionNodeId])).toEqual([['prototype-without-arrow', 'stray']]);
        expect(r.exemptCount).toBe(4);
    });
});

describe('tab hotspots named by tab', () => {
    const names = [
        { id: 'home', name: 'Home' },
        { id: 'home2', name: 'Home · empty' },
        { id: 'pay', name: 'Pay' },
        { id: 'act', name: 'Activity' },
        { id: 'acct', name: 'Account' },
        { id: 'acctv', name: 'Account · verify your identity' },
        { id: 'dev', name: 'Device details' },
    ];
    const hotspot = (nodeId: string, screenId: string, destinationId: string, tab: string): ProtoReaction => ({ nodeId, screenId, trigger: 'ON_CLICK', destinationId, nodeName: `Hotspot · ${tab}`, ancestorNames: [] });
    const arrows: ProtoArrow[] = [
        { id: 'a1', from: 'home', to: 'pay', trigger: 'h1', triggerName: 'Hotspot · Pay', label: 'Pay' },
        { id: 'a2', from: 'home', to: 'acct', trigger: 'h2', triggerName: 'Hotspot · Account' },
        { id: 'a3', from: 'home', to: 'act', trigger: 'h3', triggerName: 'Activity Tab' },
        { id: 'a4', from: 'home', to: 'home2', trigger: 'h4', triggerName: 'Hotspot · Home' },
    ];

    test('hotspots named after a tab are exempt on every other screen, and so is any destination that is a tab root or its variant', () => {
        const reactions: ProtoReaction[] = [
            hotspot('h1', 'home', 'pay', 'Pay'),
            hotspot('h2', 'home', 'acct', 'Account'),
            hotspot('h3', 'home', 'act', 'Activity'),
            hotspot('h4', 'home', 'home2', 'Home'),
            hotspot('x1', 'dev', 'pay', 'Pay'),
            hotspot('x2', 'dev', 'act', 'Activity'),
            hotspot('x3', 'dev', 'home', 'Home'),
            { nodeId: 'btn', screenId: 'dev', trigger: 'ON_CLICK', destinationId: 'acctv', nodeName: 'Verify', ancestorNames: [] },
            { nodeId: 'stray', screenId: 'dev', trigger: 'ON_CLICK', destinationId: 'home2', nodeName: 'Remove device', ancestorNames: [] },
        ];
        const r = lint(names, arrows, reactions);
        expect(r.issues.map((i) => i.reactionNodeId)).toEqual([]);
        expect(r.exemptCount).toBe(5);
    });

    test('a hotspot named after a non-tab screen is not exempt', () => {
        const r = lint(names, arrows, [{ nodeId: 'z', screenId: 'home', trigger: 'ON_CLICK', destinationId: 'dev', nodeName: 'Hotspot · Device details', ancestorNames: [] }]);
        expect(r.issues.filter((i) => i.kind === 'prototype-without-arrow').map((i) => i.reactionNodeId)).toEqual(['z']);
    });
});
