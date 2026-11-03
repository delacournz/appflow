import { describe, expect, test } from 'bun:test';

import type { DesignSpec, SpecCollection, SpecComponent, SpecTextStyle, SpecToken, TokenValue } from '../../shared/design-spec';
import { diffSpecs, emptyMapping, type DesignMapping, type SyncOp } from './diff';

const color = (hex: string): TokenValue => ({ kind: 'color', hex });
const float = (value: number): TokenValue => ({ kind: 'float', value });
const alias = (to: string): TokenValue => ({ kind: 'alias', to });

const tok = (name: string, value: TokenValue, extra: Partial<SpecToken> = {}): SpecToken => ({
    name,
    type: value.kind === 'alias' ? 'color' : value.kind === 'color' ? 'color' : 'float',
    values: { Value: value },
    ...extra,
});
const coll = (name: string, tokens: SpecToken[], modes = ['Value']): SpecCollection => ({ name, modes, tokens });
const spec = (collections: SpecCollection[], textStyles: SpecTextStyle[] = [], components: SpecComponent[] = []): DesignSpec => ({ collections, textStyles, components });

const ops = (plan: { ops: SyncOp[] }, op: SyncOp['op']) => plan.ops.filter((o) => o.op === op);

describe('tokens', () => {
    test('identical specs give no ops', () => {
        const s = spec([coll('Tokens', [tok('radius/input', float(12)), tok('color/bg', color('#0A0A0AFF'))])]);
        const plan = diffSpecs(s, s, emptyMapping());
        expect(plan.ops).toEqual([]);
        expect(plan.counts).toEqual({ create: 0, update: 0, orphan: 0, matched: 2 });
    });

    test('creates a missing collection and its tokens', () => {
        const code = spec([coll('Tokens', [tok('radius/input', float(12))])]);
        const plan = diffSpecs(code, spec([]), emptyMapping());
        expect(ops(plan, 'create-collection')).toEqual([{ op: 'create-collection', collection: 'Tokens', modes: ['Value'] }]);
        expect(ops(plan, 'create-token')).toHaveLength(1);
    });

    test('updates a changed value and keeps the figma id', () => {
        const code = spec([coll('Tokens', [tok('size/button-secondary', float(56))])]);
        const figma = spec([coll('Tokens', [tok('size/button-secondary', float(54), { figmaId: 'V:1' })])]);
        const [op] = ops(diffSpecs(code, figma, emptyMapping()), 'update-token');
        expect(op).toEqual({
            op: 'update-token',
            collection: 'Tokens',
            name: 'size/button-secondary',
            figmaId: 'V:1',
            values: [{ mode: 'Value', from: float(54), to: float(56) }],
        });
    });

    test('ignores float noise and colour rounding', () => {
        const code = spec([coll('Tokens', [tok('a', float(12)), tok('b', color('#A3A3A3FF'))])]);
        const figma = spec([coll('Tokens', [tok('a', float(12.0004)), tok('b', color('#A4A3A3FF'))])]);
        expect(diffSpecs(code, figma, emptyMapping()).ops).toEqual([]);
    });

    test('reports figma-only tokens as orphans', () => {
        const figma = spec([coll('Tokens', [tok('text/text-chip', color('#E6E6E6FF'), { figmaId: 'V:9' })])]);
        const plan = diffSpecs(spec([coll('Tokens', [])]), figma, emptyMapping());
        expect(ops(plan, 'orphan-token')).toEqual([{ op: 'orphan-token', collection: 'Tokens', name: 'text/text-chip', figmaId: 'V:9' }]);
    });

    test('rename map matches a figma token to a code token and renames it', () => {
        const code = spec([coll('Tokens', [tok('color/muted-foreground', color('#A3A3A3FF'), { codeId: 'css:--muted-foreground' })])]);
        const figma = spec([coll('Tokens', [tok('text/text-2', color('#A3A3A3FF'), { figmaId: 'V:2' })])]);
        const mapping: DesignMapping = { ...emptyMapping(), rename: { tokens: { 'Tokens/text/text-2': 'Tokens/color/muted-foreground' }, textStyles: {}, components: {} } };
        const plan = diffSpecs(code, figma, mapping);
        expect(plan.ops).toEqual([
            {
                op: 'update-token',
                collection: 'Tokens',
                name: 'text/text-2',
                figmaId: 'V:2',
                values: [],
                rename: { from: 'text/text-2', to: 'color/muted-foreground' },
                codeId: 'css:--muted-foreground',
            },
        ]);
    });

    test('a stored code id matches even after the code token is renamed', () => {
        const code = spec([coll('Tokens', [tok('color/muted', color('#A3A3A3FF'), { codeId: 'css:--muted-foreground' })])]);
        const figma = spec([coll('Tokens', [tok('color/muted-foreground', color('#A3A3A3FF'), { codeId: 'css:--muted-foreground', figmaId: 'V:2' })])]);
        const [op] = ops(diffSpecs(code, figma, emptyMapping()), 'update-token');
        expect(op).toMatchObject({ figmaId: 'V:2', rename: { from: 'color/muted-foreground', to: 'color/muted' } });
        expect(ops(diffSpecs(code, figma, emptyMapping()), 'orphan-token')).toEqual([]);
    });

    test('aliases compare by the code key of their target', () => {
        const code = spec([
            coll('Primitives', [tok('neutral/500', color('#A3A3A3FF'))]),
            coll('Tokens', [tok('color/muted-foreground', alias('Primitives/neutral/500'))]),
        ]);
        const figma = spec([
            coll('Primitives', [tok('neutral/500', color('#A3A3A3FF'), { figmaId: 'P:5' })]),
            coll('Tokens', [tok('text/text-2', alias('Primitives/neutral/500'), { figmaId: 'V:2' })]),
        ]);
        const mapping: DesignMapping = { ...emptyMapping(), rename: { tokens: { 'Tokens/text/text-2': 'Tokens/color/muted-foreground' }, textStyles: {}, components: {} } };
        const [op] = ops(diffSpecs(code, figma, mapping), 'update-token');
        expect(op).toMatchObject({ values: [] });
    });

    test('an alias that points elsewhere is an update', () => {
        const code = spec([coll('P', [tok('a', color('#000000FF')), tok('b', color('#FFFFFFFF'))]), coll('T', [tok('x', alias('P/b'))])]);
        const figma = spec([coll('P', [tok('a', color('#000000FF')), tok('b', color('#FFFFFFFF'))]), coll('T', [tok('x', alias('P/a'), { figmaId: 'V:x' })])]);
        const [op] = ops(diffSpecs(code, figma, emptyMapping()), 'update-token');
        expect(op).toMatchObject({ values: [{ mode: 'Value', from: alias('P/a'), to: alias('P/b') }] });
    });

    test('a code literal equal to what a Figma alias resolves to is not a change', () => {
        const code = spec([coll('Tokens', [tok('color/primary', color('#93D6EEFF'))])]);
        const figma = spec([coll('Primitives', [tok('glacier/500', color('#93D6EEFF'))]), coll('Tokens', [tok('color/primary', alias('Primitives/glacier/500'), { figmaId: 'V:p' })])]);
        const mapping: DesignMapping = { ...emptyMapping(), ignore: { tokens: ['Primitives/*'], textStyles: [], components: [] } };
        expect(diffSpecs(code, figma, mapping).ops).toEqual([]);
    });

    test('a code alias whose target resolves to the Figma literal is not a change', () => {
        const code = spec([coll('Tokens', [tok('color/bg', color('#0A0A0AFF')), tok('color/media', alias('Tokens/color/bg'))])]);
        const figma = spec([coll('Tokens', [tok('color/bg', color('#0A0A0AFF')), tok('color/media', color('#0A0A0AFF'))])]);
        expect(diffSpecs(code, figma, emptyMapping()).ops).toEqual([]);
    });

    test('a literal that differs from the resolved alias is an update', () => {
        const code = spec([coll('Tokens', [tok('color/primary', color('#FFFFFFFF'))])]);
        const figma = spec([coll('P', [tok('g', color('#93D6EEFF'))]), coll('Tokens', [tok('color/primary', alias('P/g'), { figmaId: 'V:p' })])]);
        const plan = diffSpecs(code, figma, { ...emptyMapping(), ignore: { tokens: ['P/*'], textStyles: [], components: [] } });
        expect(ops(plan, 'update-token')).toHaveLength(1);
    });

    test('single-mode collections match whatever their mode is called', () => {
        const code = spec([coll('Tokens', [{ name: 'r', type: 'float', values: { default: float(1) } }], ['default'])]);
        const figma = spec([coll('Tokens', [{ name: 'r', type: 'float', values: { Dark: float(1) } }], ['Dark'])]);
        expect(diffSpecs(code, figma, emptyMapping()).ops).toEqual([]);
    });

    test('adds a missing mode', () => {
        const code = spec([coll('Theme', [{ name: 'bg', type: 'color', values: { dark: color('#000000FF'), light: color('#FFFFFFFF') } }], ['dark', 'light'])]);
        const figma = spec([{ name: 'Theme', modes: ['dark'], figmaId: 'C:1', tokens: [{ name: 'bg', type: 'color', values: { dark: color('#000000FF') }, figmaId: 'V:1' }] }]);
        const plan = diffSpecs(code, figma, emptyMapping());
        expect(ops(plan, 'add-mode')).toEqual([{ op: 'add-mode', collection: 'Theme', mode: 'light' }]);
        expect(ops(plan, 'update-token')).toEqual([
            { op: 'update-token', collection: 'Theme', name: 'bg', figmaId: 'V:1', values: [{ mode: 'light', from: null, to: color('#FFFFFFFF') }] },
        ]);
    });

    test('code syntax and code id are written when missing', () => {
        const code = spec([coll('Tokens', [tok('radius/input', float(12), { codeId: 'css:--radius-input', codeSyntax: { WEB: 'var(--radius-input)' } })])]);
        const figma = spec([coll('Tokens', [tok('radius/input', float(12), { figmaId: 'V:r' })])]);
        const [op] = ops(diffSpecs(code, figma, emptyMapping()), 'update-token');
        expect(op).toEqual({
            op: 'update-token',
            collection: 'Tokens',
            name: 'radius/input',
            figmaId: 'V:r',
            values: [],
            codeId: 'css:--radius-input',
            codeSyntax: { WEB: 'var(--radius-input)' },
        });
    });

    test('ignored keys are left out on both sides', () => {
        const code = spec([coll('Tokens', [tok('keep', float(1))])]);
        const figma = spec([coll('Tokens', [tok('keep', float(1)), tok('size/avatar', float(42))]), coll('Primitives', [tok('x', float(1))])]);
        const mapping: DesignMapping = { ...emptyMapping(), ignore: { tokens: ['Tokens/size/*', 'Primitives/*'], textStyles: [], components: [] } };
        expect(diffSpecs(code, figma, mapping).ops).toEqual([]);
    });

    test('suggests renames for orphans whose value matches a new code token', () => {
        const code = spec([coll('Tokens', [tok('radius/notice', float(14))])]);
        const figma = spec([coll('Tokens', [tok('radius/note', float(14), { figmaId: 'V:n' })])]);
        const plan = diffSpecs(code, figma, emptyMapping());
        expect(plan.renameCandidates).toEqual([{ kind: 'token', figma: 'Tokens/radius/note', code: 'Tokens/radius/notice' }]);
    });

    test('ambiguous lookalikes are not suggested', () => {
        const code = spec([coll('Tokens', [tok('spacing/fab-md', float(56))])]);
        const figma = spec([coll('Tokens', [tok('radius/phone', float(56)), tok('size/button-secondary', float(56))])]);
        expect(diffSpecs(code, figma, emptyMapping()).renameCandidates).toEqual([]);
    });
});

describe('text styles', () => {
    const style = (name: string, extra: Partial<SpecTextStyle> = {}): SpecTextStyle => ({
        name,
        fontFamily: 'Archivo',
        fontStyle: 'SemiBold',
        fontSize: 20,
        lineHeight: { unit: 'PIXELS', value: 28 },
        letterSpacing: { unit: 'PERCENT', value: 0 },
        ...extra,
    });

    test('create, update and orphan', () => {
        const code = spec([], [style('Title 1', { fontSize: 22 }), style('Body')]);
        const figma = spec([], [style('Title 1', { figmaId: 'S:1' }), style('Legacy', { figmaId: 'S:9' })]);
        const plan = diffSpecs(code, figma, emptyMapping());
        expect(ops(plan, 'create-text-style')).toEqual([{ op: 'create-text-style', style: style('Body') }]);
        expect(ops(plan, 'update-text-style')).toEqual([
            { op: 'update-text-style', name: 'Title 1', figmaId: 'S:1', changes: [{ field: 'fontSize', from: 20, to: 22 }] },
        ]);
        expect(ops(plan, 'orphan-text-style')).toEqual([{ op: 'orphan-text-style', name: 'Legacy', figmaId: 'S:9' }]);
    });
});

test('zero tracking matches in any unit', () => {
    const base: SpecTextStyle = { name: 'Body', fontFamily: 'A', fontStyle: 'Regular', fontSize: 15, lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 } };
    const plan = diffSpecs(spec([], [base]), spec([], [{ ...base, letterSpacing: { unit: 'PERCENT', value: 0 } }]), emptyMapping());
    expect(plan.ops).toEqual([]);
});

test('percent and px metrics compare in px at the font size', () => {
    const code: SpecTextStyle = { name: 'Title 1', fontFamily: 'A', fontStyle: 'SemiBold', fontSize: 22, lineHeight: { unit: 'PIXELS', value: 28 }, letterSpacing: { unit: 'PIXELS', value: -0.22 } };
    const same = { ...code, lineHeight: { unit: 'PERCENT' as const, value: 127.27272 }, letterSpacing: { unit: 'PERCENT' as const, value: -1.0000001 } };
    expect(diffSpecs(spec([], [code]), spec([], [same]), emptyMapping()).ops).toEqual([]);
    const off = { ...same, lineHeight: { unit: 'PERCENT' as const, value: 125 }, figmaId: 'S:1' };
    expect(diffSpecs(spec([], [code]), spec([], [off]), emptyMapping()).ops).toEqual([
        { op: 'update-text-style', name: 'Title 1', figmaId: 'S:1', changes: [{ field: 'lineHeight', from: { unit: 'PERCENT', value: 125 }, to: { unit: 'PIXELS', value: 28 } }] },
    ]);
});

describe('components', () => {
    const comp = (name: string, axes: Record<string, string[]>, extra: Partial<SpecComponent> = {}): SpecComponent => ({ name, axes, defaults: {}, ...extra });

    test('missing component, missing and extra options', () => {
        const code = spec([], [], [comp('Alert', { status: ['info', 'destructive'], variant: ['soft', 'notice'] }), comp('Badge', {})]);
        const figma = spec([], [], [comp('Notice', { Status: ['Info', 'Legal'], Variant: ['Soft'] }, { figmaId: 'CS:1' })]);
        const mapping: DesignMapping = { ...emptyMapping(), rename: { tokens: {}, textStyles: {}, components: { Notice: 'Alert' } } };
        const plan = diffSpecs(code, figma, mapping);
        expect(ops(plan, 'create-component')).toEqual([{ op: 'create-component', component: comp('Badge', {}) }]);
        expect(ops(plan, 'add-variant-option')).toEqual([
            { op: 'add-variant-option', component: 'Notice', figmaId: 'CS:1', axis: 'Status', option: 'destructive' },
            { op: 'add-variant-option', component: 'Notice', figmaId: 'CS:1', axis: 'Variant', option: 'notice' },
        ]);
        expect(ops(plan, 'orphan-variant-option')).toEqual([{ op: 'orphan-variant-option', component: 'Notice', figmaId: 'CS:1', axis: 'Status', option: 'Legal' }]);
    });

    test('a missing axis is added with all its options', () => {
        const code = spec([], [], [comp('Button', { size: ['sm', 'lg'] })]);
        const figma = spec([], [], [comp('Button', {}, { figmaId: 'CS:2' })]);
        expect(ops(diffSpecs(code, figma, emptyMapping()), 'add-variant-axis')).toEqual([
            { op: 'add-variant-axis', component: 'Button', figmaId: 'CS:2', axis: 'size', options: ['sm', 'lg'], existing: 'sm' },
        ]);
    });

    test('variant renames translate Figma axes and options before comparing', () => {
        const code = spec([], [], [comp('Alert', { status: ['info', 'destructive'], variant: ['soft', 'notice'] }, { defaults: { status: 'info', variant: 'soft' } })]);
        const figma = spec([], [], [comp('Notice', { Tone: ['Info', 'Error', 'Legal'] }, { figmaId: 'CS:1' })]);
        const mapping: DesignMapping = {
            ...emptyMapping(),
            rename: { tokens: {}, textStyles: {}, components: { Notice: 'Alert' } },
            variants: { Notice: { Tone: { axis: 'status', options: { Info: 'info', Error: 'destructive' } } } },
            variantDefaults: { Alert: { variant: 'notice' } },
        };
        const plan = diffSpecs(code, figma, mapping);
        expect(plan.ops).toEqual([
            { op: 'rename-variant', component: 'Notice', figmaId: 'CS:1', axis: 'Tone', to: 'status', options: { Info: 'info', Error: 'destructive' } },
            { op: 'orphan-variant-option', component: 'Notice', figmaId: 'CS:1', axis: 'status', option: 'Legal' },
            { op: 'add-variant-axis', component: 'Notice', figmaId: 'CS:1', axis: 'variant', options: ['soft', 'notice'], existing: 'notice' },
        ]);
    });

    test('code components that share a code id pair with the Figma item of the same name', () => {
        const id = 'tv:item.variants.ts#itemVariants';
        const code = spec([], [], [comp('List row', {}, { codeId: id }), comp('Toggle row', { state: ['on'] }, { codeId: id })]);
        const figma = spec([], [], [comp('Toggle row', { state: ['on'] }, { figmaId: 'CS:2', codeId: id }), comp('List row', {}, { figmaId: 'CS:1', codeId: id })]);
        expect(diffSpecs(code, figma, emptyMapping()).ops).toEqual([]);
    });
});
