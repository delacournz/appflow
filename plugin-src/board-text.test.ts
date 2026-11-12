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

    test('a grouped screen at absolute coordinates reports no issues', () => {
        const out = renderBoard({ ...base, screens: [at('a', 'Welcome', 0, 0, { labelX: 100 }), at('b', 'Verify your ID', 1, 0, { labelX: 500 })], arrows: [] });
        expect(out.issues).toEqual([]);
    });
});

describe('build status', () => {
    test('marks cells, lists screens and flags gaps', () => {
        const out = renderBoard(
            {
                ...base,
                screens: [
                    at('a', 'Welcome', 0, 0, { status: 'built', route: 'src/app/index.tsx', verifiedAt: '2026-11-03', hasBadge: true }),
                    at('b', 'Verify your ID', 1, 0, { status: 'drift', route: 'src/app/verify.tsx', verifiedAt: '2026-11-03', hasBadge: true }),
                    at('c', 'In-app browser', 1, 1, { status: 'built', route: null, verifiedAt: '2026-11-03', hasBadge: false }),
                ],
                arrows: [],
            },
            12,
        );
        expect(out.grid).toBe(
            [
                '    | c0           | c1',
                '----+--------------+--------------',
                ' r0 | ✓ Welcome    | ~ Verify yo…',
                ' r1 |              | ✓ In-app br…',
            ].join('\n'),
        );
        expect(out.screens).toEqual([
            { id: 'a', name: 'Welcome', col: 0, row: 0, route: 'src/app/index.tsx', status: 'built', verifiedAt: '2026-11-03' },
            { id: 'b', name: 'Verify your ID', col: 1, row: 0, route: 'src/app/verify.tsx', status: 'drift', verifiedAt: '2026-11-03' },
            { id: 'c', name: 'In-app browser', col: 1, row: 1, route: null, status: 'built', verifiedAt: '2026-11-03' },
        ]);
        expect(out.issues).toEqual(['In-app browser: no build badge (run badge_screens)', 'In-app browser: marked built but has no route text']);
    });
});

describe('flow groups', () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const withGroups = (groups: NonNullable<BoardInput['groups']>, screens = base.screens): BoardInput => ({ ...base, screens, groups });

    test('lists groups with member names and draws the tree', () => {
        const screens = [at('a', 'Welcome', 0, 0, { flowGroupId: 'g1' }), at('b', 'Verify your ID', 1, 0, { flowGroupId: 'g2' }), at('c', 'In-app browser', 1, 1)];
        const out = renderBoard(
            withGroups(
                [
                    { id: 'g1', name: 'Account', screenIds: ['a'], box, visible: true },
                    { id: 'g2', name: 'Passkeys', parentId: 'g1', screenIds: ['b'], box, visible: true },
                ],
                screens,
            ),
            10,
        );
        expect(out.groups).toEqual([
            { id: 'g1', name: 'Account', parentId: null, screens: ['Welcome'], box },
            { id: 'g2', name: 'Passkeys', parentId: 'g1', screens: ['Verify your ID'], box },
        ]);
        expect(out.groupTree).toBe('Account (g1): Welcome\n  Passkeys (g2): Verify your ID');
        expect(out.issues).toEqual([]);
    });

    test('no groups gives empty output', () => {
        const out = renderBoard(base, 10);
        expect(out.groups).toEqual([]);
        expect(out.groupTree).toBe('');
    });

    test('flags empty, hidden and stale groups', () => {
        const screens = [at('a', 'Welcome', 0, 0, { flowGroupId: 'g1' }), at('b', 'Verify your ID', 1, 0), at('c', 'In-app browser', 1, 1)];
        const out = renderBoard(
            withGroups(
                [
                    { id: 'g1', name: 'Stale', screenIds: ['a', 'zz', 'b'], box, visible: true },
                    { id: 'g2', name: 'Empty', screenIds: [], box, visible: false },
                    { id: 'g3', name: 'Hidden', screenIds: ['c'], box, visible: false },
                    { id: 'g4', name: 'Orphan', parentId: 'nope', screenIds: [], box, visible: true },
                ],
                screens,
            ),
            10,
        );
        const text = out.issues.join('\n');
        expect(text).toContain('Group "Stale" lists zz, which is not a screen on this board');
        expect(text).toContain('Group "Stale" lists Verify your ID, whose flow group is not it');
        expect(text).toContain('Group "Empty" has no screens');
        expect(text).toContain('Group "Hidden" is hidden but has screens');
        expect(text).toContain('Group "Orphan" has a missing parent nope');
    });

    test('flags a screen pointing at a missing group', () => {
        const out = renderBoard(withGroups([], [at('a', 'Welcome', 0, 0, { flowGroupId: 'gone' }), ...base.screens.slice(1)]), 10);
        expect(out.issues.join('\n')).toContain('Welcome: flow group gone no longer exists');
    });
});
