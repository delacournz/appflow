import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import * as z from 'zod/v4';

import type { FileInfo, JsonObject, JsonValue, PluginReply } from '../shared/protocol';
import { STALE_FIX, stalePlugin } from './build';
import { pinOf, resolveFile, summarize, type Pin } from './files';
import { CONFIG_FILE, loadDesignConfig, readCodeSpec } from './sync/config';
import { isComponentOp, isTextStyleOp, isTokenOp, type SyncOp } from '../shared/design-ops';
import type { DesignSpec } from '../shared/design-spec';
import { diffSpecs, matchComponents, type DesignMapping, type SyncPlan } from './sync/diff';
import { parseSpec } from './sync/spec-schema';
import { summarizePlan } from './sync/summary';
import type { CodeConnectEntry, CodeConnectStore } from './store';

export type ToolContext = {
    /** Every connected plugin window, one per Figma file. */
    files(): FileInfo[];
    /** Sends a command to the plugin window `connId` (the only one when omitted). */
    plugin(tool: string, args: JsonObject, timeoutMs: number, connId?: string): Promise<PluginReply>;
    /** Per agent session: the file select_file pinned. */
    session: { pinned: Pin | null };
    store: CodeConnectStore;
    downloadDir: string;
    /** Hash of the plugin build the server expects (plugin/build.json). */
    expectedBuild?: string | null;
};

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
export type ToolResult = { content: Content[]; isError?: boolean };
export type ObjectSchema = z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>;

type ToolSpec<S extends ObjectSchema> = {
    name: string;
    description: string;
    inputSchema: S;
    /** Runs even when no plugin is connected and picks its own file: runTool neither resolves nor strips `file`. */
    local?: boolean;
    run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
};

/** A tool with its argument type erased, so tools with different schemas share one list. */
export type ToolDef = Omit<ToolSpec<ObjectSchema>, 'run'> & { run(args: unknown, ctx: ToolContext): Promise<ToolResult> };

/** The SDK validates arguments against inputSchema before calling run, so the cast is checked at runtime. */
const tool = <S extends ObjectSchema>(spec: ToolSpec<S>): ToolDef => ({ ...spec, run: (args, ctx) => spec.run(args as z.output<S>, ctx) });

export const DEFAULT_TIMEOUT_MS = 60_000;
const EXPORT_TIMEOUT_MS = 120_000;

const NOT_CONNECTED = 'The Figma plugin is not connected. In the Figma desktop app, open the file and run Plugins → Development → AppFlow, then try again.';

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });
const asJson = (value: unknown): ToolResult => text(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const images = (list: string[] | undefined): Content[] => (list ?? []).map((data) => ({ type: 'image', data, mimeType: 'image/png' }));
const timeout = (args: { timeoutMs?: JsonValue }, fallback = DEFAULT_TIMEOUT_MS) => (typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : fallback);
/** Validated tool arguments hold only JSON values (strings, numbers, booleans, arrays and objects of those). */
const toJson = (args: object): JsonObject => args as JsonObject;

class ToolError extends Error {}

async function plugin(ctx: ToolContext, name: string, args: JsonObject, ms = timeout(args)): Promise<Extract<PluginReply, { ok: true }>> {
    const reply = await ctx.plugin(name, args, ms);
    if (!reply.ok) throw new ToolError(reply.error);
    return reply;
}

const fileArg = z
    .string()
    .describe('Which open Figma file: its fileKey, a figma.com URL, or its name. Needed only when several files run AppFlow and none is pinned with select_file.')
    .optional();
const nodeId = z.string().describe('Node ID such as "193:443" (a "193-443" from a URL also works). Defaults to the current selection.').optional();
const boardIdAll = z.string().describe('Board node ID. Default: every adopted board on the current page.').optional();
const obj = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);
const num = (description?: string) => (description ? z.number().describe(description) : z.number());
const bool = (description?: string) => (description ? z.boolean().describe(description) : z.boolean());
const str = (description?: string) => (description ? z.string().describe(description) : z.string());

/** A tool that forwards its arguments to the plugin and returns the result (and any images). */
const passthrough = <S extends ObjectSchema>(name: string, description: string, inputSchema: S, ms?: number): ToolDef =>
    tool({
        name,
        description,
        inputSchema,
        async run(args, ctx) {
            const json = toJson(args);
            const r = await plugin(ctx, name, json, ms ?? timeout(json));
            return { content: [...asJson(r.result).content, ...images(r.images)] };
        },
    });

const UPLOAD_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_UPLOAD = 10 * 1024 * 1024;

type Ref = { nodeId: string; layer: string; componentKey: string; componentName: string };
type Comp = { key: string; name: string; nodeId: string } & JsonObject;

async function refs(ctx: ToolContext, args: { nodeId?: string }): Promise<{ instances: Ref[]; components: Comp[] }> {
    const r = await plugin(ctx, 'component_refs', args.nodeId === undefined ? {} : { nodeId: args.nodeId });
    return r.result as unknown as { instances: Ref[]; components: Comp[] };
}

const mappingSchema = z.object({
    nodeId: str('A component, component set or instance.'),
    source: str('Path or URL of the code component.'),
    componentName: str('The code component’s name, such as "Button".'),
    label: str('Framework label, such as "React" or "React Native".').optional(),
    snippet: str('Example usage.').optional(),
    snippetImports: z.array(z.string()).optional(),
});

async function saveMapping(ctx: ToolContext, m: z.output<typeof mappingSchema>): Promise<{ key: string; entry: CodeConnectEntry }> {
    const r = await plugin(ctx, 'resolve_component', { nodeId: m.nodeId });
    const c = r.result as { key: string; name: string; nodeId: string };
    const entry: CodeConnectEntry = {
        componentName: m.componentName,
        source: m.source,
        ...(m.label === undefined ? {} : { label: m.label }),
        ...(m.snippet === undefined ? {} : { snippet: m.snippet }),
        ...(m.snippetImports === undefined ? {} : { snippetImports: m.snippetImports }),
        figmaName: c.name,
        figmaNodeId: c.nodeId,
        updatedAt: new Date().toISOString(),
    };
    await ctx.store.set(c.key, entry);
    return { key: c.key, entry };
}

const VERBOSE = 'Return every op as full JSON. Default false: one line per op (+ create, ~ update, ? Figma only).';

type SyncKind = 'tokens' | 'textStyles' | 'components';
const SYNC_ORDER: SyncKind[] = ['tokens', 'textStyles', 'components'];
const SYNC_SCOPE: Record<SyncKind, { keep(spec: DesignSpec): DesignSpec; is(op: SyncOp): boolean }> = {
    tokens: { keep: (s) => ({ collections: s.collections, textStyles: [], components: [] }), is: isTokenOp },
    textStyles: { keep: (s) => ({ collections: [], textStyles: s.textStyles, components: [] }), is: isTextStyleOp },
    components: { keep: (s) => ({ collections: [], textStyles: [], components: s.components }), is: isComponentOp },
};

async function figmaSpec(ctx: ToolContext, includeComponents: boolean): Promise<DesignSpec> {
    const r = await plugin(ctx, 'export_design_system', { includeComponents }, EXPORT_TIMEOUT_MS);
    return parseSpec(r.result, 'The Figma export');
}

/** A style op per styled code component: on its matched Figma set, or on the set a create op makes. */
function styleOps(code: DesignSpec, figma: DesignSpec, mapping: DesignMapping): SyncOp[] {
    const { codeComps, pairs } = matchComponents(code, figma, mapping);
    return codeComps.flatMap((c): SyncOp[] => {
        if (!c.styles) return [];
        const f = pairs.get(c);
        const layers = f ? mapping.layers[f.name] : undefined;
        return [{ op: 'style-component', component: f?.name ?? c.name, ...(f?.figmaId ? { figmaId: f.figmaId } : {}), axes: c.axes, styles: c.styles, ...(layers ? { layers } : {}) }];
    });
}

type SyncArgs = { projectRoot: string; dryRun?: boolean; prune?: boolean; verbose?: boolean; styling?: boolean };

/** Code spec, Figma export, diff, and (unless dryRun) apply and diff again. Limited to one kind of item. */
const sync = async (ctx: ToolContext, kind: SyncKind, args: SyncArgs): Promise<ToolResult> => asJson(await syncKind(ctx, kind, args));

async function syncKind(ctx: ToolContext, kind: SyncKind, args: SyncArgs): Promise<Record<string, unknown>> {
    const show = (p: SyncPlan) => (args.verbose ? p : summarizePlan(p));
    const config = await loadDesignConfig(args.projectRoot);
    const warnings: string[] = [];
    const scope = SYNC_SCOPE[kind];
    const code = scope.keep(await readCodeSpec(args.projectRoot, config.sources, warnings));
    const withComponents = kind === 'components';
    const plan = (figma: DesignSpec) => {
        const p = diffSpecs(code, scope.keep(figma), config.mapping);
        return { ...p, ops: p.ops.filter(scope.is) };
    };
    const figma = await figmaSpec(ctx, withComponents);
    const before = plan(figma);
    const styling = withComponents && (args.styling ?? true) ? styleOps(code, figma, config.mapping) : [];
    const ops = [...before.ops, ...styling];
    if (args.dryRun ?? true) return { dryRun: true, plan: show({ ...before, ops }), warnings };
    if (ops.length === 0) return { dryRun: false, result: null, remaining: before.counts, warnings };
    const r = await plugin(ctx, 'apply_design_ops', { ops: ops as unknown as JsonValue, prune: args.prune ?? false }, EXPORT_TIMEOUT_MS);
    const after = plan(await figmaSpec(ctx, withComponents));
    return { dryRun: false, result: r.result, remaining: after.counts, remainingOps: show(after).ops, warnings };
}

const syncArgs = (what: string) =>
    obj({
        projectRoot: str(`Absolute path of the project that holds ${CONFIG_FILE}.`),
        dryRun: bool(`Only return the plan. Default true; pass false to change ${what} in Figma.`).optional(),
        prune: bool(`Delete Figma ${what} that code does not have. Default false: they are reported as orphans.`).optional(),
        verbose: bool(VERBOSE).optional(),
    });

const RAW_TOOLS: ToolDef[] = [
    tool({
        name: 'figma_status',
        description: 'Whether the AppFlow plugin is connected, plus the open file, pages and selection. Call this first. With several files open, lists them; pass file or pin one with select_file.',
        inputSchema: obj({ file: fileArg }),
        local: true,
        async run(args, ctx) {
            const files = ctx.files();
            if (files.length === 0) {
                return asJson({ connected: false, howToConnect: 'Open the file in the Figma desktop app and run Plugins → Development → AppFlow.' });
            }
            const pinned = ctx.session.pinned;
            const all = files.length > 1 ? { files: files.map(summarize) } : {};
            const picked = resolveFile(files, args.file, pinned);
            if (!picked.ok) return asJson({ connected: true, file: null, pinned, ...all, note: picked.error });
            const f = picked.file;
            const reply = await ctx.plugin('figma_status', {}, DEFAULT_TIMEOUT_MS, f.connId);
            if (!reply.ok) throw new ToolError(reply.error);
            const expected = ctx.expectedBuild ?? null;
            const stale = stalePlugin(expected, f.build) ? { stale: true, fix: STALE_FIX, expectedBuild: expected, pluginBuild: f.build } : {};
            return asJson({ connected: true, ...stale, file: summarize(f), pinned, ...all, ...(reply.result as JsonObject) });
        },
    }),
    tool({
        name: 'list_files',
        description: 'The Figma files running AppFlow right now (name, fileKey, docId, editor, last activity) and the file this session pinned.',
        inputSchema: obj({}),
        local: true,
        run: async (_args, ctx) => asJson({ files: ctx.files().map(summarize), pinned: ctx.session.pinned }),
    }),
    tool({
        name: 'select_file',
        description: 'Pin the Figma file this session works on, so later calls need no file argument. A call’s own file still wins. Omit file to clear the pin.',
        inputSchema: obj({ file: str('The fileKey, a figma.com URL, or the file name.').optional() }),
        local: true,
        async run(args, ctx) {
            if (args.file === undefined) {
                ctx.session.pinned = null;
                return asJson({ pinned: null });
            }
            const picked = resolveFile(ctx.files(), args.file, null);
            if (!picked.ok) throw new ToolError(picked.error);
            ctx.session.pinned = pinOf(picked.file);
            return asJson({ pinned: ctx.session.pinned, file: summarize(picked.file) });
        },
    }),
    passthrough('whoami', 'The signed-in Figma user (name, id) and the open file. Plans and seats are not visible to a plugin.', obj({})),
    passthrough(
        'get_metadata',
        'A lightweight XML outline of a node or the selection: layer IDs, names, types, positions and sizes (and text). With no nodeId and no selection, lists the pages. Pass a page id to outline a page.',
        obj({ nodeId, maxDepth: num('Default 50.').optional(), maxNodes: num('Default 4000.').optional() }),
    ),
    tool({
        name: 'get_screenshot',
        description:
            'A PNG of a node, the selected layer, several nodes (nodeIds: the union of their bounds) or an explicit region of the current page. Use nodeIds or region to see a flow with its arrows.',
        inputSchema: obj({
            nodeId,
            nodeIds: z.array(z.string()).describe('Capture the union of these nodes’ bounds, including anything drawn between them.').optional(),
            region: obj({ x: num(), y: num(), width: num(), height: num() }).describe('Absolute canvas rect on the current page.').optional(),
            maxDimension: num('Longest side in pixels. Default 1024.').optional(),
            scale: num('Export scale; overrides maxDimension.').optional(),
        }),
        async run(args, ctx) {
            const r = await plugin(ctx, 'get_screenshot', toJson(args));
            return { content: [...images(r.images), ...asJson(r.result).content] };
        },
    }),
    tool({
        name: 'get_design_context',
        description:
            'Design-to-code context for a node or the selection: React + Tailwind JSX built from Figma’s CSS (or inline styles with format "css"), instances as <Component …props />, bound variables, and a screenshot. A reference to adapt, not final code.',
        inputSchema: obj({
            nodeId,
            clientFrameworks: str('For example "react". Include "css" for inline styles.').optional(),
            format: z.enum(['tailwind', 'css']).optional(),
            expandInstances: bool('Render instance internals instead of <Component />. Default false.').optional(),
            maxNodes: num('Default 1500.').optional(),
            includeScreenshot: bool('Default true.').optional(),
        }),
        async run(args, ctx) {
            const r = await plugin(ctx, 'get_design_context', toJson(args), 120_000);
            const { code, ...rest } = r.result as { code?: string } & JsonObject;
            const body = `## Code (${String(rest.framework ?? 'React')})\n\n\`\`\`tsx\n${code ?? ''}\`\`\`\n\n## Context\n\n${JSON.stringify(rest, null, 2)}`;
            return { content: [{ type: 'text', text: body }, ...images(r.images)] };
        },
    }),
    passthrough(
        'get_variable_defs',
        'Variables and styles used in a node or the selection (colours, spacing, typography), resolved to values: { defs: { name: value }, variables, styles }.',
        obj({ nodeId }),
    ),
    passthrough(
        'get_figjam',
        'XML outline of FigJam content (stickies, shapes, connectors with from/to, sections) plus a screenshot.',
        obj({ nodeId, includeScreenshot: bool().optional(), maxDimension: num().optional() }),
    ),
    passthrough(
        'search_design_system',
        'Search this file’s components, component sets, variables and styles, and variables from enabled libraries. Several searches per call.',
        obj({
            query: str().optional(),
            queries: z.array(z.object({ entity: z.enum(['component', 'variable', 'style']).optional(), query: str() })).optional(),
            includeLibraries: bool('Include library variables. Default true.').optional(),
            limit: num('Per query. Default 20.').optional(),
        }),
        120_000,
    ),
    passthrough('get_libraries', 'Libraries visible to the plugin: enabled libraries with variable collections, and remote components used on the current page.', obj({})),
    tool({
        name: 'download_assets',
        description:
            'Export up to 20 nodes (their export settings, or defaultFormat/defaultScale) and the original image fills inside them, saved to local files. Returns the file paths.',
        inputSchema: obj({
            nodeIds: z.array(z.string()).optional(),
            defaultFormat: z.enum(['PNG', 'JPG', 'SVG', 'PDF']).optional(),
            defaultScale: num('0.01 to 4. Default 2.').optional(),
            includeImageSources: bool('Default true.').optional(),
            outDir: str('Folder to save into. Defaults to the bridge download folder.').optional(),
        }),
        async run({ outDir, ...rest }, ctx) {
            const r = await plugin(ctx, 'download_assets', toJson(rest), 120_000);
            const dir = outDir ?? join(ctx.downloadDir, new Date().toISOString().replace(/[:.]/g, '-'));
            await mkdir(dir, { recursive: true });
            const files: string[] = [];
            for (const f of r.files ?? []) {
                const path = join(dir, basename(f.name));
                await writeFile(path, Buffer.from(f.base64, 'base64'));
                files.push(path);
            }
            return asJson({ files, ...(r.result as JsonObject) });
        },
    }),
    tool({
        name: 'upload_assets',
        description:
            'Place local PNG, JPG, GIF, WebP or SVG files (up to 10 MB each, 60 per call) in the file. SVGs become vector layers. With nodeId, the first raster image becomes that layer’s fill.',
        inputSchema: obj({
            files: z.array(z.string()).describe('Absolute file paths.'),
            nodeId: str().optional(),
            parentId: str().optional(),
            x: num().optional(),
            y: num().optional(),
        }),
        async run({ files: paths, ...rest }, ctx) {
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
            const r = await plugin(ctx, 'upload_assets', { ...toJson(rest), files }, 120_000);
            return asJson(r.result);
        },
    }),
    tool({
        name: 'use_figma',
        description:
            'Run Plugin API JavaScript in the open file. The code is the body of an async function: top-level await and `return` work, `figma` is in scope. documentAccess is "dynamic-page": use getNodeByIdAsync, setCurrentPageAsync and setReactionsAsync. Load fonts before editing text. Returns the returned value (nodes reduced to {id, type, name}) and console.log lines.',
        inputSchema: obj({ code: str(), timeoutMs: num(`Default ${DEFAULT_TIMEOUT_MS}.`).optional() }),
        async run(args, ctx) {
            if (!args.code.trim()) return text('`code` is required.', true);
            const r = await plugin(ctx, 'use_figma', toJson(args));
            return asJson({ result: r.result, logs: r.logs ?? [] });
        },
    }),
    tool({
        name: 'html_to_figma',
        description:
            'Render a self-contained HTML document at a width and rebuild it as editable layers (frames, text, SVGs, images). Pass `html`, or `path` to a local .html file. Remote images and fonts are not fetched.',
        inputSchema: obj({
            html: str().optional(),
            path: str('A local .html file, instead of `html`.').optional(),
            width: num('Viewport width. Default 1440.').optional(),
            height: num('Fixed height. Defaults to the page height.').optional(),
            name: str().optional(),
            parentId: str().optional(),
            x: num().optional(),
            y: num().optional(),
        }),
        async run({ path, ...rest }, ctx) {
            const html = path === undefined ? rest.html : await readFile(path, 'utf8');
            if (html === undefined || !html.trim()) return text('Pass `html` or `path`.', true);
            if (html.length > 50 * 1024 * 1024) return text('HTML is over 50 MB.', true);
            const r = await plugin(ctx, 'html_to_figma', { ...toJson(rest), html }, 180_000);
            return asJson(r.result);
        },
    }),
    passthrough(
        'generate_diagram',
        'Draw a Mermaid flowchart (flowchart/graph TD|LR|BT|RL; node shapes [], (), {}, (()), ([]); links -->, ---, -.->, ==> with labels). FigJam gets shapes and connectors; design files get frames and arrows. Other Mermaid types are not supported.',
        obj({ mermaid: str(), name: str().optional(), x: num().optional(), y: num().optional() }),
    ),
    passthrough(
        'lint_flow_layout',
        'Check that flow arrows read left to right and that flow group boxes are clean. Scans arrow vectors under a node (or the current page) and reports any whose head points left (points-left) or whose path travels left (runs-left), with ids and endpoints. The one leftward run allowed is the bottom-exit detour: drop from the source bottom, one run left along the row gap, head pointing right or down. On adopted boards with flow groups it also returns layoutIssues (each with boardId and message) and counts per kind: group-crosses-content (a box stroke cuts a screen, route text or badge), group-crosses-label (a stroke cuts an arrow label), group-overlaps-group, group-encloses-foreign (a non-member screen inside a box), title-overlaps, and nesting-too-deep, child-outside-parent, parent-missing, plus arrow checks label-overlaps-label, lines-overlap (two collinear arrow lines sharing over 40px), shared-start (two arrows leaving the same dot for different targets that share more than 48px of their first run: they must fork into rows of their own), line-crosses-title (an arrow line through a group title), line-crosses-screen (a line through a screen that is neither its source nor its target), starts-wrong-side (an arrow starting on the left or top edge of its source) and ends-wrong-side (an arrow ending on the right or bottom edge of its target): arrows start only on the bottom or right edge of a screen and end only on its left or top edge. Arrows into one target merge on a shared trunk and final run, which lines-overlap ignores; arrows from one dot to different targets fork (a short stub, then a row each). It also checks the prototype against the arrows: prototype-mismatch (the trigger of an arrow navigates somewhere other than its target, or has no navigate reaction; an error), and, informational only and never failing passed, prototype-without-arrow (a NAVIGATE reaction on a screen or inside it, screen-level AFTER_TIMEOUT included, to another board screen that no arrow connects; back links like Close or Go to wallet may stay prototype-only) and auto-arrow-no-prototype (an arrow with no trigger whose source has no frame-level AFTER_TIMEOUT and no reaction to the target). Reactions to nodes that are not board screens (overlays, back, other pages) are ignored. Persistent navigation is exempt: a reaction on a layer named like a tab bar, bottom nav or navigation bar (or inside one), or on a control named after a tab (a name ending in a tab root, like Hotspot · Pay), or to a tab root or a state variant of one (Account · verify your identity). Tab roots are the screens reached by arrows whose trigger is named Hotspot · … or contains Tab, or whose label is Tap Home/Pay/Activity/Account, needs no arrow; exemptCount in counts shows how many were skipped. Duplicate reactions (the same control and destination) are reported once. Each carries the arrow id when there is one, source and target names, the reaction node id, its name (triggerName) and the actual destination id. Arrow lines may cross a box; nothing else may. passed is false on any issue except informational ones. Run it after laying out, grouping or rerouting a flow; follow the flow-layout skill to fix issues.',
        obj({ nodeId, tolerance: num('Pixels of leftward movement to ignore. Default 1.').optional() }),
    ),
    passthrough(
        'connect',
        'Draw a flow arrow from one screen to another on an adopted board and, with a trigger, point the trigger’s prototype navigate reaction at the target (replacing its current one). Routes orthogonally per the flow-layout skill, creates the vector, start dot and label in the board’s arrows group, and stores the link so reroute_flow can redraw it. Calling it again for the same from/to/trigger updates the arrow. A target to the left is drawn below the rows and returned with backwards: true. Returns { arrowGroupId, points, prototypeUpdated, backwards, updated }.',
        obj({
            from: str('Source screen frame ID.'),
            to: str('Target screen frame ID.'),
            trigger: str('The control inside the source screen that causes the move. The arrow starts 10 px right of it.').optional(),
            label: str('Text on the arrow, such as "Continue".'),
            prototype: bool('Also set the trigger’s navigate reaction. Default true.').optional(),
            boardId: str('Board node ID. Defaults to the source screen’s board.').optional(),
            exit: z
                .enum(['side', 'bottom'])
                .describe('For a target below and right: "bottom" leaves the source’s bottom edge and turns right, keeping a busy gutter clear. Default "side".')
                .optional(),
        }),
    ),
    passthrough(
        'reroute_flow',
        'Redraw flow arrows from the current positions of their screens and triggers, after moving screens. Updates each vector, dot and label in place, assigns lanes per gutter in a stable order, and reports arrows whose screens were deleted and arrows that run backwards. Without boardId it covers every adopted board on the current page. Refuses with pitch-mismatch when the board\'s stored pitch no longer matches where its screens sit (re-deriving cells from those positions would stack screens in one cell); a uniform board whose screens agree on one pitch is repaired from their positions instead. Spacing "grouped": every flow group (nested ones too) lays its own screens on its own grid at the board pitch, so groups need not share rows or columns; the conversion keeps every screen that is on its group’s pitch and snaps the others once to the nearest free cell (dryRun reports the grids and the planned moves first). A group that grows pushes its neighbours right or down, never up or left.',
        obj({
            boardId: str('Board node ID.').optional(),
            arrowIds: z.array(z.string()).describe('Only redraw these arrow group IDs (as returned by connect).').optional(),
            spacing: z.enum(['uniform', 'banded', 'grouped']).describe('Board spacing mode, stored on the board. "uniform" (default): one column pitch and one row pitch for the whole board, grown to fit the widest group boundary, so every column shares an x and every row a y. "banded": base pitch plus per-region extras (older behaviour). Switching converts the board on this call.').optional(),
            dryRun: bool('With spacing "grouped": report the grids the conversion would make and the planned snap moves, changing nothing. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'adopt_board',
        'Make an existing hand-built flow board manageable: infers the grid from the screen frames inside the board, stores flowbridge plugin data on the board and screens, and groups each arrow vector with its start dot and label (linking it to its screens and trigger), and records each screen frame. Screens stay top-level frames (never grouped) so prototype Play and flow starting points work; Figma\'s own frame title is the screen name, so there is no label text. A "Route · {name}" text above the frame and a "Badge · {name}" pill are loose siblings. Also links each "Badge · {name}" pill to its screen (exact name, else the pill in the screen\'s own slot) and re-links arrow groups whose stored ids are stale (a copied board): ends are resolved from where the arrow is now, with the group name "Flow · A → B · label" as a tiebreak, tolerating screens shifted by up to ~650px since the arrow was drawn; run reroute_flow afterwards to redraw them. Ends that cannot be told apart are reported (unmatched, with candidates) instead of guessed. Safe to re-run: existing board data, screen status, flow group membership and extras are kept and only missing links are added. Use dryRun to preview without writing.',
        obj({
            boardNodeId: str('The board background rectangle or section.'),
            colWidth: num('Override the inferred column spacing.').optional(),
            rowHeight: num('Override the inferred row spacing.').optional(),
            arrowsGroupIds: z.array(z.string()).describe('Group(s) holding the arrows. Defaults to the "Flow arrows" group that matches the board name.').optional(),
            dryRun: bool('Report what would be adopted without changing the file. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'describe_board',
        'Describe adopted flow boards as text. Per board returns { boardId, name, cols, rows, grid, screens, arrows, groups, groupTree, issues }: grid is an ASCII table of screen names by column (c0..) and row (r0..), each prefixed with its build mark (✓ built, ~ drift, · not built); screens lists { id, name, col, row, route, status, verifiedAt } for the verify-built skill; arrows lists each link as "From (c,r) --label--> To (c,r) [trigger: name | auto]" (plus [bottom exit]), and issues lists meta/position mismatches, stale screen meta, two screens in one cell, arrows with missing endpoints arrows pointing left, screens with no build badge, built screens with no route text, and flow-group problems (empty, hidden or stale groups, missing parents); groups lists flow groups as { id, name, parentId, screens: [names], box } and groupTree draws them indented. On a grouped board grid holds one titled table per layout grid (titled Group name, origin x,y), cells are local to each grid, and grids lists { id, name, originX, originY, cols, rows, grid }; issues add screens off the pitch of their grid. Without boardId it covers every adopted board on the current page.',
        obj({
            boardId: boardIdAll,
            width: num('Characters per grid cell before a screen name is truncated. Default 16.').optional(),
        }),
    ),
    passthrough(
        'duplicate_screen',
        'Duplicate a screen frame of an adopted flow board into a free grid cell (col, row). Clones the top-level frame with its route text and build badge as loose siblings (no label text; Figma\'s frame title is the name). A source still in a legacy "Screen · …" group clones the whole group instead; run ungroup_screens first. Names them, writes fresh flowbridge data on the copy, keeps prototype reactions, and grows the board background to fit. Refuses an occupied cell. The copy joins the source screen’s flow group (see create_flow_group) unless group says otherwise; on a board with flow groups the boxes are refitted and arrows rerouted, and the result carries flowGroupId and groups (issues). The copy’s build badge resets to Not built. With banner, updates the first KycEntryRow (or ListGroup.Item*) row in the copy: title, description and optionally its prefix icon component.',
        obj({
            id: str('The screen frame to duplicate.'),
            col: z.int().describe('Target board column (0-based).'),
            row: z.int().describe('Target board row (0-based).'),
            name: str('Name for the new screen (its frame name, shown as Figma\'s frame title) and its route and badge layers.'),
            route: str('Route text for the copy. Defaults to the original route text.').optional(),
            group: str('Flow group (labelled box) to put the copy in: a groupId, or "none" for no group. Default: the source screen\'s flow group. The box refits to hold the copy.').optional(),
            banner: obj({
                title: str(),
                description: str(),
                iconComponentId: str('COMPONENT or COMPONENT_SET to swap the prefix icon instance to.').optional(),
            })
                .describe('Retarget the banner row in the copy.')
                .optional(),
        }),
    ),
    passthrough(
        'group_screens',
        'Legacy, NOT for labelled boxes around screens (use create_flow_group for those). WARNING, grouped screens are not top-level frames, so this BREAKS prototype Play and flow starting points ("Can only set flow starting point that is a top level frame") and prototype reactions on the frames. Prefer ungroup_screens; only use this if the user explicitly wants groups. Groups each adopted screen\'s label text, route text, build badge and frame into one "Screen · {name}" layer (group kept where the frame was, arrows kept above). Idempotent: a screen already in an exact screen group is only recorded. Stores groupId in the screen data so move_screen, insert_*, compact_board and duplicate_screen move or clone the whole group. Without boardId it covers every adopted board on the current page. Returns { dryRun, boards, grouped, skipped, missingLabel: [frame ids with no label text], details: [{ frameId, name, status, groupId, reason? }] }.',
        obj({
            boardId: boardIdAll,
            dryRun: bool('Report what would be grouped without changing the file. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'create_flow_group',
        'Draw a labelled box around a set of screens on an adopted board: a white 12 px no-fill rectangle with 160 px padding and a dark title bar (an auto-layout frame, full box width, flush on the box top, bold white left-aligned name) above it ("Group · {name}" and "Group title · {name}" layers, in a "Flow groups · {board}" frame just above the board background and below the screens, so screens stay top-level and prototype Play works). The box and title are fitted automatically: the board\'s column and row gaps are widened where a box edge meets another group or ungrouped screen (screens after that boundary shift), and the box refits whenever screens are added, moved, duplicated or removed. Rules the layout keeps: arrow lines may cross a box stroke; a box, its stroke and its title never cross a screen, route text, badge, arrow label, or another group\'s box or title (anything that cannot be avoided is listed in issues; fix by moving screens or arrows). Never draw boxes by hand. Members: screenIds, else cells, else the selected screens. A screen is in at most one group, so a screen already in another group is refused (use update_flow_group remove first). Nesting is one level: with parentId the new group is a child inside that group; its screens may be taken from the parent (they move into the child) and the parent\'s box wraps the child\'s box and title. A group nested deeper is refused. On a grouped board (reroute_flow spacing "grouped") the group gets a grid of its own at the top-left of its members and no screen moves; a screen that joins and is off the grid pitch snaps to the nearest free cell and is listed in snapped, and a box that grows pushes neighbouring groups right or down. Use dryRun to preview members and the extra spacing. Returns { groupId, name, screens, box, title, extras, screensShifted, board, issues, nesting, reroute } (dryRun: { dryRun, screens, extras, screensShifted }).',
        obj({
            name: str('Group title, such as "Passkeys".'),
            boardId: str('Board node ID. Default: the board of the given or selected screens, else the only board on the page.').optional(),
            screenIds: z.array(z.string()).describe('Screen frame IDs to put in the group.').optional(),
            cells: z.array(obj({ col: z.int(), row: z.int() })).describe('Grid cells whose screens go in the group. Used when screenIds is omitted.').optional(),
            parentId: str('Nest the new group inside this flow group (one level only).').optional(),
            style: obj({
                color: str('#RRGGBB for the box line. Default #FFFFFF.').optional(),
                strokeWeight: num('Box line width in px. Default 12.').optional(),
                padding: num('Gap from screens and route text to the box line, px (min 48). Default 160.').optional(),
                titleSize: num('Title font size. Default 96 (63 for a nested group).').optional(),
                titleFill: str('#RRGGBB title bar fill. Default #2C2C2C.').optional(),
                titleColor: str('#RRGGBB title text. Default #FFFFFF.').optional(),
            })
                .describe('Box and title style.')
                .optional(),
            dryRun: bool('Report the members and the spacing change without editing the file. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'update_flow_group',
        'Change a flow group: rename it, add or remove screens, nest it under another group (parentId) or promote it to the top level (parentId null), or restyle it. The board refits automatically (boundaries, screens, box, title, background) and arrows are rerouted. Rules as in create_flow_group: a screen is in at most one group, one level of nesting, a group cannot be emptied (use delete_flow_group). A child may add screens its parent holds. Returns { groupId, name, screens, box, title, extras, screensShifted, board, issues, nesting, reroute }.',
        obj({
            groupId: str('The flow group ID (from create_flow_group).'),
            name: str().optional(),
            add: z.array(z.string()).describe('Screen frame IDs to add.').optional(),
            remove: z.array(z.string()).describe('Screen frame IDs to take out of the group (they become ungrouped).').optional(),
            parentId: z.union([z.string(), z.null()]).describe('Group ID to nest under, or null to move a child to the top level.').optional(),
            style: obj({
                color: str('#RRGGBB.').optional(),
                strokeWeight: num().optional(),
                padding: num().optional(),
                titleSize: num().optional(),
                titleFill: str().optional(),
                titleColor: str().optional(),
            })
                .describe('Fields to change.')
                .optional(),
        }),
        120_000,
    ),
    passthrough(
        'delete_flow_group',
        'Delete a flow group: removes its box, title and data and frees its screens (screens are not touched). Children of a deleted parent become top-level groups. The board refits, and when the last group goes the extra spacing the groups needed is released. Returns { deleted, freedScreens, promoted, extras, screensShifted, board, issues, reroute }.',
        obj({ groupId: str('The flow group ID.') }),
        120_000,
    ),
    passthrough(
        'adopt_flow_groups',
        'Turn hand-drawn group boxes into real flow groups (see create_flow_group). Detects stroked rectangles/frames with no fill (or fill alpha <= 0.3) that fully contain at least one screen, titled by the nearest text or "Section Heading" instance just above or at the top of the box; a box inside another becomes a child group (one level; deeper boxes are reported in skipped). Also groups the screens below a "Section Heading" instance that has no box, within its width, down to the next heading. Names fall back to "Group N". ALWAYS run with dryRun true first (the default) and review the plan: groups [{ key, name, memberIds, allMemberIds, parentKey, sourceNodeIds, source, confidence, notes }] and skipped. With dryRun false it creates the groups (parents first) with one refit and reroute. The old boxes, titles and heading instances are deleted ONLY with removeOld true: set it only with the user\'s explicit consent (instances are removed, their main components are never touched). Returns { dryRun, boards: [{ boardId, groups, skipped, created, errors, removed, issues }] }.',
        obj({
            boardId: boardIdAll,
            dryRun: bool('Report the plan without changing the file. Default true.').optional(),
            removeOld: bool('Also delete the hand-drawn boxes, titles and Section Heading instances that were turned into groups. Default false; only with user consent.').optional(),
        }),
        180_000,
    ),
    passthrough(
        'repair_board',
        'Rebuild a board whose background node was deleted. Screens, arrows, flow groups and the group holder still carry the old board id; this draws a new locked background under them, infers a uniform grid from the screens\' stored cells (or uses the holder\'s board backup), relinks every screen, arrow and group to the new id, then settles and reroutes the board. Without boardId it repairs the only missing board on the page. Run dryRun first to see the inferred grid and counts. Returns { boardId, missingBoardId, name, fromBackup, grid, screens, arrows, groups, settled }.',
        obj({
            boardId: str('The deleted board background id that screens still point at. Default: the only missing board on the page.').optional(),
            dryRun: bool('Report what would be rebuilt without changing the file. Default false.').optional(),
        }),
        180_000,
    ),
    passthrough(
        'ungroup_screens',
        'Make every adopted screen a top-level frame again, so prototype Play and flow starting points work. For each screen in a "Screen · …" group: moves the frame, route text and badge out to the group\'s parent at the group\'s index (absolute positions kept, arrows kept above, empty group deleted), deletes the "Label · …" text unless keepLabels (Figma\'s own frame title is the name), moves the route text to 72 px above the frame at its left edge, right-aligns the badge with the frame centred on that line, and rewrites the screen data with labelId null and groupId null. Idempotent: already ungrouped screens only get route and badge positions normalised. Run once on boards made with screen groups. Without boardId it covers every adopted board on the current page. Returns { dryRun, boards, ungrouped, already, skipped, labelsRemoved, details: [{ frameId, name, status: \'ungrouped\' | \'already\' | \'skipped\', labelRemoved, reason? }] }.',
        obj({
            boardId: boardIdAll,
            dryRun: bool('Report what would change without editing the file. Default false.').optional(),
            keepLabels: bool('Keep the "Label · …" text instead of deleting it. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'set_screen_status',
        'Record whether screens are built in code and show it as a "Badge · {name}" pill (Built green, Drift amber, Not built grey) as a loose sibling of the screen frame, right-aligned with the frame and centred on the route text line above it. Follow skill://appflow/verify-built/SKILL.md first: only mark built after comparing the route\'s code and the running app with the frame. built needs confidence ("runtime" when checked in the running app, "static" when only the code was compared); drift needs notes listing what differs. Batch every screen into one call. Works on top-level (ungrouped) screens. Returns { updated: [{ id, name, status, badgeId }], errors: [{ id, error }] }.',
        obj({
            screens: z.array(
                obj({
                    id: str('Screen frame ID.'),
                    status: z.enum(['built', 'drift', 'not-built']),
                    confidence: z.enum(['static', 'runtime']).describe('Required for built.').optional(),
                    commit: str('Short git SHA the check ran against.').optional(),
                    notes: str('Required for drift: what differs. Optional for built (e.g. why only static).').optional(),
                }),
            ),
        }),
        120_000,
    ),
    passthrough(
        'badge_screens',
        'Add or refresh the build badge on every adopted screen, showing its stored status (Not built when none; a screen with no stored status keeps the Built or Drift its current badge shows, marked recovered), and delete orphan badges: "Badge · …" pills on the board that no screen points at (left behind by renames, duplicates or deletes; listed in removed with their old text). Idempotent; run once on existing boards. Without boardId it covers every adopted board on the current page. Returns { dryRun, boards, added, refreshed, removed: [{ id, name, text }], skipped: [{ id, name, reason }] }.',
        obj({
            boardId: boardIdAll,
            dryRun: bool('Report what would change without editing the file. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'create_board',
        'Create an empty flow board: a heading "Board · {name}", a background rectangle sized for cols x rows screens, and an empty "Flow arrows · {name}" frame kept above the screens, with flowbridge board data written. Copies the heading and background styles and arrow style from an existing adopted board on the page. Without x and y it is placed clear of everything on the page. Returns { boardId, headingId, arrowsGroupId, bounds, grid, styledFrom }.',
        obj({
            name: str('Board name, used in the heading and layer names.'),
            x: num('Left edge of the board background. Default: right of all page content.').optional(),
            y: num('Top edge of the board background. Default: top of the page content.').optional(),
            colWidth: num('Column spacing in px (screen width + gutter). Default 700.').optional(),
            rowHeight: num('Row spacing in px. Default 1112.').optional(),
            screenW: num('Screen frame width. Default 393.').optional(),
            screenH: num('Screen frame height. Default 852.').optional(),
            cols: num('Columns the background is sized for. Default 4.').optional(),
            rows: num('Rows the background is sized for. Default 2.').optional(),
        }),
    ),
    passthrough(
        'move_screen',
        'Move an adopted screen to a grid cell, taking its route text and badge with it, and update its stored cell. On a grouped board col and row are local to the screen’s own grid (its group’s, or the board grid for ungrouped screens); with group the screen moves into that group’s grid at that local cell (a swap across two groups is refused). Refuses an occupied cell unless swap is true (the two screens then trade cells). Grows the board background when the cell is outside it, then reroutes the board’s arrows. Screens whose stored data was copied by duplicating a frame in Figma are repaired from their position and reported in stale. Flow group boxes refit to the new positions. Returns { boardId, moved: [{id, name, from, to}], stale, board, reroute, groups? }.',
        obj({
            id: str('Screen frame ID.'),
            col: num('Target column, 0-based.'),
            row: num('Target row, 0-based.'),
            swap: bool('Trade places with a screen already in the cell. Default false.').optional(),
            group: str('Also move the screen into this flow group (a groupId), or "none" to take it out of its group. Default: membership unchanged. Boxes refit either way.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'insert_columns',
        'Make room for new columns: every screen with a column greater than `after` (and its route text and badge) moves `count` columns right, the board grows, and arrows are rerouted. Use after: -1 to insert before the first column. On a grouped board only one grid shifts: groupId names the group (default: the board grid of ungrouped screens), other groups stay where they are and the box refits, pushing neighbours only if it overlaps. Returns { boardId, moved, stale, board, reroute }.',
        obj({
            boardId: str('Board node ID.'),
            after: num('Insert after this column (0-based). -1 inserts before the first.'),
            count: num('Columns to insert. Default 1.').optional(),
            groupId: str('Grouped boards: the flow group whose grid to shift. Default: the board grid (ungrouped screens).').optional(),
        }),
        120_000,
    ),
    passthrough(
        'insert_rows',
        'Make room for new rows: every screen with a row greater than `after` (and its route text and badge) moves `count` rows down, the board grows, and arrows are rerouted. Use after: -1 to insert before the first row. On a grouped board only one grid shifts: groupId names the group (default: the board grid of ungrouped screens), other groups stay where they are and the box refits, pushing neighbours only if it overlaps. Returns { boardId, moved, stale, board, reroute }.',
        obj({
            boardId: str('Board node ID.'),
            after: num('Insert after this row (0-based). -1 inserts before the first.'),
            count: num('Rows to insert. Default 1.').optional(),
            groupId: str('Grouped boards: the flow group whose grid to shift. Default: the board grid (ungrouped screens).').optional(),
        }),
        120_000,
    ),
    passthrough(
        'compact_board',
        'Close empty columns and rows between screens (the first used column and row keep their index; on a grouped board each grid is compacted on its own), shrink the board background to fit, and reroute arrows. Returns { boardId, moved, stale, board, reroute }.',
        obj({ boardId: str('Board node ID.') }),
        120_000,
    ),
    passthrough(
        'get_context_for_code_connect',
        'Component details for writing a Code Connect mapping: properties with variant options, variants, nested instances and text layers.',
        obj({ nodeId }),
    ),
    tool({
        name: 'get_code_connect_suggestions',
        description: 'Components in a node, the selection or the current page that have no Code Connect mapping yet, with their properties. Find matching code components, then call send_code_connect_mappings.',
        inputSchema: obj({ nodeId }),
        async run(args, ctx) {
            const { components } = await refs(ctx, args);
            const stored = await ctx.store.all();
            const unmapped = components.filter((c) => !stored[c.key]);
            return asJson({ unmapped, alreadyMapped: components.length - unmapped.length });
        },
    }),
    tool({
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
    }),
    tool({
        name: 'add_code_connect_map',
        description: 'Map a Figma component (from a component, set or instance node) to a code component. Stored locally.',
        inputSchema: mappingSchema,
        async run(args, ctx) {
            return asJson(await saveMapping(ctx, args));
        },
    }),
    tool({
        name: 'send_code_connect_mappings',
        description: 'Save several Code Connect mappings at once, for example after get_code_connect_suggestions.',
        inputSchema: obj({ mappings: z.array(mappingSchema) }),
        async run({ mappings }, ctx) {
            const saved: string[] = [];
            for (const m of mappings) saved.push((await saveMapping(ctx, m)).key);
            return asJson({ saved: saved.length, keys: saved });
        },
    }),
    tool({
        name: 'export_design_system',
        description: 'Export the open file’s local variables (with modes, aliases, scopes, code syntax), text styles and components as a DesignSpec JSON.',
        inputSchema: obj({ includeComponents: bool('Also list component sets and their variant axes. Default true; loads every page.').optional() }),
        async run(args, ctx) {
            const r = await plugin(ctx, 'export_design_system', { includeComponents: args.includeComponents ?? true }, EXPORT_TIMEOUT_MS);
            return asJson(r.result);
        },
    }),
    tool({
        name: 'diff_design_system',
        description: `Compare the project’s code design system (read from ${CONFIG_FILE} at projectRoot) with the open Figma file. Code is the source of truth. Returns the ops that would make Figma match code (create, update, orphan), counts and rename candidates. Changes nothing.`,
        inputSchema: obj({
            projectRoot: str(`Absolute path of the project that holds ${CONFIG_FILE}.`),
            includeComponents: bool('Compare components and variants too. Default true.').optional(),
            verbose: bool(VERBOSE).optional(),
        }),
        async run(args, ctx) {
            const config = await loadDesignConfig(args.projectRoot);
            const code = await readCodeSpec(args.projectRoot, config.sources);
            const includeComponents = args.includeComponents ?? true;
            const r = await plugin(ctx, 'export_design_system', { includeComponents }, EXPORT_TIMEOUT_MS);
            const figma = parseSpec(r.result, 'The Figma export');
            const plan = diffSpecs(includeComponents ? code : { ...code, components: [] }, figma, config.mapping);
            return asJson(args.verbose ? plan : summarizePlan(plan));
        },
    }),
    tool({
        name: 'sync_tokens',
        description: `Make the open file's variables match the code tokens from ${CONFIG_FILE}: create collections, modes and variables (with scopes, code syntax and code ids), rename matched variables to code names, and set values and aliases. Dry run by default; Figma-only variables are removed only with prune.`,
        inputSchema: syncArgs('variables'),
        run: (args, ctx) => sync(ctx, 'tokens', args),
    }),
    tool({
        name: 'sync_design_system',
        description: `Run sync_tokens, sync_text_styles and sync_components in that order (or the kinds in include) with the same dryRun and prune. Returns one result per kind. See skill://appflow/sync-from-code/SKILL.md.`,
        inputSchema: syncArgs('variables, text styles and variants').extend({
            include: z.array(z.enum(['tokens', 'textStyles', 'components'])).min(1).describe('Kinds to sync. Default all three. Always run in the order tokens, textStyles, components.').optional(),
            styling: bool('Paint component variants from their code classes. Default true.').optional(),
        }),
        async run(args, ctx) {
            const out: Record<string, unknown> = {};
            for (const kind of SYNC_ORDER) if (!args.include || args.include.includes(kind)) out[kind] = await syncKind(ctx, kind, args);
            return asJson(out);
        },
    }),
    tool({
        name: 'sync_components',
        description: `Make the open file's component sets match the code components (tailwind-variants) in ${CONFIG_FILE}: rename variant axes and options per the mapping, add missing axes and options (cloned from the default variant), create missing sets on a "Code components" page, link code ids, and (styling, default true) paint each variant from its code classes bound to the synced variables. Run sync_tokens first. Dry run by default; Figma-only variants are removed only with prune.`,
        inputSchema: syncArgs('variants').extend({ styling: bool('Also paint each variant from its code classes. Default true.').optional() }),
        run: (args, ctx) => sync(ctx, 'components', args),
    }),
    tool({
        name: 'sync_text_styles',
        description: `Make the open file's text styles match the code type roles from ${CONFIG_FILE}. Fonts must be available in Figma; a missing one is an error, never a guess. Dry run by default; Figma-only styles are removed only with prune.`,
        inputSchema: syncArgs('text styles'),
        run: (args, ctx) => sync(ctx, 'textStyles', args),
    }),
];

/** Adds the optional `file` argument to every tool that talks to the plugin. */
const withFile = (def: ToolDef): ToolDef => (def.local ? def : { ...def, inputSchema: def.inputSchema.extend({ file: fileArg }) });

export const TOOLS: ToolDef[] = RAW_TOOLS.map(withFile);

/**
 * Runs a tool. A plugin tool's `file` (else the session pin, else the only
 * file) picks the plugin window; every plugin call the tool makes goes there.
 * `file` itself is not passed on.
 */
export async function runTool(def: ToolDef, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
        if (def.local) return await def.run(args, ctx);
        const files = ctx.files();
        if (files.length === 0) return text(NOT_CONNECTED, true);
        const { file, ...rest } = (args ?? {}) as { file?: string } & JsonObject;
        const picked = resolveFile(files, file, ctx.session.pinned);
        if (!picked.ok) return text(picked.error, true);
        const connId = picked.file.connId;
        const scoped: ToolContext = { ...ctx, plugin: (name, a, ms) => ctx.plugin(name, a, ms, connId) };
        return await def.run(rest, scoped);
    } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
    }
}

/** Looks a tool up by name, validates the arguments against its schema and runs it. For callers outside MCP, such as scripts/call.ts. */
export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return text(`Unknown tool: ${name}.`, true);
    const parsed = def.inputSchema.safeParse(args ?? {});
    if (!parsed.success) return text(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, true);
    return runTool(def, parsed.data, ctx);
}
