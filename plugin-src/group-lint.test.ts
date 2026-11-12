import { describe, expect, test } from 'bun:test';
import { lintGroups } from './group-lint';

const box = { x: 0, y: 0, width: 1000, height: 800 };
const title = { x: 0, y: -200, width: 300, height: 115 };

describe('lintGroups', () => {
    test('clean layout passes', () => {
        const r = lintGroups([{ id: 'g', box, title }], [{ kind: 'screen', id: 's', rect: { x: 200, y: 200, width: 300, height: 400 }, ownerGroupId: 'g' }]);
        expect(r.issues).toEqual([]);
        expect(r.counts).toEqual({});
    });

    test('merges conflict and nesting kinds with counts', () => {
        const r = lintGroups(
            [
                { id: 'p', box, title },
                { id: 'c', parentId: 'p', box: { x: 900, y: 100, width: 400, height: 300 }, title: { x: 900, y: -50, width: 100, height: 50 } },
            ],
            [{ kind: 'screen', id: 's', rect: { x: 2000, y: 0, width: 100, height: 100 } }],
        );
        expect(r.counts['child-outside-parent']).toBe(1);
        expect(r.counts['group-overlaps-group']).toBe(1);
        expect(r.issues.every((i) => typeof i.message === 'string' && i.message.length > 0)).toBe(true);
    });

    test('foreign screen inside a box is reported', () => {
        const r = lintGroups([{ id: 'g', box, title }], [{ kind: 'screen', id: 's', rect: { x: 200, y: 200, width: 100, height: 100 } }]);
        expect(r.counts['group-encloses-foreign']).toBe(1);
    });
});
