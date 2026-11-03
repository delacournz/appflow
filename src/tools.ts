import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import * as z from 'zod/v4';

import type { JsonObject, JsonValue, PluginReply } from '../shared/protocol';
import { STALE_FIX, stalePlugin } from './build';
import { CONFIG_FILE, loadDesignConfig, readCodeSpec } from './sync/config';
import { isComponentOp, isTextStyleOp, isTokenOp, type SyncOp } from '../shared/design-ops';
import type { DesignSpec } from '../shared/design-spec';
import { diffSpecs, matchComponents, type DesignMapping, type SyncPlan } from './sync/diff';
import { parseSpec } from './sync/spec-schema';
import { summarizePlan } from './sync/summary';
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
export type ObjectSchema = z.ZodObject<z.ZodRawShape, z.core.$ZodObjectConfig>;

type ToolSpec<S extends ObjectSchema> = {
    name: string;
    description: string;
    inputSchema: S;
    /** Runs even when the plugin is not connected. */
    offline?: boolean;
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

export const TOOLS: ToolDef[] = [
    tool({
        name: 'figma_status',
        description: 'Whether the AppFlow plugin is connected, plus the open file, pages and selection. Call this first.',
        inputSchema: obj({}),
        offline: true,
        async run(_args, ctx) {
            if (!ctx.connected()) {
                return asJson({ connected: false, howToConnect: 'Open the file in the Figma desktop app and run Plugins → Development → AppFlow.' });
            }
            const r = await plugin(ctx, 'figma_status', {});
            const expected = ctx.expectedBuild ?? null;
            const actual = ctx.pluginBuild?.() ?? null;
            const stale = stalePlugin(expected, actual) ? { stale: true, fix: STALE_FIX, expectedBuild: expected, pluginBuild: actual } : {};
            return asJson({ connected: true, ...stale, ...(r.result as JsonObject) });
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
        'Check that flow arrows read left to right. Scans arrow vectors under a node (or the current page) and reports any whose head points left (points-left) or whose path travels left (runs-left), with ids and endpoints. Run it after laying out or rerouting a flow; follow the flow-layout skill to fix issues.',
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
        'Redraw flow arrows from the current positions of their screens and triggers, after moving screens. Updates each vector, dot and label in place, assigns lanes per gutter in a stable order, and reports arrows whose screens were deleted and arrows that run backwards. Without boardId it covers every adopted board on the current page.',
        obj({
            boardId: str('Board node ID.').optional(),
            arrowIds: z.array(z.string()).describe('Only redraw these arrow group IDs (as returned by connect).').optional(),
        }),
        120_000,
    ),
    passthrough(
        'adopt_board',
        'Make an existing hand-built flow board manageable: infers the grid from the screen frames inside the board, stores flowbridge plugin data on the board and screens, and groups each arrow vector with its start dot and label (linking it to its screens and trigger). Reports vectors it could not match instead of guessing. Use dryRun to preview without writing.',
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
        'Describe adopted flow boards as text. Per board returns { boardId, name, cols, rows, grid, screens, arrows, issues }: grid is an ASCII table of screen names by column (c0..) and row (r0..), each prefixed with its build mark (✓ built, ~ drift, · not built); screens lists { id, name, col, row, route, status, verifiedAt } for the verify-built skill; arrows lists each link as "From (c,r) --label--> To (c,r) [trigger: name | auto]" (plus [bottom exit]), and issues lists meta/position mismatches, stale label meta, two screens in one cell, arrows with missing endpoints arrows pointing left, screens with no build badge and built screens with no route text. Without boardId it covers every adopted board on the current page.',
        obj({
            boardId: boardIdAll,
            width: num('Characters per grid cell before a screen name is truncated. Default 16.').optional(),
        }),
    ),
    passthrough(
        'duplicate_screen',
        'Duplicate a screen frame of an adopted flow board into a free grid cell (col, row). Clones the frame with its label and route text (when the source is in a "Screen · …" group, clones the whole group as a sibling of the source group), names them, writes fresh flowbridge data on the copy, keeps prototype reactions, and grows the board background to fit. Refuses an occupied cell. The copy’s build badge resets to Not built. With banner, updates the first KycEntryRow (or ListGroup.Item*) row in the copy: title, description and optionally its prefix icon component.',
        obj({
            id: str('The screen frame to duplicate.'),
            col: z.int().describe('Target board column (0-based).'),
            row: z.int().describe('Target board row (0-based).'),
            name: str('Name for the new screen and its label text.'),
            route: str('Route text for the copy. Defaults to the original route text.').optional(),
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
        'Group each adopted screen\'s label text, route text, build badge and frame into one "Screen · {name}" layer (label and route above the frame, group kept where the frame was, arrows kept above). Idempotent: a screen already in an exact screen group is only recorded. Stores groupId in the screen data so move_screen, insert_*, compact_board and duplicate_screen move or clone the whole group. Run once on boards made before screen groups. Without boardId it covers every adopted board on the current page. Returns { dryRun, boards, grouped, skipped, missingLabel: [frame ids with no label text], details: [{ frameId, name, status, groupId, reason? }] }.',
        obj({
            boardId: boardIdAll,
            dryRun: bool('Report what would be grouped without changing the file. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'set_screen_status',
        'Record whether screens are built in code and show it as a "Badge · {name}" pill (Built green, Drift amber, Not built grey) inside each "Screen · …" group, right-aligned with the frame on the label line. Follow skill://appflow/verify-built/SKILL.md first: only mark built after comparing the route\'s code and the running app with the frame. built needs confidence ("runtime" when checked in the running app, "static" when only the code was compared); drift needs notes listing what differs. Batch every screen into one call. Screens must be grouped (run group_screens). Returns { updated: [{ id, name, status, badgeId }], errors: [{ id, error }] }.',
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
        'Add or refresh the build badge on every adopted, grouped screen, showing its stored status (Not built when none). Idempotent; run once on existing boards and after group_screens. Without boardId it covers every adopted board on the current page. Returns { dryRun, boards, added, refreshed, skipped: [{ id, name, reason }] }.',
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
        'Move an adopted screen to a grid cell, taking its label and route texts with it, and update its stored cell. Refuses an occupied cell unless swap is true (the two screens then trade cells). Grows the board background when the cell is outside it, then reroutes the board’s arrows. Screens whose stored data was copied by duplicating a frame in Figma are repaired from their position and reported in stale. Returns { boardId, moved: [{id, name, from, to}], stale, board, reroute }.',
        obj({
            id: str('Screen frame ID.'),
            col: num('Target column, 0-based.'),
            row: num('Target row, 0-based.'),
            swap: bool('Trade places with a screen already in the cell. Default false.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'insert_columns',
        'Make room for new columns: every screen with a column greater than `after` (and its label and route texts) moves `count` columns right, the board grows, and arrows are rerouted. Use after: -1 to insert before the first column. Returns { boardId, moved, stale, board, reroute }.',
        obj({
            boardId: str('Board node ID.'),
            after: num('Insert after this column (0-based). -1 inserts before the first.'),
            count: num('Columns to insert. Default 1.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'insert_rows',
        'Make room for new rows: every screen with a row greater than `after` (and its label and route texts) moves `count` rows down, the board grows, and arrows are rerouted. Use after: -1 to insert before the first row. Returns { boardId, moved, stale, board, reroute }.',
        obj({
            boardId: str('Board node ID.'),
            after: num('Insert after this row (0-based). -1 inserts before the first.'),
            count: num('Rows to insert. Default 1.').optional(),
        }),
        120_000,
    ),
    passthrough(
        'compact_board',
        'Close empty columns and rows between screens (the first used column and row keep their index), shrink the board background to fit, and reroute arrows. Returns { boardId, moved, stale, board, reroute }.',
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

/** Runs a tool, refusing with a clear message when it needs the plugin and the plugin is closed. */
export async function runTool(def: ToolDef, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!def.offline && !ctx.connected()) return text(NOT_CONNECTED, true);
    try {
        return await def.run(args, ctx);
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
