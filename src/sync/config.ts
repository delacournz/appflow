/** `appflow.design.json`: where a project's code design system comes from, and how its names map to Figma. */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import * as z from 'zod/v4';

import { emptySpec, type DesignSpec } from '../../shared/design-spec';
import type { DesignMapping } from './diff';
import { extractTailwindCss, type CssFile } from '../extract/tailwind-css';
import { componentsFromProbe, probeVariants, refOf } from '../extract/tailwind-variants';
import { parseSpec } from './spec-schema';

export const CONFIG_FILE = 'appflow.design.json';

const ref = z.string().regex(/.#./, 'expected "path#export"');

const sourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('spec-json'), path: z.string().min(1) }),
    z.object({
        kind: z.literal('tailwind-css'),
        /** CSS files in cascade order, such as tokens.css then theme.css. */
        paths: z.array(z.string().min(1)).min(1),
        modes: z.array(z.string()).optional(),
        primitives: z.string().optional(),
        tokens: z.string().optional(),
        textStylePrefix: z.string().optional(),
        fontFamily: z.string().optional(),
    }),
    z.object({
        kind: z.literal('tailwind-variants'),
        /** Component name to `path#export` of its tv() result. Only these files are imported. */
        components: z.record(z.string(), z.union([ref, z.object({ ref, axes: z.array(z.string()).optional() })])),
    }),
]);
export type DesignSource = z.output<typeof sourceSchema>;

const names = z.record(z.string(), z.string()).default({});
const globs = z.array(z.string()).default([]);

const configSchema = z.object({
    sources: z.array(sourceSchema),
    rename: z.object({ tokens: names, textStyles: names, components: names }).default({ tokens: {}, textStyles: {}, components: {} }),
    ignore: z.object({ tokens: globs, textStyles: globs, components: globs }).default({ tokens: [], textStyles: [], components: [] }),
    variants: z.record(z.string(), z.record(z.string(), z.object({ axis: z.string().optional(), options: z.record(z.string(), z.string()).optional() }))).default({}),
    variantDefaults: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    layers: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export type DesignConfig = { sources: DesignSource[]; mapping: DesignMapping };

async function readJson(path: string, missing: string): Promise<unknown> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        throw new Error(missing);
    }
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function loadDesignConfig(root: string): Promise<DesignConfig> {
    const path = join(root, CONFIG_FILE);
    const value = await readJson(path, `No ${CONFIG_FILE} at ${path}. Create one with a "sources" list, for example {"sources":[{"kind":"spec-json","path":"design/spec.json"}]}.`);
    const r = configSchema.safeParse(value);
    if (!r.success) throw new Error(`${path} is invalid:\n${z.prettifyError(r.error)}`);
    const { sources, rename, ignore, variants, variantDefaults, layers } = r.data;
    return { sources, mapping: { rename, ignore, variants, variantDefaults, layers } };
}

/** Resolves `path` under `root`, refusing anything that escapes it. */
function inside(root: string, path: string): string {
    const abs = resolve(root, path);
    const rel = relative(resolve(root), abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Source ${path} is outside the project root ${root}.`);
    return abs;
}

function merge(into: DesignSpec, part: DesignSpec): void {
    for (const c of part.collections) {
        const existing = into.collections.find((x) => x.name === c.name);
        if (existing) existing.tokens.push(...c.tokens);
        else into.collections.push({ ...c, tokens: [...c.tokens] });
    }
    into.textStyles.push(...part.textStyles);
    into.components.push(...part.components);
}

/** Token name to its float value (null for colours and aliases), for the class interpreter. */
function tokenValues(spec: DesignSpec): Map<string, number | null> {
    const out = new Map<string, number | null>();
    for (const c of spec.collections) {
        for (const t of c.tokens) {
            const v = Object.values(t.values)[0];
            out.set(t.name, v?.kind === 'float' ? v.value : null);
        }
    }
    return out;
}

/**
 * Reads every source and merges them into one spec. Extractor warnings go to `warnings`. Component sources run
 * last, so their classes bind to the tokens of every other source.
 */
export async function readCodeSpec(root: string, sources: DesignSource[], warnings: string[] = []): Promise<DesignSpec> {
    const spec = emptySpec();
    const ordered = [...sources.filter((s) => s.kind !== 'tailwind-variants'), ...sources.filter((s) => s.kind === 'tailwind-variants')];
    for (const source of ordered) {
        switch (source.kind) {
            case 'spec-json': {
                const path = inside(root, source.path);
                merge(spec, parseSpec(await readJson(path, `Source ${path} does not exist.`), path));
                break;
            }
            case 'tailwind-css': {
                const files: CssFile[] = [];
                for (const p of source.paths) {
                    const abs = inside(root, p);
                    let css: string;
                    try {
                        css = await readFile(abs, 'utf8');
                    } catch {
                        throw new Error(`Source ${abs} does not exist.`);
                    }
                    files.push({ path: p, css });
                }
                const { paths: _paths, kind: _kind, ...options } = source;
                const out = extractTailwindCss(files, options);
                warnings.push(...out.warnings);
                merge(spec, out.spec);
                break;
            }
            case 'tailwind-variants': {
                const entries = await probeVariants(root, Object.values(source.components).map(refOf));
                const out = componentsFromProbe(entries, source.components, tokenValues(spec));
                warnings.push(...out.warnings);
                spec.components.push(...out.components);
                break;
            }
        }
    }
    return spec;
}

/** `*` matches any run of characters, `/` included. Everything else is literal. */
export function matchesGlob(value: string, glob: string): boolean {
    const pattern = glob
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${pattern}$`).test(value);
}
