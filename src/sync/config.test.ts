import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_FILE, loadDesignConfig, matchesGlob, readCodeSpec } from './config';

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'appflow-sync-'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const write = async (path: string, value: unknown) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
};

describe('loadDesignConfig', () => {
    test('fills defaults', async () => {
        await write(CONFIG_FILE, { sources: [{ kind: 'spec-json', path: 'design/spec.json' }] });
        const config = await loadDesignConfig(root);
        expect(config.sources).toEqual([{ kind: 'spec-json', path: 'design/spec.json' }]);
        expect(config.mapping).toEqual({ rename: { tokens: {}, textStyles: {}, components: {} }, ignore: { tokens: [], textStyles: [], components: [] }, variants: {}, variantDefaults: {}, layers: {} });
    });

    test('reads rename and ignore', async () => {
        await write(CONFIG_FILE, {
            sources: [{ kind: 'spec-json', path: 's.json' }],
            rename: { tokens: { 'Tokens/text/text-2': 'Tokens/color/muted-foreground' } },
            ignore: { tokens: ['Primitives/*'] },
        });
        const { mapping } = await loadDesignConfig(root);
        expect(mapping.rename.tokens).toEqual({ 'Tokens/text/text-2': 'Tokens/color/muted-foreground' });
        expect(mapping.ignore.tokens).toEqual(['Primitives/*']);
    });

    test('a missing file says where it looked', async () => {
        await expect(loadDesignConfig(root)).rejects.toThrow(join(root, CONFIG_FILE));
    });

    test('an invalid file says what is wrong', async () => {
        await write(CONFIG_FILE, { sources: [{ kind: 'nope' }] });
        await expect(loadDesignConfig(root)).rejects.toThrow(/sources/);
    });
});

describe('readCodeSpec', () => {
    test('merges spec-json sources', async () => {
        await write('a.json', { collections: [{ name: 'Tokens', modes: ['Value'], tokens: [{ name: 'r', type: 'float', values: { Value: { kind: 'float', value: 12 } } }] }] });
        await write('b.json', { textStyles: [{ name: 'Body', fontFamily: 'Archivo', fontStyle: 'Regular', fontSize: 15, lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 } }] });
        const s = await readCodeSpec(root, [
            { kind: 'spec-json', path: 'a.json' },
            { kind: 'spec-json', path: 'b.json' },
        ]);
        expect(s.collections.map((c) => c.name)).toEqual(['Tokens']);
        expect(s.textStyles.map((t) => t.name)).toEqual(['Body']);
        expect(s.components).toEqual([]);
    });

    test('rejects a malformed spec with its path', async () => {
        await write('bad.json', { collections: [{ name: 'T', modes: ['Value'], tokens: [{ name: 'x', type: 'color', values: { Value: { kind: 'color', hex: 'red' } } }] }] });
        await expect(readCodeSpec(root, [{ kind: 'spec-json', path: 'bad.json' }])).rejects.toThrow(/bad\.json/);
    });

    test('reads tailwind-css sources with their options', async () => {
        await write('styles/tokens.css', '@theme { --radius-input: 12px; --color-glacier-500: #93D6EE; }');
        await write('styles/theme.css', '@layer theme { :root { @variant dark { --bg: #0A0A0A; } @variant light { --bg: #FFFFFF; } } } @theme inline { --color-bg: var(--bg); }');
        const warnings: string[] = [];
        const s = await readCodeSpec(root, [{ kind: 'tailwind-css', paths: ['styles/tokens.css', 'styles/theme.css'], modes: ['dark'] }], warnings);
        expect(s.collections.map((c) => [c.name, c.modes, c.tokens.map((t) => t.name)])).toEqual([
            ['Primitives', ['Value'], ['glacier/500']],
            ['Tokens', ['dark'], ['radius/input', 'color/bg']],
        ]);
        expect(s.collections[1]?.tokens[0]?.source).toBe('styles/tokens.css:1');
        expect(warnings).toEqual([]);
    });

    test('loads a tailwind-css source from the config', async () => {
        await write(CONFIG_FILE, { sources: [{ kind: 'tailwind-css', paths: ['a.css'], modes: ['dark'], textStylePrefix: 'Sony FT/' }] });
        expect((await loadDesignConfig(root)).sources).toEqual([{ kind: 'tailwind-css', paths: ['a.css'], modes: ['dark'], textStylePrefix: 'Sony FT/' }]);
    });

    test('tailwind-variants components are styled with the tokens of earlier sources', async () => {
        await write('tokens.css', '@theme { --radius-notice: 14px; } @layer theme { :root { @variant dark { --muted: #262626; } } } @theme inline { --color-muted: var(--muted); }');
        await write('alert.variants.ts', "export const alertVariants = Object.assign(() => '', { base: 'rounded-notice', slots: {}, variants: { tone: { muted: 'bg-muted' } }, defaultVariants: { tone: 'muted' }, compoundVariants: [] });");
        const s = await readCodeSpec(root, [
            { kind: 'tailwind-variants', components: { Alert: 'alert.variants.ts#alertVariants' } },
            { kind: 'tailwind-css', paths: ['tokens.css'] },
        ]);
        expect(s.components).toMatchObject([{ name: 'Alert', axes: { tone: ['muted'] }, defaults: { tone: 'muted' } }]);
        expect(s.components[0]?.styles?.base.root).toEqual([{ kind: 'radius', token: 'radius/notice', value: 14 }]);
        expect(s.components[0]?.styles?.variants.tone?.muted?.root).toEqual([{ kind: 'fill', token: 'color/muted' }]);
    });

    test('axes: [] makes no variants; a left-out axis keeps its default styling', async () => {
        await write('card.variants.ts', "export const cardVariants = Object.assign(() => '', { base: '', slots: {}, variants: { size: { sm: 'p-2', md: 'p-4' }, tone: { a: 'opacity-50', b: '' } }, defaultVariants: { size: 'md', tone: 'a' }, compoundVariants: [{ size: 'md', tone: 'a', class: 'gap-2' }, { size: 'sm', class: 'gap-1' }] });");
        const s = await readCodeSpec(root, [{ kind: 'tailwind-variants', components: { Card: { ref: 'card.variants.ts#cardVariants', axes: [] } } }]);
        const c = s.components[0];
        expect(c?.axes).toEqual({});
        expect(c?.styles?.variants).toEqual({});
        expect(c?.styles?.base.root).toEqual([
            ...(['top', 'right', 'bottom', 'left'] as const).map((side) => ({ kind: 'padding' as const, side, value: 16 })),
            { kind: 'opacity', value: 0.5 },
            { kind: 'gap', value: 8 },
        ]);
        expect(c?.styles?.compound).toEqual([]);
    });

    test('refuses a source outside the project', async () => {
        await expect(readCodeSpec(root, [{ kind: 'spec-json', path: '../outside.json' }])).rejects.toThrow(/outside/);
    });
});

test('matchesGlob', () => {
    expect(matchesGlob('Primitives/neutral/500', 'Primitives/*')).toBe(true);
    expect(matchesGlob('Tokens/size/avatar', 'Tokens/size/*')).toBe(true);
    expect(matchesGlob('Tokens/radius/input', 'Tokens/size/*')).toBe(false);
    expect(matchesGlob('Tokens/a.b', 'Tokens/a.b')).toBe(true);
    expect(matchesGlob('Tokens/axb', 'Tokens/a.b')).toBe(false);
});
