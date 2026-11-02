import type { JsonValue } from '../shared/protocol';

/** The node a tool acts on: `nodeId`, else the first selected node, else `null`. */
export async function targetNode(nodeId: string | undefined): Promise<BaseNode | null> {
    if (nodeId) return figma.getNodeByIdAsync(nodeId.replace('-', ':'));
    return figma.currentPage.selection[0] ?? null;
}

export async function requireNode(nodeId: string | undefined): Promise<BaseNode> {
    const node = await targetNode(nodeId);
    if (!node) throw new Error(nodeId ? `No node ${nodeId}.` : 'Pass nodeId or select a layer in Figma.');
    return node;
}

export const isScene = (node: BaseNode): node is SceneNode => 'visible' in node;

/** Every node in the subtree, depth first, up to `limit`. */
export function walk(root: BaseNode, limit = 5000): BaseNode[] {
    const out: BaseNode[] = [];
    const stack: BaseNode[] = [root];
    while (stack.length && out.length < limit) {
        const node = stack.pop() as BaseNode;
        out.push(node);
        if ('children' in node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as BaseNode);
    }
    return out;
}

/** The component set of a variant, or the component itself. */
export function componentOwner(component: ComponentNode): ComponentNode | ComponentSetNode {
    return component.parent?.type === 'COMPONENT_SET' ? component.parent : component;
}

export async function mainOwner(instance: InstanceNode): Promise<ComponentNode | ComponentSetNode | null> {
    const main = await instance.getMainComponentAsync();
    return main ? componentOwner(main) : null;
}

/** Makes a value safe to JSON-encode: nodes become {id, type, name}, symbols and bytes become strings. */
export function toJson(value: unknown, seen = new Set<object>(), depth = 0): JsonValue {
    if (value === undefined || value === null) return null;
    if (value === figma.mixed) return '<mixed>';
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return String(value);
    if (value instanceof Uint8Array) return `<${value.length} bytes>`;
    if (typeof value !== 'object') return String(value);
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && typeof record.type === 'string' && 'removed' in record) {
        return { id: record.id, type: record.type, name: typeof record.name === 'string' ? record.name : null };
    }
    if (seen.has(value) || depth > 20) return '<circular>';
    seen.add(value);
    const out: JsonValue = Array.isArray(value)
        ? value.map((v) => toJson(v, seen, depth + 1))
        : Object.fromEntries(Object.keys(record).map((k) => [k, toJson(record[k], seen, depth + 1)]));
    seen.delete(value);
    return out;
}

export function errorText(error: unknown): string {
    if (error instanceof Error) return error.stack ? `${error.message}\n${error.stack}` : error.message;
    return String(error);
}

/** A free spot to the right of everything on the current page. */
export function freeSpot(gap = 200): { x: number; y: number } {
    const kids = figma.currentPage.children;
    if (!kids.length) return { x: 0, y: 0 };
    let maxX = -Infinity;
    let minY = Infinity;
    for (const n of kids) {
        maxX = Math.max(maxX, n.x + n.width);
        minY = Math.min(minY, n.y);
    }
    return { x: Math.round(maxX + gap), y: Math.round(minY) };
}

const FONT_STYLES = ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'];
let fontCache: Font[] | null = null;

/** The closest installed font for a CSS family and weight, falling back to Inter. Loaded and ready to use. */
export async function resolveFont(family: string, weight: number, italic: boolean): Promise<FontName> {
    if (!fontCache) fontCache = await figma.listAvailableFontsAsync();
    const norm = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
    const pick = (fam: string): FontName | null => {
        const styles = (fontCache as Font[]).filter((f) => norm(f.fontName.family) === norm(fam)).map((f) => f.fontName);
        if (!styles.length) return null;
        const target = Math.min(8, Math.max(0, Math.round(weight / 100) - 1));
        const ranked = styles
            .map((f) => {
                const s = norm(f.style);
                const isItalic = s.includes('italic');
                const base = s.replace('italic', '') || 'regular';
                const idx = FONT_STYLES.findIndex((w) => norm(w) === base);
                return { f, score: (idx === -1 ? 10 : Math.abs(idx - target)) + (isItalic === italic ? 0 : 5) };
            })
            .sort((a, b) => a.score - b.score);
        return ranked[0]?.f ?? null;
    };
    const first = family.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? 'Inter';
    const font = pick(first) ?? pick('Inter') ?? { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(font);
    return font;
}

export const hex = (c: RGB | RGBA): string => {
    const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
    const a = 'a' in c && c.a < 1 ? h(c.a) : '';
    return `#${h(c.r)}${h(c.g)}${h(c.b)}${a}`;
};
