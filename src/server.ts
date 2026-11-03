/**
 * appflow: an MCP server over stdio that forwards tool calls to the
 * "AppFlow" Figma plugin over a WebSocket on 127.0.0.1. Several sessions
 * share the port: see bridge.ts.
 *
 * stdout carries only MCP messages (via the SDK's stdio transport).
 * Everything else is logged to stderr.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { startBridge } from './bridge';
import { readExpectedBuild, stalePlugin, STALE_FIX } from './build';
import { createServer } from './mcp';
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

const handle = serveStdio(() => createServer(ctx), { onerror: (error) => log('mcp:', error.message) });

let stopping = false;
/** Ends the MCP connection and frees the plugin port. Runs once, on stdin EOF or a signal. */
async function shutdown() {
    if (stopping) return;
    stopping = true;
    await handle.close().catch((error: unknown) => log('close:', error));
    bridge.stop();
    process.exit(0);
}

process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
