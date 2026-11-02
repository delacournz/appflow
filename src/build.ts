import { readFile } from 'node:fs/promises';

export const STALE_FIX = 'Re-run Plugins → Development → AppFlow';

/** True when the plugin in Figma was built from different code than the server expects. */
export function stalePlugin(expected: string | null, actual: string | null): boolean {
    return expected !== null && expected !== actual;
}

/** The hash `scripts/build.ts` wrote to plugin/build.json, or null when absent. */
export async function readExpectedBuild(path: string): Promise<string | null> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        const build = typeof parsed === 'object' && parsed !== null ? (parsed as { build?: unknown }).build : undefined;
        return typeof build === 'string' ? build : null;
    } catch {
        return null;
    }
}
