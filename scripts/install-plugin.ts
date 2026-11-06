/**
 * Registers plugin/manifest.json as a development plugin in the Figma desktop app,
 * the same as Plugins → Development → Import plugin from manifest…
 *
 * Figma keeps imported dev plugins in its settings.json (`localFileExtensions`) and
 * rewrites that file on quit, so the app is quit first, patched, then reopened.
 * This format is undocumented; a backup is written next to settings.json.
 *
 * Usage: bun run scripts/install-plugin.ts [--no-restart] [--dry-run]
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

type ManifestMeta = { type: 'manifest'; codeFileId: number; uiFileIds: number[] };
type FileMeta = { type: 'code' | 'ui'; manifestFileId: number };

export type LocalFileExtension = {
    id: number;
    manifestPath: string;
    lastKnownName?: string;
    lastKnownPluginId?: string;
    cachedContainsWidget?: boolean;
    fileMetadata: ManifestMeta | FileMeta;
};

export type FigmaSettings = { localFileExtensions?: LocalFileExtension[]; [key: string]: unknown };
type Paths = { manifest: string; code: string; ui: string };
type PluginInfo = { name: string; id: string };

const inside = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/** True when the plugin dir holds exactly one manifest entry wired to one code and one ui entry. */
function isInstalled(ours: LocalFileExtension[], paths: Paths, info: PluginInfo): boolean {
    if (ours.length !== 3) return false;
    const manifest = ours.find((e) => e.fileMetadata.type === 'manifest');
    if (!manifest || manifest.fileMetadata.type !== 'manifest') return false;
    if (manifest.manifestPath !== paths.manifest || manifest.lastKnownName !== info.name || manifest.lastKnownPluginId !== info.id) return false;
    const { codeFileId, uiFileIds } = manifest.fileMetadata;
    const linked = (id: number | undefined, type: 'code' | 'ui', path: string) => {
        const entry = ours.find((e) => e.id === id);
        return entry?.manifestPath === path && entry.fileMetadata.type === type && entry.fileMetadata.manifestFileId === manifest.id;
    };
    return uiFileIds.length === 1 && linked(codeFileId, 'code', paths.code) && linked(uiFileIds[0], 'ui', paths.ui);
}

/** Returns settings with the plugin's entries replaced by a fresh linked set. Pure. */
export function addPlugin(settings: FigmaSettings, pluginDir: string, paths: Paths, info: PluginInfo): { settings: FigmaSettings; changed: boolean } {
    const list = settings.localFileExtensions ?? [];
    const ours = list.filter((e) => inside(pluginDir, e.manifestPath));
    if (isInstalled(ours, paths, info)) return { settings, changed: false };

    const rest = list.filter((e) => !inside(pluginDir, e.manifestPath));
    const base = rest.reduce((max, e) => Math.max(max, e.id), 0);
    const [manifestId, codeId, uiId] = [base + 1, base + 2, base + 3];
    const added: LocalFileExtension[] = [
        { id: manifestId, manifestPath: paths.manifest, lastKnownName: info.name, lastKnownPluginId: info.id, fileMetadata: { type: 'manifest', codeFileId: codeId, uiFileIds: [uiId] }, cachedContainsWidget: false },
        { id: codeId, manifestPath: paths.code, fileMetadata: { type: 'code', manifestFileId: manifestId } },
        { id: uiId, manifestPath: paths.ui, fileMetadata: { type: 'ui', manifestFileId: manifestId } },
    ];
    return { settings: { ...settings, localFileExtensions: [...rest, ...added] }, changed: true };
}

function settingsPath(): string {
    if (platform() === 'darwin') return join(homedir(), 'Library/Application Support/Figma/settings.json');
    if (platform() === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Figma/settings.json');
    throw new Error('Figma desktop only runs on macOS and Windows.');
}

const figmaRunning = () => platform() === 'darwin' && Bun.spawnSync(['pgrep', '-x', 'Figma']).exitCode === 0;

async function quitFigma(): Promise<void> {
    Bun.spawnSync(['osascript', '-e', 'quit app "Figma"']);
    for (let i = 0; i < 60 && figmaRunning(); i++) await Bun.sleep(250);
    if (figmaRunning()) throw new Error('Figma did not quit. Close it and run this again.');
}

async function main(): Promise<void> {
    const args = new Set(process.argv.slice(2));
    const dryRun = args.has('--dry-run');
    const restart = !args.has('--no-restart');

    const pluginDir = resolve(import.meta.dir, '../plugin');
    const paths: Paths = { manifest: join(pluginDir, 'manifest.json'), code: join(pluginDir, 'code.js'), ui: join(pluginDir, 'ui.html') };
    if (!existsSync(paths.code) || !existsSync(paths.ui)) throw new Error('plugin/ is not built. Run `bun run build` first.');
    const manifest: { name: string; id: string } = await Bun.file(paths.manifest).json();

    const file = settingsPath();
    if (!existsSync(file)) throw new Error(`No Figma settings at ${file}. Install and open the Figma desktop app once first.`);

    const current: FigmaSettings = await Bun.file(file).json();
    const { settings, changed } = addPlugin(current, pluginDir, paths, { name: manifest.name, id: manifest.id });
    if (!changed) return console.log(`✅ ${manifest.name} is already in Figma → Plugins → Development.`);
    if (dryRun) return console.log(JSON.stringify(settings.localFileExtensions, null, 2));

    const wasRunning = figmaRunning();
    if (wasRunning) {
        if (!restart) throw new Error('Figma is running and rewrites its settings on quit. Close it, or drop --no-restart.');
        console.log('Quitting Figma to register the plugin…');
        await quitFigma();
    } else if (platform() === 'win32') {
        console.log('Make sure Figma is closed, or it will overwrite this change on quit.');
    }

    // Re-read: Figma may have written settings while quitting.
    const fresh: FigmaSettings = await Bun.file(file).json();
    await Bun.write(`${file}.appflow-backup`, JSON.stringify(fresh));
    await Bun.write(file, JSON.stringify(addPlugin(fresh, pluginDir, paths, { name: manifest.name, id: manifest.id }).settings));
    console.log(`✅ Added ${manifest.name} to Figma → Plugins → Development (backup: ${file}.appflow-backup)`);

    if (restart && platform() === 'darwin') Bun.spawnSync(['open', '-a', 'Figma']);
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
