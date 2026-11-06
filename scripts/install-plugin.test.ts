import { describe, expect, test } from 'bun:test';
import { addPlugin, type FigmaSettings, type LocalFileExtension } from './install-plugin';

const dir = '/repo/plugin';
const paths = { manifest: `${dir}/manifest.json`, code: `${dir}/code.js`, ui: `${dir}/ui.html` };
const other: LocalFileExtension = { id: 4, manifestPath: '/other/code.js', fileMetadata: { type: 'code', manifestFileId: 3 } };

describe('addPlugin', () => {
    test('adds linked manifest, code and ui entries', () => {
        const { settings, changed } = addPlugin({ zoomStop: 1 }, dir, paths, { name: 'AppFlow', id: 'x' });
        expect(changed).toBe(true);
        expect(settings.zoomStop).toBe(1);
        const list = settings.localFileExtensions ?? [];
        expect(list).toHaveLength(3);
        const [manifest, code, ui] = list;
        expect(manifest).toMatchObject({ id: 1, manifestPath: paths.manifest, lastKnownName: 'AppFlow', lastKnownPluginId: 'x', fileMetadata: { type: 'manifest', codeFileId: 2, uiFileIds: [3] } });
        expect(code).toMatchObject({ id: 2, manifestPath: paths.code, fileMetadata: { type: 'code', manifestFileId: 1 } });
        expect(ui).toMatchObject({ id: 3, manifestPath: paths.ui, fileMetadata: { type: 'ui', manifestFileId: 1 } });
    });

    test('keeps other plugins and ids above the existing max', () => {
        const { settings } = addPlugin({ localFileExtensions: [other] }, dir, paths, { name: 'AppFlow', id: 'x' });
        const list = settings.localFileExtensions ?? [];
        expect(list[0]).toEqual(other);
        expect(list.slice(1).map((e) => e.id)).toEqual([5, 6, 7]);
    });

    test('replaces stale entries inside the plugin dir', () => {
        const stale: FigmaSettings = {
            localFileExtensions: [other, { id: 7, manifestPath: paths.code, fileMetadata: { type: 'code', manifestFileId: 6 } }, { id: 9, manifestPath: paths.manifest, fileMetadata: { type: 'manifest', codeFileId: 7, uiFileIds: [] } }],
        };
        const { settings } = addPlugin(stale, dir, paths, { name: 'AppFlow', id: 'x' });
        const list = settings.localFileExtensions ?? [];
        expect(list.filter((e) => e.manifestPath.startsWith(dir))).toHaveLength(3);
        expect(list).toContainEqual(other);
    });

    test('is a no-op when already installed cleanly', () => {
        const first = addPlugin({}, dir, paths, { name: 'AppFlow', id: 'x' }).settings;
        expect(addPlugin(first, dir, paths, { name: 'AppFlow', id: 'x' }).changed).toBe(false);
    });
});
