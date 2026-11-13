import { describe, expect, test } from 'bun:test';

import { arrowsContainerName, isArrowsContainerType, recoverableArrowIds, recoveryIndex } from './arrow-recovery';

describe('arrow container recovery', () => {
    test('names the container after the board', () => {
        expect(arrowsContainerName('Board background · Main flow')).toBe('Flow arrows · Main flow');
        expect(arrowsContainerName('Board · Main flow')).toBe('Flow arrows · Main flow');
        expect(arrowsContainerName('Background')).toBe('Flow arrows');
    });
    test('only real containers count as present', () => {
        expect(isArrowsContainerType('FRAME')).toBe(true);
        expect(isArrowsContainerType('GROUP')).toBe(true);
        expect(isArrowsContainerType('RECTANGLE')).toBe(false);
    });
    test('goes directly below the labels container, else on top', () => {
        expect(recoveryIndex(['s1', 's2', 'L'], 'L')).toBe(2);
        expect(recoveryIndex(['s1', 's2'], null)).toBe(2);
        expect(recoveryIndex(['s1', 's2'], 'gone')).toBe(2);
    });
    test('gathers only this board\'s arrow nodes', () => {
        expect(recoverableArrowIds([{ id: 'a', boardId: '1:1' }, { id: 'b', boardId: '2:2' }, { id: 'c', boardId: null }], '1:1')).toEqual(['a']);
    });
});
