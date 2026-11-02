/**
 * figma-local-bridge: an MCP server over stdio that forwards tool calls to the
 * "Local Agent Bridge" Figma plugin over a WebSocket on 127.0.0.1.
 *
 * stdout carries only JSON-RPC. Everything else is logged to stderr.
 */
import type { ServerWebSocket } from 'bun';

import { type Bridge, type BridgeCommand, type BridgeReply, handleRequest, type RpcRequest } from './rpc';

const PORT = Number(process.env.FIGMA_BRIDGE_PORT ?? 3055);
const log = (...parts: unknown[]) => console.error('[figma-local-bridge]', ...parts);

type Pending = { resolve: (reply: BridgeReply) => void; timer: ReturnType<typeof setTimeout> };
type PluginMessage = { id: string; reply: BridgeReply } | { hello: { fileName: string } };

let plugin: ServerWebSocket<undefined> | null = null;
const pending = new Map<string, Pending>();

function settle(id: string, reply: BridgeReply) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(reply);
}

const bridge: Bridge = {
    isConnected: () => plugin !== null,
    send: (cmd: BridgeCommand, timeoutMs: number) =>
        new Promise<BridgeReply>((resolve) => {
            const socket = plugin;
            if (!socket) return resolve({ ok: false, error: 'The Figma plugin disconnected.' });
            const id = crypto.randomUUID();
            const timer = setTimeout(
                () => settle(id, { ok: false, error: `Timed out after ${timeoutMs} ms. The code may still be running in Figma.` }),
                timeoutMs,
            );
            pending.set(id, { resolve, timer });
            socket.send(JSON.stringify({ id, cmd }));
        }),
};

try {
    Bun.serve({
        hostname: '127.0.0.1',
        port: PORT,
        fetch(req, server) {
            if (new URL(req.url).pathname === '/plugin' && server.upgrade(req)) return undefined;
            return new Response('figma-local-bridge', { status: 200 });
        },
        websocket: {
            open(ws) {
                if (plugin && plugin !== ws) plugin.close(1000, 'Replaced by a newer plugin window');
                plugin = ws;
                log('plugin connected');
            },
            message(ws, raw) {
                let msg: PluginMessage;
                try {
                    msg = JSON.parse(String(raw)) as PluginMessage;
                } catch {
                    return;
                }
                if ('hello' in msg) log('file:', msg.hello.fileName);
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
    const res = await handleRequest(req, bridge);
    if (res) write(res);
}

let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void onLine(line);
        newline = buffer.indexOf('\n');
    }
}
process.exit(0);
