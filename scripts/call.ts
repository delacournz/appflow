/**
 * One-shot CLI: hosts the plugin socket, waits for the plugin to connect, runs one tool and prints the result.
 * Usage: bun run scripts/call.ts <tool> [json-args | @file.json]
 * Images are written to $APPFLOW_HOME/cli/ and their paths printed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ClientMessage, PluginReply, ServerMessage } from '../shared/protocol';
import { CodeConnectStore } from '../src/store';
import { callTool, type ToolContext } from '../src/tools';

const [tool, raw] = process.argv.slice(2);
if (!tool) {
    console.error('Usage: bun run scripts/call.ts <tool> [json-args | @file.json]');
    process.exit(2);
}
const args: unknown = raw ? JSON.parse(raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw) : {};
const PORT = Number(process.env.APPFLOW_PORT ?? process.env.FIGMA_BRIDGE_PORT ?? 3055);
const HOME = process.env.APPFLOW_HOME ?? process.env.FIGMA_BRIDGE_HOME ?? join(homedir(), '.appflow');

const pending = new Map<string, (r: PluginReply) => void>();
let socket: import('bun').ServerWebSocket<undefined> | null = null;
let onConnect: () => void = () => {};
const connected = new Promise<void>((resolve) => (onConnect = resolve));

const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('appflow cli')),
    websocket: {
        maxPayloadLength: 256 * 1024 * 1024,
        open(ws) {
            socket = ws;
            onConnect();
        },
        message(_ws, data) {
            const msg = JSON.parse(String(data)) as ClientMessage;
            if (!('hello' in msg)) pending.get(msg.id)?.(msg.reply);
        },
    },
});

const ctx: ToolContext = {
    connected: () => socket !== null,
    plugin: (name, a, timeoutMs) =>
        new Promise((resolve) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => resolve({ ok: false, error: `Timed out after ${timeoutMs} ms.` }), timeoutMs);
            pending.set(id, (r) => {
                clearTimeout(timer);
                resolve(r);
            });
            const msg: ServerMessage = { id, cmd: { tool: name, args: a } };
            socket?.send(JSON.stringify(msg));
        }),
    store: new CodeConnectStore(join(HOME, 'code-connect.json')),
    downloadDir: join(HOME, 'downloads'),
};

await Promise.race([connected, Bun.sleep(10_000)]);
const result = await callTool(tool, args, ctx);
const dir = join(HOME, 'cli');
for (const [i, c] of result.content.entries()) {
    if (c.type === 'text') console.log(c.text);
    else {
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${tool}-${Date.now()}-${i}.png`);
        await writeFile(path, Buffer.from(c.data, 'base64'));
        console.log(`[image] ${path}`);
    }
}
server.stop(true);
process.exit(result.isError ? 1 : 0);
