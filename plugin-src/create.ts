import type { HtmlBox, HtmlLayer, HtmlText } from '../shared/html';
import type { JsonObject, JsonValue } from '../shared/protocol';
import { layoutFlowchart, type ChartEdge, type ChartNode, type Flowchart, parseMermaid } from './mermaid';
import { errorText, freeSpot, resolveFont, toJson } from './nodes';
import { fail, type Handler, num, ok, str } from './types';

// ---------- use_figma

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
) => (figmaApi: PluginAPI, console: Pick<Console, 'log' | 'info' | 'warn' | 'error'>) => Promise<unknown>;

export const useFigma: Handler = async (args) => {
    const code = str(args, 'code');
    if (!code) return fail('`code` is required.');
    const logs: string[] = [];
    const capture = (...parts: unknown[]) => {
        logs.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(toJson(p)))).join(' '));
    };
    try {
        const fn = new AsyncFunction('figma', 'console', code);
        const result = await fn(figma, { log: capture, info: capture, warn: capture, error: capture });
        return ok(toJson(result), { logs });
    } catch (error) {
        return fail(errorText(error) + (logs.length ? `\n\nconsole:\n${logs.join('\n')}` : ''));
    }
};

// ---------- generate_diagram

const NODE_W = 200;
const NODE_H = 72;

async function diagramFigjam(chart: Flowchart, pos: Record<string, { x: number; y: number }>, origin: { x: number; y: number }, name: string) {
    const shapes = new Map<string, ShapeWithTextNode>();
    const shapeType: Record<ChartNode['shape'], ShapeWithTextNode['shapeType']> = {
        rect: 'SQUARE',
        round: 'ROUNDED_RECTANGLE',
        diamond: 'DIAMOND',
        circle: 'ELLIPSE',
        stadium: 'ROUNDED_RECTANGLE',
    };
    const created: SceneNode[] = [];
    for (const n of chart.nodes) {
        const p = pos[n.id] ?? { x: 0, y: 0 };
        const s = figma.createShapeWithText();
        s.shapeType = shapeType[n.shape];
        s.resize(NODE_W, NODE_H);
        s.x = origin.x + p.x;
        s.y = origin.y + p.y;
        await figma.loadFontAsync(s.text.fontName as FontName);
        s.text.characters = n.label;
        s.name = n.label;
        shapes.set(n.id, s);
        created.push(s);
    }
    for (const e of chart.edges) {
        const from = shapes.get(e.from);
        const to = shapes.get(e.to);
        if (!from || !to) continue;
        const c = figma.createConnector();
        c.connectorStart = { endpointNodeId: from.id, magnet: 'AUTO' };
        c.connectorEnd = { endpointNodeId: to.id, magnet: 'AUTO' };
        c.connectorLineType = 'ELBOWED';
        c.connectorEndStrokeCap = e.arrow ? 'ARROW_LINES' : 'NONE';
        if (e.style === 'dotted') c.dashPattern = [8, 8];
        if (e.style === 'thick') c.strokeWeight = 4;
        if (e.label) {
            await figma.loadFontAsync(c.text.fontName as FontName);
            c.text.characters = e.label;
        }
        created.push(c);
    }
    const section = figma.createSection();
    section.name = name;
    const minX = Math.min(...created.filter((n) => n.type !== 'CONNECTOR').map((n) => n.x)) - 80;
    const minY = Math.min(...created.filter((n) => n.type !== 'CONNECTOR').map((n) => n.y)) - 80;
    const maxX = Math.max(...created.filter((n) => n.type !== 'CONNECTOR').map((n) => n.x + n.width)) + 80;
    const maxY = Math.max(...created.filter((n) => n.type !== 'CONNECTOR').map((n) => n.y + n.height)) + 80;
    section.x = minX;
    section.y = minY;
    section.resizeWithoutConstraints(maxX - minX, maxY - minY);
    for (const n of created) {
        const ax = n.x;
        const ay = n.y;
        section.appendChild(n);
        if (n.type !== 'CONNECTOR') {
            n.x = ax - minX;
            n.y = ay - minY;
        }
    }
    return section;
}

const RADIUS: Record<ChartNode['shape'], number> = { rect: 4, round: 16, diamond: 4, circle: 999, stadium: 999 };

async function diagramDesign(chart: Flowchart, pos: Record<string, { x: number; y: number }>, origin: { x: number; y: number }, name: string) {
    const font = await resolveFont('Inter', 500, false);
    const labelFont = await resolveFont('Inter', 400, false);
    const ink: RGB = { r: 0.12, g: 0.12, b: 0.14 };
    const line: RGB = { r: 0.45, g: 0.47, b: 0.52 };
    const xs = Object.values(pos).map((p) => p.x);
    const ys = Object.values(pos).map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const pad = 80;
    const frame = figma.createFrame();
    frame.name = name;
    frame.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.99 } }];
    frame.resize(Math.max(...xs) - minX + NODE_W + pad * 2, Math.max(...ys) - minY + NODE_H + pad * 2);
    frame.x = origin.x;
    frame.y = origin.y;
    const at = (id: string) => {
        const p = pos[id] ?? { x: 0, y: 0 };
        return { x: p.x - minX + pad, y: p.y - minY + pad };
    };

    for (const e of chart.edges) {
        const a = at(e.from);
        const b = at(e.to);
        const vertical = chart.direction === 'TB' || chart.direction === 'BT';
        const pts = edgePoints(a, b, vertical);
        const v = figma.createVector();
        frame.appendChild(v);
        const minPx = Math.min(...pts.map((p) => p.x));
        const minPy = Math.min(...pts.map((p) => p.y));
        await v.setVectorNetworkAsync({
            vertices: pts.map((p, i) => ({ x: p.x - minPx, y: p.y - minPy, strokeCap: i === pts.length - 1 && e.arrow ? 'ARROW_LINES' : 'NONE' })),
            segments: pts.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
            regions: [],
        });
        v.x = minPx;
        v.y = minPy;
        v.strokes = [{ type: 'SOLID', color: line }];
        v.strokeWeight = e.style === 'thick' ? 3 : 1.5;
        if (e.style === 'dotted') v.dashPattern = [6, 6];
        v.cornerRadius = 12;
        v.name = `Edge · ${e.from} → ${e.to}`;
        const mid = pts[Math.floor(pts.length / 2)] ?? pts[0];
        const prev = pts[Math.floor(pts.length / 2) - 1] ?? mid;
        if (e.label && mid && prev) {
            const t = figma.createText();
            t.fontName = labelFont;
            t.fontSize = 12;
            t.characters = e.label;
            t.fills = [{ type: 'SOLID', color: ink }];
            frame.appendChild(t);
            t.x = (mid.x + prev.x) / 2 + 6;
            t.y = (mid.y + prev.y) / 2 - t.height / 2;
        }
    }
    for (const n of chart.nodes) {
        const p = at(n.id);
        const box = figma.createFrame();
        box.name = n.label;
        box.layoutMode = 'HORIZONTAL';
        box.primaryAxisAlignItems = 'CENTER';
        box.counterAxisAlignItems = 'CENTER';
        box.resize(NODE_W, NODE_H);
        box.primaryAxisSizingMode = 'FIXED';
        box.counterAxisSizingMode = 'FIXED';
        box.paddingLeft = box.paddingRight = 12;
        box.cornerRadius = RADIUS[n.shape];
        box.fills = [{ type: 'SOLID', color: n.shape === 'diamond' ? { r: 1, g: 0.97, b: 0.88 } : { r: 1, g: 1, b: 1 } }];
        box.strokes = [{ type: 'SOLID', color: line }];
        if (n.shape === 'diamond') box.dashPattern = [4, 4];
        const t = figma.createText();
        t.fontName = font;
        t.fontSize = 14;
        t.characters = n.label;
        t.textAlignHorizontal = 'CENTER';
        t.fills = [{ type: 'SOLID', color: ink }];
        box.appendChild(t);
        t.layoutSizingHorizontal = 'FILL';
        t.textAutoResize = 'HEIGHT';
        frame.appendChild(box);
        box.x = p.x;
        box.y = p.y;
    }
    return frame;
}

function edgePoints(a: { x: number; y: number }, b: { x: number; y: number }, vertical: boolean): { x: number; y: number }[] {
    if (vertical) {
        const down = b.y >= a.y;
        const sx = a.x + NODE_W / 2;
        const tx = b.x + NODE_W / 2;
        const sy = down ? a.y + NODE_H : a.y;
        const ty = down ? b.y : b.y + NODE_H;
        if (sx === tx) return [{ x: sx, y: sy }, { x: tx, y: ty }];
        const my = (sy + ty) / 2;
        return [{ x: sx, y: sy }, { x: sx, y: my }, { x: tx, y: my }, { x: tx, y: ty }];
    }
    const right = b.x >= a.x;
    const sy = a.y + NODE_H / 2;
    const ty = b.y + NODE_H / 2;
    const sx = right ? a.x + NODE_W : a.x;
    const tx = right ? b.x : b.x + NODE_W;
    if (sy === ty) return [{ x: sx, y: sy }, { x: tx, y: ty }];
    const mx = (sx + tx) / 2;
    return [{ x: sx, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: tx, y: ty }];
}

export const generateDiagram: Handler = async (args) => {
    const source = str(args, 'mermaid') ?? str(args, 'description');
    if (!source) return fail('Pass `mermaid` with a flowchart.');
    let chart: Flowchart;
    try {
        chart = parseMermaid(source);
    } catch (error) {
        return fail(errorText(error));
    }
    if (!chart.nodes.length) return fail('The flowchart has no nodes.');
    const pos = layoutFlowchart(chart, { nodeWidth: NODE_W, nodeHeight: NODE_H, gapMain: 96, gapCross: 56 });
    const origin = num(args, 'x') !== undefined ? { x: num(args, 'x') as number, y: num(args, 'y') ?? 0 } : freeSpot();
    const name = str(args, 'name') ?? 'Diagram';
    const root = figma.editorType === 'figjam' ? await diagramFigjam(chart, pos, origin, name) : await diagramDesign(chart, pos, origin, name);
    figma.viewport.scrollAndZoomIntoView([root]);
    return ok({ id: root.id, name: root.name, nodes: chart.nodes.length, edges: chart.edges.length, editorType: figma.editorType });
};

// ---------- html_to_figma (layers from the UI's measured layout)

const solid = (c: { r: number; g: number; b: number; a: number }): SolidPaint => ({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a });

async function buildLayer(layer: HtmlLayer, parent: FrameNode, stats: { count: number }): Promise<void> {
    stats.count++;
    switch (layer.kind) {
        case 'text':
            await buildText(layer, parent);
            return;
        case 'svg': {
            try {
                const svg = figma.createNodeFromSvg(layer.svg);
                svg.name = layer.name;
                parent.appendChild(svg);
                svg.x = layer.x;
                svg.y = layer.y;
                if (layer.w > 0 && layer.h > 0) svg.resize(layer.w, layer.h);
            } catch {
                /* invalid SVG: skip it */
            }
            return;
        }
        case 'image': {
            const rect = figma.createRectangle();
            rect.name = layer.name;
            rect.resize(Math.max(1, layer.w), Math.max(1, layer.h));
            rect.fills = layer.bytes
                ? [{ type: 'IMAGE', imageHash: figma.createImage(layer.bytes).hash, scaleMode: 'FILL' }]
                : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
            parent.appendChild(rect);
            rect.x = layer.x;
            rect.y = layer.y;
            return;
        }
        case 'box': {
            const f = boxFrame(layer);
            parent.appendChild(f);
            f.x = layer.x;
            f.y = layer.y;
            for (const child of layer.children) await buildLayer(child, f, stats);
        }
    }
}

function boxFrame(box: HtmlBox): FrameNode {
    const f = figma.createFrame();
    f.name = box.name;
    f.resize(Math.max(1, box.w), Math.max(1, box.h));
    f.fills = box.bg ? [solid(box.bg)] : [];
    f.clipsContent = box.clip;
    [f.topLeftRadius, f.topRightRadius, f.bottomRightRadius, f.bottomLeftRadius] = box.radius;
    if (box.border) {
        f.strokes = [solid(box.border.color)];
        f.strokeWeight = box.border.width;
        f.strokeAlign = 'INSIDE';
    }
    if (box.shadow) {
        f.effects = [
            {
                type: 'DROP_SHADOW',
                color: box.shadow.color,
                offset: { x: box.shadow.x, y: box.shadow.y },
                radius: box.shadow.blur,
                spread: box.shadow.spread,
                visible: true,
                blendMode: 'NORMAL',
            },
        ];
    }
    f.opacity = box.opacity;
    return f;
}

async function buildText(layer: HtmlText, parent: FrameNode) {
    const t = figma.createText();
    t.fontName = await resolveFont(layer.font.family, layer.font.weight, layer.font.italic);
    t.characters = layer.text;
    t.name = layer.name;
    t.fontSize = Math.max(1, layer.font.size);
    if (layer.font.lineHeight) t.lineHeight = { unit: 'PIXELS', value: layer.font.lineHeight };
    if (layer.font.letterSpacing) t.letterSpacing = { unit: 'PIXELS', value: layer.font.letterSpacing };
    t.fills = [solid(layer.color)];
    t.textAlignHorizontal = layer.align;
    t.textDecoration = layer.decoration;
    parent.appendChild(t);
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(1, layer.w + 2), Math.max(1, layer.h));
    t.x = layer.x;
    t.y = layer.y;
}

export const htmlBuild: Handler = async (args) => {
    const tree = args.tree as unknown as HtmlBox | undefined;
    if (!tree || tree.kind !== 'box') return fail('Nothing to build.');
    const parentId = str(args, 'parentId');
    const parent = parentId ? await figma.getNodeByIdAsync(parentId) : figma.currentPage;
    if (!parent || !('appendChild' in parent)) return fail(`Parent ${parentId} cannot hold layers.`);
    const root = boxFrame(tree);
    root.name = str(args, 'name') ?? tree.name;
    root.clipsContent = true;
    (parent as ChildrenMixin).appendChild(root);
    const spot = num(args, 'x') !== undefined ? { x: num(args, 'x') as number, y: num(args, 'y') ?? 0 } : freeSpot();
    root.x = spot.x;
    root.y = spot.y;
    const stats = { count: 1 };
    for (const child of tree.children) await buildLayer(child, root, stats);
    figma.viewport.scrollAndZoomIntoView([root]);
    return ok({ id: root.id, name: root.name, width: root.width, height: root.height, layers: stats.count } as JsonObject as JsonValue);
};

export type { ChartEdge };
