import type { JsonObject, JsonValue } from '../shared/protocol';

/** A file as bytes, before the UI turns it into base64. */
export type ByteFile = { name: string; mime: string; bytes: Uint8Array };

/** What a tool handler returns on the plugin's main thread. */
export type MainReply =
    | { ok: true; result: JsonValue; logs?: string[]; images?: Uint8Array[]; files?: ByteFile[] }
    | { ok: false; error: string };

export type Handler = (args: JsonObject) => Promise<MainReply>;

export const ok = (result: JsonValue, extra: Omit<Extract<MainReply, { ok: true }>, 'ok' | 'result'> = {}): MainReply => ({
    ok: true,
    result,
    ...extra,
});

export const fail = (error: string): MainReply => ({ ok: false, error });

export const str = (args: JsonObject, key: string): string | undefined => {
    const v = args[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
};

export const num = (args: JsonObject, key: string): number | undefined => {
    const v = args[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

export const bool = (args: JsonObject, key: string, fallback: boolean): boolean => {
    const v = args[key];
    return typeof v === 'boolean' ? v : fallback;
};
