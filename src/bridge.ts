/**
 * The socket side of the server. Every agent session starts its own stdio
 * server, but only one process can listen on the port. That process is the
 * leader: it owns the plugin socket (`/plugin`) and relays calls from the
 * other servers, its followers (`/peer`). When the leader exits, a follower
 * takes the port and the plugin window reconnects to it.
 */
import type { Server, ServerWebSocket } from 'bun';

import type { ClientMessage, JsonObject, PluginCommand, PluginReply, ServerMessage } from '../shared/protocol';

export type Role = 'leader' | 'follower' | 'none';

export type Bridge = {
    role(): Role;
    connected(): boolean;
    pluginBuild(): string | null;
    call(tool: string, args: JsonObject, timeoutMs: number): Promise<PluginReply>;
    stop(): void;
};

export type BridgeOptions = {
    port: number;
    log: (...parts: unknown[]) => void;
    /** Base delay before a follower retries the port. Default 250 ms. */
    retryMs?: number;
    /** Called with each hello from the plugin, on the leader only. */
    onHello?: (hello: Extract<ClientMessage, { hello: unknown }>['hello']) => void;
};

/** follower → leader */
type PeerRequest = { id: string; cmd: PluginCommand; timeoutMs: number };
/** leader → follower */
type PeerMessage = { id: string; reply: PluginReply } | { status: { connected: boolean; build: string | null } };

type SocketData = { kind: 'plugin' | 'peer' };
type Pending = { resolve: (reply: PluginReply) => void; timer: ReturnType<typeof setTimeout> };

const DISCONNECTED: PluginReply = { ok: false, error: 'The Figma plugin disconnected.' };
const LEADER_GONE: PluginReply = { ok: false, error: 'The AppFlow server that holds the plugin connection exited. Try again in a moment.' };

export function startBridge(opts: BridgeOptions): Bridge {
    const { port, log } = opts;
    const retryMs = opts.retryMs ?? 250;

    let role: Role = 'none';
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    let server: Server<SocketData> | null = null;
    let plugin: ServerWebSocket<SocketData> | null = null;
    const peers = new Set<ServerWebSocket<SocketData>>();

    let leaderSocket: WebSocket | null = null;
    let status: { connected: boolean; build: string | null } = { connected: false, build: null };

    const pending = new Map<string, Pending>();

    function settle(id: string, reply: PluginReply) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(reply);
    }

    function failAll(reply: PluginReply) {
        for (const id of [...pending.keys()]) settle(id, reply);
    }

    function track(timeoutMs: number, resolve: (reply: PluginReply) => void): string {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => settle(id, { ok: false, error: `Timed out after ${timeoutMs} ms. The work may still be running in Figma.` }), timeoutMs);
        pending.set(id, { resolve, timer });
        return id;
    }

    function broadcast() {
        const msg: PeerMessage = { status };
        const raw = JSON.stringify(msg);
        for (const peer of peers) peer.send(raw);
    }

    function leaderCall(cmd: PluginCommand, timeoutMs: number): Promise<PluginReply> {
        return new Promise((resolve) => {
            const socket = plugin;
            if (!socket) return resolve(DISCONNECTED);
            const id = track(timeoutMs, resolve);
            const msg: ServerMessage = { id, cmd };
            socket.send(JSON.stringify(msg));
        });
    }

    function followerCall(cmd: PluginCommand, timeoutMs: number): Promise<PluginReply> {
        return new Promise((resolve) => {
            const socket = leaderSocket;
            if (!socket || socket.readyState !== WebSocket.OPEN || !status.connected) return resolve(DISCONNECTED);
            const id = track(timeoutMs + 1000, resolve);
            const req: PeerRequest = { id, cmd, timeoutMs };
            socket.send(JSON.stringify(req));
        });
    }

    function tryLead(): boolean {
        try {
            server = Bun.serve<SocketData, never>({
                hostname: '127.0.0.1',
                port,
                fetch(req, srv) {
                    const path = new URL(req.url).pathname;
                    if (path === '/plugin' && srv.upgrade(req, { data: { kind: 'plugin' } })) return undefined;
                    if (path === '/peer' && srv.upgrade(req, { data: { kind: 'peer' } })) return undefined;
                    return new Response('appflow', { status: 200 });
                },
                websocket: {
                    maxPayloadLength: 256 * 1024 * 1024,
                    open(ws) {
                        if (ws.data.kind === 'peer') {
                            peers.add(ws);
                            const msg: PeerMessage = { status };
                            ws.send(JSON.stringify(msg));
                            return;
                        }
                        if (plugin && plugin !== ws) plugin.close(1000, 'Replaced by a newer plugin window');
                        plugin = ws;
                        status = { connected: true, build: null };
                        broadcast();
                        log('plugin connected');
                    },
                    async message(ws, raw) {
                        if (ws.data.kind === 'peer') {
                            let req: PeerRequest;
                            try {
                                req = JSON.parse(String(raw)) as PeerRequest;
                            } catch {
                                return;
                            }
                            const reply = await leaderCall(req.cmd, req.timeoutMs);
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
                        if ('hello' in msg) {
                            status = { connected: true, build: msg.hello.build ?? null };
                            broadcast();
                            opts.onHello?.(msg.hello);
                        } else settle(msg.id, msg.reply);
                    },
                    close(ws) {
                        if (ws.data.kind === 'peer') {
                            peers.delete(ws);
                            return;
                        }
                        if (plugin !== ws) return;
                        plugin = null;
                        status = { connected: false, build: null };
                        broadcast();
                        log('plugin disconnected');
                        failAll(DISCONNECTED);
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
            if ('status' in msg) status = msg.status;
            else settle(msg.id, msg.reply);
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
            if (leaderSocket !== ws) return;
            leaderSocket = null;
            role = 'none';
            status = { connected: false, build: null };
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
        connected: () => (role === 'leader' ? plugin !== null : role === 'follower' && status.connected),
        pluginBuild: () => status.build,
        call: (tool, args, timeoutMs) => {
            const cmd: PluginCommand = { tool, args };
            if (role === 'leader') return leaderCall(cmd, timeoutMs);
            return followerCall(cmd, timeoutMs);
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
                plugin?.close(1001, 'AppFlow server stopped');
                for (const peer of peers) peer.close(1001, 'AppFlow server stopped');
                server.stop(true);
                server = null;
                plugin = null;
                peers.clear();
            }
            role = 'none';
        },
    };
}
