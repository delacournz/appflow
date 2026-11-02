import type { JsonObject, JsonValue } from '../shared/protocol';
import { componentOwner, mainOwner, requireNode, targetNode, walk } from './nodes';
import { fail, type Handler, ok, str } from './types';

async function ownerOf(node: BaseNode): Promise<ComponentNode | ComponentSetNode | null> {
    if (node.type === 'COMPONENT_SET') return node;
    if (node.type === 'COMPONENT') return componentOwner(node);
    if (node.type === 'INSTANCE') return mainOwner(node);
    return null;
}

function propertyDefs(owner: ComponentNode | ComponentSetNode): JsonObject {
    const defs = owner.componentPropertyDefinitions;
    return Object.fromEntries(
        Object.entries(defs).map(([key, d]) => [
            key,
            {
                type: d.type,
                defaultValue: d.defaultValue,
                ...(d.variantOptions ? { variantOptions: d.variantOptions } : {}),
            } as JsonObject,
        ]),
    );
}

/** Properties, variants, nested instances and text layers of a component, for writing a Code Connect template. */
export const getContextForCodeConnect: Handler = async (args) => {
    const node = await requireNode(str(args, 'nodeId'));
    const owner = await ownerOf(node);
    if (!owner) return fail('Pick a component, component set or instance.');
    const sample = owner.type === 'COMPONENT_SET' ? (owner.defaultVariant ?? owner.children[0]) : owner;
    const nested = new Map<string, JsonObject>();
    const texts: JsonObject[] = [];
    for (const n of sample ? walk(sample, 2000).slice(1) : []) {
        if (n.type === 'INSTANCE') {
            const o = await mainOwner(n);
            if (o && !nested.has(o.key)) nested.set(o.key, { name: o.name, key: o.key, layer: n.name });
        }
        if (n.type === 'TEXT' && texts.length < 50) texts.push({ layer: n.name, characters: n.characters });
    }
    return ok({
        name: owner.name,
        key: owner.key,
        nodeId: owner.id,
        type: owner.type,
        description: owner.description,
        remote: owner.remote,
        properties: propertyDefs(owner),
        variants: owner.type === 'COMPONENT_SET' ? owner.children.map((c) => c.name) : [],
        nestedInstances: [...nested.values()],
        textLayers: texts,
    });
};

/** The component behind a node, for the server's Code Connect store. */
export const resolveComponent: Handler = async (args) => {
    const node = await requireNode(str(args, 'nodeId'));
    const owner = await ownerOf(node);
    if (!owner) return fail(`${node.name} is not a component, component set or instance.`);
    return ok({ key: owner.key, name: owner.name, nodeId: owner.id, type: owner.type });
};

/** Instances and components in a subtree, with the key of the component (set) each one maps to. */
export const componentRefs: Handler = async (args) => {
    const node = (await targetNode(str(args, 'nodeId'))) ?? figma.currentPage;
    const instances: JsonValue[] = [];
    const components = new Map<string, JsonObject>();
    for (const n of walk(node, 5000)) {
        if (n.type === 'INSTANCE') {
            const o = await mainOwner(n);
            if (!o) continue;
            instances.push({ nodeId: n.id, layer: n.name, componentKey: o.key, componentName: o.name });
            if (!components.has(o.key)) components.set(o.key, { key: o.key, name: o.name, nodeId: o.id, type: o.type, remote: o.remote, properties: propertyDefs(o) });
        } else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
            const o = n.type === 'COMPONENT' ? componentOwner(n) : n;
            if (!components.has(o.key)) components.set(o.key, { key: o.key, name: o.name, nodeId: o.id, type: o.type, remote: o.remote, properties: propertyDefs(o) });
        }
    }
    return ok({ instances, components: [...components.values()] });
};
