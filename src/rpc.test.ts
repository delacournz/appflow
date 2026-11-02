import { describe, expect, test } from 'bun:test';

import { type Bridge, type BridgeCommand, type BridgeReply, handleRequest, type RpcResponse } from './rpc';

type Call = { cmd: BridgeCommand; timeoutMs: number };

function fakeBridge(reply: BridgeReply, connected = true): Bridge & { calls: Call[] } {
    const calls: Call[] = [];
    return {
        calls,
        isConnected: () => connected,
        send: async (cmd, timeoutMs) => {
            calls.push({ cmd, timeoutMs });
            return reply;
        },
    };
}

const ok: BridgeReply = { ok: true, result: { count: 2 }, logs: ['hello'] };

async function call(name: string, args: Record<string, unknown>, bridge: Bridge): Promise<RpcResponse> {
    const res = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, bridge);
    if (!res) throw new Error('expected a response');
    return res;
}

describe('handleRequest', () => {
    test('initialize echoes the protocol version and declares tools', async () => {
        const res = await handleRequest(
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
            fakeBridge(ok),
        );
        expect(res).toMatchObject({
            id: 1,
            result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'figma-local-bridge' } },
        });
    });

    test('notifications get no response', async () => {
        expect(await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeBridge(ok))).toBeNull();
    });

    test('tools/list names the three tools', async () => {
        const res = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, fakeBridge(ok));
        const tools = (res?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
        expect(tools).toEqual(['figma_status', 'figma_run', 'figma_screenshot']);
    });

    test('unknown methods return method-not-found', async () => {
        const res = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'nope' }, fakeBridge(ok));
        expect(res?.error?.code).toBe(-32601);
    });

    test('figma_run sends the code and returns the result with logs', async () => {
        const bridge = fakeBridge(ok);
        const res = await call('figma_run', { code: 'return 1', timeoutMs: 5000 }, bridge);
        expect(bridge.calls).toEqual([{ cmd: { type: 'run', code: 'return 1' }, timeoutMs: 5000 }]);
        const text = (res.result as { content: { text: string }[] }).content[0]?.text ?? '';
        expect(JSON.parse(text)).toEqual({ result: { count: 2 }, logs: ['hello'] });
    });

    test('figma_run without code is a tool error', async () => {
        const res = await call('figma_run', {}, fakeBridge(ok));
        expect(res.result).toMatchObject({ isError: true });
    });

    test('a plugin error is returned as a tool error', async () => {
        const res = await call('figma_run', { code: 'x' }, fakeBridge({ ok: false, error: 'boom' }));
        expect(res.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    });

    test('tools fail clearly when the plugin is not open', async () => {
        const res = await call('figma_run', { code: 'x' }, fakeBridge(ok, false));
        const result = res.result as { isError: boolean; content: { text: string }[] };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('Local Agent Bridge');
    });

    test('figma_screenshot returns an image', async () => {
        const bridge = fakeBridge({ ok: true, result: { width: 10, height: 20 }, image: 'iVBOR' });
        const res = await call('figma_screenshot', { nodeId: '1:2' }, bridge);
        expect(bridge.calls[0]?.cmd).toEqual({ type: 'screenshot', nodeId: '1:2', scale: 1 });
        const content = (res.result as { content: unknown[] }).content;
        expect(content[0]).toEqual({ type: 'image', data: 'iVBOR', mimeType: 'image/png' });
        expect(content[1]).toEqual({ type: 'text', text: '{"width":10,"height":20}' });
    });
});
