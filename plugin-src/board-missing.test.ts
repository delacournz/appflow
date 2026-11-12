import { describe, expect, test } from 'bun:test';

import { boardMissingMessage, findOrphans } from './board-missing';

describe('board missing', () => {
    test('the message names the board and how to recover', () => {
        const m = boardMissingMessage('2024:2387');
        expect(m).toContain('Board background 2024:2387 is missing');
        expect(m).toContain('Cmd+Z');
        expect(m).toContain('Show version history');
        expect(m).toContain('repair_board');
    });

    test('orphans are counted per missing board, screens and groups', () => {
        const issues = findOrphans(['b1', 'b1', 'b1', 'b2'], ['b1', 'b1'], new Set(['b2']));
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ kind: 'board-background-missing', boardId: 'b1', screens: 3, groups: 2 });
    });

    test('nothing is reported while every board resolves', () => {
        expect(findOrphans(['b1'], ['b1'], new Set(['b1']))).toEqual([]);
    });

    test('a board known only from its groups is reported too', () => {
        expect(findOrphans([], ['b9'], new Set())).toMatchObject([{ boardId: 'b9', screens: 0, groups: 1 }]);
    });
});
