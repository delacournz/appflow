/**
 * appflow: an MCP server over stdio that forwards tool calls to the
 * "AppFlow" Figma plugin over a WebSocket on 127.0.0.1. Several sessions
 * share the port: see bridge.ts.
 *
 * stdout carries only MCP messages (via the SDK's stdio transport).
 * Everything else is logged to stderr.
 */
import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { startBridge } from './bridge';
import { readExpectedBuild, stalePlugin, STALE_FIX } from './build';
import { createServer, syncTools } from './mcp';
import { CodeConnectStore } from './store';
import { TOOLS, type ToolContext, type ToolDef } from './tools';
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
        log('file:', hello.fileName, `(${hello.editorType})`, 'key:', hello.fileKey ?? 'none', 'build:', build ?? 'unknown');
        if (stalePlugin(expectedBuild, build)) log(`plugin build ${build ?? 'unknown'} differs from expected ${expectedBuild}. ${STALE_FIX}`);
    },
});

const ctx: ToolContext = {
    files: bridge.files,
    plugin: bridge.call,
    session: { pinned: null },
    store: new CodeConnectStore(join(HOME, 'code-connect.json')),
    downloadDir: join(HOME, 'downloads'),
    get expectedBuild() {
        return expectedBuild;
    },
};

const servers = new Set<McpServer>();
let liveTools: readonly ToolDef[] = TOOLS;
const handle = serveStdio(
    () => {
        const server = createServer(ctx, liveTools);
        servers.add(server);
        return server;
    },
    { onerror: (error) => log('mcp:', error.message) },
);

/**
 * Every `bun run build` rewrites plugin/build.json. Re-import the tool list then (cache-busted) and sync it into the running
 * servers, which notify the client with tools/list_changed, so new or changed tools appear without /mcp. Only tools.ts is
 * re-read; a change to a module it imports still needs a restart.
 */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
async function reloadTools(): Promise<void> {
    try {
        const mod = (await import(`./tools.ts?v=${Date.now()}`)) as { TOOLS: ToolDef[] };
        liveTools = mod.TOOLS;
        for (const server of servers) {
            const c = syncTools(server, liveTools, ctx);
            if (c.added.length || c.removed.length || c.updated.length) log('tools reloaded:', JSON.stringify(c));
        }
    } catch (error) {
        log('tool reload failed:', error instanceof Error ? error.message : error);
    }
}
const watcher = watch(dirname(BUILD_JSON), (_event, file) => {
    if (file !== 'build.json') return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadTools(), 300);
});


let stopping = false;
/** Ends the MCP connection and frees the plugin port. Runs once, on stdin EOF or a signal. */
async function shutdown() {
    if (stopping) return;
    stopping = true;
    watcher.close();
    await handle.close().catch((error: unknown) => log('close:', error));
    bridge.stop();
    process.exit(0);
}

process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
