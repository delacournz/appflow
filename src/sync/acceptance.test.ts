/** First sync of the wallet code tokens against a snapshot of its Figma file, with the one-time rename seed. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDesignConfig, readCodeSpec } from './config';
import { diffSpecs } from './diff';
import { parseSpec } from './spec-schema';

const root = join(import.meta.dir, '../extract/__fixtures__/wallet');

test('wallet first sync plan', async () => {
    const config = await loadDesignConfig(root);
    const warnings: string[] = [];
    const code = await readCodeSpec(root, config.sources, warnings);
    const figma = parseSpec(JSON.parse(readFileSync(join(root, 'figma-export.json'), 'utf8')), 'figma-export.json');
    const plan = diffSpecs(code, figma, config.mapping);

    const updates = plan.ops.filter((o) => o.op === 'update-token');
    expect(updates.filter((o) => o.values.length > 0).map((o) => o.name)).toEqual(['radius/pill']);
    expect(updates.find((o) => o.name === 'text/text-2')).toMatchObject({ rename: { from: 'text/text-2', to: 'color/muted-foreground' }, codeId: 'css:--color-muted-foreground', values: [] });

    expect(plan.ops.filter((o) => o.op === 'orphan-token').map((o) => o.name)).toEqual([
        'ground/surface-3',
        'ground/grabber',
        'ground/island',
        'text/text-chip',
        'radius/phone',
        'size/button-secondary',
        'size/row-detail',
        'size/avatar',
        'size/tab-bar',
        'size/chip',
        'brand/icon-bg',
    ]);
    expect(plan.renameCandidates).toEqual([{ kind: 'token', figma: 'Tokens/text/text-chip', code: 'Tokens/color/tertiary-foreground' }]);

    const styles = plan.ops.filter((o) => o.op === 'update-text-style');
    expect(styles.find((o) => o.name === 'Sony FT/Amount L')).toMatchObject({ rename: { from: 'Sony FT/Amount L', to: 'Sony FT/Amount lg' } });
    expect(styles.find((o) => o.name === 'Sony FT/Title 1')?.changes).toEqual([{ field: 'lineHeight', from: { unit: 'PERCENT', value: 125 }, to: { unit: 'PIXELS', value: 28 } }]);
    expect(plan.ops.filter((o) => o.op === 'orphan-text-style').map((o) => o.name)).toEqual(['Sony FT/Display', 'Sony FT/Headline', 'Sony FT/Keypad']);
    expect(warnings).toHaveLength(1);
});
