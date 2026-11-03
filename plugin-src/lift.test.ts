import { describe, expect, test } from 'bun:test';

import { liftOutOfGroups, type LiftNode } from './lift';

type Fake = LiftNode & { name: string; children: Fake[]; parent: Fake | null };

function node(name: string, type: string, children: Fake[] = []): Fake {
    const n: Fake = {
        name,
        type,
        parent: null,
        children,
        insertChild(index: number, child: LiftNode) {
            const c = child as Fake;
            if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
            n.children.splice(index, 0, c);
            c.parent = n;
        },
    };
    for (const c of children) c.parent = n;
    return n;
}

const names = (n: Fake) => n.children.map((c) => c.name);

describe('liftOutOfGroups', () => {
    test('moves grouped screens next to their group while the work runs, then puts them back in place', async () => {
        const frameA = node('A', 'FRAME');
        const labelA = node('label A', 'TEXT');
        const groupA = node('Screen · A', 'GROUP', [labelA, frameA]);
        const frameB = node('B', 'FRAME');
        const groupB = node('Screen · B', 'GROUP', [frameB, node('label B', 'TEXT')]);
        const page = node('page', 'PAGE', [groupA, groupB]);

        let during: { a: string; b: string; page: string[] } | null = null;
        const out = await liftOutOfGroups([frameA, frameB], async () => {
            during = { a: frameA.parent?.type ?? '', b: frameB.parent?.type ?? '', page: names(page) };
            return 42;
        });

        expect(out).toBe(42);
        expect(during).toEqual({ a: 'PAGE', b: 'PAGE', page: ['Screen · A', 'A', 'Screen · B', 'B'] });
        expect(names(groupA)).toEqual(['label A', 'A']);
        expect(names(groupB)).toEqual(['B', 'label B']);
        expect(names(page)).toEqual(['Screen · A', 'Screen · B']);
    });

    test('restores even when the work throws, and leaves ungrouped screens alone', async () => {
        const grouped = node('A', 'FRAME');
        const group = node('Screen · A', 'GROUP', [grouped, node('label', 'TEXT')]);
        const loose = node('B', 'FRAME');
        const page = node('page', 'PAGE', [group, loose]);

        await expect(
            liftOutOfGroups([grouped, loose], async () => {
                throw new Error('rejected');
            }),
        ).rejects.toThrow('rejected');
        expect(names(group)).toEqual(['A', 'label']);
        expect(names(page)).toEqual(['Screen · A', 'B']);
    });

    test('the same screen passed twice is lifted once', async () => {
        const frame = node('A', 'FRAME');
        const group = node('Screen · A', 'GROUP', [frame, node('label', 'TEXT')]);
        node('page', 'PAGE', [group]);
        await liftOutOfGroups([frame, frame], async () => undefined);
        expect(names(group)).toEqual(['A', 'label']);
    });
});
