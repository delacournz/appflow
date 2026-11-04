/**
 * The messages between the MCP server and the Figma plugin. The server and
 * the plugin UI speak JSON over a WebSocket, so bytes travel as base64. The UI
 * turns base64 into bytes before handing a command to the plugin's main
 * thread, and bytes back into base64 on the way out.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A file the plugin receives (upload) or returns (export). */
export type Base64File = { name: string; mime: string; base64: string };

export type PluginCommand = { tool: string; args: JsonObject };

/** What the server receives from the plugin. */
export type PluginReply =
    | { ok: true; result: JsonValue; logs?: string[]; images?: string[]; files?: Base64File[] }
    | { ok: false; error: string };

/** server → plugin */
export type ServerMessage = { id: string; cmd: PluginCommand };

/**
 * What the plugin says about its document when it connects. `fileKey` needs
 * `enablePrivatePluginApi`; `docId` is an id the plugin stores in the file's
 * shared plugin data, so files without a key can still be told apart. Both
 * are optional so older plugin builds still connect.
 */
export type Hello = { fileName: string; editorType: string; build?: string; fileKey?: string | null; docId?: string };

/** plugin → server. `activity` marks the file as the one the user touched last. */
export type ClientMessage = { id: string; reply: PluginReply } | { hello: Hello } | { activity: true };

/** One connected plugin window, as the leader tracks it. `connId` is unique per socket. */
export type FileInfo = {
    connId: string;
    fileKey: string | null;
    docId: string;
    fileName: string;
    editorType: string;
    build: string | null;
    connectedAt: number;
    lastActiveAt: number;
};
