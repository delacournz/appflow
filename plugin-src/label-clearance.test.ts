import { describe, expect, test } from 'bun:test';

import { fitBox, groupConflicts, type ConflictContent, type ConflictGroup } from './flow-group';
import { internalArrowRects, sameBoxes, type GroupRec } from './flow-group-plan';
import type { Rect } from './rect';
import { clearLabel, labelObstacles } from './route-avoid';
import { planRoutes } from './route-plan';

/**
 * End to end on the numbers of a live board (screens 393x852, stroke 12, padding 160, clear 48): route the arrow, clear its
 * label against the boxes, then run the same conflict check the lint uses. No labels may touch a stroke zone or a title bar.
 */
const F = (x: number, y: number): Rect => ({ x, y, width: 393, height: 852 });
const rec = (id: string, screenIds: string[], parentId?: string): GroupRec => ({ id, name: id, screenIds, ...(parentId ? { parentId } : {}) });
const withRoute = (source: Rect, target: Rect, boxes: ConflictGroup[], size: { width: number; height: number }) => {
    const plan = planRoutes(
        { gutter: 307, limits: [undefined], boxes: boxes.map((b) => ({ ...b.box, strokeWeight: 12 })) },
        [{ id: 'a', ends: { source, target, trigger: null, triggerMissing: false, exit: 'side' } }],
    )[0];
    const route = plan?.route;
    if (!route) throw new Error('no route');
    const placed = clearLabel(route, size, labelObstacles(boxes.map((b) => ({ box: b.box, title: b.title, strokeWeight: 12 }))));
    return { route, placed };
};
const rectAt = (c: { x: number; y: number }, s: { width: number; height: number }): Rect => ({ x: c.x - s.width / 2, y: c.y - s.height / 2, width: s.width, height: s.height });
const conflictsFor = (boxes: ConflictGroup[], screens: Rect[], label: Rect) => {
    const contents: ConflictContent[] = [...screens.map((r, i): ConflictContent => ({ kind: 'screen', id: `s${i}`, rect: r })), { kind: 'label', id: 'L', rect: label }];
    return groupConflicts(boxes.map((b) => ({ ...b, strokeWeight: 12 })), contents).filter((i) => i.kind !== 'group-encloses-foreign');
};

describe('labels inside a group (live case: wide label on a down arrow)', () => {
    const a = F(6464, 2174);
    const b = F(6464, 3286);
    const size = { width: 347, height: 31 };
    const label = rectAt({ x: 6804, y: 3156 }, size);

    test('without the label in the content the right stroke zone is hit', () => {
        const { box, title } = fitBox([a, b]);
        const boxes: ConflictGroup[] = [{ id: 'g', box, title }];
        expect(box.x + box.width).toBe(6464 + 393 + 172);
        expect(conflictsFor(boxes, [a, b], label).length).toBeGreaterThan(0);
    });

    test('with the internal arrow label in the content the box wraps it with padding', () => {
        const rects = internalArrowRects([rec('g', ['a', 'b'])], [{ from: 'a', to: 'b', rects: [label] }]).get('g') ?? [];
        expect(rects).toEqual([label]);
        const { box, title } = fitBox([a, b, ...rects]);
        expect(box.x + box.width).toBeGreaterThanOrEqual(label.x + label.width + 160 + 12);
        expect(conflictsFor([{ id: 'g', box, title }], [a, b], label)).toEqual([]);
    });

    test('arrows that leave the group are not wrapped; children count for their parent', () => {
        const arrows = [{ from: 'a', to: 'x', rects: [label] }, { from: 'c', to: 'd', rects: [label] }];
        const map = internalArrowRects([rec('p', ['a'], undefined), rec('k', ['c', 'd'], 'p')], arrows);
        expect(map.get('p')).toEqual([label]);
        expect(map.get('k')).toEqual([label]);
        const parent = internalArrowRects([rec('p', ['a', 'c', 'x']), rec('k', ['d'], 'p')], [{ from: 'c', to: 'd', rects: [label] }]);
        expect(parent.get('p')).toEqual([label]);
        expect(parent.get('k')).toBeUndefined();
    });
});

describe('labels between groups', () => {
    test('side by side: a label next to the source lands in the gap, off the left box stroke', () => {
        const source = F(10385, 3286);
        const target = F(11804, 3286);
        const left = fitBox([source]);
        const right = fitBox([target]);
        const boxes: ConflictGroup[] = [{ id: 'l', ...left }, { id: 'r', ...right }];
        const size = { width: 128, height: 31 };
        const { placed } = withRoute(source, target, boxes, size);
        expect(placed.ok).toBe(true);
        if (!placed.ok) return;
        const at = rectAt(placed.anchor, size);
        expect(at.x).toBeGreaterThanOrEqual(left.box.x + left.box.width + 48);
        expect(at.x + at.width).toBeLessThanOrEqual(right.box.x - 48);
        expect(conflictsFor(boxes, [source, target], at)).toEqual([]);
    });

    test('stacked: a vertical label slides between the upper box bottom and the lower title bar, keeping 48 clear', () => {
        const upper = F(11804, 4398);
        const lower = F(11804, 6162);
        const upperFit = fitBox([upper]);
        const lowerFit = fitBox([lower]);
        const boxes: ConflictGroup[] = [{ id: 'u', ...upperFit }, { id: 'l', ...lowerFit }];
        const size = { width: 114, height: 31 };
        const { placed } = withRoute(lower, upper, boxes, size);
        expect(placed.ok).toBe(true);
        if (!placed.ok) return;
        const at = rectAt(placed.anchor, size);
        expect(at.y).toBeGreaterThanOrEqual(upperFit.box.y + upperFit.box.height + 48);
        expect(at.y + at.height).toBeLessThanOrEqual(lowerFit.title.y - 48);
        expect(conflictsFor(boxes, [upper, lower], at)).toEqual([]);
    });
});

describe('sameBoxes', () => {
    const b = { id: 'g', box: { x: 0, y: 0, width: 10, height: 10 }, title: { x: 0, y: -5, width: 10, height: 5 } };
    test('equal within half a pixel; different when a box grows or a group is missing', () => {
        expect(sameBoxes([b], [{ ...b, box: { ...b.box, width: 10.2 } }])).toBe(true);
        expect(sameBoxes([b], [{ ...b, box: { ...b.box, width: 40 } }])).toBe(false);
        expect(sameBoxes([b], [])).toBe(false);
    });
});
