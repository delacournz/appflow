/** Zod schemas for DesignSpec. Server only: the plugin bundle stays free of zod. */
import * as z from 'zod/v4';

import { normalizeHex, type DesignSpec } from '../../shared/design-spec';
import type { ComponentStyles } from '../../shared/design-style';

const hex = z.string().refine((s) => normalizeHex(s) !== null, { message: 'Expected a hex colour such as #A3A3A3 or #A3A3A3FF' }).transform((s) => normalizeHex(s) ?? s);

export const tokenValueSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('color'), hex }),
    z.object({ kind: z.literal('float'), value: z.number() }),
    z.object({ kind: z.literal('string'), value: z.string() }),
    z.object({ kind: z.literal('boolean'), value: z.boolean() }),
    z.object({ kind: z.literal('alias'), to: z.string().min(1) }),
]);

const codeSyntaxSchema = z.object({ WEB: z.string().optional(), ANDROID: z.string().optional(), iOS: z.string().optional() });

export const tokenSchema = z.object({
    name: z.string().min(1),
    type: z.enum(['color', 'float', 'string', 'boolean']),
    values: z.record(z.string(), tokenValueSchema),
    codeId: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    codeSyntax: codeSyntaxSchema.optional(),
    description: z.string().optional(),
    source: z.string().optional(),
    figmaId: z.string().optional(),
});

export const collectionSchema = z.object({
    name: z.string().min(1),
    modes: z.array(z.string()).min(1),
    tokens: z.array(tokenSchema).default([]),
    figmaId: z.string().optional(),
});

const unitValue = z.object({ unit: z.enum(['PIXELS', 'PERCENT']), value: z.number() });

export const textStyleSchema = z.object({
    name: z.string().min(1),
    fontFamily: z.string(),
    fontStyle: z.string(),
    fontSize: z.number(),
    lineHeight: z.union([z.object({ unit: z.literal('AUTO') }), unitValue]),
    letterSpacing: unitValue,
    codeId: z.string().optional(),
    source: z.string().optional(),
    figmaId: z.string().optional(),
});

export const componentSchema = z.object({
    name: z.string().min(1),
    axes: z.record(z.string(), z.array(z.string())).default({}),
    defaults: z.record(z.string(), z.string()).default({}),
    /** Produced by the extractor; only its outline is checked. */
    styles: z.custom<ComponentStyles>((v) => typeof v === 'object' && v !== null && 'base' in v && 'variants' in v).optional(),
    codeId: z.string().optional(),
    source: z.string().optional(),
    figmaId: z.string().optional(),
});

/** A whole or partial spec: missing lists default to empty. */
export const designSpecSchema = z.object({
    collections: z.array(collectionSchema).default([]),
    textStyles: z.array(textStyleSchema).default([]),
    components: z.array(componentSchema).default([]),
});

/** Parses a spec, throwing an Error that starts with `label`. */
export function parseSpec(value: unknown, label: string): DesignSpec {
    const r = designSpecSchema.safeParse(value);
    if (!r.success) throw new Error(`${label} is not a valid design spec:\n${z.prettifyError(r.error)}`);
    return r.data;
}
