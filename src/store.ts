import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One Code Connect mapping, keyed by the Figma component (set) key. */
export type CodeConnectEntry = {
    componentName: string;
    source: string;
    label?: string;
    snippet?: string;
    snippetImports?: string[];
    figmaName: string;
    figmaNodeId: string;
    updatedAt: string;
};

/** Local Code Connect mappings in a JSON file, shared by every Figma file on this machine. */
export class CodeConnectStore {
    constructor(private readonly path: string) {}

    async all(): Promise<Record<string, CodeConnectEntry>> {
        try {
            return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, CodeConnectEntry>;
        } catch {
            return {};
        }
    }

    async set(key: string, entry: CodeConnectEntry): Promise<void> {
        const all = await this.all();
        all[key] = entry;
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
    }
}
