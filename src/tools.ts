import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { JsonObject, JsonValue, PluginReply } from '../shared/protocol';
import { STALE_FIX, stalePlugin } from './build';
import type { CodeConnectEntry, CodeConnectStore } from './store';

export type ToolContext = {
    connected(): boolean;
    plugin(tool: string, args: JsonObject, timeoutMs: number): Promise<PluginReply>;
    store: CodeConnectStore;
    downloadDir: string;
    /** Hash of the plugin build the server expects (plugin/build.json). */
    expectedBuild?: string | null;
    /** Hash the connected plugin reported in its hello. */
    pluginBuild?(): string | null;
};

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
export type ToolResult = { content: Content[]; isError?: boolean };
type Schema = { type: 'object'; properties: Record<string, JsonObject>; required?: string[]; additionalProperties?: boolean };

export type ToolDef = {
    name: string;
    description: string;
    inputSchema: Schema;
    /** Runs even when the plugin is not connected. */
    offline?: boolean;
    run(args: JsonObject, ctx: ToolContext): Promise<ToolResult>;
};

export const DEFAULT_TIMEOUT_MS = 60_000;

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });
const asJson = (value: unknown): ToolResult => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const images = (list: string[] | undefined): Content[] => (list ?? []).map((data) => ({ type: 'image', data, mimeType: 'image/png' }));
const timeout = (args: JsonObject, fallback = DEFAULT_TIMEOUT_MS) => (typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : fallback);

class ToolError extends Error {}

async function plugin(ctx: ToolContext, tool: string, args: JsonObject, ms = timeout(args)): Promise<Extract<PluginReply, { ok: true }>> {
    const reply = await ctx.plugin(tool, args, ms);
    if (!reply.ok) throw new ToolError(reply.error);
    return reply;
}

const nodeId = { type: 'string', description: 'Node ID such as "193:443" (a "193-443" from a URL also works). Defaults to the current selection.' };
const obj = (properties: Record<string, JsonObject>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

/** A tool that forwards its arguments to the plugin and returns the result (and any images). */
const passthrough = (name: string, description: string, inputSchema: Schema, ms?: number): ToolDef => ({
    name,
    description,
    inputSchema,
    async run(args, ctx) {
        const r = await plugin(ctx, name, args, ms ?? timeout(args));
        return { content: [...asJson(r.result).content, ...images(r.images)] };
    },
});

const UPLOAD_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_UPLOAD = 10 * 1024 * 1024;

type Ref = { nodeId: string; layer: string; componentKey: string; componentName: string };
type Comp = { key: string; name: string; nodeId: string } & JsonObject;

async function refs(ctx: ToolContext, args: JsonObject): Promise<{ instances: Ref[]; components: Comp[] }> {
    const r = await plugin(ctx, 'component_refs', typeof args.nodeId === 'string' ? { nodeId: args.nodeId } : {});
    return r.result as unknown as { instances: Ref[]; components: Comp[] };
}

async function saveMapping(ctx: ToolContext, m: JsonObject): Promise<{ key: string; entry: CodeConnectEntry }> {
    if (typeof m.nodeId !== 'string' || typeof m.source !== 'string' || typeof m.componentName !== 'string') {
        throw new ToolError('Each mapping needs nodeId, source and componentName.');
    }
    const r = await plugin(ctx, 'resolve_component', { nodeId: m.nodeId });
    const c = r.result as { key: string; name: string; nodeId: string };
    const entry: CodeConnectEntry = {
        componentName: m.componentName,
        source: m.source,
        ...(typeof m.label === 'string' ? { label: m.label } : {}),
        ...(typeof m.snippet === 'string' ? { snippet: m.snippet } : {}),
        ...(Array.isArray(m.snippetImports) ? { snippetImports: m.snippetImports.filter((s): s is string => typeof s === 'string') } : {}),
        figmaName: c.name,
        figmaNodeId: c.nodeId,
        updatedAt: new Date().toISOString(),
    };
    await ctx.store.set(c.key, entry);
    return { key: c.key, entry };
}

const mappingSchema: JsonObject = {
    type: 'object',
    properties: {
        nodeId: { type: 'string', description: 'A component, component set or instance.' },
        source: { type: 'string', description: 'Path or URL of the code component.' },
        componentName: { type: 'string', description: 'The code component’s name, such as "Button".' },
        label: { type: 'string', description: 'Framework label, such as "React" or "React Native".' },
        snippet: { type: 'string', description: 'Example usage.' },
        snippetImports: { type: 'array', items: { type: 'string' } },
    },
    required: ['nodeId', 'source', 'componentName'],
};

export const TOOLS: ToolDef[] = [
    {
        name: 'figma_status',
        description: 'Whether the Local Agent Bridge plugin is connected, plus the open file, pages and selection. Call this first.',
        inputSchema: obj({}),
        offline: true,
        async run(_args, ctx) {
            if (!ctx.connected()) {
                return asJson({ connected: false, howToConnect: 'Open the file in the Figma desktop app and run Plugins → Development → Local Agent Bridge.' });
            }
            const r = await plugin(ctx, 'figma_status', {});
            const expected = ctx.expectedBuild ?? null;
            const actual = ctx.pluginBuild?.() ?? null;
            const stale = stalePlugin(expected, actual) ? { stale: true, fix: STALE_FIX, expectedBuild: expected, pluginBuild: actual } : {};
            return asJson({ connected: true, ...stale, ...(r.result as JsonObject) });
        },
    },
    passthrough('whoami', 'The signed-in Figma user (name, id) and the open file. Plans and seats are not visible to a plugin.', obj({})),
    passthrough(
        'get_metadata',
        'A lightweight XML outline of a node or the selection: layer IDs, names, types, positions and sizes (and text). With no nodeId and no selection, lists the pages. Pass a page id to outline a page.',
        obj({ nodeId, maxDepth: { type: 'number', description: 'Default 50.' }, maxNodes: { type: 'number', description: 'Default 4000.' } }),
    ),
    {
        name: 'get_screenshot',
        description:
            'A PNG of a node, the selected layer, several nodes (nodeIds: the union of their bounds) or an explicit region of the current page. Use nodeIds or region to see a flow with its arrows.',
        inputSchema: obj({
            nodeId,
            nodeIds: { type: 'array', items: { type: 'string' }, description: 'Capture the union of these nodes’ bounds, including anything drawn between them.' },
            region: {
                type: 'object',
                description: 'Absolute canvas rect on the current page.',
                properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
                required: ['x', 'y', 'width', 'height'],
                additionalProperties: false,
            },
            maxDimension: { type: 'number', description: 'Longest side in pixels. Default 1024.' },
            scale: { type: 'number', description: 'Export scale; overrides maxDimension.' },
        }),
        async run(args, ctx) {
            const r = await plugin(ctx, 'get_screenshot', args);
            return { content: [...images(r.images), ...asJson(r.result).content] };
        },
    },
    {
        name: 'get_design_context',
        description:
            'Design-to-code context for a node or the selection: React + Tailwind JSX built from Figma’s CSS (or inline styles with format "css"), instances as <Component …props />, bound variables, and a screenshot. A reference to adapt, not final code.',
        inputSchema: obj({
            nodeId,
            clientFrameworks: { type: 'string', description: 'For example "react". Include "css" for inline styles.' },
            format: { type: 'string', enum: ['tailwind', 'css'] },
            expandInstances: { type: 'boolean', description: 'Render instance internals instead of <Component />. Default false.' },
            maxNodes: { type: 'number', description: 'Default 1500.' },
            includeScreenshot: { type: 'boolean', description: 'Default true.' },
        }),
        async run(args, ctx) {
            const r = await plugin(ctx, 'get_design_context', args, timeout(args, 120_000));
            const { code, ...rest } = r.result as { code?: string } & JsonObject;
            const body = `## Code (${String(rest.framework ?? 'React')})\n\n\`\`\`tsx\n${code ?? ''}\`\`\`\n\n## Context\n\n${JSON.stringify(rest, null, 2)}`;
            return { content: [{ type: 'text', text: body }, ...images(r.images)] };
        },
    },
    passthrough(
        'get_variable_defs',
        'Variables and styles used in a node or the selection (colours, spacing, typography), resolved to values: { defs: { name: value }, variables, styles }.',
        obj({ nodeId }),
    ),
    passthrough(
        'get_figjam',
        'XML outline of FigJam content (stickies, shapes, connectors with from/to, sections) plus a screenshot.',
        obj({ nodeId, includeScreenshot: { type: 'boolean' }, maxDimension: { type: 'number' } }),
    ),
    passthrough(
        'search_design_system',
        'Search this file’s components, component sets, variables and styles, and variables from enabled libraries. Several searches per call.',
        obj({
            query: { type: 'string' },
            queries: {
                type: 'array',
                items: { type: 'object', properties: { entity: { type: 'string', enum: ['component', 'variable', 'style'] }, query: { type: 'string' } }, required: ['query'] },
            },
            includeLibraries: { type: 'boolean', description: 'Include library variables. Default true.' },
            limit: { type: 'number', description: 'Per query. Default 20.' },
        }),
        120_000,
    ),
    passthrough('get_libraries', 'Libraries visible to the plugin: enabled libraries with variable collections, and remote components used on the current page.', obj({})),
    {
        name: 'download_assets',
        description:
            'Export up to 20 nodes (their export settings, or defaultFormat/defaultScale) and the original image fills inside them, saved to local files. Returns the file paths.',
        inputSchema: obj({
            nodeIds: { type: 'array', items: { type: 'string' } },
            defaultFormat: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'] },
            defaultScale: { type: 'number', description: '0.01 to 4. Default 2.' },
            includeImageSources: { type: 'boolean', description: 'Default true.' },
            outDir: { type: 'string', description: 'Folder to save into. Defaults to the bridge download folder.' },
        }),
        async run(args, ctx) {
            const { outDir, ...rest } = args;
            const r = await plugin(ctx, 'download_assets', rest, timeout(args, 120_000));
            const dir = typeof outDir === 'string' ? outDir : join(ctx.downloadDir, new Date().toISOString().replace(/[:.]/g, '-'));
            await mkdir(dir, { recursive: true });
            const files: string[] = [];
            for (const f of r.files ?? []) {
                const path = join(dir, basename(f.name));
                await writeFile(path, Buffer.from(f.base64, 'base64'));
                files.push(path);
            }
            return asJson({ files, ...(r.result as JsonObject) });
        },
    },
    {
        name: 'upload_assets',
        description:
            'Place local PNG, JPG, GIF, WebP or SVG files (up to 10 MB each, 60 per call) in the file. SVGs become vector layers. With nodeId, the first raster image becomes that layer’s fill.',
        inputSchema: obj(
            {
                files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' },
                nodeId: { type: 'string' },
                parentId: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
            },
            ['files'],
        ),
        async run(args, ctx) {
            const paths = Array.isArray(args.files) ? args.files.filter((p): p is string => typeof p === 'string') : [];
            if (!paths.length) return text('`files` needs at least one path.', true);
            if (paths.length > 60) return text('Up to 60 files per call.', true);
            const files: JsonObject[] = [];
            for (const path of paths) {
                const mime = UPLOAD_TYPES[extname(path).toLowerCase()];
                if (!mime) return text(`${basename(path)}: only PNG, JPG, GIF, WebP and SVG are supported.`, true);
                if ((await stat(path)).size > MAX_UPLOAD) return text(`${basename(path)} is over 10 MB.`, true);
                const bytes = await readFile(path);
                files.push(mime === 'image/svg+xml' ? { name: basename(path), mime, text: bytes.toString('utf8') } : { name: basename(path), mime, base64: bytes.toString('base64') });
            }
            const { files: _paths, ...rest } = args;
            const r = await plugin(ctx, 'upload_assets', { ...rest, files }, timeout(args, 120_000));
            return asJson(r.result);
        },
    },
    {
        name: 'use_figma',
        description:
            'Run Plugin API JavaScript in the open file. The code is the body of an async function: top-level await and `return` work, `figma` is in scope. documentAccess is "dynamic-page": use getNodeByIdAsync, setCurrentPageAsync and setReactionsAsync. Load fonts before editing text. Returns the returned value (nodes reduced to {id, type, name}) and console.log lines.',
        inputSchema: obj({ code: { type: 'string' }, timeoutMs: { type: 'number', description: `Default ${DEFAULT_TIMEOUT_MS}.` } }, ['code']),
        async run(args, ctx) {
            if (typeof args.code !== 'string' || !args.code.trim()) return text('`code` is required.', true);
            const r = await plugin(ctx, 'use_figma', args);
            return asJson({ result: r.result, logs: r.logs ?? [] });
        },
    },
    {
        name: 'html_to_figma',
        description:
            'Render a self-contained HTML document at a width and rebuild it as editable layers (frames, text, SVGs, images). Pass `html`, or `path` to a local .html file. Remote images and fonts are not fetched.',
        inputSchema: obj({
            html: { type: 'string' },
            path: { type: 'string', description: 'A local .html file, instead of `html`.' },
            width: { type: 'number', description: 'Viewport width. Default 1440.' },
            height: { type: 'number', description: 'Fixed height. Defaults to the page height.' },
            name: { type: 'string' },
            parentId: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
        }),
        async run(args, ctx) {
            const { path, ...rest } = args;
            const html = typeof path === 'string' ? await readFile(path, 'utf8') : rest.html;
            if (typeof html !== 'string' || !html.trim()) return text('Pass `html` or `path`.', true);
            if (html.length > 50 * 1024 * 1024) return text('HTML is over 50 MB.', true);
            const r = await plugin(ctx, 'html_to_figma', { ...rest, html }, timeout(args, 180_000));
            return asJson(r.result);
        },
    },
    passthrough(
        'generate_diagram',
        'Draw a Mermaid flowchart (flowchart/graph TD|LR|BT|RL; node shapes [], (), {}, (()), ([]); links -->, ---, -.->, ==> with labels). FigJam gets shapes and connectors; design files get frames and arrows. Other Mermaid types are not supported.',
        obj({ mermaid: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, ['mermaid']),
    ),
    passthrough(
        'lint_flow_layout',
        'Check that flow arrows read left to right. Scans arrow vectors under a node (or the current page) and reports any whose head points left (points-left) or whose path travels left (runs-left), with ids and endpoints. Run it after laying out or rerouting a flow; follow the flow-layout skill to fix issues.',
        obj({ nodeId, tolerance: { type: 'number', description: 'Pixels of leftward movement to ignore. Default 1.' } }),
    ),
    passthrough(
        'connect',
        'Draw a flow arrow from one screen to another on an adopted board and, with a trigger, point the trigger’s prototype navigate reaction at the target (replacing its current one). Routes orthogonally per the flow-layout skill, creates the vector, start dot and label in the board’s arrows group, and stores the link so reroute_flow can redraw it. Calling it again for the same from/to/trigger updates the arrow. A target to the left is drawn below the rows and returned with backwards: true. Returns { arrowGroupId, points, prototypeUpdated, backwards, updated }.',
        obj(
            {
                from: { type: 'string', description: 'Source screen frame ID.' },
                to: { type: 'string', description: 'Target screen frame ID.' },
                trigger: { type: 'string', description: 'The control inside the source screen that causes the move. The arrow starts 10 px right of it.' },
                label: { type: 'string', description: 'Text on the arrow, such as "Continue".' },
                prototype: { type: 'boolean', description: 'Also set the trigger’s navigate reaction. Default true.' },
                boardId: { type: 'string', description: 'Board node ID. Defaults to the source screen’s board.' },
            },
            ['from', 'to', 'label'],
        ),
    ),
    passthrough(
        'reroute_flow',
        'Redraw flow arrows from the current positions of their screens and triggers, after moving screens. Updates each vector, dot and label in place, assigns lanes per gutter in a stable order, and reports arrows whose screens were deleted and arrows that run backwards. Without boardId it covers every adopted board on the current page.',
        obj({
            boardId: { type: 'string', description: 'Board node ID.' },
            arrowIds: { type: 'array', items: { type: 'string' }, description: 'Only redraw these arrow group IDs (as returned by connect).' },
        }),
        120_000,
    ),
    passthrough(
        'adopt_board',
        'Make an existing hand-built flow board manageable: infers the grid from the screen frames inside the board, stores flowbridge plugin data on the board and screens, and groups each arrow vector with its start dot and label (linking it to its screens and trigger). Reports vectors it could not match instead of guessing. Use dryRun to preview without writing.',
        obj(
            {
                boardNodeId: { type: 'string', description: 'The board background rectangle or section.' },
                colWidth: { type: 'number', description: 'Override the inferred column spacing.' },
                rowHeight: { type: 'number', description: 'Override the inferred row spacing.' },
                arrowsGroupIds: { type: 'array', items: { type: 'string' }, description: 'Group(s) holding the arrows. Defaults to the "Flow arrows" group that matches the board name.' },
                dryRun: { type: 'boolean', description: 'Report what would be adopted without changing the file. Default false.' },
            },
            ['boardNodeId'],
        ),
        120_000,
    ),
    passthrough(
        'get_context_for_code_connect',
        'Component details for writing a Code Connect mapping: properties with variant options, variants, nested instances and text layers.',
        obj({ nodeId }),
    ),
    {
        name: 'get_code_connect_suggestions',
        description: 'Components in a node, the selection or the current page that have no Code Connect mapping yet, with their properties. Find matching code components, then call send_code_connect_mappings.',
        inputSchema: obj({ nodeId }),
        async run(args, ctx) {
            const { components } = await refs(ctx, args);
            const stored = await ctx.store.all();
            const unmapped = components.filter((c) => !stored[c.key]);
            return asJson({ unmapped, alreadyMapped: components.length - unmapped.length });
        },
    },
    {
        name: 'get_code_connect_map',
        description: 'The code component mapped to each instance in a node, the selection or the current page, from the local Code Connect store.',
        inputSchema: obj({ nodeId }),
        async run(args, ctx) {
            const { instances } = await refs(ctx, args);
            const stored = await ctx.store.all();
            const mapped: Record<string, JsonValue> = {};
            const unmapped = new Set<string>();
            for (const i of instances) {
                const e = stored[i.componentKey];
                if (!e) {
                    unmapped.add(i.componentName);
                    continue;
                }
                mapped[i.nodeId] = {
                    componentName: e.componentName,
                    source: e.source,
                    snippet: e.snippet ?? null,
                    snippetImports: e.snippetImports ?? [],
                    label: e.label ?? null,
                    figmaComponent: e.figmaName,
                };
            }
            return asJson({ mapped, unmappedComponents: [...unmapped] });
        },
    },
    {
        name: 'add_code_connect_map',
        description: 'Map a Figma component (from a component, set or instance node) to a code component. Stored locally.',
        inputSchema: mappingSchema as Schema,
        async run(args, ctx) {
            return asJson(await saveMapping(ctx, args));
        },
    },
    {
        name: 'send_code_connect_mappings',
        description: 'Save several Code Connect mappings at once, for example after get_code_connect_suggestions.',
        inputSchema: obj({ mappings: { type: 'array', items: mappingSchema } }, ['mappings']),
        async run(args, ctx) {
            const list = Array.isArray(args.mappings) ? args.mappings : [];
            const saved: JsonValue[] = [];
            for (const m of list) if (m && typeof m === 'object' && !Array.isArray(m)) saved.push((await saveMapping(ctx, m)).key);
            return asJson({ saved: saved.length, keys: saved });
        },
    },
];

export async function runTool(name: string, args: JsonObject, ctx: ToolContext): Promise<ToolResult> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return text(`Unknown tool: ${name}. Cloud-only Figma tools (shaders, generative plugins, Weave, image generation, new files) are not available locally.`, true);
    if (!tool.offline && !ctx.connected()) {
        return text('The Figma plugin is not connected. In the Figma desktop app, open the file and run Plugins → Development → Local Agent Bridge, then try again.', true);
    }
    try {
        return await tool.run(args, ctx);
    } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
    }
}
