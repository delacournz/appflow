import { describe, expect, test } from 'bun:test';

import { hexToOklch, mixOklch, oklchToHex, parseColor } from './color';

describe('oklch', () => {
    test('converts sRGB red to its CSS Color 4 reference', () => {
        const c = hexToOklch('#FF0000FF');
        expect(c.l).toBeCloseTo(0.628, 3);
        expect(c.c).toBeCloseTo(0.2577, 3);
        expect(c.h).toBeCloseTo(29.23, 1);
    });

    test('round-trips', () => {
        for (const hex of ['#93D6EEFF', '#0A0A0AFF', '#F87171FF', '#FFFFFFFF', '#000000FF', '#34D3999E']) expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    });

    test('mixes black and white to mid grey', () => {
        expect(mixOklch(hexToOklch('#000000FF'), hexToOklch('#FFFFFFFF'), 0.5)).toBe('#636363FF');
    });

    test('a mix with itself is itself', () => {
        expect(mixOklch(hexToOklch('#1C1C1CFF'), hexToOklch('#1C1C1CFF'), 0.5)).toBe('#1C1C1CFF');
    });
});

describe('parseColor', () => {
    test('hex forms', () => {
        expect(parseColor('#93D6EE')).toBe('#93D6EEFF');
        expect(parseColor('#0000')).toBe('#00000000');
    });
    test('oklch with alpha', () => {
        expect(parseColor('oklch(0 0 0 / 62%)')).toBe('#0000009E');
        expect(parseColor('oklch(100% 0 0)')).toBe('#FFFFFFFF');
    });
    test('rgb', () => {
        expect(parseColor('rgb(255 0 0)')).toBe('#FF0000FF');
        expect(parseColor('rgba(0, 0, 0, 0.5)')).toBe('#00000080');
    });
    test('anything else is null', () => {
        expect(parseColor('red')).toBeNull();
        expect(parseColor('var(--x)')).toBeNull();
    });
});
