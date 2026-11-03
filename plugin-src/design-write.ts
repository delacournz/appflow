/** Pure helpers for applying sync ops. No `figma` global. */
import type { SyncOp } from '../shared/design-ops';
import { normalizeHex } from '../shared/design-spec';

export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
    const n = normalizeHex(hex);
    if (!n) throw new Error(`Not a hex colour: ${hex}`);
    const ch = (i: number) => Number.parseInt(n.slice(i, i + 2), 16) / 255;
    return { r: ch(1), g: ch(3), b: ch(5), a: ch(7) };
}

/** A collection's mode id by name (any case). A single-mode collection matches any name. */
export function modeIdFor(modes: readonly { modeId: string; name: string }[], name: string): string | null {
    const hit = modes.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.modeId;
    return modes.length === 1 ? (modes[0]?.modeId ?? null) : null;
}

/**
 * Apply order: 0 collections and modes, 1 creates and renames, 2 values and styling (so an alias or a binding
 * can point at a token created in phase 1), 3 removals.
 */
export function phaseOf(op: SyncOp): number {
    switch (op.op) {
        case 'create-collection':
        case 'add-mode':
            return 0;
        case 'style-component':
            return 2;
        case 'orphan-token':
        case 'orphan-text-style':
        case 'orphan-component':
        case 'orphan-variant-axis':
        case 'orphan-variant-option':
            return 3;
        default:
            return 1;
    }
}

export const fontAvailable = (fonts: readonly { fontName: { family: string; style: string } }[], family: string, style: string): boolean =>
    fonts.some((f) => f.fontName.family === family && f.fontName.style === style);

/** `Tone=Info, Size=Small` to `{ Tone: 'Info', Size: 'Small' }`. */
export function parseVariantName(name: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of name.split(',')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}

export const formatVariantName = (props: Record<string, string>): string =>
    Object.entries(props)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');

/** Renames `axis` to `to` in place (keeping its position) and maps its value through `options`. */
export function renameVariantProps(props: Record<string, string>, axis: string, to: string, options: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) {
        if (k === axis) out[to] = options[v] ?? v;
        else out[k] = v;
    }
    return out;
}

export type SlotTarget = { kind: 'root' } | { kind: 'skip' } | { kind: 'layer'; name: string };

/** Where a code slot's classes go: the variant itself (`root`, or a slot mapped to "root"), nowhere (mapped to ""), or a named layer. */
export function slotTarget(slot: string, layers: Record<string, string>): SlotTarget {
    const mapped = layers[slot];
    if (mapped === '') return { kind: 'skip' };
    if (mapped === 'root' || (mapped === undefined && slot === 'root')) return { kind: 'root' };
    return { kind: 'layer', name: mapped ?? slot };
}

/** A Figma variant's props as code axis and option names (any case); props code does not know are dropped. */
export function codeCombo(props: Record<string, string>, axes: Record<string, string[]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) {
        const axis = Object.keys(axes).find((a) => a.toLowerCase() === k.toLowerCase());
        const option = axis ? axes[axis]?.find((o) => o.toLowerCase() === v.toLowerCase()) : undefined;
        if (axis && option) out[axis] = option;
    }
    return out;
}
