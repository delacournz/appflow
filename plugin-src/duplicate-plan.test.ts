import { describe, expect, test } from 'bun:test';
import { screenNames } from './screen-group';
import { bannerName, cellRect, findDescendant, frameName, growBounds, labelName, overlapsAny, pickBanner, routeName, type TreeNode } from './duplicate-plan';

const board = { originX: 100, originY: 200, colWidth: 500, rowHeight: 1000, screenW: 390, screenH: 844 };

describe('cellRect', () => {
    test('origin cell', () => {
        expect(cellRect(board, 0, 0)).toEqual({ x: 100, y: 200, width: 390, height: 844 });
    });
    test('offsets by col and row', () => {
        expect(cellRect(board, 2, 3)).toEqual({ x: 1100, y: 3200, width: 390, height: 844 });
    });
});

describe('overlapsAny', () => {
    const target = { x: 0, y: 0, width: 100, height: 100 };
    test('no rects', () => expect(overlapsAny(target, [])).toBe(-1));
    test('returns index of first overlap', () => {
        expect(overlapsAny(target, [{ x: 200, y: 0, width: 50, height: 50 }, { x: 50, y: 50, width: 100, height: 100 }])).toBe(1);
    });
    test('touching edges do not overlap', () => {
        expect(overlapsAny(target, [{ x: 100, y: 0, width: 50, height: 50 }, { x: 0, y: 100, width: 50, height: 50 }])).toBe(-1);
    });
    test('contained rect overlaps', () => {
        expect(overlapsAny(target, [{ x: 10, y: 10, width: 5, height: 5 }])).toBe(0);
    });
});

describe('growBounds', () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
    test('unchanged when inside', () => {
        expect(growBounds(bounds, [{ x: 100, y: 100, width: 100, height: 100 }], 50)).toEqual(bounds);
    });
    test('grows right and down with margin', () => {
        expect(growBounds(bounds, [{ x: 900, y: 950, width: 200, height: 300 }], 40)).toEqual({ x: 0, y: 0, width: 1140, height: 1290 });
    });
    test('grows left and up with margin', () => {
        expect(growBounds(bounds, [{ x: -10, y: -20, width: 50, height: 50 }], 30)).toEqual({ x: -40, y: -50, width: 1040, height: 1050 });
    });
});

describe('naming', () => {
    test('names', () => {
        expect(frameName('Home')).toBe('Home');
        expect(labelName('Home')).toBe('Label · Home');
        expect(routeName('Home')).toBe('Route · Home');
        expect(bannerName('KYC')).toBe('ListGroup.Item · KYC');
    });
});

const n = (name: string, children?: TreeNode[]): TreeNode => ({ name, children });

describe('pickBanner', () => {
    test('prefers KycEntryRow', () => {
        const kyc = n('KycEntryRow', [n('x')]);
        const tree = n('Screen', [n('ListGroup.Item', [n('a')]), n('Body', [kyc])]);
        expect(pickBanner(tree)).toBe(kyc);
    });
    test('falls back to first ListGroup.Item frame', () => {
        const first = n('ListGroup.Item', [n('ListGroup.ItemTitle')]);
        const tree = n('Screen', [n('ListGroup.ItemTitle'), first, n('ListGroup.Item 2', [])]);
        expect(pickBanner(tree)).toBe(first);
    });
    test('ignores leaf nodes that match the prefix', () => {
        expect(pickBanner(n('Screen', [n('ListGroup.ItemTitle')]))).toBeNull();
    });
    test('null when nothing matches', () => {
        expect(pickBanner(n('Screen', [n('Other', [])]))).toBeNull();
    });
    test('does not match the root itself', () => {
        expect(pickBanner(n('KycEntryRow', []))).toBeNull();
    });
});

describe('findDescendant', () => {
    test('depth-first by predicate', () => {
        const t = n('r', [n('a', [n('ListGroup.ItemTitle')]), n('ListGroup.ItemTitle')]);
        expect(findDescendant(t, (x) => x.name.endsWith('ItemTitle'))).toBe((t.children as TreeNode[])[0]?.children?.[0] ?? null);
    });
});

describe('screen layer names', () => {
    test('match the label and route naming used when cloning', () => {
        const n = screenNames('Expired');
        expect(n.frame).toBe(frameName('Expired'));
        expect(n.label).toBe(labelName('Expired'));
        expect(n.route).toBe(routeName('Expired'));
    });
});
