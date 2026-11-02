import { describe, expect, test } from 'bun:test';

import { layoutFlowchart, parseMermaid } from './mermaid';

describe('parseMermaid', () => {
    test('reads direction, node shapes and labels', () => {
        const chart = parseMermaid(`flowchart LR
  A[Sign in] --> B{Code ok?}
  B -->|yes| C(Tabs)
  B -- no --> D((Retry))
  C --> E([Done])`);
        expect(chart.direction).toBe('LR');
        expect(chart.nodes).toEqual([
            { id: 'A', label: 'Sign in', shape: 'rect' },
            { id: 'B', label: 'Code ok?', shape: 'diamond' },
            { id: 'C', label: 'Tabs', shape: 'round' },
            { id: 'D', label: 'Retry', shape: 'circle' },
            { id: 'E', label: 'Done', shape: 'stadium' },
        ]);
        expect(chart.edges).toEqual([
            { from: 'A', to: 'B', label: '', style: 'solid', arrow: true },
            { from: 'B', to: 'C', label: 'yes', style: 'solid', arrow: true },
            { from: 'B', to: 'D', label: 'no', style: 'solid', arrow: true },
            { from: 'C', to: 'E', label: '', style: 'solid', arrow: true },
        ]);
    });

    test('accepts graph TD, dotted, thick and plain links, chains and bare ids', () => {
        const chart = parseMermaid(`graph TD
  a -.-> b ==> c --- d
  %% a comment
  b --> a`);
        expect(chart.direction).toBe('TB');
        expect(chart.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(chart.nodes[0]).toEqual({ id: 'a', label: 'a', shape: 'rect' });
        expect(chart.edges.map((e) => [e.from, e.to, e.style, e.arrow])).toEqual([
            ['a', 'b', 'dotted', true],
            ['b', 'c', 'thick', true],
            ['c', 'd', 'solid', false],
            ['b', 'a', 'solid', true],
        ]);
    });

    test('keeps the first label given to a node', () => {
        const chart = parseMermaid('flowchart TD\n A[Start] --> B\n A --> C[End]');
        expect(chart.nodes.find((n) => n.id === 'A')?.label).toBe('Start');
    });

    test('rejects other diagram types', () => {
        expect(() => parseMermaid('sequenceDiagram\n A->>B: hi')).toThrow('flowchart');
    });
});

describe('layoutFlowchart', () => {
    test('ranks nodes by longest path and spreads siblings', () => {
        const chart = parseMermaid('flowchart TD\n A --> B\n A --> C\n B --> D\n C --> D');
        const pos = layoutFlowchart(chart, { nodeWidth: 100, nodeHeight: 40, gapMain: 60, gapCross: 20 });
        expect(pos.A.y).toBe(0);
        expect(pos.B.y).toBe(100);
        expect(pos.C.y).toBe(100);
        expect(pos.D.y).toBe(200);
        expect(pos.B.x).not.toBe(pos.C.x);
    });

    test('LR lays ranks along x', () => {
        const chart = parseMermaid('flowchart LR\n A --> B');
        const pos = layoutFlowchart(chart, { nodeWidth: 100, nodeHeight: 40, gapMain: 60, gapCross: 20 });
        expect(pos.A.x).toBe(0);
        expect(pos.B.x).toBe(160);
        expect(pos.A.y).toBe(pos.B.y);
    });

    test('survives cycles', () => {
        const chart = parseMermaid('flowchart TD\n A --> B\n B --> A');
        const pos = layoutFlowchart(chart, { nodeWidth: 100, nodeHeight: 40, gapMain: 60, gapCross: 20 });
        expect(Object.keys(pos).sort()).toEqual(['A', 'B']);
    });
});
