import { afterEach, describe, expect, test } from 'bun:test';

import type { Hello, PluginReply, ServerMessage } from '../shared/protocol';
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

type FakeOptions = Partial<Hello> & { /** Never answer a command. */ silent?: boolean };

/** A fake plugin window: answers every command with the tool name it got (and its file name when it sent one). */
async function fakePlugin(port: number, opts: FakeOptions | string = {}): Promise<WebSocket> {
    const o: FakeOptions = typeof opts === 'string' ? { build: opts } : opts;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
    plugins.push(ws);
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('plugin could not connect'));
    });
    const hello: Hello = { fileName: o.fileName ?? 'File', editorType: o.editorType ?? 'figma', build: o.build ?? 'b1', ...(o.fileKey === undefined ? {} : { fileKey: o.fileKey }), ...(o.docId === undefined ? {} : { docId: o.docId }) };
    ws.send(JSON.stringify({ hello }));
    ws.onmessage = (event) => {
        if (o.silent) return;
        const msg = JSON.parse(String(event.data)) as ServerMessage;
        const reply: PluginReply = { ok: true, result: o.fileName ? { echoed: msg.cmd.tool, file: o.fileName } : { echoed: msg.cmd.tool } };
        ws.send(JSON.stringify({ id: msg.id, reply }));
    };
    return ws;
}

const hasFiles = (b: Bridge, ...names: string[]) => names.every((n) => b.files().some((f) => f.fileName === n));
const connOf = (b: Bridge, fileName: string) => b.files().find((f) => f.fileName === fileName)?.connId ?? '';

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
        await waitFor(() => b.connected() && b.files()[0]?.build === 'b7');
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

describe('bridge with several files', () => {
    test('a second file does not push the first one off', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        await fakePlugin(port, { fileName: 'A', fileKey: 'KA', docId: 'da' });
        await fakePlugin(port, { fileName: 'B', fileKey: 'KB', docId: 'db' });
        await waitFor(() => hasFiles(a, 'A', 'B'));
        await Bun.sleep(100);
        expect(a.files().map((f) => f.fileName).sort()).toEqual(['A', 'B']);
        expect(a.files().find((f) => f.fileName === 'A')).toMatchObject({ fileKey: 'KA', docId: 'da', build: 'b1', editorType: 'figma' });
    });

    test('calls go to the file they name, from the leader and from a follower', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const b = bridge(port);
        await waitFor(() => b.role() === 'follower');
        await fakePlugin(port, { fileName: 'A', fileKey: 'KA', docId: 'da' });
        await fakePlugin(port, { fileName: 'B', fileKey: 'KB', docId: 'db' });
        await waitFor(() => hasFiles(b, 'A', 'B') && hasFiles(a, 'A', 'B'));

        expect(await a.call('t', {}, 1000, connOf(a, 'B'))).toEqual({ ok: true, result: { echoed: 't', file: 'B' } });
        expect(await a.call('t', {}, 1000, connOf(a, 'A'))).toEqual({ ok: true, result: { echoed: 't', file: 'A' } });
        expect(await b.call('t', {}, 1000, connOf(b, 'A'))).toEqual({ ok: true, result: { echoed: 't', file: 'A' } });
        expect(await b.call('t', {}, 1000, connOf(b, 'B'))).toEqual({ ok: true, result: { echoed: 't', file: 'B' } });
    });

    test('a call that names no file is refused when several are open', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        await fakePlugin(port, { fileName: 'A', docId: 'da' });
        await fakePlugin(port, { fileName: 'B', docId: 'db' });
        await waitFor(() => a.files().length === 2);
        const reply = await a.call('t', {}, 1000);
        expect(reply.ok).toBe(false);
    });

    test('a call to a file that is gone is refused', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        await fakePlugin(port, { fileName: 'A', docId: 'da' });
        await waitFor(() => a.files().length === 1);
        const reply = await a.call('t', {}, 1000, 'nope');
        expect(reply).toEqual({ ok: false, error: 'That Figma file is no longer connected.' });
    });

    test('closing one file fails only its own calls', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const slow = await fakePlugin(port, { fileName: 'A', docId: 'da', silent: true });
        await fakePlugin(port, { fileName: 'B', docId: 'db' });
        await waitFor(() => hasFiles(a, 'A', 'B'));
        const ca = connOf(a, 'A');
        const pendingA = a.call('t', {}, 5000, ca);
        slow.close();
        expect(await pendingA).toEqual({ ok: false, error: 'The Figma plugin disconnected.' });
        await waitFor(() => a.files().length === 1);
        expect(await a.call('t', {}, 1000, connOf(a, 'B'))).toEqual({ ok: true, result: { echoed: 't', file: 'B' } });
    });

    test('activity marks the file as last active', async () => {
        const port = randomPort();
        const a = bridge(port);
        await waitFor(() => a.role() === 'leader');
        const ws = await fakePlugin(port, { fileName: 'A', docId: 'da' });
        await waitFor(() => a.files()[0]?.fileName === 'A');
        const before = a.files()[0]?.lastActiveAt ?? 0;
        await Bun.sleep(5);
        ws.send(JSON.stringify({ activity: true }));
        await waitFor(() => (a.files()[0]?.lastActiveAt ?? 0) > before);
    });
});
