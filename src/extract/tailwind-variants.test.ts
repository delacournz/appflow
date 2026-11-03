import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { componentsFromProbe, probeVariants, type ProbeEntry } from './tailwind-variants';

const root = join(import.meta.dir, '__fixtures__/tv');
const tokens = new Map<string, number | null>([
    ['color/muted', null],
    ['color/foreground', null],
    ['color/destructive', null],
    ['color/destructive-soft', null],
    ['color/primary', null],
    ['radius/notice', 14],
    ['radius/full', 9999],
    ['text/sm', 14],
]);

describe('probeVariants', () => {
    test('imports each ref in a child process and reads its tv config', async () => {
        const entries = await probeVariants(root, ['alert.variants.ts#alertVariants', 'alert.variants.ts#nope']);
        expect(entries[0]).toMatchObject({ ref: 'alert.variants.ts#alertVariants', ok: true, defaultVariants: { variant: 'soft', inset: 'false' } });
        expect(entries[0]?.ok && entries[0].variants.status?.destructive).toEqual({ title: 'text-destructive opacity-50' });
        expect(entries[0]?.ok && entries[0].compoundVariants).toEqual([{ when: { variant: ['soft'], status: ['destructive'] }, slots: { root: 'bg-destructive-soft' } }]);
        expect(entries[1]).toMatchObject({ ref: 'alert.variants.ts#nope', ok: false });
    });

    test('refuses a ref outside the project', async () => {
        await expect(probeVariants(root, ['../../tw-classes.ts#x'])).rejects.toThrow(/outside/);
    });
});

describe('componentsFromProbe', () => {
    test('axes, defaults, code id and styles per slot', async () => {
        const entries = await probeVariants(root, ['alert.variants.ts#alertVariants', 'alert.variants.ts#badgeVariants']);
        const { components, warnings } = componentsFromProbe(entries, { Alert: 'alert.variants.ts#alertVariants', Badge: 'alert.variants.ts#badgeVariants' }, tokens);
        const [alert, badge] = components;
        expect(alert).toMatchObject({
            name: 'Alert',
            axes: { variant: ['soft', 'notice'], status: ['default', 'destructive'], size: ['sm', 'md'], inset: ['true', 'false'] },
            defaults: { variant: 'soft', status: 'default', size: 'md', inset: 'false' },
            codeId: 'tv:alert.variants.ts#alertVariants',
            source: 'alert.variants.ts',
        });
        expect(alert?.styles?.base).toEqual({ root: [{ kind: 'layout', mode: 'HORIZONTAL' }, { kind: 'align', axis: 'counter', value: 'MIN' }], title: [{ kind: 'font-weight', style: 'SemiBold' }] });
        expect(alert?.styles?.variants.variant?.notice?.root).toEqual([{ kind: 'radius', token: 'radius/notice', value: 14 }, { kind: 'stroke-none' }, { kind: 'fill', token: 'color/muted' }]);
        expect(alert?.styles?.compound).toEqual([{ when: { variant: 'soft', status: 'destructive' }, slots: { root: [{ kind: 'fill', token: 'color/destructive-soft' }] } }]);
        expect(alert?.styles?.unknown).toEqual([]);
        expect(badge?.styles?.base.root).toEqual([{ kind: 'radius', token: 'radius/full', value: 9999 }, { kind: 'padding', side: 'left', value: 8 }, { kind: 'padding', side: 'right', value: 8 }]);
        expect(badge?.styles?.variants.tone?.loud).toEqual({ root: [{ kind: 'fill', token: 'color/primary' }] });
        expect(warnings).toEqual([]);
    });

    test('an axes list limits which axes become variants', async () => {
        const entries = await probeVariants(root, ['alert.variants.ts#alertVariants']);
        const [alert] = componentsFromProbe(entries, { Alert: { ref: 'alert.variants.ts#alertVariants', axes: ['status', 'variant'] } }, tokens).components;
        expect(alert?.axes).toEqual({ status: ['default', 'destructive'], variant: ['soft', 'notice'] });
        expect(alert?.defaults).toEqual({ status: 'default', variant: 'soft' });
    });

    test('a ref that failed to load is a warning', async () => {
        const entries = await probeVariants(root, ['alert.variants.ts#nope']);
        const { components, warnings } = componentsFromProbe(entries, { Nope: 'alert.variants.ts#nope' }, tokens);
        expect(components).toEqual([]);
        expect(warnings[0]).toContain('alert.variants.ts#nope');
    });
});
