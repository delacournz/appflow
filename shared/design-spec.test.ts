import { describe, expect, test } from 'bun:test';

import { normalizeHex, tokenKey } from './design-spec';

describe('normalizeHex', () => {
    test('expands and upper-cases', () => {
        expect(normalizeHex('#a3a3a3')).toBe('#A3A3A3FF');
        expect(normalizeHex('#fff')).toBe('#FFFFFFFF');
        expect(normalizeHex('#0008')).toBe('#00000088');
        expect(normalizeHex(' #00000080 ')).toBe('#00000080');
    });
    test('rejects non-hex', () => {
        expect(normalizeHex('red')).toBeNull();
        expect(normalizeHex('#12345')).toBeNull();
        expect(normalizeHex('oklch(0 0 0)')).toBeNull();
    });
});

test('tokenKey joins collection and name', () => {
    expect(tokenKey('Tokens', 'color/muted-foreground')).toBe('Tokens/color/muted-foreground');
});
