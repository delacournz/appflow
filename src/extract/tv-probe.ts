/**
 * Runs in a child `bun` process with cwd = the project root, so project imports and tsconfig paths resolve and
 * project code never runs inside the MCP server. argv[2] is a JSON list of `{ ref, file, name }`. Prints one JSON
 * list of ProbeEntry to stdout.
 */
type Classes = string | string[] | undefined | null;
type SlotValue = Classes | Record<string, Classes>;
type TvLike = {
    base?: Classes;
    slots?: Record<string, Classes>;
    variants?: Record<string, Record<string, SlotValue>>;
    defaultVariants?: Record<string, unknown>;
    compoundVariants?: Record<string, unknown>[];
};

const join = (c: Classes): string => (Array.isArray(c) ? c.join(' ') : (c ?? '')).trim();
const slotMap = (v: SlotValue): Record<string, string> => {
    if (v === null || v === undefined || typeof v === 'string' || Array.isArray(v)) return { root: join(v) };
    return Object.fromEntries(Object.entries(v).map(([k, c]) => [k === 'base' ? 'root' : k, join(c)]));
};

const refs = JSON.parse(process.argv[2] ?? '[]') as { ref: string; file: string; name: string }[];
const out: unknown[] = [];
for (const { ref, file, name } of refs) {
    try {
        const mod = (await import(file)) as Record<string, unknown>;
        const exported = mod[name];
        const tv = exported as unknown as TvLike;
        if (typeof exported !== 'function' || typeof tv.variants !== 'object') throw new Error(`export ${name} is not a tailwind-variants result`);
        const slots: Record<string, string> = { root: join(tv.base) };
        for (const [k, c] of Object.entries(tv.slots ?? {})) {
            const key = k === 'base' ? 'root' : k;
            slots[key] = `${slots[key] ?? ''} ${join(c)}`.trim();
        }
        const variants: Record<string, Record<string, Record<string, string>>> = {};
        for (const [axis, options] of Object.entries(tv.variants ?? {})) {
            variants[axis] = Object.fromEntries(Object.entries(options).map(([o, v]) => [o, slotMap(v)]));
        }
        const compoundVariants = (tv.compoundVariants ?? []).map((cv) => {
            const when: Record<string, string[]> = {};
            let cls: SlotValue = undefined;
            for (const [k, v] of Object.entries(cv)) {
                if (k === 'class' || k === 'className') cls = v as SlotValue;
                else when[k] = (Array.isArray(v) ? v : [v]).map(String);
            }
            return { when, slots: slotMap(cls) };
        });
        const defaultVariants = Object.fromEntries(Object.entries(tv.defaultVariants ?? {}).map(([k, v]) => [k, String(v)]));
        out.push({ ref, ok: true, slots, variants, defaultVariants, compoundVariants });
    } catch (error) {
        out.push({ ref, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
}
process.stdout.write(JSON.stringify(out));

export {};
