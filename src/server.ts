/**
 * appflow: an MCP server over stdio that forwards tool calls to the
 * "AppFlow" Figma plugin over a WebSocket on 127.0.0.1.
 *
 * stdout carries only JSON-RPC. Everything else is logged to stderr.
 */
import type { ServerWebSocket } from 'bun';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ClientMessage, JsonObject, PluginReply, ServerMessage } from '../shared/protocol';
import { readExpectedBuild, stalePlugin, STALE_FIX } from './build';
import { handleRequest, type RpcRequest } from './rpc';
import { CodeConnectStore } from './store';
import type { ToolContext } from './tools';

const PORT = Number(process.env.APPFLOW_PORT ?? process.env.FIGMA_BRIDGE_PORT ?? 3055);
const HOME = process.env.APPFLOW_HOME ?? process.env.FIGMA_BRIDGE_HOME ?? join(homedir(), '.appflow');
const log = (...parts: unknown[]) => console.error('[appflow]', ...parts);

type Pending = { resolve: (reply: PluginReply) => void; timer: ReturnType<typeof setTimeout> };

let plugin: ServerWebSocket<undefined> | null = null;
let pluginBuild: string | null = null;
const BUILD_JSON = new URL('../plugin/build.json', import.meta.url).pathname;
let expectedBuild = await readExpectedBuild(BUILD_JSON);
const pending = new Map<string, Pending>();

function settle(id: string, reply: PluginReply) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(reply);
}

const ctx: ToolContext = {
    connected: () => plugin !== null,
    plugin: (tool: string, args: JsonObject, timeoutMs: number) =>
        new Promise<PluginReply>((resolve) => {
            const socket = plugin;
            if (!socket) return resolve({ ok: false, error: 'The Figma plugin disconnected.' });
            const id = crypto.randomUUID();
            const timer = setTimeout(() => settle(id, { ok: false, error: `Timed out after ${timeoutMs} ms. The work may still be running in Figma.` }), timeoutMs);
            pending.set(id, { resolve, timer });
            const msg: ServerMessage = { id, cmd: { tool, args } };
            socket.send(JSON.stringify(msg));
        }),
    store: new CodeConnectStore(join(HOME, 'code-connect.json')),
    downloadDir: join(HOME, 'downloads'),
    get expectedBuild() {
        return expectedBuild;
    },
    pluginBuild: () => pluginBuild,
};

try {
    Bun.serve({
        hostname: '127.0.0.1',
        port: PORT,
        fetch(req, server) {
            if (new URL(req.url).pathname === '/plugin' && server.upgrade(req)) return undefined;
            return new Response('appflow', { status: 200 });
        },
        websocket: {
            maxPayloadLength: 256 * 1024 * 1024,
            open(ws) {
                if (plugin && plugin !== ws) plugin.close(1000, 'Replaced by a newer plugin window');
                plugin = ws;
                pluginBuild = null;
                log('plugin connected');
            },
            async message(_ws, raw) {
                let msg: ClientMessage;
                try {
                    msg = JSON.parse(String(raw)) as ClientMessage;
                } catch {
                    return;
                }
                if ('hello' in msg) {
                    pluginBuild = msg.hello.build ?? null;
                    expectedBuild = await readExpectedBuild(BUILD_JSON);
                    log('file:', msg.hello.fileName, `(${msg.hello.editorType})`, 'build:', pluginBuild ?? 'unknown');
                    if (stalePlugin(expectedBuild, pluginBuild)) log(`plugin build ${pluginBuild ?? 'unknown'} differs from expected ${expectedBuild}. ${STALE_FIX}`);
                }
                else settle(msg.id, msg.reply);
            },
            close(ws) {
                if (plugin !== ws) return;
                plugin = null;
                log('plugin disconnected');
                for (const id of [...pending.keys()]) settle(id, { ok: false, error: 'The Figma plugin disconnected.' });
            },
        },
    });
    log(`listening on ws://127.0.0.1:${PORT}/plugin`);
} catch (error) {
    log(`could not listen on port ${PORT}; is another session running the bridge?`, error);
}

const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function onLine(line: string) {
    if (line.trim() === '') return;
    let req: RpcRequest;
    try {
        req = JSON.parse(line) as RpcRequest;
    } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
    }
    const res = await handleRequest(req, ctx);
    if (res) write(res);
}

const inFlight = new Set<Promise<void>>();
let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const job = onLine(line).finally(() => inFlight.delete(job));
        inFlight.add(job);
        newline = buffer.indexOf('\n');
    }
}
await Promise.allSettled([...inFlight]);
process.exit(0);
