import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonObject, PluginReply } from '../shared/protocol';
import { handleRequest, type RpcResponse } from './rpc';
import { CodeConnectStore } from './store';
import type { ToolContext } from './tools';

type Call = { tool: string; args: JsonObject; timeoutMs: number };
type Content = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = { content: Content[]; isError?: boolean };

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figma-bridge-'));
});
afterEach(async () => {
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

async function call(name: string, args: JsonObject, c: ToolContext): Promise<ToolResult> {
    const res = (await handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, c)) as RpcResponse;
    return res.result as ToolResult;
}

const json = (r: ToolResult, i = 0) => JSON.parse(r.content[i]?.text ?? 'null');

describe('protocol', () => {
    test('initialize echoes the version and declares tools and prompts', async () => {
        const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx({}));
        expect(res).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'figma-local-bridge' } } });
    });

    test('notifications get no response; unknown methods are method-not-found', async () => {
        expect(await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx({}))).toBeNull();
        expect((await handleRequest({ jsonrpc: '2.0', id: 3, method: 'nope' }, ctx({})))?.error?.code).toBe(-32601);
    });

    test('tools/list uses the official tool names', async () => {
        const res = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx({}));
        const names = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
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
        const init = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx({}));
        const result = init?.result as { capabilities: Record<string, unknown>; instructions: string };
        expect(result.capabilities).toHaveProperty('resources');
        expect(result.instructions).toContain('left to right');
        expect(result.instructions).toContain('lint_flow_layout');

        const tools = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx({}));
        expect((tools?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain('lint_flow_layout');

        const list = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx({}));
        const uri = (list?.result as { resources: { uri: string }[] }).resources[0]?.uri ?? '';
        expect(uri).toBe('skill://figma-bridge/flow-layout/SKILL.md');
        const read = await handleRequest({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri } }, ctx({}));
        const text = (read?.result as { contents: { text: string; mimeType: string }[] }).contents[0];
        expect(text?.mimeType).toBe('text/markdown');
        expect(text?.text).toContain('left to right');
        expect((await handleRequest({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'skill://nope' } }, ctx({})))?.error).toBeDefined();

        const prompts = await handleRequest({ jsonrpc: '2.0', id: 6, method: 'prompts/list' }, ctx({}));
        expect((prompts?.result as { prompts: { name: string }[] }).prompts.map((p) => p.name)).toContain('flow_layout');
        const got = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'flow_layout' } }, ctx({}));
        expect((got?.result as { messages: { content: { text: string } }[] }).messages[0]?.content.text).toContain('lint_flow_layout');
    });

    test('prompts: create_design_system_rules', async () => {
        const list = await handleRequest({ jsonrpc: '2.0', id: 4, method: 'prompts/list' }, ctx({}));
        expect((list?.result as { prompts: { name: string }[] }).prompts[0]?.name).toBe('create_design_system_rules');
        const got = await handleRequest(
            { jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'create_design_system_rules', arguments: { clientFrameworks: 'react-native' } } },
            ctx({}),
        );
        const text = (got?.result as { messages: { content: { text: string } }[] }).messages[0]?.content.text ?? '';
        expect(text).toContain('react-native');
        expect(text).toContain('search_design_system');
    });
});

describe('tools', () => {
    test('fail clearly when the plugin is not open', async () => {
        const r = await call('use_figma', { code: 'x' }, ctx({}, false));
        expect(r.isError).toBe(true);
        expect(r.content[0]?.text).toContain('Local Agent Bridge');
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
        const r = await call('get_screenshot', { nodeId: '1:2' }, ctx({ get_screenshot: { ok: true, result: { width: 10 }, images: ['iVBOR'] } }));
        expect(r.content[0]).toEqual({ type: 'image', data: 'iVBOR', mimeType: 'image/png' });
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
        const res = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx({}));
        const tools = (res?.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
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
        expect(json(await call('figma_status', {}, c))).toMatchObject({ connected: true, stale: true, fix: 'Re-run Plugins → Development → Local Agent Bridge', expectedBuild: 'new11111', pluginBuild: 'old22222' });
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

describe('flow tools', () => {
    test('connect, reroute_flow and adopt_board are listed with their required args', async () => {
        const res = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx({}));
        const tools = (res?.result as { tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[] }).tools;
        const by = (n: string) => tools.find((t) => t.name === n);
        expect(by('connect')?.inputSchema.required).toEqual(['from', 'to', 'label']);
        expect(Object.keys(by('connect')?.inputSchema.properties ?? {})).toEqual(['from', 'to', 'trigger', 'label', 'prototype', 'boardId']);
        expect(by('reroute_flow')?.inputSchema.properties).toHaveProperty('arrowIds');
        expect(by('adopt_board')?.inputSchema.required).toEqual(['boardNodeId']);
        expect(by('adopt_board')?.inputSchema.properties).toHaveProperty('dryRun');
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
