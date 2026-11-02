import { describe, expect, test } from 'bun:test';

import { renderBoard, type BoardInput, type BoardScreen } from './board-text';

const meta = { originX: 100, originY: 200, colWidth: 400, rowHeight: 900 };
const at = (id: string, name: string, col: number, row: number, extra: Partial<BoardScreen> = {}): BoardScreen => ({
    id,
    name,
    col,
    row,
    x: meta.originX + col * meta.colWidth,
    y: meta.originY + row * meta.rowHeight,
    labelX: meta.originX + col * meta.colWidth,
    ...extra,
});

const base: BoardInput = {
    boardId: '1:1',
    name: 'Board · KYC',
    meta,
    screens: [at('a', 'Welcome', 0, 0), at('b', 'Verify your ID', 1, 0), at('c', 'In-app browser', 1, 1)],
    arrows: [
        { from: 'a', to: 'b', label: 'Continue', mode: 'trigger', triggerName: 'Button · Continue', exit: undefined },
        { from: 'b', to: 'c', label: 'Opens the provider link', mode: 'auto', triggerName: null, exit: 'bottom' },
    ],
};

describe('renderBoard', () => {
    test('draws the grid, arrows and no issues for a clean board', () => {
        const out = renderBoard(base, 10);
        expect(out.cols).toBe(2);
        expect(out.rows).toBe(2);
        expect(out.grid).toBe(
            [
                '    | c0         | c1',
                '----+------------+------------',
                ' r0 | Welcome    | Verify yo…',
                ' r1 |            | In-app br…',
            ].join('\n'),
        );
        expect(out.arrows).toEqual([
            'Welcome (c0,r0) --Continue--> Verify your ID (c1,r0) [trigger: Button · Continue]',
            'Verify your ID (c1,r0) --Opens the provider link--> In-app browser (c1,r1) [auto] [bottom exit]',
        ]);
        expect(out.issues).toEqual([]);
    });

    test('reports a screen whose meta cell disagrees with its position', () => {
        const out = renderBoard({ ...base, screens: [at('a', 'Welcome', 0, 0, { x: meta.originX + 2 * meta.colWidth, labelX: meta.originX + 2 * meta.colWidth }), ...base.screens.slice(1)] }, 10);
        expect(out.issues).toEqual(['Welcome: meta says (c0,r0) but it sits at (c2,r0)']);
    });

    test('reports stale label meta, double-booked cells, missing endpoints and left arrows', () => {
        const input: BoardInput = {
            ...base,
            screens: [at('a', 'Welcome', 0, 0, { labelX: 5 }), at('b', 'Verify your ID', 1, 0), at('c', 'Dupe', 1, 0)],
            arrows: [
                { from: 'b', to: 'a', label: 'Back', mode: 'auto', triggerName: null, exit: undefined },
                { from: 'a', to: 'gone', label: 'Lost', mode: 'auto', triggerName: null, exit: undefined },
            ],
        };
        const out = renderBoard(input, 10);
        expect(out.issues).toEqual([
            'Welcome: label is at x=5 but the frame is at x=100',
            'Cell (c1,r0) holds 2 screens: Verify your ID, Dupe',
            'Arrow "Lost": target gone is missing',
            'Arrow "Back" points left: Verify your ID (c1) to Welcome (c0)',
        ]);
        expect(out.arrows).toEqual([
            'Welcome (c0,r0) --Lost--> gone (missing) [auto]',
            'Verify your ID (c1,r0) --Back--> Welcome (c0,r0) [auto]',
        ]);
    });

    test('handles an empty board', () => {
        const out = renderBoard({ ...base, screens: [], arrows: [] });
        expect(out).toMatchObject({ cols: 0, rows: 0, grid: '', arrows: [], issues: [] });
    });
});
