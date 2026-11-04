/**
 * Picks which connected Figma file a tool call goes to. Several files can run
 * the plugin at once; a call goes to the file it names, else to the session's
 * pinned file, else to the only file. Anything else is an error that lists the
 * files: a write to the wrong document is worse than asking.
 */
import type { FileInfo } from '../shared/protocol';

/** The file an agent session pinned with select_file. Matched by fileKey, else docId, so it survives a reconnect. */
export type Pin = { fileKey: string | null; docId: string; fileName: string };

export type Resolved = { ok: true; file: FileInfo } | { ok: false; error: string };

export type FileSummary = { fileName: string; fileKey: string | null; docId: string; editorType: string; lastActiveAt: string };

export const pinOf = (f: FileInfo): Pin => ({ fileKey: f.fileKey, docId: f.docId, fileName: f.fileName });

export const summarize = (f: FileInfo): FileSummary => ({
    fileName: f.fileName,
    fileKey: f.fileKey,
    docId: f.docId,
    editorType: f.editorType,
    lastActiveAt: new Date(f.lastActiveAt).toISOString(),
});

const URL_KEY = /^https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|proto|slides|make)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/;

/** The file key in a figma.com URL (the branch key for a branch), or null. */
export function fileKeyFromUrl(text: string): string | null {
    const m = URL_KEY.exec(text.trim());
    if (!m) return null;
    return m[2] ?? m[1] ?? null;
}

const HOW = 'Pass `file` (a fileKey, Figma URL or file name) or call select_file.';

function listing(files: FileInfo[]): string {
    const order = [...files].sort((x, y) => y.lastActiveAt - x.lastActiveAt);
    return order.map((f) => `- "${f.fileName}" (${f.editorType}, ${f.fileKey ? `fileKey ${f.fileKey}` : `docId ${f.docId}`})`).join('\n');
}

function one(found: FileInfo[], what: string, files: FileInfo[]): Resolved {
    const [first] = found;
    if (found.length === 1 && first) return { ok: true, file: first };
    if (found.length === 0) return { ok: false, error: `No connected Figma file matches ${what}. Connected files:\n${listing(files)}\n${HOW}` };
    return { ok: false, error: `${what} matches several connected Figma files:\n${listing(found)}\nUse the fileKey or docId instead.` };
}

function byRef(files: FileInfo[], ref: string): Resolved {
    const what = `"${ref}"`;
    const urlKey = fileKeyFromUrl(ref);
    if (urlKey) return one(files.filter((f) => f.fileKey === urlKey), what, files);

    const ids = files.filter((f) => f.fileKey === ref || f.docId === ref || f.connId === ref);
    if (ids.length > 0) return one(ids, what, files);

    const needle = ref.trim().toLowerCase();
    const exact = files.filter((f) => f.fileName.toLowerCase() === needle);
    if (exact.length > 0) return one(exact, what, files);
    return one(files.filter((f) => f.fileName.toLowerCase().includes(needle)), what, files);
}

function byPin(files: FileInfo[], pin: Pin): Resolved {
    const found = files.filter((f) => (pin.fileKey ? f.fileKey === pin.fileKey : f.docId === pin.docId));
    if (found.length === 0) {
        const others = files.length > 0 ? ` Connected files:\n${listing(files)}` : '';
        return { ok: false, error: `The pinned file "${pin.fileName}" is not connected. Run AppFlow in it again, or call select_file to pick another.${others}` };
    }
    return one(found, `The pinned file "${pin.fileName}"`, files);
}

export function resolveFile(files: FileInfo[], ref: string | undefined, pin: Pin | null): Resolved {
    if (files.length === 0) return { ok: false, error: 'No Figma file is connected. In the Figma desktop app, open the file and run Plugins → Development → AppFlow, then try again.' };
    if (ref !== undefined && ref.trim() !== '') return byRef(files, ref);
    if (pin) return byPin(files, pin);
    const [only] = files;
    if (files.length === 1 && only) return { ok: true, file: only };
    return { ok: false, error: `Several Figma files are connected:\n${listing(files)}\n${HOW}` };
}
