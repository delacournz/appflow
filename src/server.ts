/**
 * appflow: an MCP server over stdio that forwards tool calls to the
 * "AppFlow" Figma plugin over a WebSocket on 127.0.0.1. Several sessions
 * share the port: see bridge.ts.
 *
 * stdout carries only JSON-RPC. Everything else is logged to stderr.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { startBridge } from './bridge';
import { readExpectedBuild, stalePlugin, STALE_FIX } from './build';
import { handleRequest, type RpcRequest } from './rpc';
import { CodeConnectStore } from './store';
import type { ToolContext } from './tools';

const PORT = Number(process.env.APPFLOW_PORT ?? process.env.FIGMA_BRIDGE_PORT ?? 3055);
const HOME = process.env.APPFLOW_HOME ?? process.env.FIGMA_BRIDGE_HOME ?? join(homedir(), '.appflow');
const log = (...parts: unknown[]) => console.error('[appflow]', ...parts);

const BUILD_JSON = new URL('../plugin/build.json', import.meta.url).pathname;
let expectedBuild = await readExpectedBuild(BUILD_JSON);

const bridge = startBridge({
    port: PORT,
    log,
    async onHello(hello) {
        expectedBuild = await readExpectedBuild(BUILD_JSON);
        const build = hello.build ?? null;
        log('file:', hello.fileName, `(${hello.editorType})`, 'build:', build ?? 'unknown');
        if (stalePlugin(expectedBuild, build)) log(`plugin build ${build ?? 'unknown'} differs from expected ${expectedBuild}. ${STALE_FIX}`);
    },
});

const ctx: ToolContext = {
    connected: bridge.connected,
    plugin: bridge.call,
    store: new CodeConnectStore(join(HOME, 'code-connect.json')),
    downloadDir: join(HOME, 'downloads'),
    get expectedBuild() {
        return expectedBuild;
    },
    pluginBuild: bridge.pluginBuild,
};

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
bridge.stop();
process.exit(0);
