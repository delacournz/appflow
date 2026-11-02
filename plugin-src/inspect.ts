import type { JsonObject, JsonValue } from '../shared/protocol';
import { hex, isScene, mainOwner, requireNode, targetNode, walk } from './nodes';
import { exportPng } from './assets';
import { bool, fail, type Handler, num, ok, str } from './types';
import { escapeXml, pascalCase, toTailwind } from './util';

// ---------- status / whoami

export const status: Handler = async () =>
    ok({
        fileName: figma.root.name,
        editorType: figma.editorType,
        page: { id: figma.currentPage.id, name: figma.currentPage.name },
        pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
        selection: figma.currentPage.selection.map((n) => ({ id: n.id, type: n.type, name: n.name })),
    });

export const whoami: Handler = async () => {
    const user = figma.currentUser;
    return ok({
        user: user ? { id: user.id, name: user.name, photoUrl: user.photoUrl, color: user.color } : null,
        fileName: figma.root.name,
        fileKey: figma.fileKey ?? null,
        editorType: figma.editorType,
        note: 'Plans and seats are only known to the Figma cloud MCP.',
    });
};

// ---------- metadata (XML outline)

function attrs(node: BaseNode): string {
    const a: [string, string | number][] = [['id', node.id], ['name', node.name]];
    if (isScene(node)) {
        if ('x' in node) a.push(['x', Math.round(node.x)], ['y', Math.round(node.y)]);
        if ('width' in node) a.push(['width', Math.round(node.width)], ['height', Math.round(node.height)]);
        if (!node.visible) a.push(['visible', 'false']);
    }
    switch (node.type) {
        case 'TEXT':
            a.push(['text', node.characters.slice(0, 200)]);
            break;
        case 'STICKY':
        case 'SHAPE_WITH_TEXT':
            a.push(['text', node.text.characters.slice(0, 200)]);
            if (node.type === 'SHAPE_WITH_TEXT') a.push(['shape', node.shapeType]);
            break;
        case 'CONNECTOR': {
            const end = (e: ConnectorEndpoint) => ('endpointNodeId' in e ? e.endpointNodeId : `${Math.round(e.position.x)},${Math.round(e.position.y)}`);
            a.push(['from', end(node.connectorStart)], ['to', end(node.connectorEnd)]);
            if (node.text.characters) a.push(['text', node.text.characters]);
            break;
        }
        case 'CODE_BLOCK':
            a.push(['language', node.codeLanguage], ['code', node.code.slice(0, 200)]);
            break;
    }
    return a.map(([k, v]) => `${k}="${escapeXml(String(v))}"`).join(' ');
}

function toXml(node: BaseNode, depth: number, maxDepth: number, budget: { left: number }, indent = ''): string {
    budget.left--;
    const tag = node.type.toLowerCase().replace(/_/g, '-');
    const kids = 'children' in node ? (node.children as readonly BaseNode[]) : [];
    if (!kids.length) return `${indent}<${tag} ${attrs(node)} />`;
    if (depth >= maxDepth || budget.left <= 0) return `${indent}<${tag} ${attrs(node)} children="${kids.length}" truncated="true" />`;
    const inner = kids.map((k) => (budget.left > 0 ? toXml(k, depth + 1, maxDepth, budget, `${indent}  `) : '')).filter(Boolean);
    return `${indent}<${tag} ${attrs(node)}>\n${inner.join('\n')}\n${indent}</${tag}>`;
}

async function outline(args: JsonObject): Promise<string> {
    const nodeId = str(args, 'nodeId');
    const maxDepth = num(args, 'maxDepth') ?? 50;
    const budget = { left: num(args, 'maxNodes') ?? 4000 };
    if (nodeId) {
        const node = await figma.getNodeByIdAsync(nodeId.replace('-', ':'));
        if (!node) throw new Error(`No node ${nodeId}.`);
        if (node.type === 'PAGE') await node.loadAsync();
        return toXml(node, 0, maxDepth, budget);
    }
    const sel = figma.currentPage.selection;
    if (sel.length) return sel.map((n) => toXml(n, 0, maxDepth, budget)).join('\n');
    const pages = figma.root.children.map((p) => `  <page id="${p.id}" name="${escapeXml(p.name)}" />`).join('\n');
    return `<document name="${escapeXml(figma.root.name)}">\n${pages}\n</document>`;
}

export const getMetadata: Handler = async (args) => ok(await outline(args));

export const getFigjam: Handler = async (args) => {
    const xml = await outline(args);
    const node = await targetNode(str(args, 'nodeId'));
    const images: Uint8Array[] = [];
    if (node && isScene(node) && bool(args, 'includeScreenshot', true)) images.push(await exportPng(node, num(args, 'maxDimension') ?? 1024));
    return ok(xml, { images });
};

// ---------- variables and styles

type VarDef = { name: string; collection: string; type: string; value: JsonValue; id: string; key: string; remote: boolean };
type StyleDef = { name: string; type: string; value: string; id: string; key: string; remote: boolean };

function formatValue(value: VariableValue, type: string): JsonValue {
    if (type === 'COLOR' && typeof value === 'object' && value !== null && 'r' in value) return hex(value as RGBA);
    if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS') return `alias:${value.id}`;
    return value as JsonValue;
}

function styleValue(style: BaseStyle): string {
    switch (style.type) {
        case 'PAINT': {
            const p = (style as PaintStyle).paints[0];
            if (!p) return 'none';
            return p.type === 'SOLID' ? hex({ ...p.color, a: p.opacity ?? 1 }) : p.type.toLowerCase();
        }
        case 'TEXT': {
            const t = style as TextStyle;
            const lh = t.lineHeight.unit === 'AUTO' ? 'auto' : `${t.lineHeight.value}${t.lineHeight.unit === 'PIXELS' ? 'px' : '%'}`;
            return `Font(family: "${t.fontName.family}", style: ${t.fontName.style}, size: ${t.fontSize}, lineHeight: ${lh})`;
        }
        case 'EFFECT':
            return (style as EffectStyle).effects.map((e) => e.type.toLowerCase()).join(', ');
        default:
            return style.type.toLowerCase();
    }
}

export async function collectDefs(root: BaseNode): Promise<{ defs: Record<string, JsonValue>; variables: VarDef[]; styles: StyleDef[] }> {
    const varIds = new Map<string, SceneNode>();
    const styleIds = new Set<string>();
    const addAlias = (v: unknown, node: SceneNode) => {
        if (Array.isArray(v)) v.forEach((x) => addAlias(x, node));
        else if (v && typeof v === 'object' && 'id' in v && typeof v.id === 'string' && 'type' in v && v.type === 'VARIABLE_ALIAS') {
            if (!varIds.has(v.id)) varIds.set(v.id, node);
        } else if (v && typeof v === 'object') Object.values(v).forEach((x) => addAlias(x, node));
    };
    for (const node of walk(root, 4000)) {
        if (!isScene(node)) continue;
        if ('boundVariables' in node && node.boundVariables) addAlias(node.boundVariables, node);
        for (const key of ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId', 'gridStyleId'] as const) {
            const id = (node as unknown as Record<string, unknown>)[key];
            if (typeof id === 'string' && id) styleIds.add(id);
        }
    }
    const variables: VarDef[] = [];
    const defs: Record<string, JsonValue> = {};
    for (const [id, consumer] of varIds) {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (!v) continue;
        const collection = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        let value: JsonValue = null;
        try {
            const r = v.resolveForConsumer(consumer);
            value = formatValue(r.value, r.resolvedType);
        } catch {
            value = null;
        }
        variables.push({ name: v.name, collection: collection?.name ?? '', type: v.resolvedType, value, id: v.id, key: v.key, remote: v.remote });
        defs[v.name] = value;
    }
    const styles: StyleDef[] = [];
    for (const id of styleIds) {
        const s = await figma.getStyleByIdAsync(id);
        if (!s) continue;
        const value = styleValue(s);
        styles.push({ name: s.name, type: s.type, value, id: s.id, key: s.key, remote: s.remote });
        defs[s.name] = value;
    }
    return { defs, variables, styles };
}

export const getVariableDefs: Handler = async (args) => {
    const node = await targetNode(str(args, 'nodeId'));
    const root = node ?? figma.currentPage;
    const { defs, variables, styles } = await collectDefs(root);
    return ok({ defs, variables, styles } as unknown as JsonValue);
};

// ---------- design context (JSX)

type Ctx = { format: 'tailwind' | 'css'; budget: number; expandInstances: boolean; components: Map<string, JsonObject> };

const VECTORISH = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'POLYGON', 'ELLIPSE', 'RECTANGLE']);
const jsxText = (s: string) => (/[{}<>]/.test(s) ? `{${JSON.stringify(s)}}` : s);
const camel = (p: string) => p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function isIcon(node: SceneNode): boolean {
    if (!('width' in node) || node.width > 64 || node.height > 64) return false;
    if (VECTORISH.has(node.type) && node.type !== 'RECTANGLE') return true;
    if (!('children' in node) || !node.children.length) return false;
    return walk(node, 200).slice(1).every((n) => VECTORISH.has(n.type) || n.type === 'GROUP' || n.type === 'FRAME');
}

async function cssOf(node: SceneNode): Promise<Record<string, string>> {
    try {
        return await node.getCSSAsync();
    } catch {
        return {};
    }
}

function styleAttr(css: Record<string, string>, ctx: Ctx): string {
    if (!Object.keys(css).length) return '';
    if (ctx.format === 'tailwind') return ` className="${toTailwind(css).replace(/"/g, "'")}"`;
    const obj = Object.entries(css).map(([k, v]) => `${camel(k)}: ${JSON.stringify(v)}`).join(', ');
    return ` style={{ ${obj} }}`;
}

async function jsx(node: SceneNode, ctx: Ctx, indent: string): Promise<string> {
    if (!node.visible) return '';
    if (ctx.budget-- <= 0) return `${indent}<div data-truncated="true" />`;
    const idAttr = ` data-node-id="${node.id}"`;
    const css = await cssOf(node);

    if (node.type === 'TEXT') return `${indent}<p${idAttr}${styleAttr(css, ctx)}>${jsxText(node.characters)}</p>`;

    if (node.type === 'INSTANCE' && !ctx.expandInstances) {
        const owner = await mainOwner(node);
        const name = pascalCase(owner?.name ?? node.name);
        const props = Object.entries(node.componentProperties)
            .map(([k, p]) => {
                const key = camel(k.split('#')[0]?.trim().toLowerCase().replace(/\s+/g, '-') ?? k);
                return typeof p.value === 'string' ? `${key}=${JSON.stringify(p.value)}` : `${key}={${JSON.stringify(p.value)}}`;
            })
            .join(' ');
        if (owner && !ctx.components.has(owner.key)) ctx.components.set(owner.key, { name: owner.name, key: owner.key, nodeId: owner.id, remote: owner.remote });
        return `${indent}<${name}${idAttr}${props ? ` ${props}` : ''}${styleAttr(css, ctx)} />`;
    }

    if (isIcon(node)) {
        try {
            const svg = await node.exportAsync({ format: 'SVG_STRING' });
            if (svg.length < 6000) return `${indent}${svg.replace(/<svg /, `<svg data-node-id="${node.id}" aria-label=${JSON.stringify(node.name)} `)}`;
        } catch {
            /* fall through to a box */
        }
    }

    const image = 'fills' in node && Array.isArray(node.fills) ? (node.fills as Paint[]).find((p) => p.type === 'IMAGE') : undefined;
    if (image && image.type === 'IMAGE' && !('children' in node && node.children.length)) {
        return `${indent}<img${idAttr} src="figma-image:${image.imageHash ?? ''}" alt=${JSON.stringify(node.name)}${styleAttr(css, ctx)} />`;
    }

    const kids = 'children' in node ? (node.children as readonly SceneNode[]) : [];
    if (!kids.length) return `${indent}<div${idAttr} data-name=${JSON.stringify(node.name)}${styleAttr(css, ctx)} />`;
    const inner: string[] = [];
    for (const k of kids) {
        const line = await jsx(k, ctx, `${indent}  `);
        if (line) inner.push(line);
    }
    return `${indent}<div${idAttr} data-name=${JSON.stringify(node.name)}${styleAttr(css, ctx)}>\n${inner.join('\n')}\n${indent}</div>`;
}

export const getDesignContext: Handler = async (args) => {
    const node = await requireNode(str(args, 'nodeId'));
    if (!isScene(node)) return fail('Pick a layer, not a page.');
    const frameworks = (str(args, 'clientFrameworks') ?? 'react').toLowerCase();
    const ctx: Ctx = {
        format: str(args, 'format') === 'css' || frameworks.includes('css') ? 'css' : 'tailwind',
        budget: num(args, 'maxNodes') ?? 1500,
        expandInstances: bool(args, 'expandInstances', false),
        components: new Map(),
    };
    const body = await jsx(node, ctx, '    ');
    const name = pascalCase(node.name);
    const code = `export function ${name}() {\n  return (\n${body}\n  );\n}\n`;
    const { defs } = await collectDefs(node);
    const images = bool(args, 'includeScreenshot', true) ? [await exportPng(node, num(args, 'maxDimension') ?? 1024)] : [];
    return ok(
        {
            framework: ctx.format === 'tailwind' ? 'React + Tailwind' : 'React + inline styles',
            code,
            components: [...ctx.components.values()],
            variables: defs,
            notes: [
                'Reference only: adapt to the project’s components and tokens.',
                'Instances render as <ComponentName …props />. Map them with get_code_connect_map.',
                'var(--token, fallback) values come from bound Figma variables.',
            ],
        },
        { images },
    );
};

// ---------- design system search

type Entity = 'component' | 'variable' | 'style';
type Hit = JsonObject;

let libraryVars: Hit[] | null = null;

async function loadLibraryVariables(): Promise<Hit[]> {
    if (libraryVars) return libraryVars;
    const hits: Hit[] = [];
    try {
        const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
        for (const c of collections) {
            const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
            for (const v of vars) hits.push({ entity: 'variable', name: v.name, key: v.key, type: v.resolvedType, collection: c.name, library: c.libraryName, local: false });
        }
    } catch {
        /* teamlibrary permission missing or offline */
    }
    libraryVars = hits;
    return hits;
}

async function localIndex(): Promise<Hit[]> {
    await figma.loadAllPagesAsync();
    const hits: Hit[] = [];
    for (const n of figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })) {
        if (n.type === 'COMPONENT' && n.parent?.type === 'COMPONENT_SET') continue;
        let page: BaseNode | null = n.parent;
        while (page && page.type !== 'PAGE') page = page.parent;
        hits.push({
            entity: 'component',
            name: n.name,
            id: n.id,
            key: n.key,
            type: n.type,
            description: n.description,
            variants: n.type === 'COMPONENT_SET' ? n.children.length : 0,
            page: page?.name ?? '',
            local: true,
        });
    }
    for (const v of await figma.variables.getLocalVariablesAsync()) {
        const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        hits.push({ entity: 'variable', name: v.name, id: v.id, key: v.key, type: v.resolvedType, collection: c?.name ?? '', local: true });
    }
    const styles: BaseStyle[] = [
        ...(await figma.getLocalPaintStylesAsync()),
        ...(await figma.getLocalTextStylesAsync()),
        ...(await figma.getLocalEffectStylesAsync()),
        ...(await figma.getLocalGridStylesAsync()),
    ];
    for (const s of styles) hits.push({ entity: 'style', name: s.name, id: s.id, key: s.key, type: s.type, value: styleValue(s), local: true });
    return hits;
}

export const searchDesignSystem: Handler = async (args) => {
    const raw = args.queries;
    const queries: { entity: Entity | 'all'; query: string }[] = Array.isArray(raw)
        ? raw.flatMap((q) => (q && typeof q === 'object' && !Array.isArray(q) && typeof q.query === 'string' ? [{ entity: (q.entity as Entity) ?? 'all', query: q.query }] : []))
        : [];
    const single = str(args, 'query');
    if (single) queries.push({ entity: 'all', query: single });
    if (!queries.length) return fail('Pass `query` or `queries: [{ entity, query }]`.');
    const limit = num(args, 'limit') ?? 20;
    const index = [...(await localIndex()), ...(bool(args, 'includeLibraries', true) ? await loadLibraryVariables() : [])];
    const results = queries.map(({ entity, query }) => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = index
            .filter((h) => entity === 'all' || h.entity === entity)
            .filter((h) => {
                const hay = `${h.name} ${typeof h.description === 'string' ? h.description : ''} ${typeof h.collection === 'string' ? h.collection : ''}`.toLowerCase();
                return terms.every((t) => hay.includes(t));
            })
            .sort((a, b) => String(a.name).length - String(b.name).length)
            .slice(0, limit);
        return { entity, query, hits };
    });
    return ok({ results, note: 'Searches this file’s components, variables and styles, plus variables from enabled libraries. Library components are not searchable from a plugin.' });
};

export const getLibraries: Handler = async () => {
    const grouped = new Map<string, { name: string; key: string }[]>();
    try {
        for (const c of await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()) {
            grouped.set(c.libraryName, [...(grouped.get(c.libraryName) ?? []), { name: c.name, key: c.key }]);
        }
    } catch {
        /* no teamlibrary access */
    }
    const remote = new Map<string, JsonObject>();
    for (const inst of figma.currentPage.findAllWithCriteria({ types: ['INSTANCE'] }).slice(0, 2000)) {
        const owner = await mainOwner(inst);
        if (owner?.remote && !remote.has(owner.key)) remote.set(owner.key, { name: owner.name, key: owner.key });
    }
    return ok({
        librariesWithVariables: [...grouped].map(([name, collections]) => ({ name, collections })),
        remoteComponentsOnCurrentPage: [...remote.values()],
        note: 'A plugin sees enabled libraries only through their variable collections, and remote components through instances.',
    });
};

