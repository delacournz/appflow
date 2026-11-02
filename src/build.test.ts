import { describe, expect, test } from 'bun:test';

import { stalePlugin } from './build';

describe('stalePlugin', () => {
    test('same hash is fresh', () => {
        expect(stalePlugin('abc', 'abc')).toBe(false);
    });
    test('different hash is stale', () => {
        expect(stalePlugin('abc', 'def')).toBe(true);
    });
    test('missing plugin hash (old plugin) is stale when a build is expected', () => {
        expect(stalePlugin('abc', null)).toBe(true);
    });
    test('unknown expected hash is never stale', () => {
        expect(stalePlugin(null, 'abc')).toBe(false);
        expect(stalePlugin(null, null)).toBe(false);
    });
});
