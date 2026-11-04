import { describe, expect, test } from 'bun:test';

import type { FileInfo } from '../shared/protocol';
import { fileKeyFromUrl, pinOf, resolveFile, summarize } from './files';

const file = (over: Partial<FileInfo>): FileInfo => ({
    connId: 'c1',
    fileKey: null,
    docId: 'd1',
    fileName: 'File',
    editorType: 'figma',
    build: 'b1',
    connectedAt: 1,
    lastActiveAt: 1,
    ...over,
});

const a = file({ connId: 'ca', fileKey: 'KEYA', docId: 'da', fileName: 'Wallet app' });
const b = file({ connId: 'cb', fileKey: 'KEYB', docId: 'db', fileName: 'Wallet marketing', editorType: 'figjam' });
const c = file({ connId: 'cc', fileKey: null, docId: 'dc', fileName: 'Scratch' });

const pick = (r: ReturnType<typeof resolveFile>) => (r.ok ? r.file.connId : r.error);

describe('fileKeyFromUrl', () => {
    test('reads design, board, file and proto URLs', () => {
        expect(fileKeyFromUrl('https://www.figma.com/design/KEYA/Wallet?node-id=1-2')).toBe('KEYA');
        expect(fileKeyFromUrl('https://figma.com/board/KEYB/Map')).toBe('KEYB');
        expect(fileKeyFromUrl('https://www.figma.com/file/KEYC/Old')).toBe('KEYC');
        expect(fileKeyFromUrl('https://www.figma.com/proto/KEYD/Flow')).toBe('KEYD');
    });

    test('prefers the branch key', () => {
        expect(fileKeyFromUrl('https://www.figma.com/design/KEYA/branch/BRANCH1/Wallet')).toBe('BRANCH1');
    });

    test('returns null for text that is not a Figma URL', () => {
        expect(fileKeyFromUrl('Wallet app')).toBeNull();
        expect(fileKeyFromUrl('https://example.com/design/KEYA/x')).toBeNull();
    });
});

describe('resolveFile', () => {
    test('no files is an error', () => {
        const r = resolveFile([], undefined, null);
        expect(r.ok).toBe(false);
    });

    test('one file needs no target', () => {
        expect(pick(resolveFile([a], undefined, null))).toBe('ca');
    });

    test('several files without a target or pin is an error that lists them', () => {
        const r = resolveFile([a, b], undefined, null);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toContain('Wallet app');
        expect(r.error).toContain('Wallet marketing');
        expect(r.error).toContain('KEYA');
        expect(r.error).toContain('select_file');
    });

    test('matches a fileKey, a URL, a docId and a file name', () => {
        const files = [a, b, c];
        expect(pick(resolveFile(files, 'KEYB', null))).toBe('cb');
        expect(pick(resolveFile(files, 'https://www.figma.com/design/KEYA/Wallet?node-id=1-2', null))).toBe('ca');
        expect(pick(resolveFile(files, 'dc', null))).toBe('cc');
        expect(pick(resolveFile(files, 'scratch', null))).toBe('cc');
        expect(pick(resolveFile(files, 'marketing', null))).toBe('cb');
    });

    test('an exact name beats a substring match', () => {
        const short = file({ connId: 'cw', docId: 'dw', fileName: 'Wallet' });
        expect(pick(resolveFile([a, short], 'wallet', null))).toBe('cw');
    });

    test('an ambiguous name is an error', () => {
        const r = resolveFile([a, b], 'wallet', null);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('matches several');
    });

    test('an unknown target is an error that lists the files', () => {
        const r = resolveFile([a, b], 'NOPE', null);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('Wallet app');
    });

    test('a URL whose file is not open is an error', () => {
        const r = resolveFile([a, b], 'https://www.figma.com/design/OTHER/x', null);
        expect(r.ok).toBe(false);
    });

    test('the pin picks a file when there is no explicit target', () => {
        expect(pick(resolveFile([a, b], undefined, pinOf(b)))).toBe('cb');
    });

    test('an explicit target beats the pin', () => {
        expect(pick(resolveFile([a, b], 'KEYA', pinOf(b)))).toBe('ca');
    });

    test('the pin follows the file across a reconnect', () => {
        const back = { ...b, connId: 'cb2' };
        expect(pick(resolveFile([a, back], undefined, pinOf(b)))).toBe('cb2');
    });

    test('a pin without a fileKey matches by docId', () => {
        expect(pick(resolveFile([a, c], undefined, pinOf(c)))).toBe('cc');
    });

    test('a pinned file that is not connected is an error, even with one other file open', () => {
        const r = resolveFile([a], undefined, pinOf(b));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('Wallet marketing');
    });

    test('two connections with the same identity are ambiguous', () => {
        const copy = { ...a, connId: 'ca2' };
        const r = resolveFile([a, copy], 'KEYA', null);
        expect(r.ok).toBe(false);
    });
});

describe('summarize', () => {
    test('drops the connection id', () => {
        expect(summarize(a)).toEqual({ fileName: 'Wallet app', fileKey: 'KEYA', docId: 'da', editorType: 'figma', lastActiveAt: new Date(1).toISOString() });
    });
});
