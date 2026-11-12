import { describe, expect, test } from 'bun:test';
import { lintArrows, lintGroups } from './group-lint';

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

describe('lintArrows', () => {
    const arrow = (id: string, points: { x: number; y: number }[], label: { x: number; y: number; width: number; height: number } | null = null) => ({ id, points, label });

    test('two labels that intersect are reported once', () => {
        const r = lintArrows(
            [arrow('a', [{ x: 0, y: 0 }, { x: 0, y: 500 }], { x: -50, y: 200, width: 100, height: 31 }), arrow('b', [{ x: 24, y: 0 }, { x: 24, y: 500 }], { x: -26, y: 210, width: 100, height: 31 })],
            [],
        );
        expect(r.counts['label-overlaps-label']).toBe(1);
        expect(r.issues.find((i) => i.kind === 'label-overlaps-label')?.message).toContain('a');
    });

    test('labels that only touch or sit apart are fine', () => {
        const r = lintArrows(
            [arrow('a', [{ x: 0, y: 0 }, { x: 0, y: 500 }], { x: 0, y: 0, width: 100, height: 31 }), arrow('b', [{ x: 300, y: 0 }, { x: 300, y: 500 }], { x: 0, y: 31, width: 100, height: 31 })],
            [],
        );
        expect(r.counts['label-overlaps-label']).toBeUndefined();
    });

    test('collinear segments sharing more than 40px are lines-overlap; 40px or less, offset lanes and crossings are not', () => {
        const base = arrow('a', [{ x: 100, y: 0 }, { x: 100, y: 300 }]);
        expect(lintArrows([base, arrow('b', [{ x: 100, y: 200 }, { x: 100, y: 400 }])], []).counts['lines-overlap']).toBe(1);
        expect(lintArrows([base, arrow('b', [{ x: 100, y: 260 }, { x: 100, y: 400 }])], []).counts['lines-overlap']).toBeUndefined();
        expect(lintArrows([base, arrow('b', [{ x: 124, y: 0 }, { x: 124, y: 300 }])], []).counts['lines-overlap']).toBeUndefined();
        expect(lintArrows([base, arrow('b', [{ x: 0, y: 150 }, { x: 400, y: 150 }])], []).counts['lines-overlap']).toBeUndefined();
        const horizontal = arrow('h', [{ x: 0, y: 50 }, { x: 300, y: 50 }]);
        expect(lintArrows([horizontal, arrow('i', [{ x: 100, y: 50 }, { x: 500, y: 50 }])], []).counts['lines-overlap']).toBe(1);
    });

    test('a line through a title text rect is line-crosses-title; one beside it is not', () => {
        const title = { id: 'g', text: { x: 0, y: 0, width: 300, height: 173 } };
        const crossing = arrow('a', [{ x: 150, y: 400 }, { x: 150, y: -300 }]);
        const beside = arrow('b', [{ x: 340, y: 400 }, { x: 340, y: -300 }]);
        const above = arrow('c', [{ x: 150, y: -100 }, { x: 150, y: -300 }]);
        const horizontal = arrow('d', [{ x: -100, y: 80 }, { x: 600, y: 80 }]);
        const r = lintArrows([crossing, beside, above, horizontal], [title]);
        expect(r.issues.filter((i) => i.kind === 'line-crosses-title').map((i) => (i as { arrowId: string }).arrowId)).toEqual(['a', 'd']);
        expect(r.counts['line-crosses-title']).toBe(2);
    });
});
