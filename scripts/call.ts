/**
 * One-shot CLI: joins the plugin socket (as leader, or through a running AppFlow server), waits for the plugin, runs one tool and prints the result.
 * Usage: bun run scripts/call.ts <tool> [json-args | @file.json] [--file <fileKey | figma URL | name>]
 * With several Figma files running AppFlow, --file (or "file" in the args) picks one.
 * Images are written to $APPFLOW_HOME/cli/ and their paths printed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { startBridge } from '../src/bridge';
import { CodeConnectStore } from '../src/store';
import { callTool, type ToolContext } from '../src/tools';

const argv = process.argv.slice(2);
const fileFlag = argv.indexOf('--file');
const file = fileFlag >= 0 ? argv[fileFlag + 1] : undefined;
const [tool, raw] = fileFlag >= 0 ? argv.filter((_, i) => i !== fileFlag && i !== fileFlag + 1) : argv;
if (!tool) {
    console.error('Usage: bun run scripts/call.ts <tool> [json-args | @file.json] [--file <fileKey | figma URL | name>]');
    process.exit(2);
}
const parsed: unknown = raw ? JSON.parse(raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw) : {};
const args: unknown = file === undefined ? parsed : { ...(parsed as object), file };
const PORT = Number(process.env.APPFLOW_PORT ?? process.env.FIGMA_BRIDGE_PORT ?? 3055);
const HOME = process.env.APPFLOW_HOME ?? process.env.FIGMA_BRIDGE_HOME ?? join(homedir(), '.appflow');

const bridge = startBridge({ port: PORT, log: (...parts) => console.error('[appflow]', ...parts) });

const ctx: ToolContext = {
    files: bridge.files,
    plugin: bridge.call,
    session: { pinned: null },
    store: new CodeConnectStore(join(HOME, 'code-connect.json')),
    downloadDir: join(HOME, 'downloads'),
};

/** Waits for the first plugin window, then (as leader) gives the other windows time to reconnect: they retry every 2 s. */
const deadline = Date.now() + 10_000;
while (bridge.files().length === 0 && Date.now() < deadline) await Bun.sleep(50);
if (bridge.role() === 'leader') await Bun.sleep(2500);

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
bridge.stop();
process.exit(result.isError ? 1 : 0);
