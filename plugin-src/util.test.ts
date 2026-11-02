import { describe, expect, test } from 'bun:test';

import { escapeXml, parseCssColor, pascalCase, toTailwind } from './util';

describe('parseCssColor', () => {
    test('rgb and rgba', () => {
        expect(parseCssColor('rgb(255, 0, 51)')).toEqual({ r: 1, g: 0, b: 0.2, a: 1 });
        expect(parseCssColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
        expect(parseCssColor('rgb(0 0 0 / 25%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
    });
    test('hex', () => {
        expect(parseCssColor('#93D6EE')).toEqual({ r: 0x93 / 255, g: 0xd6 / 255, b: 0xee / 255, a: 1 });
        expect(parseCssColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    });
    test('transparent and junk', () => {
        expect(parseCssColor('transparent')).toBeNull();
        expect(parseCssColor('rgba(0, 0, 0, 0)')).toBeNull();
        expect(parseCssColor('nope')).toBeNull();
    });
});

describe('toTailwind', () => {
    test('maps common properties and falls back to arbitrary properties', () => {
        expect(
            toTailwind({
                display: 'flex',
                'flex-direction': 'column',
                gap: '14px',
                width: '393px',
                background: 'var(--bg, #0A0A0A)',
                'font-family': 'Archivo',
            }),
        ).toBe('flex flex-col gap-[14px] w-[393px] bg-[var(--bg,#0A0A0A)] [font-family:Archivo]');
    });
});

test('escapeXml', () => {
    expect(escapeXml('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;');
});

test('pascalCase', () => {
    expect(pascalCase('Button / Kind=Primary')).toBe('ButtonKindPrimary');
    expect(pascalCase('tab bar')).toBe('TabBar');
    expect(pascalCase('9 lives')).toBe('C9Lives');
});
