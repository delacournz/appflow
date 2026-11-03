/**
 * Component styling read from Tailwind classes, as Figma properties. Plain types only (shared with the plugin).
 *
 * A `token` is a code token name such as `color/muted` or `spacing/button-lg`; the plugin binds the local
 * variable with that name. `value` is the fallback (or the only value, for scale steps like `gap-1.5`).
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Amount = { token?: string; value?: number };

export type StyleDecl =
    | { kind: 'fill'; token: string }
    | { kind: 'fill-none' }
    | { kind: 'stroke'; token: string }
    | { kind: 'stroke-none' }
    | ({ kind: 'stroke-weight' } & Amount)
    | ({ kind: 'radius' } & Amount)
    | ({ kind: 'size'; axis: 'width' | 'height' } & Amount)
    | ({ kind: 'padding'; side: Side } & Amount)
    | ({ kind: 'gap' } & Amount)
    | ({ kind: 'font-size' } & Amount)
    | { kind: 'text-fill'; token: string }
    | { kind: 'font-weight'; style: string }
    | { kind: 'opacity'; value: number }
    | { kind: 'layout'; mode: 'HORIZONTAL' | 'VERTICAL' }
    | { kind: 'align'; axis: 'primary' | 'counter'; value: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' };

/** Decls per slot. `root` is the component itself; other slots are child layers of the same name. */
export type SlotDecls = Record<string, StyleDecl[]>;

export type ComponentStyles = {
    base: SlotDecls;
    variants: Record<string, Record<string, SlotDecls>>;
    compound: { when: Record<string, string>; slots: SlotDecls }[];
    /** Classes the interpreter could not express, with the slot they were in. */
    unknown: string[];
};

/** The key two decls share when the later one replaces the earlier (like tailwind-merge). */
export function declKey(d: StyleDecl): string {
    switch (d.kind) {
        case 'fill':
        case 'fill-none':
            return 'fill';
        case 'stroke':
        case 'stroke-none':
            return 'stroke';
        case 'size':
            return `size:${d.axis}`;
        case 'padding':
            return `padding:${d.side}`;
        case 'align':
            return `align:${d.axis}`;
        default:
            return d.kind;
    }
}

/** Merges decl lists in order; a later decl replaces an earlier one with the same key. */
export function mergeDecls(...lists: StyleDecl[][]): StyleDecl[] {
    const out = new Map<string, StyleDecl>();
    for (const list of lists) for (const d of list) out.set(declKey(d), d);
    return [...out.values()];
}

/** The decls of each slot for one variant combination: base, then each axis option, then matching compounds. */
export function resolveSlots(styles: ComponentStyles, combo: Record<string, string>): SlotDecls {
    const layers: SlotDecls[] = [styles.base];
    for (const [axis, option] of Object.entries(combo)) {
        const s = styles.variants[axis]?.[option];
        if (s) layers.push(s);
    }
    for (const c of styles.compound) if (Object.entries(c.when).every(([a, o]) => combo[a] === o)) layers.push(c.slots);
    const slots = new Set(layers.flatMap((l) => Object.keys(l)));
    const out: SlotDecls = {};
    for (const slot of slots) out[slot] = mergeDecls(...layers.map((l) => l[slot] ?? []));
    return out;
}
