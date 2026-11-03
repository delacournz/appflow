import { describe, expect, test } from 'bun:test';

import { parseCustomProperties } from './css';

describe('parseCustomProperties', () => {
    test('records each custom property with its enclosing blocks and line', () => {
        const css = `/* a { b } */
@theme {
	--radius: 1rem; /* trailing */
	color: red;
}
@layer theme {
	:root {
		@variant dark {
			--bg: #0A0A0A;
		}
	}
}
@theme inline {
	--color-bg: var(--bg);
}`;
        expect(parseCustomProperties(css)).toEqual([
            { name: '--radius', value: '1rem', blocks: ['@theme'], line: 3 },
            { name: '--bg', value: '#0A0A0A', blocks: ['@layer theme', ':root', '@variant dark'], line: 9 },
            { name: '--color-bg', value: 'var(--bg)', blocks: ['@theme inline'], line: 14 },
        ]);
    });

    test('keeps strings and parentheses intact', () => {
        const css = '@theme { --font: "A;B"; --mix: color-mix(in oklch, var(--a) 14%, var(--b)); }';
        expect(parseCustomProperties(css).map((d) => d.value)).toEqual(['"A;B"', 'color-mix(in oklch, var(--a) 14%, var(--b))']);
    });

    test('a last declaration without a semicolon still counts', () => {
        expect(parseCustomProperties('@theme { --a: 1px }').map((d) => d.name)).toEqual(['--a']);
    });
});
