/**
 * A Mermaid flowchart subset: `flowchart|graph TD|TB|BT|LR|RL`, node shapes
 * `[ ]`, `( )`, `{ }`, `(( ))`, `([ ])`, `[[ ]]`, links `-->`, `---`, `-.->`,
 * `==>` with `|label|` or inline `-- label -->` text, and chains `a --> b --> c`.
 * Pure, so it is tested without Figma.
 */

export type Direction = 'TB' | 'BT' | 'LR' | 'RL';
export type NodeShape = 'rect' | 'round' | 'diamond' | 'circle' | 'stadium';
export type ChartNode = { id: string; label: string; shape: NodeShape };
export type ChartEdge = { from: string; to: string; label: string; style: 'solid' | 'dotted' | 'thick'; arrow: boolean };
export type Flowchart = { direction: Direction; nodes: ChartNode[]; edges: ChartEdge[] };

const SHAPES: { open: string; close: string; shape: NodeShape }[] = [
    { open: '((', close: '))', shape: 'circle' },
    { open: '([', close: '])', shape: 'stadium' },
    { open: '[[', close: ']]', shape: 'rect' },
    { open: '[', close: ']', shape: 'rect' },
    { open: '(', close: ')', shape: 'round' },
    { open: '{', close: '}', shape: 'diamond' },
];

const LINKS: { re: RegExp; style: ChartEdge['style']; arrow: boolean }[] = [
    { re: /^--\s+(.+?)\s+-->/, style: 'solid', arrow: true },
    { re: /^-\.\s+(.+?)\s+\.->/, style: 'dotted', arrow: true },
    { re: /^==\s+(.+?)\s+==>/, style: 'thick', arrow: true },
    { re: /^-\.->/, style: 'dotted', arrow: true },
    { re: /^-\.-/, style: 'dotted', arrow: false },
    { re: /^==>/, style: 'thick', arrow: true },
    { re: /^===/, style: 'thick', arrow: false },
    { re: /^-->/, style: 'solid', arrow: true },
    { re: /^---/, style: 'solid', arrow: false },
];

const IGNORED = /^(%%|classDef\b|class\b|style\b|linkStyle\b|click\b|subgraph\b|end\b|direction\b)/;

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

export function parseMermaid(source: string): Flowchart {
    const lines = source.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
    const header = /^(flowchart|graph)\s*(TD|TB|BT|LR|RL)?\s*$/i.exec(lines[0] ?? '');
    if (!header) throw new Error('Only Mermaid flowcharts are supported: start with "flowchart TD" or "graph LR".');
    const dir = (header[2] ?? 'TB').toUpperCase();
    const direction: Direction = dir === 'TD' ? 'TB' : (dir as Direction);

    const nodes = new Map<string, ChartNode>();
    const edges: ChartEdge[] = [];

    const readNode = (text: string): { id: string; rest: string } | null => {
        const m = /^([A-Za-z0-9_\-.]+?)(?=$|\s|\[|\(|\{|-->|---|-\.|==|&)/.exec(text);
        if (!m) return null;
        const id = m[1] as string;
        let rest = text.slice(id.length);
        let label: string | null = null;
        let shape: NodeShape = 'rect';
        for (const s of SHAPES) {
            if (!rest.startsWith(s.open)) continue;
            const end = rest.indexOf(s.close, s.open.length);
            if (end === -1) continue;
            label = unquote(rest.slice(s.open.length, end));
            shape = s.shape;
            rest = rest.slice(end + s.close.length);
            break;
        }
        const existing = nodes.get(id);
        if (!existing) nodes.set(id, { id, label: label ?? id, shape });
        else if (label !== null && existing.label === existing.id) nodes.set(id, { id, label, shape });
        return { id, rest };
    };

    for (const line of lines.slice(1)) {
        if (IGNORED.test(line)) continue;
        let text = line;
        const first = readNode(text);
        if (!first) continue;
        let from = first.id;
        text = first.rest.trimStart();
        while (text.length > 0) {
            const link = LINKS.map((l) => ({ l, m: l.re.exec(text) })).find((x) => x.m);
            if (!link?.m) break;
            let label = link.m[1] ? unquote(link.m[1]) : '';
            text = text.slice(link.m[0].length).trimStart();
            const pipe = /^\|([^|]*)\|/.exec(text);
            if (pipe) {
                label = unquote(pipe[1] ?? '');
                text = text.slice(pipe[0].length).trimStart();
            }
            const next = readNode(text);
            if (!next) break;
            edges.push({ from, to: next.id, label, style: link.l.style, arrow: link.l.arrow });
            from = next.id;
            text = next.rest.trimStart();
        }
    }
    return { direction, nodes: [...nodes.values()], edges };
}

export type LayoutOptions = { nodeWidth: number; nodeHeight: number; gapMain: number; gapCross: number };

/** Top-left positions per node id: layered by longest path, siblings centred across the flow. */
export function layoutFlowchart(chart: Flowchart, o: LayoutOptions): Record<string, { x: number; y: number }> {
    const ids = chart.nodes.map((n) => n.id);
    const order = new Map(ids.map((id, i) => [id, i]));
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const e of chart.edges) out.get(e.from)?.push(e.to);

    // Drop back edges (found by DFS) so the rest is a DAG.
    const back = new Set<string>();
    const state = new Map<string, 'active' | 'done'>();
    const visit = (id: string) => {
        state.set(id, 'active');
        for (const to of out.get(id) ?? []) {
            if (state.get(to) === 'active') back.add(`${id}>${to}`);
            else if (!state.has(to)) visit(to);
        }
        state.set(id, 'done');
    };
    for (const id of ids) if (!state.has(id)) visit(id);

    const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const e of chart.edges) if (!back.has(`${e.from}>${e.to}`)) preds.get(e.to)?.push(e.from);
    const rank = new Map<string, number>();
    const rankOf = (id: string): number => {
        const known = rank.get(id);
        if (known !== undefined) return known;
        rank.set(id, 0);
        const r = Math.max(0, ...(preds.get(id) ?? []).map((p) => rankOf(p) + 1));
        rank.set(id, r);
        return r;
    };
    for (const id of ids) rankOf(id);

    const maxRank = Math.max(0, ...rank.values());
    const layers = new Map<number, string[]>();
    for (const id of ids) {
        const r = rank.get(id) ?? 0;
        layers.set(r, [...(layers.get(r) ?? []), id]);
    }

    const vertical = chart.direction === 'TB' || chart.direction === 'BT';
    const reversed = chart.direction === 'BT' || chart.direction === 'RL';
    const mainStep = (vertical ? o.nodeHeight : o.nodeWidth) + o.gapMain;
    const crossStep = (vertical ? o.nodeWidth : o.nodeHeight) + o.gapCross;
    const pos: Record<string, { x: number; y: number }> = {};
    for (const [r, layer] of layers) {
        layer.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
        layer.forEach((id, i) => {
            const main = (reversed ? maxRank - r : r) * mainStep;
            const cross = Math.round((i - (layer.length - 1) / 2) * crossStep);
            pos[id] = vertical ? { x: cross, y: main } : { x: main, y: cross };
        });
    }
    return pos;
}
