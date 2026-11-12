import { describe, expect, test } from 'bun:test';

import { isLabelsContainerName, labelsContainerName, labelsToMigrate, stackingNeeds } from './arrow-labels';

describe('labelsContainerName', () => {
    test('mirrors the arrows container name', () => {
        expect(labelsContainerName('Flow arrows · Main flow')).toBe('Flow arrow labels · Main flow');
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
