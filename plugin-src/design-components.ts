/**
 * Component ops: variant renames, new axes and options (cloned from the default variant), new component sets,
 * code links, and styling each variant from its code classes. Variants are only removed with prune.
 */
import type { ApplyResult, ComponentOp } from '../shared/design-ops';
import { CODE_ID_KEY, PLUGIN_DATA_NAMESPACE, type SpecComponent } from '../shared/design-spec';
import { resolveSlots, type Amount, type StyleDecl } from '../shared/design-style';
import { codeCombo, fontAvailable, formatVariantName, paddingResets, parseVariantName, renameVariantProps, slotTarget, solidFrom } from './design-write';

export type ComponentState = {
    result: ApplyResult;
    /** Code token name (`color/muted`) to variable. */
    byName: Map<string, Variable>;
    fonts: Font[] | null;
    /** Component sets created in this run, by code name. */
    created: Map<string, ComponentSetNode>;
};

const CODE_PAGE = 'Code components';
const GAP = 24;

async function nodeFor(op: { component: string; figmaId?: string }, s: ComponentState): Promise<ComponentSetNode | ComponentNode> {
    const made = s.created.get(op.component);
    if (made) return made;
    const node = op.figmaId ? await figma.getNodeByIdAsync(op.figmaId) : null;
    if (!node || (node.type !== 'COMPONENT_SET' && node.type !== 'COMPONENT')) throw new Error('component not found');
    return node;
}

async function setFor(op: { component: string; figmaId?: string }, s: ComponentState): Promise<ComponentSetNode> {
    const node = await nodeFor(op, s);
    if (node.type !== 'COMPONENT_SET') throw new Error(`${node.name} is a single component, not a variant set`);
    return node;
}

/** A set's variants, or a single component as its only variant. */
const variants = (node: ComponentSetNode | ComponentNode): ComponentNode[] =>
    node.type === 'COMPONENT' ? [node] : node.children.filter((c): c is ComponentNode => c.type === 'COMPONENT');

/** Clones the default variant with `props`, below the set's current contents. Skips a combination that exists. */
function cloneVariant(set: ComponentSetNode, props: Record<string, string>, s: ComponentState): void {
    const name = formatVariantName(props);
    if (variants(set).some((v) => v.name === name)) return;
    const base = set.defaultVariant;
    const copy = base.clone();
    set.appendChild(copy);
    copy.name = name;
    const bottom = Math.max(...set.children.filter((c) => c !== copy).map((c) => c.y + c.height));
    copy.x = base.x;
    copy.y = bottom + GAP;
    s.result.created.push(copy.id);
}

async function createSet(component: SpecComponent, s: ComponentState): Promise<ComponentSetNode> {
    let page = figma.root.children.find((p) => p.name === CODE_PAGE);
    if (!page) {
        page = figma.createPage();
        page.name = CODE_PAGE;
    }
    await page.loadAsync();
    const combos: Record<string, string>[] = [{ ...component.defaults }];
    for (const [axis, options] of Object.entries(component.axes)) {
        const def = component.defaults[axis] ?? options[0];
        if (combos[0] && def !== undefined) combos[0][axis] = def;
        for (const o of options) if (o !== def) combos.push({ ...combos[0], [axis]: o });
    }
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    const nodes = combos.map((combo, i) => {
        const c = figma.createComponent();
        c.layoutMode = 'HORIZONTAL';
        c.primaryAxisSizingMode = 'AUTO';
        c.counterAxisSizingMode = 'AUTO';
        c.paddingLeft = c.paddingRight = 16;
        c.paddingTop = c.paddingBottom = 12;
        const label = figma.createText();
        label.name = 'label';
        label.characters = component.name;
        c.appendChild(label);
        c.name = Object.keys(combo).length ? formatVariantName(combo) : 'Default';
        c.y = i * 64;
        page.appendChild(c);
        return c;
    });
    const right = Math.max(0, ...page.children.filter((n) => !nodes.includes(n as ComponentNode)).map((n) => n.x + n.width));
    const set = figma.combineAsVariants(nodes, page);
    set.name = component.name;
    set.x = right + 200;
    if (component.codeId) set.setSharedPluginData(PLUGIN_DATA_NAMESPACE, CODE_ID_KEY, component.codeId);
    s.created.set(component.name, set);
    s.result.created.push(set.id);
    return set;
}

export async function componentOp(op: Exclude<ComponentOp, { op: 'style-component' }>, s: ComponentState, prune: boolean): Promise<'done' | string> {
    switch (op.op) {
        case 'create-component':
            await createSet(op.component, s);
            return 'done';
        case 'rename-variant': {
            const set = await setFor(op, s);
            for (const v of variants(set)) v.name = formatVariantName(renameVariantProps(parseVariantName(v.name), op.axis, op.to, op.options));
            s.result.updated.push(set.id);
            return 'done';
        }
        case 'add-variant-axis': {
            const set = await setFor(op, s);
            for (const v of variants(set)) v.name = formatVariantName({ ...parseVariantName(v.name), [op.axis]: op.existing });
            const base = parseVariantName(set.defaultVariant.name);
            for (const o of op.options) if (o !== op.existing) cloneVariant(set, { ...base, [op.axis]: o }, s);
            s.result.updated.push(set.id);
            return 'done';
        }
        case 'add-variant-option': {
            const set = await setFor(op, s);
            cloneVariant(set, { ...parseVariantName(set.defaultVariant.name), [op.axis]: op.option }, s);
            return 'done';
        }
        case 'link-component': {
            const set = await nodeFor(op, s);
            if (op.codeId) set.setSharedPluginData(PLUGIN_DATA_NAMESPACE, CODE_ID_KEY, op.codeId);
            s.result.updated.push(set.id);
            return 'done';
        }
        case 'orphan-variant-option': {
            if (!prune) return 'variant kept: pass prune: true to remove it';
            const set = await setFor(op, s);
            const doomed = variants(set).filter((v) => parseVariantName(v.name)[op.axis] === op.option);
            if (doomed.length === variants(set).length) return 'kept: it is every variant of the set';
            for (const v of doomed) {
                s.result.removed.push(v.id);
                v.remove();
            }
            return 'done';
        }
        case 'orphan-variant-axis':
        case 'orphan-component':
            return 'Figma-only axes and components are reported, never removed';
    }
}

/** The node for a slot (see slotTarget): the variant, the first descendant with the layer name, or 'skip'. */
function slotNode(variant: ComponentNode, slot: string, layers: Record<string, string>): SceneNode | 'skip' | null {
    const target = slotTarget(slot, layers);
    if (target.kind === 'skip') return 'skip';
    if (target.kind === 'root') return variant;
    const name = target.name.toLowerCase();
    return variant.findOne((n) => n.name.toLowerCase() === name);
}

/** A solid paint bound to the token's variable, seeded with its value for `node` (the base colour is what renders). */
function paint(token: string, s: ComponentState, node: SceneNode): SolidPaint {
    const v = s.byName.get(token);
    if (!v) throw new Error(`variable ${token} does not exist`);
    const solid = solidFrom(v.resolveForConsumer(node).value);
    if (!solid) throw new Error(`variable ${token} is not a colour`);
    return figma.variables.setBoundVariableForPaint({ type: 'SOLID', ...solid }, 'color', v);
}

type Bindable = Parameters<FrameNode['setBoundVariable']>[0];

/** Binds `field` to the amount's variable, or sets its value. */
function amount(node: SceneNode, field: Bindable, a: Amount, s: ComponentState, set: (n: number) => void): void {
    const v = a.token ? s.byName.get(a.token) : undefined;
    if (v && 'setBoundVariable' in node) {
        (node as FrameNode).setBoundVariable(field, v);
        return;
    }
    if (a.value === undefined) throw new Error(`variable ${a.token ?? '?'} does not exist`);
    set(a.value);
}

const texts = (node: SceneNode): TextNode[] => (node.type === 'TEXT' ? [node] : 'findAllWithCriteria' in node ? node.findAllWithCriteria({ types: ['TEXT'] }) : []);

async function loadText(t: TextNode): Promise<FontName> {
    if (t.fontName === figma.mixed) throw new Error(`text ${t.name} mixes fonts`);
    await figma.loadFontAsync(t.fontName);
    return t.fontName;
}

async function apply(node: SceneNode, d: StyleDecl, s: ComponentState): Promise<void> {
    const frame = node as FrameNode;
    switch (d.kind) {
        case 'fill':
            if ('fills' in node) frame.fills = [paint(d.token, s, node)];
            return;
        case 'fill-none':
            if ('fills' in node) frame.fills = [];
            return;
        case 'stroke':
            if ('strokes' in node) frame.strokes = [paint(d.token, s, node)];
            return;
        case 'stroke-none':
            if ('strokes' in node) frame.strokes = [];
            return;
        case 'stroke-weight':
            amount(node, 'strokeWeight', d, s, (n) => (frame.strokeWeight = n));
            return;
        case 'radius':
            for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'] as const) amount(node, f, d, s, (n) => (frame[f] = n));
            return;
        case 'size':
            if (d.axis === 'width' && 'layoutSizingHorizontal' in node) frame.layoutSizingHorizontal = 'FIXED';
            if (d.axis === 'height' && 'layoutSizingVertical' in node) frame.layoutSizingVertical = 'FIXED';
            amount(node, d.axis, d, s, (n) => frame.resize(d.axis === 'width' ? n : frame.width, d.axis === 'height' ? n : frame.height));
            return;
        case 'padding': {
            if (!('layoutMode' in node) || frame.layoutMode === 'NONE') throw new Error(`${node.name} has no auto layout for padding`);
            const field = `padding${d.side.charAt(0).toUpperCase()}${d.side.slice(1)}` as 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft';
            amount(node, field, d, s, (n) => (frame[field] = n));
            return;
        }
        case 'gap':
            if (!('layoutMode' in node) || frame.layoutMode === 'NONE') throw new Error(`${node.name} has no auto layout for gap`);
            amount(node, 'itemSpacing', d, s, (n) => (frame.itemSpacing = n));
            return;
        case 'layout':
            if ('layoutMode' in node) frame.layoutMode = d.mode;
            return;
        case 'align':
            if (!('layoutMode' in node) || frame.layoutMode === 'NONE') return;
            if (d.axis === 'primary') frame.primaryAxisAlignItems = d.value;
            else if (d.value !== 'SPACE_BETWEEN') frame.counterAxisAlignItems = d.value;
            return;
        case 'opacity':
            if ('opacity' in node) frame.opacity = d.value;
            return;
        case 'text-fill':
            for (const t of texts(node)) {
                await loadText(t);
                t.fills = [paint(d.token, s, t)];
            }
            return;
        case 'font-size':
            for (const t of texts(node)) {
                await loadText(t);
                const v = d.token ? s.byName.get(d.token) : undefined;
                if (v) t.setBoundVariable('fontSize', v);
                else if (d.value !== undefined) t.fontSize = d.value;
                else throw new Error(`variable ${d.token ?? '?'} does not exist`);
            }
            return;
        case 'font-weight':
            for (const t of texts(node)) {
                const font = await loadText(t);
                s.fonts ??= await figma.listAvailableFontsAsync();
                if (!fontAvailable(s.fonts, font.family, d.style)) throw new Error(`font ${font.family} ${d.style} is not available`);
                const next = { family: font.family, style: d.style };
                await figma.loadFontAsync(next);
                t.fontName = next;
            }
            return;
    }
}

/** Styles every variant of the set from its code combination. Problems are collected, not thrown. */
export async function styleComponent(op: Extract<ComponentOp, { op: 'style-component' }>, s: ComponentState): Promise<string[]> {
    const set = await nodeFor(op, s);
    const problems = new Set<string>();
    for (const v of variants(set)) {
        const combo = codeCombo(parseVariantName(v.name), op.axes);
        for (const [slot, decls] of Object.entries(resolveSlots(op.styles, combo))) {
            const node = slotNode(v, slot, op.layers ?? {});
            if (node === 'skip') continue;
            if (!node) {
                if (decls.length) problems.add(`no layer named ${slot}`);
                continue;
            }
            // Zero the padding first so a fixed size can shrink below what the old padding needed.
            if ('layoutMode' in node && node.layoutMode !== 'NONE') {
                for (const side of paddingResets(decls)) {
                    const field = `padding${side.charAt(0).toUpperCase()}${side.slice(1)}` as 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft';
                    node.setBoundVariable(field, null);
                    node[field] = 0;
                }
            }
            for (const d of decls) {
                try {
                    await apply(node, d, s);
                } catch (error) {
                    problems.add(`${slot} ${d.kind}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        s.result.updated.push(v.id);
    }
    return [...problems];
}
