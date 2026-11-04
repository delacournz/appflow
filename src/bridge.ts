/**
 * The socket side of the server. Every agent session starts its own stdio
 * server, but only one process can listen on the port. That process is the
 * leader: it owns the plugin socket (`/plugin`) and relays calls from the
 * other servers, its followers (`/peer`). When the leader exits, a follower
 * takes the port and the plugin window reconnects to it.
 *
 * Several Figma files can run the plugin at once. The leader keeps one socket
 * per plugin window and a call names the window (`connId`) it goes to; the
 * choice of file is made in files.ts.
 */
import type { Server, ServerWebSocket } from 'bun';

import type { ClientMessage, FileInfo, Hello, JsonObject, PluginCommand, PluginReply, ServerMessage } from '../shared/protocol';

export type Role = 'leader' | 'follower' | 'none';

export type Bridge = {
    role(): Role;
    connected(): boolean;
    /** Every connected plugin window. */
    files(): FileInfo[];
    /** Sends a command to the window `connId`, or to the only window when it is omitted. */
    call(tool: string, args: JsonObject, timeoutMs: number, connId?: string): Promise<PluginReply>;
    stop(): void;
};

export type BridgeOptions = {
    port: number;
    log: (...parts: unknown[]) => void;
    /** Base delay before a follower retries the port. Default 250 ms. */
    retryMs?: number;
    /** Called with each hello from the plugin, on the leader only. */
    onHello?: (hello: Hello) => void;
};

/** follower → leader */
type PeerRequest = { id: string; cmd: PluginCommand; timeoutMs: number; connId?: string };
/** leader → follower */
type PeerMessage = { id: string; reply: PluginReply } | { status: { files: FileInfo[] } };

type SocketData = { kind: 'plugin'; connId: string } | { kind: 'peer' };
/** `connId` is the plugin window a leader call waits on, so its close fails only its own calls. */
type Pending = { resolve: (reply: PluginReply) => void; timer: ReturnType<typeof setTimeout>; connId?: string };

const DISCONNECTED: PluginReply = { ok: false, error: 'The Figma plugin disconnected.' };
const GONE: PluginReply = { ok: false, error: 'That Figma file is no longer connected.' };
const SEVERAL: PluginReply = { ok: false, error: 'Several Figma files are connected and the call did not name one.' };
const LEADER_GONE: PluginReply = { ok: false, error: 'The AppFlow server that holds the plugin connection exited. Try again in a moment.' };

export function startBridge(opts: BridgeOptions): Bridge {
    const { port, log } = opts;
    const retryMs = opts.retryMs ?? 250;

    let role: Role = 'none';
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    let server: Server<SocketData> | null = null;
    /** Leader: plugin windows by connId. */
    const plugins = new Map<string, { ws: ServerWebSocket<SocketData>; info: FileInfo }>();
    const peers = new Set<ServerWebSocket<SocketData>>();

    let leaderSocket: WebSocket | null = null;
    /** Follower: the leader's last file list. */
    let remoteFiles: FileInfo[] = [];

    const files = (): FileInfo[] => (role === 'leader' ? [...plugins.values()].map((p) => p.info) : remoteFiles);

    const pending = new Map<string, Pending>();

    function settle(id: string, reply: PluginReply) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(reply);
    }

    function failAll(reply: PluginReply, connId?: string) {
        for (const [id, entry] of [...pending.entries()]) if (connId === undefined || entry.connId === connId) settle(id, reply);
    }

    function track(timeoutMs: number, resolve: (reply: PluginReply) => void, connId?: string): string {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => settle(id, { ok: false, error: `Timed out after ${timeoutMs} ms. The work may still be running in Figma.` }), timeoutMs);
        pending.set(id, { resolve, timer, ...(connId === undefined ? {} : { connId }) });
        return id;
    }

    function broadcast() {
        const msg: PeerMessage = { status: { files: files() } };
        const raw = JSON.stringify(msg);
        for (const peer of peers) peer.send(raw);
    }

    /** The window a call goes to: the one named, else the only one. */
    function target(connId: string | undefined): { connId: string; ws: ServerWebSocket<SocketData> } | PluginReply {
        if (connId !== undefined) {
            const p = plugins.get(connId);
            return p ? { connId, ws: p.ws } : GONE;
        }
        if (plugins.size === 0) return DISCONNECTED;
        if (plugins.size > 1) return SEVERAL;
        const [only] = plugins.entries();
        return only ? { connId: only[0], ws: only[1].ws } : DISCONNECTED;
    }

    function leaderCall(cmd: PluginCommand, timeoutMs: number, connId?: string): Promise<PluginReply> {
        return new Promise((resolve) => {
            const t = target(connId);
            if ('ok' in t) return resolve(t);
            const id = track(timeoutMs, resolve, t.connId);
            const msg: ServerMessage = { id, cmd };
            t.ws.send(JSON.stringify(msg));
        });
    }

    function followerCall(cmd: PluginCommand, timeoutMs: number, connId?: string): Promise<PluginReply> {
        return new Promise((resolve) => {
            const socket = leaderSocket;
            if (!socket || socket.readyState !== WebSocket.OPEN || remoteFiles.length === 0) return resolve(DISCONNECTED);
            const id = track(timeoutMs + 1000, resolve);
            const req: PeerRequest = { id, cmd, timeoutMs, ...(connId === undefined ? {} : { connId }) };
            socket.send(JSON.stringify(req));
        });
    }

    function onHello(connId: string, hello: Hello) {
        const p = plugins.get(connId);
        if (!p) return;
        p.info = {
            ...p.info,
            fileName: hello.fileName,
            editorType: hello.editorType,
            build: hello.build ?? null,
            fileKey: hello.fileKey ?? null,
            docId: hello.docId ?? p.info.docId,
            lastActiveAt: Date.now(),
        };
        broadcast();
        opts.onHello?.(hello);
    }

    function tryLead(): boolean {
        try {
            server = Bun.serve<SocketData, never>({
                hostname: '127.0.0.1',
                port,
                fetch(req, srv) {
                    const path = new URL(req.url).pathname;
                    if (path === '/plugin' && srv.upgrade(req, { data: { kind: 'plugin', connId: crypto.randomUUID() } })) return undefined;
                    if (path === '/peer' && srv.upgrade(req, { data: { kind: 'peer' } })) return undefined;
                    return new Response('appflow', { status: 200 });
                },
                websocket: {
                    maxPayloadLength: 256 * 1024 * 1024,
                    open(ws) {
                        if (ws.data.kind === 'peer') {
                            peers.add(ws);
                            const msg: PeerMessage = { status: { files: files() } };
                            ws.send(JSON.stringify(msg));
                            return;
                        }
                        const { connId } = ws.data;
                        const now = Date.now();
                        plugins.set(connId, { ws, info: { connId, fileKey: null, docId: connId, fileName: 'Untitled', editorType: 'figma', build: null, connectedAt: now, lastActiveAt: now } });
                        broadcast();
                        log(`plugin connected (${plugins.size} open)`);
                    },
                    async message(ws, raw) {
                        if (ws.data.kind === 'peer') {
                            let req: PeerRequest;
                            try {
                                req = JSON.parse(String(raw)) as PeerRequest;
                            } catch {
                                return;
                            }
                            const reply = await leaderCall(req.cmd, req.timeoutMs, req.connId);
                            const msg: PeerMessage = { id: req.id, reply };
                            if (peers.has(ws)) ws.send(JSON.stringify(msg));
                            return;
                        }
                        let msg: ClientMessage;
                        try {
                            msg = JSON.parse(String(raw)) as ClientMessage;
                        } catch {
                            return;
                        }
                        const { connId } = ws.data;
                        if ('hello' in msg) onHello(connId, msg.hello);
                        else if ('activity' in msg) {
                            const p = plugins.get(connId);
                            if (p) p.info = { ...p.info, lastActiveAt: Date.now() };
                            broadcast();
                        } else settle(msg.id, msg.reply);
                    },
                    close(ws) {
                        if (ws.data.kind === 'peer') {
                            peers.delete(ws);
                            return;
                        }
                        const { connId } = ws.data;
                        const p = plugins.get(connId);
                        if (!p || p.ws !== ws) return;
                        plugins.delete(connId);
                        broadcast();
                        log(`plugin disconnected: ${p.info.fileName} (${plugins.size} open)`);
                        failAll(DISCONNECTED, connId);
                    },
                },
            });
        } catch {
            return false;
        }
        role = 'leader';
        log(`leader: listening on ws://127.0.0.1:${port}/plugin`);
        return true;
    }

    function follow() {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`);
        leaderSocket = ws;
        let opened = false;
        ws.onopen = () => {
            opened = true;
            role = 'follower';
            log(`follower: relaying through the server on port ${port}`);
        };
        ws.onmessage = (event) => {
            const msg = JSON.parse(String(event.data)) as PeerMessage;
            if ('status' in msg) remoteFiles = msg.status.files;
            else settle(msg.id, msg.reply);
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
            if (leaderSocket !== ws) return;
            leaderSocket = null;
            role = 'none';
            remoteFiles = [];
            failAll(LEADER_GONE);
            if (opened) log('leader went away; taking over or following the next one');
            schedule(opened);
        };
    }

    /** Jitter spreads followers out so one wins the port and the rest follow it. */
    function schedule(soon: boolean) {
        if (stopped) return;
        clearTimeout(retryTimer);
        const delay = (soon ? 0 : retryMs) + Math.random() * retryMs;
        retryTimer = setTimeout(join, delay);
    }

    function join() {
        if (stopped) return;
        if (!tryLead()) follow();
    }

    join();

    return {
        role: () => role,
        connected: () => files().length > 0,
        files,
        call: (tool, args, timeoutMs, connId) => {
            const cmd: PluginCommand = { tool, args };
            if (role === 'leader') return leaderCall(cmd, timeoutMs, connId);
            return followerCall(cmd, timeoutMs, connId);
        },
        stop() {
            stopped = true;
            clearTimeout(retryTimer);
            failAll(DISCONNECTED);
            if (leaderSocket) {
                const ws = leaderSocket;
                leaderSocket = null;
                ws.close();
            }
            if (server) {
                for (const p of plugins.values()) p.ws.close(1001, 'AppFlow server stopped');
                for (const peer of peers) peer.close(1001, 'AppFlow server stopped');
                server.stop(true);
                server = null;
                plugins.clear();
                peers.clear();
            }
            role = 'none';
        },
    };
}
