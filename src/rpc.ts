/** JSON-RPC for MCP over stdio: initialize, tools and prompts. Sockets live in server.ts. */
import type { JsonObject } from '../shared/protocol';
import flowLayoutSkill from './skills/flow-layout.md' with { type: 'text' };
import { runTool, TOOLS, type ToolContext } from './tools';

export type RpcRequest = { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };
export type RpcResponse = { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string } };

const SERVER_INFO = { name: 'figma-local-bridge', version: '0.2.0' };

const INSTRUCTIONS = [
    'Local Figma tools with the same names as the Figma MCP server, run through the "Local Agent Bridge" plugin in the Figma desktop app.',
    'Call figma_status first. Most tools default to the current selection when nodeId is omitted.',
    'use_figma runs Plugin API code with documentAccess "dynamic-page": use async APIs (getNodeByIdAsync, setCurrentPageAsync, setReactionsAsync). Colours are 0-1. Load fonts before editing text.',
    'Screen flows read left to right: the main path goes right, branches go straight down, overlays and entry points straight up; arrows never point or run left; move the target screen rather than bending an arrow back. Read skill://figma-bridge/flow-layout/SKILL.md before laying out a flow, and run lint_flow_layout before you finish.',
    'Code Connect mappings are stored locally. Cloud-only tools (shaders, generative plugins, Weave, generate_image, create_new_file, generate_figma_design, send_code_to_figma, get_motion_context) are not available.',
].join(' ');

const SKILLS = [
    {
        uri: 'skill://figma-bridge/flow-layout/SKILL.md',
        name: 'flow-layout',
        description: 'Lay out screen flows left to right with no arrows going back on themselves; check with lint_flow_layout.',
        mimeType: 'text/markdown',
        text: flowLayoutSkill,
    },
];

const PROMPTS = [
    {
        name: 'create_design_system_rules',
        description: 'Write a rules file that tells the agent how to turn Figma designs into code for this codebase and design system.',
        arguments: [
            { name: 'clientLanguages', description: 'For example "typescript".', required: false },
            { name: 'clientFrameworks', description: 'For example "react-native".', required: false },
        ],
    },
    {
        name: 'flow_layout',
        description: 'Rules for laying out a screen flow left to right, and the check to run before finishing.',
        arguments: [],
    },
];

function rulesPrompt(args: Record<string, unknown>): string {
    const langs = typeof args.clientLanguages === 'string' ? args.clientLanguages : 'the project’s languages';
    const frameworks = typeof args.clientFrameworks === 'string' ? args.clientFrameworks : 'the project’s frameworks';
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

export async function handleRequest(req: RpcRequest, ctx: ToolContext): Promise<RpcResponse | null> {
    if (req.id === undefined) return null;
    const id = req.id;
    const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    const params = req.params ?? {};

    switch (req.method) {
        case 'initialize':
            return reply({
                protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
                capabilities: { tools: {}, prompts: {}, resources: {} },
                serverInfo: SERVER_INFO,
                instructions: INSTRUCTIONS,
            });
        case 'ping':
            return reply({});
        case 'tools/list':
            return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
            const name = typeof params.name === 'string' ? params.name : '';
            const args = (params.arguments ?? {}) as JsonObject;
            return reply(await runTool(name, args, ctx));
        }
        case 'prompts/list':
            return reply({ prompts: PROMPTS });
        case 'resources/list':
            return reply({ resources: SKILLS.map(({ text: _text, ...r }) => r) });
        case 'resources/templates/list':
            return reply({ resourceTemplates: [] });
        case 'resources/read': {
            const skill = SKILLS.find((r) => r.uri === params.uri);
            if (!skill) return { jsonrpc: '2.0', id, error: { code: -32002, message: `Resource not found: ${String(params.uri)}` } };
            return reply({ contents: [{ uri: skill.uri, mimeType: skill.mimeType, text: skill.text }] });
        }
        case 'prompts/get': {
            if (params.name === 'flow_layout') {
                return reply({ description: 'Flow layout rules', messages: [{ role: 'user', content: { type: 'text', text: flowLayoutSkill } }] });
            }
            if (params.name !== 'create_design_system_rules') return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${String(params.name)}` } };
            const text = rulesPrompt((params.arguments ?? {}) as Record<string, unknown>);
            return reply({ description: PROMPTS.find((p) => p.name === 'create_design_system_rules')?.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
        }
        default:
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
}
