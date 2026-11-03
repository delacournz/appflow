import { expect, test } from 'bun:test';

import type { SyncOp } from '../../shared/design-ops';
import { describeOp, summarizePlan } from './summary';

test('one line per op', () => {
    const ops: SyncOp[] = [
        { op: 'create-collection', collection: 'Tokens', modes: ['dark'] },
        { op: 'add-mode', collection: 'Tokens', mode: 'light' },
        { op: 'create-token', collection: 'Tokens', token: { name: 'radius/base', type: 'float', values: { dark: { kind: 'float', value: 16 } } } },
        {
            op: 'update-token',
            collection: 'Tokens',
            name: 'text/text-2',
            figmaId: 'V:1',
            values: [{ mode: 'Dark', from: { kind: 'alias', to: 'Primitives/neutral/500' }, to: { kind: 'color', hex: '#A3A3A3FF' } }],
            rename: { from: 'text/text-2', to: 'color/muted-foreground' },
            codeId: 'css:--color-muted-foreground',
        },
        { op: 'orphan-token', collection: 'Tokens', name: 'size/chip' },
        { op: 'update-text-style', name: 'Sony FT/Title 1', changes: [{ field: 'lineHeight', from: { unit: 'PERCENT', value: 125 }, to: { unit: 'PIXELS', value: 28 } }] },
        { op: 'add-variant-option', component: 'Notice', axis: 'Variant', option: 'notice' },
    ];
    expect(ops.map(describeOp)).toEqual([
        '+ collection Tokens [dark]',
        '+ mode Tokens/light',
        '+ Tokens/radius/base = 16',
        '~ Tokens/text/text-2 → color/muted-foreground; Dark: @Primitives/neutral/500 → #A3A3A3FF; link css:--color-muted-foreground',
        '? Tokens/size/chip (Figma only)',
        '~ text style Sony FT/Title 1: lineHeight 125% → 28px',
        '+ Notice Variant=notice',
    ]);
});

test('summarizePlan keeps counts and candidates', () => {
    const s = summarizePlan({ ops: [{ op: 'add-mode', collection: 'T', mode: 'm' }], counts: { create: 1, update: 0, orphan: 0, matched: 3 }, renameCandidates: [] });
    expect(s).toEqual({ counts: { create: 1, update: 0, orphan: 0, matched: 3 }, renameCandidates: [], ops: ['+ mode T/m'] });
});
