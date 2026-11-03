import { afterEach, describe, expect, test } from 'bun:test';

import type { PluginReply, ServerMessage } from '../shared/protocol';
import { startBridge, type Bridge } from './bridge';

const bridges: Bridge[] = [];
const plugins: WebSocket[] = [];
afterEach(() => {
    for (const p of plugins.splice(0)) p.close();
    for (const b of bridges.splice(0)) b.stop();
});

const randomPort = () => 40000 + Math.floor(Math.random() * 20000);

function bridge(port: number): Bridge {
    const b = startBridge({ port, log: () => {}, retryMs: 50 });
    bridges.push(b);
    return b;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('waitFor timed out');
        await Bun.sleep(10);
    }
}

/** A fake plugin window: answers every command with the tool name it got. */
async function fakePlugin(port: number, build = 'b1'): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
    plugins.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('plugin could not connect'));
    });
    ws.send(JSON.stringify({ hello: { fileName: 'File', editorType: 'figma', build } }));
    ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        const reply: PluginReply = { ok: true, result: { echoed: msg.cmd.tool } };
        ws.send(JSON.stringify({ id: msg.id, reply }));
    };
    return ws;
}

describe('bridge', () => {
    test('first bridge leads, second follows', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const b = bridge(port);
        await waitFor(() => b.role() === 'follower');
    });

    test('a follower sees the plugin and relays calls through the leader', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const b = bridge(port);
        await waitFor(() => b.role() === 'follower');
        expect(b.connected()).toBe(false);

        await fakePlugin(port, 'b7');
        await waitFor(() => b.connected() && b.pluginBuild() === 'b7');
        expect(a.connected()).toBe(true);

        expect(await b.call('figma_status', {}, 1000)).toEqual({ ok: true, result: { echoed: 'figma_status' } });
        expect(await a.call('get_metadata', {}, 1000)).toEqual({ ok: true, result: { echoed: 'get_metadata' } });
    });

    test('a follower reports a plugin disconnect', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const b = bridge(port);
        await waitFor(() => b.role() === 'follower');
        const p = await fakePlugin(port);
        await waitFor(() => b.connected());
        p.close();
        await waitFor(() => !b.connected());
        expect(await b.call('figma_status', {}, 500)).toEqual({ ok: false, error: 'The Figma plugin disconnected.' });
    });

    test('a follower takes over when the leader stops', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const b = bridge(port);
        await waitFor(() => b.role() === 'follower');

        a.stop();
        await waitFor(() => b.role() === 'leader');

        await fakePlugin(port);
        await waitFor(() => b.connected());
        expect(await b.call('whoami', {}, 1000)).toEqual({ ok: true, result: { echoed: 'whoami' } });
    });

    test('one of several followers takes over; the rest follow it', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const followers = [bridge(port), bridge(port), bridge(port)];
        await waitFor(() => followers.every((f) => f.role() === 'follower'));

        a.stop();
        await waitFor(() => followers.filter((f) => f.role() === 'leader').length === 1 && followers.every((f) => f.role() !== 'none'));

        await fakePlugin(port);
        await waitFor(() => followers.every((f) => f.connected()));
        for (const f of followers) expect((await f.call('ping', {}, 1000)).ok).toBe(true);
    });

    test('a call times out when the plugin never answers', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
        plugins.push(ws);
        await waitFor(() => a.connected());
        const reply = await a.call('slow', {}, 50);
        expect(reply.ok).toBe(false);
    });
});
