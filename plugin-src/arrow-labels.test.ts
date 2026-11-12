import { describe, expect, test } from 'bun:test';

import { isLabelsContainerName, labelsContainerName, labelsInsertIndex, labelsToMigrate, labelStackIssue, stackingNeeds } from './arrow-labels';

describe('labelsContainerName', () => {
    test('takes the board part from the board name, else the arrows container name', () => {
        expect(labelsContainerName('Board background · Main flow', 'Flow arrows')).toBe('Flow arrow labels · Main flow');
        expect(labelsContainerName('Board · Main flow')).toBe('Flow arrow labels · Main flow');
        expect(labelsContainerName('Background', 'Flow arrows · Main flow')).toBe('Flow arrow labels · Main flow');
        expect(labelsContainerName('', 'Flow arrows')).toBe('Flow arrow labels');
        expect(isLabelsContainerName('Flow arrow labels · Main flow')).toBe(true);
        expect(isLabelsContainerName('Flow arrows · Main flow')).toBe(false);
    });
});

describe('labelsToMigrate', () => {
    test('moves only labels that are not in the container yet, so a second run does nothing', () => {
        const arrows = [
            { labelId: 'a', labelParentId: 'g1' },
            { labelId: 'b', labelParentId: 'L' },
            { labelId: 'c', labelParentId: null },
        ];
        expect(labelsToMigrate(arrows, 'L')).toEqual(['a', 'c']);
        expect(labelsToMigrate(arrows.map((a) => ({ ...a, labelParentId: 'L' })), 'L')).toEqual([]);
    });
});

describe('stackingNeeds', () => {
    const screen = (id: string) => id.startsWith('s');
    test('labels sit directly above arrows, which sit above every screen', () => {
        expect(stackingNeeds(['s1', 's2', 'A', 'L'], screen, 'A', 'L')).toEqual({ raiseArrows: false, placeLabels: false });
    });
    test('a screen above the arrows raises both containers', () => {
        expect(stackingNeeds(['A', 'L', 's1'], screen, 'A', 'L')).toEqual({ raiseArrows: true, placeLabels: true });
    });
    test('labels below or away from the arrows are placed again', () => {
        expect(stackingNeeds(['L', 'A', 's1'].slice(0, 2), screen, 'A', 'L').placeLabels).toBe(true);
        expect(stackingNeeds(['A', 'x', 'L'], screen, 'A', 'L')).toEqual({ raiseArrows: false, placeLabels: true });
    });
    test('without a labels container only the arrows matter', () => {
        expect(stackingNeeds(['A', 's1'], screen, 'A', null)).toEqual({ raiseArrows: true, placeLabels: false });
    });
});

describe('labelsInsertIndex', () => {
    const move = (ids: string[], id: string, index: number): string[] => {
        const rest = ids.filter((x) => x !== id);
        const before = ids.slice(0, index).filter((x) => x !== id).length;
        return [...rest.slice(0, before), id, ...rest.slice(before)];
    };
    test('labels below the arrows end directly above them', () => {
        const ids = ['s1', 'L', 'A', 'b1'];
        expect(move(ids, 'L', labelsInsertIndex(ids, 'A'))).toEqual(['s1', 'A', 'L', 'b1']);
    });
    test('labels far above the arrows end directly above them', () => {
        const ids = ['A', 'x', 'L'];
        expect(move(ids, 'L', labelsInsertIndex(ids, 'A'))).toEqual(['A', 'L', 'x']);
    });
});

describe('labelStackIssue', () => {
    test('labels directly or anywhere above the arrows are fine', () => {
        expect(labelStackIssue(['A', 'L'], 'A', 'L')).toBeNull();
        expect(labelStackIssue(['A', 'b', 'L'], 'A', 'L')).toBeNull();
    });
    test('labels under the arrows are an issue', () => {
        expect(labelStackIssue(['L', 'A', 'b'], 'A', 'L')).toEqual({ kind: 'labels-under-lines', arrowsId: 'A', labelsId: 'L' });
    });
    test('no labels container or a different parent is not checked', () => {
        expect(labelStackIssue(['A'], 'A', null)).toBeNull();
        expect(labelStackIssue(['A'], 'A', 'L')).toBeNull();
    });
});
