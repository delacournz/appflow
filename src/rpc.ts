/**
 * The MCP side of the bridge: JSON-RPC requests in, responses out. Knows
 * nothing about sockets; it talks to the Figma plugin through `Bridge`.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type RpcRequest = {
    jsonrpc: '2.0';
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
};

export type RpcResponse = {
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: { code: number; message: string };
};

/** What the server asks the plugin to do. */
export type BridgeCommand =
    | { type: 'status' }
    | { type: 'run'; code: string }
    | { type: 'screenshot'; nodeId: string; scale: number };

/** What the plugin answers. `image` is base64 PNG, only for screenshots. */
export type BridgeReply =
    | { ok: true; result: JsonValue; logs?: string[]; image?: string }
    | { ok: false; error: string };

export interface Bridge {
    isConnected(): boolean;
    send(cmd: BridgeCommand, timeoutMs: number): Promise<BridgeReply>;
}

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' };
type ToolResult = { content: ToolContent[]; isError?: boolean };

const SERVER_INFO = { name: 'figma-local-bridge', version: '0.1.0' };
const DEFAULT_TIMEOUT_MS = 60_000;

const INSTRUCTIONS = [
    'Runs Figma Plugin API code in the Figma desktop file where the "Local Agent Bridge" plugin is open.',
    'Call figma_status first. Code runs like a plugin with documentAccess "dynamic-page": use async APIs',
    '(figma.getNodeByIdAsync, await figma.setCurrentPageAsync(page), node.setReactionsAsync).',
    'Colors are 0-1. Load fonts before editing text. Return node IDs you create or change.',
].join(' ');

const TOOLS = [
    {
        name: 'figma_status',
        description: 'Whether the Local Agent Bridge plugin is connected, and the open file, current page and selection.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'figma_run',
        description:
            'Run JavaScript against the Figma Plugin API in the open file. The code is the body of an async function: top-level await and `return` work. `figma` is in scope. Returns the JSON of the returned value and any console.log lines. Nodes in the result are reduced to {id, type, name}.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Plugin API JavaScript. Use `return` to send data back.' },
                timeoutMs: { type: 'number', description: `Default ${DEFAULT_TIMEOUT_MS}.` },
            },
            required: ['code'],
            additionalProperties: false,
        },
    },
    {
        name: 'figma_screenshot',
        description: 'Export a node as a PNG and return the image.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'Node ID such as "193:443".' },
                scale: { type: 'number', description: 'Export scale, 0.1 to 4. Default 1.' },
            },
            required: ['nodeId'],
            additionalProperties: false,
        },
    },
];

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

const NOT_CONNECTED =
    'The Figma plugin is not connected. In the Figma desktop app, open the file and run Plugins → Development → Local Agent Bridge, then try again.';

async function callTool(name: string, args: Record<string, unknown>, bridge: Bridge): Promise<ToolResult> {
    if (!TOOLS.some((t) => t.name === name)) return text(`Unknown tool: ${name}`, true);
    if (!bridge.isConnected()) return text(NOT_CONNECTED, true);

    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
    let cmd: BridgeCommand;
    switch (name) {
        case 'figma_run':
            if (typeof args.code !== 'string' || args.code.trim() === '') return text('`code` is required.', true);
            cmd = { type: 'run', code: args.code };
            break;
        case 'figma_screenshot': {
            if (typeof args.nodeId !== 'string' || args.nodeId === '') return text('`nodeId` is required.', true);
            const scale = typeof args.scale === 'number' ? Math.min(4, Math.max(0.1, args.scale)) : 1;
            cmd = { type: 'screenshot', nodeId: args.nodeId, scale };
            break;
        }
        default:
            cmd = { type: 'status' };
    }

    const reply = await bridge.send(cmd, timeoutMs);
    if (!reply.ok) return text(reply.error, true);
    if (cmd.type === 'screenshot' && reply.image) {
        return {
            content: [
                { type: 'image', data: reply.image, mimeType: 'image/png' },
                { type: 'text', text: JSON.stringify(reply.result) },
            ],
        };
    }
    const body = cmd.type === 'run' ? { result: reply.result, logs: reply.logs ?? [] } : reply.result;
    return text(JSON.stringify(body, null, 2));
}

/** Handles one JSON-RPC message. Returns `null` for notifications, which get no response. */
export async function handleRequest(req: RpcRequest, bridge: Bridge): Promise<RpcResponse | null> {
    if (req.id === undefined) return null;
    const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id: req.id as string | number, result });

    switch (req.method) {
        case 'initialize': {
            const requested = req.params?.protocolVersion;
            return reply({
                protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
                instructions: INSTRUCTIONS,
            });
        }
        case 'ping':
            return reply({});
        case 'tools/list':
            return reply({ tools: TOOLS });
        case 'tools/call': {
            const name = typeof req.params?.name === 'string' ? req.params.name : '';
            const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
            try {
                return reply(await callTool(name, args, bridge));
            } catch (error) {
                return reply(text(error instanceof Error ? error.message : String(error), true));
            }
        }
        default:
            return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
    }
}
