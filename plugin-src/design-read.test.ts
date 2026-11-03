import { describe, expect, test } from 'bun:test';

import { axesFromVariantNames, rgbaToHex, toSpecLetterSpacing, toSpecLineHeight, tokenTypeOf } from './design-read';

describe('rgbaToHex', () => {
    test('rounds 0-1 channels to #RRGGBBAA', () => {
        expect(rgbaToHex({ r: 0.6392, g: 0.6392, b: 0.6392, a: 1 })).toBe('#A3A3A3FF');
        expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 0.62 })).toBe('#0000009E');
        expect(rgbaToHex({ r: 1, g: 1, b: 1 })).toBe('#FFFFFFFF');
    });
});

describe('text metrics', () => {
    test('line height', () => {
        expect(toSpecLineHeight({ unit: 'AUTO' })).toEqual({ unit: 'AUTO' });
        expect(toSpecLineHeight({ unit: 'PIXELS', value: 28 })).toEqual({ unit: 'PIXELS', value: 28 });
        expect(toSpecLineHeight({ unit: 'PERCENT', value: 140 })).toEqual({ unit: 'PERCENT', value: 140 });
    });
    test('letter spacing', () => {
        expect(toSpecLetterSpacing({ unit: 'PIXELS', value: -0.2 })).toEqual({ unit: 'PIXELS', value: -0.2 });
        expect(toSpecLetterSpacing({ unit: 'PERCENT', value: 0 })).toEqual({ unit: 'PERCENT', value: 0 });
    });
});

describe('tokenTypeOf', () => {
    test('maps Figma resolved types', () => {
        expect(tokenTypeOf('COLOR')).toBe('color');
        expect(tokenTypeOf('FLOAT')).toBe('float');
        expect(tokenTypeOf('STRING')).toBe('string');
        expect(tokenTypeOf('BOOLEAN')).toBe('boolean');
        expect(tokenTypeOf('EASING')).toBeNull();
    });
});

describe('axesFromVariantNames', () => {
    test('collects axes and options in first-seen order', () => {
        const names = ['Tone=Info, Size=Small', 'Tone=Error, Size=Small', 'Tone=Info, Size=Large'];
        expect(axesFromVariantNames(names)).toEqual({ Tone: ['Info', 'Error'], Size: ['Small', 'Large'] });
    });
    test('ignores parts without a value', () => {
        expect(axesFromVariantNames(['Default', 'Kind=Primary'])).toEqual({ Kind: ['Primary'] });
    });
});
