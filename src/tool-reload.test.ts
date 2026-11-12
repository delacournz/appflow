import { describe, expect, test } from 'bun:test';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { createServer, syncTools } from './mcp';
import { TOOLS, type ToolContext, type ToolDef } from './tools';

const ctx = { files: () => [], plugin: async () => ({ ok: false, error: 'x' }), session: { pinned: null } } as unknown as ToolContext;

describe('live tool reload', () => {
    test('syncTools adds, updates and removes tools and the client hears list_changed', async () => {
        const server = createServer(ctx);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        let heard: string[] | null = null;
        const mc = new Client(
            { name: 't', version: '0' },
            { listChanged: { tools: { debounceMs: 0, onChanged: (_e, items) => (heard = items?.map((t) => t.name) ?? null) } } },
        );
        await mc.connect(clientSide);

        const base = TOOLS.find((t) => t.name === 'figma_status') as ToolDef;
        const next: ToolDef[] = [
            ...TOOLS.filter((t) => t.name !== 'whoami').map((t) => (t.name === 'figma_status' ? { ...t, description: 'NEW DESCRIPTION' } : t)),
            { ...base, name: 'brand_new_tool', description: 'added live' },
        ];
        const changes = syncTools(server, next, ctx);
        expect(changes).toEqual({ added: ['brand_new_tool'], removed: ['whoami'], updated: expect.arrayContaining(['figma_status']) });

        const list = (await mc.listTools()).tools;
        const names = list.map((t) => t.name);
        expect(names).toContain('brand_new_tool');
        expect(names).not.toContain('whoami');
        expect(list.find((t) => t.name === 'figma_status')?.description).toBe('NEW DESCRIPTION');
        await Bun.sleep(50);
        expect(heard).not.toBeNull();
        expect(heard as unknown as string[]).toContain('brand_new_tool');
    });

    test('an unchanged list changes nothing', () => {
        const server = createServer(ctx);
        expect(syncTools(server, TOOLS, ctx)).toEqual({ added: [], removed: [], updated: [] });
    });
});
