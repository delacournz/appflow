/**
 * tailwind-variants `tv()` results to SpecComponents: axes, defaults and per-slot styles.
 *
 * Each ref is `path#export`. The files are imported by `tv-probe.ts` in a child bun process (cwd = project root),
 * so their imports resolve as in the project and none of their code runs in the server.
 */
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { SpecComponent } from '../../shared/design-spec';
import { mergeDecls, type ComponentStyles, type SlotDecls } from '../../shared/design-style';
import { interpretClasses } from './tw-classes';

type Slots = Record<string, string>;
export type ProbeEntry =
    | { ref: string; ok: true; slots: Slots; variants: Record<string, Record<string, Slots>>; defaultVariants: Record<string, string>; compoundVariants: { when: Record<string, string[]>; slots: Slots }[] }
    | { ref: string; ok: false; error: string };

const PROBE = join(import.meta.dir, 'tv-probe.ts');
const PROBE_TIMEOUT_MS = 30_000;

function splitRef(root: string, ref: string): { ref: string; file: string; name: string } {
    const hash = ref.lastIndexOf('#');
    if (hash <= 0) throw new Error(`Component ref ${ref} must be "path#export".`);
    const file = resolve(root, ref.slice(0, hash));
    const rel = relative(resolve(root), file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Component ref ${ref} is outside the project root ${root}.`);
    return { ref, file, name: ref.slice(hash + 1) };
}

export async function probeVariants(root: string, refs: string[]): Promise<ProbeEntry[]> {
    const targets = refs.map((r) => splitRef(root, r));
    if (targets.length === 0) return [];
    const proc = Bun.spawn([process.execPath, 'run', PROBE, JSON.stringify(targets)], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Reading tailwind-variants failed (exit ${code}): ${stderr.trim().slice(0, 2000)}`);
    return JSON.parse(stdout) as ProbeEntry[];
}

type Tokens = ReadonlyMap<string, number | null>;

function slotDecls(slots: Slots, tokens: Tokens, label: string, unknown: string[]): SlotDecls {
    const out: SlotDecls = {};
    for (const [slot, classes] of Object.entries(slots)) {
        if (!classes) continue;
        const r = interpretClasses(classes, tokens);
        if (r.decls.length) out[slot] = r.decls;
        for (const u of r.unknown) unknown.push(`${label} ${slot}: ${u}`);
    }
    return out;
}

/** Every single-value combination of a compound's conditions. */
function expand(when: Record<string, string[]>): Record<string, string>[] {
    let combos: Record<string, string>[] = [{}];
    for (const [axis, values] of Object.entries(when)) combos = combos.flatMap((c) => values.map((v) => ({ ...c, [axis]: v })));
    return combos;
}

const mergeSlots = (...layers: SlotDecls[]): SlotDecls => {
    const out: SlotDecls = {};
    for (const slot of new Set(layers.flatMap((l) => Object.keys(l)))) out[slot] = mergeDecls(...layers.map((l) => l[slot] ?? []));
    return out;
};

/**
 * Axes that do not become Figma variants are fixed at their code default: that option's classes join the base,
 * and a compound condition on such an axis holds only for the default (dropped otherwise).
 */
function fixLeftOutAxes(styles: ComponentStyles, kept: Record<string, string[]>, defaults: Record<string, string | boolean>): ComponentStyles {
    const fixed = Object.keys(styles.variants).filter((a) => !(a in kept));
    const def = (a: string) => (defaults[a] === undefined ? undefined : String(defaults[a]));
    const layers = [styles.base, ...fixed.flatMap((a) => { const d = def(a); const s = d === undefined ? undefined : styles.variants[a]?.[d]; return s ? [s] : []; })];
    const compound: ComponentStyles['compound'] = [];
    for (const c of styles.compound) {
        const when: Record<string, string> = {};
        let holds = true;
        for (const [a, o] of Object.entries(c.when)) {
            if (a in kept) when[a] = o;
            else if (def(a) !== o) holds = false;
        }
        if (!holds) continue;
        if (Object.keys(when).length) compound.push({ when, slots: c.slots });
        else layers.push(c.slots);
    }
    return { ...styles, base: mergeSlots(...layers), variants: Object.fromEntries(Object.entries(styles.variants).filter(([a]) => a in kept)), compound };
}

/** A component's tv() ref, optionally limited to the axes that should become Figma variants. */
export type ComponentRef = string | { ref: string; axes?: string[] };
export const refOf = (r: ComponentRef): string => (typeof r === 'string' ? r : r.ref);

/** `names` maps a component name to its ref. */
export function componentsFromProbe(entries: ProbeEntry[], names: Record<string, ComponentRef>, tokens: Tokens): { components: SpecComponent[]; warnings: string[] } {
    const warnings: string[] = [];
    const components: SpecComponent[] = [];
    for (const [name, target] of Object.entries(names)) {
        const ref = refOf(target);
        const only = typeof target === 'string' ? undefined : target.axes;
        const e = entries.find((x) => x.ref === ref);
        if (!e || !e.ok) {
            warnings.push(`Skipped component ${name}: ${ref} ${e && !e.ok ? e.error : 'was not read'}.`);
            continue;
        }
        const unknown: string[] = [];
        const styles: ComponentStyles = {
            base: slotDecls(e.slots, tokens, 'base', unknown),
            variants: Object.fromEntries(Object.entries(e.variants).map(([axis, opts]) => [axis, Object.fromEntries(Object.entries(opts).map(([o, s]) => [o, slotDecls(s, tokens, `${axis}.${o}`, unknown)]))])),
            compound: e.compoundVariants.flatMap((cv) => {
                const slots = slotDecls(cv.slots, tokens, 'compound', unknown);
                return expand(cv.when).map((when) => ({ when, slots }));
            }),
            unknown: [...new Set(unknown)],
        };
        for (const a of only ?? []) if (!(a in e.variants)) warnings.push(`Component ${name}: axis ${a} is not in ${ref}.`);
        const axes = Object.fromEntries(
            Object.entries(e.variants)
                .filter(([axis]) => !only || only.includes(axis))
                .map(([axis, opts]) => [axis, Object.keys(opts)]),
        );
        const defaults = Object.fromEntries(Object.entries(e.defaultVariants).filter(([axis]) => axis in axes));
        components.push({ name, axes, defaults, codeId: `tv:${ref}`, source: ref.slice(0, ref.lastIndexOf('#')), styles: fixLeftOutAxes(styles, axes, e.defaultVariants) });
    }
    return { components, warnings };
}
