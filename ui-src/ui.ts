import type { Base64File, JsonObject, JsonValue, PluginReply, ServerMessage } from '../shared/protocol';
import { measureHtml } from './measure';

/**
 * The plugin window. Holds the WebSocket to the local MCP server and relays
 * commands to the main thread, converting base64 ⇄ bytes on the way. Measures
 * HTML for `html_to_figma` here, because only the UI has a DOM.
 */

type MainFile = { name: string; mime: string; bytes: Uint8Array };
type MainReply =
    | { ok: true; result: JsonValue; logs?: string[]; images?: Uint8Array[]; files?: MainFile[] }
    | { ok: false; error: string };
type MainMessage = { type: 'hello'; fileName: string; editorType: string } | { type: 'reply'; id: string; reply: MainReply };

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const dot = $('dot');
const state = $('state');
const last = $('last');
const portInput = $('port') as HTMLInputElement;
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;

const setState = (on: boolean, text: string) => {
    dot.classList.toggle('on', on);
    state.textContent = text;
};

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

const send = (id: string, reply: PluginReply) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ id, reply }));
const toMain = (message: object) => parent.postMessage({ pluginMessage: message }, '*');

async function onCommand({ id, cmd }: ServerMessage) {
    last.textContent = `${new Date().toLocaleTimeString()} · ${cmd.tool}`;
    let args: JsonObject = cmd.args ?? {};
    try {
        if (cmd.tool === 'html_to_figma') {
            const html = typeof args.html === 'string' ? args.html : '';
            const width = typeof args.width === 'number' ? args.width : 1440;
            const height = typeof args.height === 'number' ? args.height : null;
            const tree = await measureHtml(html, width, height);
            const { html: _html, ...rest } = args;
            toMain({ type: 'command', id, cmd: { tool: 'html_build', args: { ...rest, tree } } });
            return;
        }
        if (Array.isArray(args.files)) {
            const files = (args.files as unknown as Base64File[]).map((f) => (f.base64 ? { name: f.name, mime: f.mime, bytes: fromBase64(f.base64) } : f));
            args = { ...args, files: files as unknown as JsonObject[] };
        }
        toMain({ type: 'command', id, cmd: { tool: cmd.tool, args } });
    } catch (error) {
        send(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}

function connect() {
    clearTimeout(retry);
    socket?.close();
    const port = Number(portInput.value) || 3055;
    const ws = new WebSocket(`ws://localhost:${port}/plugin`);
    socket = ws;
    ws.onopen = () => {
        setState(true, 'Connected to the local bridge');
        toMain({ type: 'hello' });
    };
    ws.onclose = () => {
        if (socket !== ws) return;
        setState(false, 'Waiting for the bridge server…');
        retry = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => void onCommand(JSON.parse(String(event.data)) as ServerMessage);
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
    const msg = event.data.pluginMessage;
    if (!msg || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (msg.type === 'hello') {
        socket.send(JSON.stringify({ hello: { fileName: msg.fileName, editorType: msg.editorType } }));
        setState(true, `Connected · ${msg.fileName}`);
        return;
    }
    const r = msg.reply;
    if (!r.ok) return void send(msg.id, r);
    send(msg.id, {
        ok: true,
        result: r.result,
        ...(r.logs ? { logs: r.logs } : {}),
        ...(r.images ? { images: r.images.map(toBase64) } : {}),
        ...(r.files ? { files: r.files.map((f) => ({ name: f.name, mime: f.mime, base64: toBase64(f.bytes) })) } : {}),
    });
};

portInput.addEventListener('change', connect);
connect();
