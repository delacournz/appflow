import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { JsonObject, PluginReply } from '../shared/protocol';
import { createServer } from './mcp';
import { CodeConnectStore } from './store';
import { callTool, type ToolContext } from './tools';

type Call = { tool: string; args: JsonObject; timeoutMs: number };
type Content = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = { content: Content[]; isError?: boolean };
type ListedTool = { name: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } };

let dir: string;
const clients = new Map<ToolContext, Promise<Client>>();
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appflow-'));
});
afterEach(async () => {
    for (const c of clients.values()) await (await c).close();
    clients.clear();
    await rm(dir, { recursive: true, force: true });
});

function ctx(replies: Record<string, PluginReply>, connected = true): ToolContext & { calls: Call[] } {
    const calls: Call[] = [];
    return {
        calls,
        connected: () => connected,
        plugin: async (tool, args, timeoutMs) => {
            calls.push({ tool, args, timeoutMs });
            return replies[tool] ?? { ok: false, error: `no fake for ${tool}` };
        },
        store: new CodeConnectStore(join(dir, 'code-connect.json')),
        downloadDir: join(dir, 'downloads'),
    };
}

/** An SDK client connected in memory to a fresh appflow server for this context. */
function client(c: ToolContext = ctx({})): Promise<Client> {
    const existing = clients.get(c);
    if (existing) return existing;
    const made = (async () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await createServer(c).connect(serverSide);
        const mc = new Client({ name: 'appflow-test', version: '0.0.0' });
        await mc.connect(clientSide);
        return mc;
    })();
    clients.set(c, made);
    return made;
}

async function call(name: string, args: JsonObject, c: ToolContext): Promise<ToolResult> {
    return (await (await client(c)).callTool({ name, arguments: args })) as ToolResult;
}

async function listTools(): Promise<ListedTool[]> {
    return (await (await client()).listTools()).tools;
}

const json = (r: ToolResult, i = 0) => JSON.parse(r.content[i]?.text ?? 'null');
const promptText = (r: { messages: { content: { type: string; text?: string } }[] }) => r.messages[0]?.content.text ?? '';

describe('protocol', () => {
    test('initialize reports appflow with tools, prompts, resources and instructions', async () => {
        const mc = await client();
        expect(mc.getServerVersion()?.name).toBe('appflow');
        expect(mc.getServerCapabilities()).toMatchObject({ tools: {}, prompts: {}, resources: {} });
        expect(mc.getInstructions()).toContain('figma_status');
    });

    test('an unknown tool is rejected as invalid params', async () => {
        await expect((await client()).callTool({ name: 'create_shader', arguments: {} })).rejects.toMatchObject({ code: -32602 });
    });

    test('invalid arguments are a tool error and never reach the plugin', async () => {
        const c = ctx({ use_figma: { ok: true, result: null } });
        const r = await call('use_figma', { timeoutMs: 5 }, c);
        expect(r.isError).toBe(true);
        expect(r.content[0]?.text).toContain('code');
        expect(c.calls).toEqual([]);
    });

    test('tools/list uses the official tool names', async () => {
        const names = (await listTools()).map((t) => t.name);
        for (const n of [
            'figma_status',
            'whoami',
            'get_metadata',
            'get_screenshot',
            'get_design_context',
            'get_variable_defs',
            'get_figjam',
            'search_design_system',
            'get_libraries',
            'download_assets',
            'upload_assets',
            'use_figma',
            'html_to_figma',
            'generate_diagram',
            'get_context_for_code_connect',
            'get_code_connect_suggestions',
            'get_code_connect_map',
            'add_code_connect_map',
            'send_code_connect_mappings',
        ]) {
            expect(names).toContain(n);
        }
    });

    test('flow layout: instructions, tool, skill resource and prompt', async () => {
        const mc = await client();
        expect(mc.getInstructions()).toContain('left to right');
        expect(mc.getInstructions()).toContain('lint_flow_layout');
        expect((await listTools()).map((t) => t.name)).toContain('lint_flow_layout');

        const uri = (await mc.listResources()).resources[0]?.uri ?? '';
        expect(uri).toBe('skill://appflow/flow-layout/SKILL.md');
        const content = (await mc.readResource({ uri })).contents[0];
        expect(content?.mimeType).toBe('text/markdown');
        expect(content && 'text' in content ? content.text : '').toContain('left to right');
        await expect(mc.readResource({ uri: 'skill://nope' })).rejects.toBeDefined();

        expect((await mc.listPrompts()).prompts.map((p) => p.name)).toContain('flow_layout');
        expect(promptText(await mc.getPrompt({ name: 'flow_layout' }))).toContain('lint_flow_layout');
    });

    test('verify built: instructions, tools, skill resource and prompt', async () => {
        const mc = await client();
        expect(mc.getInstructions()).toContain('verify-built');
        const names = (await listTools()).map((t) => t.name);
        expect(names).toContain('set_screen_status');
        expect(names).toContain('badge_screens');
        const uri = 'skill://appflow/verify-built/SKILL.md';
        expect((await mc.listResources()).resources.map((r) => r.uri)).toContain(uri);
        const content = (await mc.readResource({ uri })).contents[0];
        expect(content && 'text' in content ? content.text : '').toContain('set_screen_status');
        expect(promptText(await mc.getPrompt({ name: 'verify_built' }))).toContain('set_screen_status');
    });

    test('prompts: create_design_system_rules', async () => {
        const mc = await client();
        const listed = (await mc.listPrompts()).prompts;
        expect(listed[0]?.name).toBe('create_design_system_rules');
        expect(listed[0]?.arguments?.map((a) => a.name)).toEqual(['clientLanguages', 'clientFrameworks']);
        const text = promptText(await mc.getPrompt({ name: 'create_design_system_rules', arguments: { clientFrameworks: 'react-native' } }));
        expect(text).toContain('react-native');
        expect(text).toContain('search_design_system');
    });
});

describe('tools', () => {
    test('fail clearly when the plugin is not open', async () => {
        const r = await call('use_figma', { code: 'x' }, ctx({}, false));
        expect(r.isError).toBe(true);
        expect(r.content[0]?.text).toContain('AppFlow');
    });

    test('figma_status explains how to connect instead of failing', async () => {
        const r = await call('figma_status', {}, ctx({}, false));
        expect(r.isError).toBeUndefined();
        expect(json(r)).toMatchObject({ connected: false });
    });

    test('use_figma returns the result and logs', async () => {
        const c = ctx({ use_figma: { ok: true, result: { count: 2 }, logs: ['hello'] } });
        const r = await call('use_figma', { code: 'return 1', timeoutMs: 5000 }, c);
        expect(c.calls[0]).toEqual({ tool: 'use_figma', args: { code: 'return 1', timeoutMs: 5000 }, timeoutMs: 5000 });
        expect(json(r)).toEqual({ result: { count: 2 }, logs: ['hello'] });
    });

    test('a plugin error is a tool error', async () => {
        const r = await call('get_metadata', {}, ctx({ get_metadata: { ok: false, error: 'boom' } }));
        expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    });

    test('get_screenshot returns an image', async () => {
        const r = await call('get_screenshot', { nodeId: '1:2' }, ctx({ get_screenshot: { ok: true, result: { width: 10 }, images: ['iVBORw=='] } }));
        expect(r.content[0]).toEqual({ type: 'image', data: 'iVBORw==', mimeType: 'image/png' });
    });

    test('get_design_context returns code, context and the screenshot', async () => {
        const c = ctx({ get_design_context: { ok: true, result: { framework: 'React + Tailwind', code: '<div />', variables: { a: '#fff' } }, images: ['png'] } });
        const r = await call('get_design_context', { nodeId: '1:2' }, c);
        expect(r.content[0]?.text).toContain('```tsx\n<div />');
        expect(r.content.some((x) => x.type === 'image')).toBe(true);
    });

    test('download_assets writes the files and returns their paths', async () => {
        const c = ctx({
            download_assets: { ok: true, result: { assets: [{ nodeId: '1:2', file: 'a.png' }] }, files: [{ name: 'a.png', mime: 'image/png', base64: btoa('PNGDATA') }] },
        });
        const out = join(dir, 'out');
        const r = await call('download_assets', { nodeIds: ['1:2'], outDir: out }, c);
        expect(await readFile(join(out, 'a.png'), 'utf8')).toBe('PNGDATA');
        expect(json(r).files).toEqual([join(out, 'a.png')]);
    });

    test('upload_assets reads files, sends SVG as text, rejects unknown types', async () => {
        await writeFile(join(dir, 'icon.svg'), '<svg/>');
        await writeFile(join(dir, 'pic.png'), 'PNG');
        await writeFile(join(dir, 'doc.txt'), 'x');
        const c = ctx({ upload_assets: { ok: true, result: { created: [] } } });
        await call('upload_assets', { files: [join(dir, 'icon.svg'), join(dir, 'pic.png')], nodeId: '1:2' }, c);
        expect(c.calls[0]?.args).toEqual({
            nodeId: '1:2',
            files: [
                { name: 'icon.svg', mime: 'image/svg+xml', text: '<svg/>' },
                { name: 'pic.png', mime: 'image/png', base64: btoa('PNG') },
            ],
        });
        const bad = await call('upload_assets', { files: [join(dir, 'doc.txt')] }, c);
        expect(bad.isError).toBe(true);
    });

    test('html_to_figma reads a file path and sends the html to the plugin', async () => {
        await writeFile(join(dir, 'page.html'), '<h1>Hi</h1>');
        const c = ctx({ html_to_figma: { ok: true, result: { id: '9:9' } } });
        await call('html_to_figma', { path: join(dir, 'page.html'), width: 390 }, c);
        expect(c.calls[0]?.args).toEqual({ html: '<h1>Hi</h1>', width: 390 });
    });

    test('Code Connect: add a mapping, then read it back for instances and drop it from suggestions', async () => {
        const c = ctx({
            resolve_component: { ok: true, result: { key: 'K1', name: 'Button', nodeId: '23:4049', type: 'COMPONENT_SET' } },
            component_refs: {
                ok: true,
                result: {
                    instances: [{ nodeId: '5:1', layer: 'Send code', componentKey: 'K1', componentName: 'Button' }],
                    components: [
                        { key: 'K1', name: 'Button', nodeId: '23:4049' },
                        { key: 'K2', name: 'Field', nodeId: '27:4069' },
                    ],
                },
            },
        });
        await call('add_code_connect_map', { nodeId: '5:1', source: 'src/components/ui/button.tsx', componentName: 'Button' }, c);
        const map = json(await call('get_code_connect_map', {}, c));
        expect(map.mapped['5:1']).toMatchObject({ componentName: 'Button', source: 'src/components/ui/button.tsx', figmaComponent: 'Button' });
        const suggestions = json(await call('get_code_connect_suggestions', {}, c));
        expect(suggestions.unmapped.map((x: { name: string }) => x.name)).toEqual(['Field']);
    });

    test('send_code_connect_mappings stores several', async () => {
        const c = ctx({ resolve_component: { ok: true, result: { key: 'K9', name: 'Card', nodeId: '1:1', type: 'COMPONENT' } } });
        const r = await call('send_code_connect_mappings', { mappings: [{ nodeId: '1:1', source: 'card.tsx', componentName: 'Card' }] }, c);
        expect(json(r).saved).toBe(1);
        expect(Object.keys(await c.store.all())).toEqual(['K9']);
    });
});

describe('screenshot targets and build handshake', () => {
    test('get_screenshot schema accepts nodeIds and region', async () => {
        const tools = await listTools();
        const shot = tools.find((t) => t.name === 'get_screenshot');
        expect(Object.keys(shot?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['nodeId', 'nodeIds', 'region', 'maxDimension', 'scale']));
    });

    test('get_screenshot forwards nodeIds and region to the plugin', async () => {
        const c = ctx({ get_screenshot: { ok: true, result: {}, images: ['png'] } });
        await call('get_screenshot', { nodeIds: ['1:2', '1:3'] }, c);
        await call('get_screenshot', { region: { x: 0, y: 0, width: 10, height: 10 } }, c);
        expect(c.calls.map((x) => x.args)).toEqual([{ nodeIds: ['1:2', '1:3'] }, { region: { x: 0, y: 0, width: 10, height: 10 } }]);
    });

    test('figma_status reports stale when the plugin build differs', async () => {
        const c = { ...ctx({ figma_status: { ok: true, result: { file: 'x' } } }), expectedBuild: 'new11111', pluginBuild: () => 'old22222' };
        expect(json(await call('figma_status', {}, c))).toMatchObject({ connected: true, stale: true, fix: 'Re-run Plugins → Development → AppFlow', expectedBuild: 'new11111', pluginBuild: 'old22222' });
    });

    test('figma_status has no stale flag when builds match', async () => {
        const c = { ...ctx({ figma_status: { ok: true, result: { file: 'x' } } }), expectedBuild: 'same', pluginBuild: () => 'same' };
        expect(json(await call('figma_status', {}, c)).stale).toBeUndefined();
    });

    test('figma_status without an expected build is unchanged', async () => {
        const r = json(await call('figma_status', {}, ctx({ figma_status: { ok: true, result: { file: 'x' } } })));
        expect(r.stale).toBeUndefined();
    });
});

describe('duplicate_screen', () => {
    test('is listed with its required args and forwards to the plugin', async () => {
        const tools = await listTools();
        const t = tools.find((x) => x.name === 'duplicate_screen');
        expect(t?.inputSchema.required).toEqual(['id', 'col', 'row', 'name']);
        expect(Object.keys(t?.inputSchema.properties ?? {})).toEqual(['id', 'col', 'row', 'name', 'route', 'banner']);
        const c = ctx({ duplicate_screen: { ok: true, result: { id: '9:9', bannerUpdated: true } } });
        expect(json(await call('duplicate_screen', { id: '1:1', col: 2, row: 0, name: 'X' }, c))).toEqual({ id: '9:9', bannerUpdated: true });
        expect(c.calls.map((x) => x.tool)).toEqual(['duplicate_screen']);
    });
});

describe('board grid tools', () => {
    test('are listed with their required args', async () => {
        const tools = await listTools();
        const by = (n: string) => tools.find((t) => t.name === n);
        expect(by('create_board')?.inputSchema.required).toEqual(['name']);
        expect(Object.keys(by('create_board')?.inputSchema.properties ?? {})).toEqual(['name', 'x', 'y', 'colWidth', 'rowHeight', 'screenW', 'screenH', 'cols', 'rows']);
        expect(by('move_screen')?.inputSchema.required).toEqual(['id', 'col', 'row']);
        expect(by('move_screen')?.inputSchema.properties).toHaveProperty('swap');
        expect(by('insert_columns')?.inputSchema.required).toEqual(['boardId', 'after']);
        expect(by('insert_rows')?.inputSchema.required).toEqual(['boardId', 'after']);
        expect(by('compact_board')?.inputSchema.required).toEqual(['boardId']);
    });

    test('pass arguments through to the plugin', async () => {
        const c = ctx({
            create_board: { ok: true, result: { boardId: '5:1' } },
            move_screen: { ok: true, result: { moved: [] } },
            insert_columns: { ok: true, result: { moved: [] } },
            insert_rows: { ok: true, result: { moved: [] } },
            compact_board: { ok: true, result: { moved: [] } },
        });
        expect(json(await call('create_board', { name: 'KYC' }, c))).toEqual({ boardId: '5:1' });
        await call('move_screen', { id: '1:1', col: 2, row: 0, swap: true }, c);
        await call('insert_columns', { boardId: '5:1', after: 0, count: 2 }, c);
        await call('insert_rows', { boardId: '5:1', after: -1 }, c);
        await call('compact_board', { boardId: '5:1' }, c);
        expect(c.calls.map((x) => x.tool)).toEqual(['create_board', 'move_screen', 'insert_columns', 'insert_rows', 'compact_board']);
        expect(c.calls[1]?.args).toEqual({ id: '1:1', col: 2, row: 0, swap: true });
    });
});

describe('flow tools', () => {
    test('connect, reroute_flow and adopt_board are listed with their required args', async () => {
        const tools = await listTools();
        const by = (n: string) => tools.find((t) => t.name === n);
        expect(by('connect')?.inputSchema.required).toEqual(['from', 'to', 'label']);
        expect(Object.keys(by('connect')?.inputSchema.properties ?? {})).toEqual(['from', 'to', 'trigger', 'label', 'prototype', 'boardId', 'exit']);
        expect(by('reroute_flow')?.inputSchema.properties).toHaveProperty('arrowIds');
        expect(by('adopt_board')?.inputSchema.required).toEqual(['boardNodeId']);
        expect(by('adopt_board')?.inputSchema.properties).toHaveProperty('dryRun');
    });

    test('describe_board is listed with optional boardId and width', async () => {
        const tools = await listTools();
        const t = tools.find((x) => x.name === 'describe_board');
        expect(Object.keys(t?.inputSchema.properties ?? {})).toEqual(['boardId', 'width']);
        expect(t?.inputSchema.required ?? []).toEqual([]);
    });

    test('they pass their arguments through to the plugin and return the result', async () => {
        const c = ctx({
            connect: { ok: true, result: { arrowGroupId: '1:9', backwards: false } },
            reroute_flow: { ok: true, result: { rerouted: 3 } },
            adopt_board: { ok: true, result: { arrowsAdopted: 4 } },
        });
        const args = { from: '1:1', to: '1:2', trigger: '1:3', label: 'Continue' };
        expect(json(await call('connect', args, c))).toEqual({ arrowGroupId: '1:9', backwards: false });
        expect(json(await call('reroute_flow', { boardId: '1:0' }, c))).toEqual({ rerouted: 3 });
        expect(json(await call('adopt_board', { boardNodeId: '1:0', dryRun: true }, c))).toEqual({ arrowsAdopted: 4 });
        expect(c.calls.map((x) => x.tool)).toEqual(['connect', 'reroute_flow', 'adopt_board']);
        expect(c.calls[0]?.args).toEqual(args);
        expect(c.calls[2]?.args).toEqual({ boardNodeId: '1:0', dryRun: true });
    });
});

describe('callTool (outside MCP)', () => {
    test('validates arguments before running the tool', async () => {
        const c = ctx({ use_figma: { ok: true, result: 1 } });
        const bad = await callTool('use_figma', { code: 1 }, c);
        expect(bad.isError).toBe(true);
        expect(c.calls).toEqual([]);
        expect(json(await callTool('use_figma', { code: 'return 1' }, c))).toEqual({ result: 1, logs: [] });
        expect((await callTool('nope', {}, c)).isError).toBe(true);
    });
});
