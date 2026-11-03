import { expect, test } from 'bun:test';

import { mergeDecls, resolveSlots, type ComponentStyles } from './design-style';

test('a later decl of the same kind wins', () => {
    expect(mergeDecls([{ kind: 'fill', token: 'color/card' }, { kind: 'gap', value: 8 }], [{ kind: 'fill-none' }, { kind: 'padding', side: 'top', value: 4 }])).toEqual([
        { kind: 'fill-none' },
        { kind: 'gap', value: 8 },
        { kind: 'padding', side: 'top', value: 4 },
    ]);
});

test('resolveSlots layers base, options and matching compounds', () => {
    const styles: ComponentStyles = {
        base: { root: [{ kind: 'layout', mode: 'HORIZONTAL' }] },
        variants: {
            variant: { soft: {}, notice: { root: [{ kind: 'fill', token: 'color/muted' }] } },
            size: { md: { root: [{ kind: 'gap', value: 12 }], title: [{ kind: 'font-size', token: 'text/base', value: 16 }] } },
        },
        compound: [{ when: { variant: 'soft', status: 'info' }, slots: { root: [{ kind: 'fill', token: 'color/info-soft' }] } }],
        unknown: [],
    };
    expect(resolveSlots(styles, { variant: 'notice', size: 'md' })).toEqual({
        root: [
            { kind: 'layout', mode: 'HORIZONTAL' },
            { kind: 'fill', token: 'color/muted' },
            { kind: 'gap', value: 12 },
        ],
        title: [{ kind: 'font-size', token: 'text/base', value: 16 }],
    });
    expect(resolveSlots(styles, { variant: 'soft', status: 'info' }).root).toContainEqual({ kind: 'fill', token: 'color/info-soft' });
});
