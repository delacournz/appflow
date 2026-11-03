import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DesignSpec, SpecToken } from '../../shared/design-spec';
import { extractTailwindCss } from './tailwind-css';

const fixture = (name: string) => ({ path: `wallet/${name}`, css: readFileSync(join(import.meta.dir, '__fixtures__/wallet', name), 'utf8') });
const wallet = () => extractTailwindCss([fixture('tokens.css'), fixture('theme.css')], { modes: ['dark'], textStylePrefix: 'Sony FT/' });

const token = (spec: DesignSpec, collection: string, name: string): SpecToken | undefined => spec.collections.find((c) => c.name === collection)?.tokens.find((t) => t.name === name);

describe('wallet fixture', () => {
    const { spec, warnings } = wallet();

    test('collections and modes', () => {
        expect(spec.collections.map((c) => [c.name, c.modes])).toEqual([
            ['Primitives', ['Value']],
            ['Tokens', ['dark']],
        ]);
    });

    test('primitive ramps split their step into a group', () => {
        expect(token(spec, 'Primitives', 'glacier/500')).toMatchObject({ type: 'color', values: { Value: { kind: 'color', hex: '#93D6EEFF' } }, codeId: 'css:--color-glacier-500', scopes: [] });
        expect(spec.collections[0]?.tokens).toHaveLength(9);
    });

    test('theme colours take the mode value, code id, syntax and scopes', () => {
        expect(token(spec, 'Tokens', 'color/muted-foreground')).toMatchObject({
            type: 'color',
            values: { dark: { kind: 'color', hex: '#A3A3A3FF' } },
            codeId: 'css:--color-muted-foreground',
            codeSyntax: { WEB: 'var(--color-muted-foreground)' },
            scopes: ['TEXT_FILL'],
        });
        expect(token(spec, 'Tokens', 'color/border')?.scopes).toEqual(['STROKE_COLOR']);
        expect(token(spec, 'Tokens', 'color/background')?.scopes).toEqual(['FRAME_FILL', 'SHAPE_FILL']);
        expect(token(spec, 'Tokens', 'color/background')?.source).toBe('wallet/theme.css:359');
    });

    test('a var() to another colour token is an alias', () => {
        expect(token(spec, 'Tokens', 'color/media')?.values).toEqual({ dark: { kind: 'alias', to: 'Tokens/color/background' } });
        expect(token(spec, 'Tokens', 'color/destructive-soft-foreground')?.values).toEqual({ dark: { kind: 'alias', to: 'Tokens/color/destructive' } });
    });

    test('color-mix and oklch resolve to hex', () => {
        expect(token(spec, 'Tokens', 'color/overlay')?.values).toEqual({ dark: { kind: 'color', hex: '#0000009E' } });
        const tertiary = token(spec, 'Tokens', 'color/tertiary')?.values.dark;
        expect(tertiary?.kind).toBe('color');
        expect(tertiary).not.toEqual({ kind: 'color', hex: '#1C1C1CFF' });
    });

    test('floats: px, rem, calc and var', () => {
        const value = (name: string) => token(spec, 'Tokens', name)?.values.dark;
        expect(value('radius/base')).toEqual({ kind: 'float', value: 16 });
        expect(value('radius/md')).toEqual({ kind: 'float', value: 12.8 });
        expect(value('radius/lg')).toEqual({ kind: 'alias', to: 'Tokens/radius/base' });
        expect(value('radius/input')).toEqual({ kind: 'float', value: 12 });
        expect(value('spacing/button-lg')).toEqual({ kind: 'float', value: 56 });
        expect(value('text/title-1')).toEqual({ kind: 'float', value: 22 });
        expect(token(spec, 'Tokens', 'radius/input')?.scopes).toEqual(['CORNER_RADIUS']);
        expect(token(spec, 'Tokens', 'spacing/row')?.scopes).toEqual(['WIDTH_HEIGHT', 'GAP']);
        expect(token(spec, 'Tokens', 'text/body')?.scopes).toEqual(['FONT_SIZE']);
    });

    test('type role sub-keys and shadows are not tokens', () => {
        const names = spec.collections.flatMap((c) => c.tokens.map((t) => t.name));
        expect(names.some((n) => n.includes('--') || n.startsWith('shadow'))).toBe(false);
    });

    test('values it cannot express are warnings', () => {
        expect(warnings.some((w) => w.includes('--tracking-kicker'))).toBe(true);
    });

    test('type roles become text styles', () => {
        expect(spec.textStyles.map((s) => s.name)).toEqual([
            'Sony FT/Amount lg',
            'Sony FT/Balance',
            'Sony FT/Amount md',
            'Sony FT/Title 1',
            'Sony FT/Title 2',
            'Sony FT/Body strong',
            'Sony FT/Body',
            'Sony FT/Subhead',
            'Sony FT/Footnote',
            'Sony FT/Caption',
            'Sony FT/Micro',
        ]);
        expect(spec.textStyles[3]).toEqual({
            name: 'Sony FT/Title 1',
            fontFamily: 'Archivo',
            fontStyle: 'SemiBold',
            fontSize: 22,
            lineHeight: { unit: 'PIXELS', value: 28 },
            letterSpacing: { unit: 'PIXELS', value: -0.22 },
            codeId: 'css:--text-title-1',
            source: 'wallet/tokens.css:47',
        });
        expect(spec.textStyles[6]).toMatchObject({ fontStyle: 'Regular', letterSpacing: { unit: 'PIXELS', value: 0 } });
    });
});

describe('modes', () => {
    const css = `@layer theme { :root {
        @variant light { --bg: #FFFFFF; }
        @variant dark { --bg: #000000; }
        @variant ios { --font-sans: "Inter"; }
    } }
    @theme inline { --color-bg: var(--bg); }
    @theme { --spacing-row: 52px; --text-body: 15px; --text-body--line-height: 1.5; --text-body--letter-spacing: 0.01em; }`;

    test('every theme variant is a mode by default; static values fill each mode', () => {
        const { spec } = extractTailwindCss([{ path: 'a.css', css }]);
        const tokens = spec.collections.find((c) => c.name === 'Tokens');
        expect(tokens?.modes).toEqual(['light', 'dark']);
        expect(tokens?.tokens.find((t) => t.name === 'color/bg')?.values).toEqual({ light: { kind: 'color', hex: '#FFFFFFFF' }, dark: { kind: 'color', hex: '#000000FF' } });
        expect(tokens?.tokens.find((t) => t.name === 'spacing/row')?.values).toEqual({ light: { kind: 'float', value: 52 }, dark: { kind: 'float', value: 52 } });
    });

    test('unitless line height and em tracking become percents', () => {
        const [style] = extractTailwindCss([{ path: 'a.css', css }]).spec.textStyles;
        expect(style).toMatchObject({ name: 'Body', fontFamily: 'Inter', fontStyle: 'Regular', lineHeight: { unit: 'PERCENT', value: 150 }, letterSpacing: { unit: 'PERCENT', value: 1 } });
    });
});
