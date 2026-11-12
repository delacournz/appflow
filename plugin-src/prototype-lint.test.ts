import { describe, expect, test } from 'bun:test';

import { isInformational, lintPrototype, type ProtoArrow, type ProtoReaction } from './prototype-lint';

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
