import { describe, expect, test } from 'bun:test';

import type { StyleDecl } from '../../shared/design-style';
import { interpretClasses } from './tw-classes';

const tokens = new Map<string, number | null>([
    ['color/muted', null],
    ['color/muted-foreground', null],
    ['color/border', null],
    ['radius/notice', 14],
    ['radius/full', 9999],
    ['spacing/button-lg', 56],
    ['spacing/icon-md', 18],
    ['text/sm', 14],
]);
const run = (classes: string) => interpretClasses(classes, tokens);

describe('interpretClasses', () => {
    test.each<[string, StyleDecl[]]>([
        ['bg-muted', [{ kind: 'fill', token: 'color/muted' }]],
        ['bg-transparent', [{ kind: 'fill-none' }]],
        ['border', [{ kind: 'stroke-weight', value: 1 }]],
        ['border-2', [{ kind: 'stroke-weight', value: 2 }]],
        ['border-border', [{ kind: 'stroke', token: 'color/border' }]],
        ['border-transparent', [{ kind: 'stroke-none' }]],
        ['rounded-notice', [{ kind: 'radius', token: 'radius/notice', value: 14 }]],
        ['rounded-full', [{ kind: 'radius', token: 'radius/full', value: 9999 }]],
        ['rounded-none', [{ kind: 'radius', value: 0 }]],
        ['h-14', [{ kind: 'size', axis: 'height', value: 56 }]],
        ['w-px', [{ kind: 'size', axis: 'width', value: 1 }]],
        ['h-button-lg', [{ kind: 'size', axis: 'height', token: 'spacing/button-lg', value: 56 }]],
        [
            'size-icon-md',
            [
                { kind: 'size', axis: 'width', token: 'spacing/icon-md', value: 18 },
                { kind: 'size', axis: 'height', token: 'spacing/icon-md', value: 18 },
            ],
        ],
        [
            'px-3',
            [
                { kind: 'padding', side: 'left', value: 12 },
                { kind: 'padding', side: 'right', value: 12 },
            ],
        ],
        ['pt-0.5', [{ kind: 'padding', side: 'top', value: 2 }]],
        ['gap-1.5', [{ kind: 'gap', value: 6 }]],
        ['text-sm', [{ kind: 'font-size', token: 'text/sm', value: 14 }]],
        ['text-muted-foreground', [{ kind: 'text-fill', token: 'color/muted-foreground' }]],
        ['font-semibold', [{ kind: 'font-weight', style: 'SemiBold' }]],
        ['opacity-50', [{ kind: 'opacity', value: 0.5 }]],
        ['flex-row', [{ kind: 'layout', mode: 'HORIZONTAL' }]],
        ['items-center', [{ kind: 'align', axis: 'counter', value: 'CENTER' }]],
        ['justify-between', [{ kind: 'align', axis: 'primary', value: 'SPACE_BETWEEN' }]],
    ])('%s', (cls, decls) => {
        expect(run(cls)).toEqual({ decls, unknown: [] });
    });

    test('unknown, state-prefixed and arbitrary classes are reported', () => {
        expect(run('bg-nope active:bg-muted h-[52px] min-w-0 p-4')).toEqual({
            decls: [
                { kind: 'padding', side: 'top', value: 16 },
                { kind: 'padding', side: 'right', value: 16 },
                { kind: 'padding', side: 'bottom', value: 16 },
                { kind: 'padding', side: 'left', value: 16 },
            ],
            unknown: ['bg-nope', 'active:bg-muted', 'h-[52px]', 'min-w-0'],
        });
    });

    test('a later class of the same kind wins', () => {
        expect(run('bg-muted bg-transparent').decls).toEqual([{ kind: 'fill-none' }]);
    });
});
