/** The appflow MCP server: tools, skill resources and prompts, built on the MCP TypeScript SDK. The transport lives in server.ts. */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import pkg from '../package.json' with { type: 'json' };
import flowLayoutSkill from './skills/flow-layout.md' with { type: 'text' };
import syncFromCodeSkill from './skills/sync-from-code.md' with { type: 'text' };
import verifyBuiltSkill from './skills/verify-built.md' with { type: 'text' };
import { runTool, TOOLS, type ToolContext, type ToolDef } from './tools';

const INSTRUCTIONS = [
    'Local Figma tools with the same names as the Figma MCP server, run through the "AppFlow" plugin in the Figma desktop app.',
    'Call figma_status first. Most tools default to the current selection when nodeId is omitted.',
    'Several Figma files can run AppFlow at once. When figma_status lists more than one, pass file (a fileKey, figma.com URL or file name) on each call or pin one for this session with select_file; a call that names no file then fails rather than guess. Take the fileKey from a Figma URL the user gives.',
    'use_figma runs Plugin API code with documentAccess "dynamic-page": use async APIs (getNodeByIdAsync, setCurrentPageAsync, setReactionsAsync). Colours are 0-1. Load fonts before editing text.',
    'Screen flows read left to right: the main path goes right, branches go straight down, overlays and entry points straight up; arrows never point or run left; move the target screen rather than bending an arrow back. Read skill://appflow/flow-layout/SKILL.md before laying out a flow. On a flow board use the board tools, not hand-drawn vectors: adopt_board or create_board, describe_board, move_screen / insert_columns / insert_rows / compact_board, duplicate_screen for state copies, create_flow_group / update_flow_group / delete_flow_group for labelled boxes around related screens (never draw boxes by hand or use group_screens; adopt_flow_groups converts old hand-drawn ones), connect (from the triggering control; it also sets the prototype) and reroute_flow. Finish with lint_flow_layout and describe_board.',
    'Each screen shows a Built, Drift or Not built badge. Change it only with set_screen_status, after following skill://appflow/verify-built/SKILL.md (compare the route code and running app with the frame); never mark a screen built because its file exists.',
    'Code is the source of truth for variables, text styles and component variants: follow skill://appflow/sync-from-code/SKILL.md (sync_design_system or sync_tokens / sync_text_styles / sync_components, dry run first, never prune without the user’s say-so).',
    'Code Connect mappings are stored locally. Cloud-only tools (shaders, generative plugins, Weave, generate_image, create_new_file, generate_figma_design, send_code_to_figma, get_motion_context) are not available.',
].join(' ');

const SKILLS = [
    {
        uri: 'skill://appflow/flow-layout/SKILL.md',
        name: 'flow-layout',
        description: 'Lay out screen flows left to right with the board tools (move_screen, duplicate_screen, connect, reroute_flow); check with lint_flow_layout and describe_board.',
        text: flowLayoutSkill,
    },
    {
        uri: 'skill://appflow/verify-built/SKILL.md',
        name: 'verify-built',
        description: 'Check board screens against their route code and the running app, then record Built / Drift / Not built badges with set_screen_status.',
        text: verifyBuiltSkill,
    },
    {
        uri: 'skill://appflow/sync-from-code/SKILL.md',
        name: 'sync-from-code',
        description: 'Make Figma variables, text styles and component variants match the code design system: dry run, apply, confirm only orphans remain.',
        text: syncFromCodeSkill,
    },
];

/** Prompts that hand the agent a skill's text as a user message. */
const SKILL_PROMPTS = [
    { name: 'flow_layout', description: 'Rules for laying out a screen flow left to right, and the check to run before finishing.', text: flowLayoutSkill },
    { name: 'verify_built', description: 'Check which board screens are built and match the design, and record their Built / Drift / Not built badges.', text: verifyBuiltSkill },
    { name: 'sync_from_code', description: 'Bring Figma variables, text styles and component variants in line with the code design system.', text: syncFromCodeSkill },
];

const userMessage = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

function rulesPrompt(args: { clientLanguages?: string; clientFrameworks?: string }): string {
    const langs = args.clientLanguages ?? 'the project’s languages';
    const frameworks = args.clientFrameworks ?? 'the project’s frameworks';
    return `Create design system rules for turning Figma designs into code in this codebase (${langs}, ${frameworks}).

1. Read the codebase: the UI component folder, theme and token files (colours, spacing, radii, typography), icon set, and styling approach.
2. Read the design system in Figma: call search_design_system for buttons, inputs, list rows, navigation, colours, spacing and type; call get_variable_defs on a typical screen; call get_code_connect_map to see existing mappings.
3. Write a rules file (save it under rules/ or instructions/, or in the agent instructions file) that covers:
   - Which code component to use for each Figma component, and the import path.
   - How Figma variables map to code tokens, with examples. Never hard-code a value that has a token.
   - Typography: which text component or style matches each Figma text style.
   - Icons: the icon library and how Figma icon names map to it.
   - Layout: how Figma auto layout maps to the layout primitives used here.
   - The workflow: get_design_context → get_screenshot → reuse existing components → match tokens → compare against the screenshot.
4. Keep it short and specific to this codebase. Use real file paths and component names.`;
}

/** One appflow server instance. serveStdio calls this once per connection; tests connect it to an in-memory client. */
type Registered = { def: ToolDef; handle: RegisteredTool; schema: string };
/** Each server's registered tools, so syncTools can update them in place. */
const registries = new WeakMap<McpServer, Map<string, Registered>>();

const schemaKey = (def: ToolDef): string => JSON.stringify(z.toJSONSchema(def.inputSchema));

/** The handler reads the current def from the registry, so a reload swaps the code without touching (and re-announcing) the tool. */
function register(server: McpServer, reg: Map<string, Registered>, def: ToolDef, ctx: ToolContext): Registered {
    const handle = server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, (args) => runTool(reg.get(def.name)?.def ?? def, args, ctx));
    return { def, handle, schema: schemaKey(def) };
}

export type ToolChanges = { added: string[]; removed: string[]; updated: string[] };

/**
 * Brings a running server's tools in line with `defs` (a freshly imported tool list): registers new tools, removes gone ones
 * and updates changed descriptions or schemas. Handlers always run the newest def. The SDK sends
 * notifications/tools/list_changed only for real changes, so the client refetches the list without a reconnect.
 */
export function syncTools(server: McpServer, defs: readonly ToolDef[], ctx: ToolContext): ToolChanges {
    const reg = registries.get(server);
    if (!reg) throw new Error('syncTools: server was not made by createServer.');
    const changes: ToolChanges = { added: [], removed: [], updated: [] };
    const wanted = new Set(defs.map((d) => d.name));
    for (const [name, r] of [...reg]) {
        if (wanted.has(name)) continue;
        r.handle.remove();
        reg.delete(name);
        changes.removed.push(name);
    }
    for (const def of defs) {
        const prev = reg.get(def.name);
        if (!prev) {
            reg.set(def.name, register(server, reg, def, ctx));
            changes.added.push(def.name);
            continue;
        }
        const schema = schemaKey(def);
        const changed = prev.def.description !== def.description || prev.schema !== schema;
        reg.set(def.name, { def, handle: prev.handle, schema });
        if (changed) prev.handle.update({ description: def.description, paramsSchema: def.inputSchema });
        if (changed) changes.updated.push(def.name);
    }
    return changes;
}

export function createServer(ctx: ToolContext, tools: readonly ToolDef[] = TOOLS): McpServer {
    const server = new McpServer(
        { name: 'appflow', version: pkg.version },
        { capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} }, instructions: INSTRUCTIONS },
    );

    const reg = new Map<string, Registered>();
    for (const def of tools) reg.set(def.name, register(server, reg, def, ctx));
    registries.set(server, reg);

    for (const skill of SKILLS) {
        server.registerResource(skill.name, skill.uri, { description: skill.description, mimeType: 'text/markdown' }, async (uri) => ({
            contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill.text }],
        }));
    }

    server.registerPrompt(
        'create_design_system_rules',
        {
            description: 'Write a rules file that tells the agent how to turn Figma designs into code for this codebase and design system.',
            argsSchema: z.object({
                clientLanguages: z.string().describe('For example "typescript".').optional(),
                clientFrameworks: z.string().describe('For example "react-native".').optional(),
            }),
        },
        (args) => userMessage(rulesPrompt(args)),
    );
    for (const p of SKILL_PROMPTS) server.registerPrompt(p.name, { description: p.description }, () => userMessage(p.text));

    return server;
}
