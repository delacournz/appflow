import { describe, expect, test } from 'bun:test';

import type { SyncOp } from '../shared/design-ops';
import { codeCombo, fontAvailable, slotTarget, formatVariantName, hexToRgba, modeIdFor, parseVariantName, phaseOf, renameVariantProps } from './design-write';

describe('hexToRgba', () => {
    test('#RRGGBBAA to 0-1 channels', () => {
        expect(hexToRgba('#FF000080')).toEqual({ r: 1, g: 0, b: 0, a: 128 / 255 });
        expect(hexToRgba('#93d6ee')).toEqual({ r: 0x93 / 255, g: 0xd6 / 255, b: 0xee / 255, a: 1 });
    });
    test('rejects junk', () => {
        expect(() => hexToRgba('red')).toThrow('red');
    });
});

describe('modeIdFor', () => {
    const modes = [
        { modeId: '1:0', name: 'Dark' },
        { modeId: '1:1', name: 'Light' },
    ];
    test('matches the name case-insensitively', () => {
        expect(modeIdFor(modes, 'light')).toBe('1:1');
        expect(modeIdFor(modes, 'Sepia')).toBeNull();
    });
    test('a single-mode collection takes any name', () => {
        expect(modeIdFor([{ modeId: '2:0', name: 'Value' }], 'dark')).toBe('2:0');
    });
});

test('phaseOf orders collections, then names, then values, then removals', () => {
    const ops: SyncOp[] = [
        { op: 'orphan-token', collection: 'T', name: 'x' },
        { op: 'update-token', collection: 'T', name: 'a', values: [] },
        { op: 'create-token', collection: 'T', token: { name: 'b', type: 'float', values: {} } },
        { op: 'add-mode', collection: 'T', mode: 'light' },
        { op: 'create-collection', collection: 'T', modes: ['dark'] },
    ];
    expect(ops.map(phaseOf)).toEqual([3, 1, 1, 0, 0]);
});

test('fontAvailable', () => {
    const fonts = [{ fontName: { family: 'Archivo', style: 'SemiBold' } }, { fontName: { family: 'Archivo', style: 'Regular' } }];
    expect(fontAvailable(fonts, 'Archivo', 'SemiBold')).toBe(true);
    expect(fontAvailable(fonts, 'Archivo', 'Semi Bold')).toBe(false);
});

describe('variant names', () => {
    test('parse and format keep order', () => {
        expect(parseVariantName('Tone=Info, Size=Small')).toEqual({ Tone: 'Info', Size: 'Small' });
        expect(formatVariantName({ status: 'info', size: 'sm' })).toBe('status=info, size=sm');
    });
    test('renameVariantProps renames the axis in place and maps options', () => {
        expect(renameVariantProps({ Tone: 'Error', Size: 'Small' }, 'Tone', 'status', { Error: 'destructive' })).toEqual({ status: 'destructive', Size: 'Small' });
        expect(Object.keys(renameVariantProps({ Size: 'S', Tone: 'Info' }, 'Tone', 'status', {}))).toEqual(['Size', 'status']);
    });
    test('codeCombo matches Figma props to code axes and options in any case', () => {
        const axes = { status: ['info', 'destructive'], variant: ['soft', 'notice'] };
        expect(codeCombo({ Status: 'Info', variant: 'notice', Extra: 'x' }, axes)).toEqual({ status: 'info', variant: 'notice' });
    });
});

describe('slotTarget', () => {
    test('root is the variant; a slot defaults to a layer of its own name', () => {
        expect(slotTarget('root', {})).toEqual({ kind: 'root' });
        expect(slotTarget('label', {})).toEqual({ kind: 'layer', name: 'label' });
        expect(slotTarget('title', { title: 'Name' })).toEqual({ kind: 'layer', name: 'Name' });
    });
    test('a slot mapped to "root" styles the variant, to "" is skipped', () => {
        expect(slotTarget('slot', { slot: 'root' })).toEqual({ kind: 'root' });
        expect(slotTarget('root', { root: '' })).toEqual({ kind: 'skip' });
        expect(slotTarget('content', { content: '' })).toEqual({ kind: 'skip' });
    });
});
