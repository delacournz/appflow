import type { JsonObject, JsonValue } from '../shared/protocol';
import { freeSpot, isScene, requireNode, walk } from './nodes';
import { parseRegion, type Rect, unionRect } from './rect';
import { type ByteFile, fail, type Handler, num, ok, str } from './types';

type Exportable = SceneNode & ExportMixin;
const exportable = (n: BaseNode): n is Exportable => isScene(n) && 'exportAsync' in n;

/** A PNG of the node whose longest side is at most `maxDimension` (scale capped at 4). */
export async function exportPng(node: SceneNode, maxDimension: number, scale?: number): Promise<Uint8Array> {
    if (!exportable(node)) throw new Error(`${(node as SceneNode).name} cannot be exported.`);
    const longest = Math.max(node.width, node.height, 1);
    const s = scale ?? Math.min(4, maxDimension / longest);
    return node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.max(0.01, s) } });
}

/** Exports `rect` of the current page by way of a temporary slice, always removed afterwards. */
async function exportRegion(rect: Rect, maxDimension: number, scale?: number): Promise<Uint8Array> {
    const slice = figma.createSlice();
    try {
        figma.currentPage.appendChild(slice);
        slice.x = rect.x;
        slice.y = rect.y;
        slice.resize(Math.max(0.01, rect.width), Math.max(0.01, rect.height));
        return await exportPng(slice, maxDimension, scale);
    } finally {
        slice.remove();
    }
}

export const getScreenshot: Handler = async (args) => {
    const scale = num(args, 'scale');
    const maxDimension = num(args, 'maxDimension') ?? 1024;
    const ids = Array.isArray(args.nodeIds) ? args.nodeIds.filter((v): v is string => typeof v === 'string') : [];
    const regionArg = args.region;
    if (regionArg !== undefined) {
        const rect = parseRegion(regionArg);
        if (!rect) return fail('region needs numeric x, y and a positive width and height.');
        const bytes = await exportRegion(rect, maxDimension, scale);
        return ok({ region: rect }, { images: [bytes] });
    }
    if (ids.length) {
        const rects: Rect[] = [];
        for (const id of ids) {
            const node = await requireNode(id);
            if (!isScene(node)) return fail(`${id} is a page, not a layer.`);
            const box = node.absoluteBoundingBox;
            if (!box) return fail(`${node.name} (${id}) has no bounds to capture.`);
            rects.push(box);
        }
        const union = unionRect(rects);
        if (!union) return fail('nodeIds was empty.');
        const bytes = await exportRegion(union, maxDimension, scale);
        return ok({ nodeIds: ids, region: union }, { images: [bytes] });
    }
    const node = await requireNode(str(args, 'nodeId'));
    if (!isScene(node)) return fail('Pick a layer, not a page.');
    const bytes = await exportPng(node, maxDimension, scale);
    return ok({ nodeId: node.id, name: node.name, width: Math.round(node.width), height: Math.round(node.height) }, { images: [bytes] });
};

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'layer';
const MIME: Record<string, string> = { PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf' };

function sniff(bytes: Uint8Array): { mime: string; ext: string } {
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50) return { mime: 'image/png', ext: 'png' };
    if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
    if (b[0] === 0x47 && b[1] === 0x49) return { mime: 'image/gif', ext: 'gif' };
    if (b[8] === 0x57 && b[9] === 0x45) return { mime: 'image/webp', ext: 'webp' };
    return { mime: 'application/octet-stream', ext: 'bin' };
}

export const downloadAssets: Handler = async (args) => {
    const ids = Array.isArray(args.nodeIds) ? args.nodeIds.filter((v): v is string => typeof v === 'string') : [];
    const one = str(args, 'nodeId');
    if (one) ids.push(one);
    if (!ids.length) for (const n of figma.currentPage.selection) ids.push(n.id);
    if (!ids.length) return fail('Pass nodeIds or select layers.');
    if (ids.length > 20) return fail('Up to 20 nodes per call.');
    const defaultFormat = (str(args, 'defaultFormat') ?? 'PNG').toUpperCase() as 'PNG' | 'JPG' | 'SVG' | 'PDF';
    const defaultScale = Math.min(4, Math.max(0.01, num(args, 'defaultScale') ?? 2));
    const includeSources = args.includeImageSources !== false;

    const files: ByteFile[] = [];
    const listing: JsonValue[] = [];
    const seenHashes = new Set<string>();
    for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id.replace('-', ':'));
        if (!node || !exportable(node)) {
            listing.push({ nodeId: id, error: 'not found or not exportable' });
            continue;
        }
        const settings: ExportSettings[] = node.exportSettings.length
            ? [...node.exportSettings]
            : [defaultFormat === 'SVG' || defaultFormat === 'PDF' ? { format: defaultFormat } : { format: defaultFormat, constraint: { type: 'SCALE', value: defaultScale } }];
        for (const setting of settings) {
            const bytes = await node.exportAsync(setting);
            const scale = 'constraint' in setting && setting.constraint?.type === 'SCALE' ? `@${setting.constraint.value}x` : '';
            const suffix = 'suffix' in setting && setting.suffix ? setting.suffix : '';
            const name = `${slug(node.name)}-${node.id.replace(/[:;]/g, '-')}${suffix}${scale}.${setting.format.toLowerCase()}`;
            files.push({ name, mime: MIME[setting.format] ?? 'application/octet-stream', bytes });
            listing.push({ nodeId: node.id, name: node.name, file: name, kind: 'export' });
        }
        if (!includeSources) continue;
        for (const n of walk(node, 2000)) {
            if (!('fills' in n) || !Array.isArray(n.fills)) continue;
            for (const p of n.fills as Paint[]) {
                if (p.type !== 'IMAGE' || !p.imageHash || seenHashes.has(p.imageHash) || seenHashes.size >= 20) continue;
                seenHashes.add(p.imageHash);
                const image = figma.getImageByHash(p.imageHash);
                if (!image) continue;
                const bytes = await image.getBytesAsync();
                const { mime, ext } = sniff(bytes);
                const name = `source-${p.imageHash.slice(0, 12)}.${ext}`;
                files.push({ name, mime, bytes });
                listing.push({ nodeId: n.id, name: n.name, file: name, kind: 'image-source', imageHash: p.imageHash });
            }
        }
    }
    return ok({ assets: listing, rawImagesTruncated: seenHashes.size >= 20 }, { files });
};

type Upload = { name: string; mime: string; bytes?: Uint8Array; text?: string };

export const uploadAssets: Handler = async (args) => {
    const uploads = (Array.isArray(args.files) ? args.files : []) as unknown as Upload[];
    if (!uploads.length) return fail('No files.');
    const target = str(args, 'nodeId') ? await requireNode(str(args, 'nodeId')) : null;
    const parentId = str(args, 'parentId');
    const parent = parentId ? await figma.getNodeByIdAsync(parentId) : figma.currentPage;
    if (!parent || !('appendChild' in parent)) return fail(`Parent ${parentId} cannot hold layers.`);
    const start = num(args, 'x') !== undefined ? { x: num(args, 'x') as number, y: num(args, 'y') ?? 0 } : freeSpot();
    let cursor = start.x;
    const created: JsonObject[] = [];

    for (const [i, u] of uploads.entries()) {
        if (u.mime === 'image/svg+xml' && typeof u.text === 'string') {
            const svg = figma.createNodeFromSvg(u.text);
            svg.name = u.name.replace(/\.svg$/i, '');
            (parent as ChildrenMixin).appendChild(svg);
            svg.x = cursor;
            svg.y = start.y;
            cursor += svg.width + 40;
            created.push({ id: svg.id, name: svg.name, type: 'svg' });
            continue;
        }
        if (!u.bytes) continue;
        const image = figma.createImage(u.bytes);
        const fill: ImagePaint = { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' };
        if (target && i === 0 && isScene(target) && 'fills' in target) {
            (target as GeometryMixin).fills = [fill];
            created.push({ id: target.id, name: target.name, type: 'fill', imageHash: image.hash });
            continue;
        }
        const { width, height } = await image.getSizeAsync();
        const rect = figma.createRectangle();
        rect.name = u.name.replace(/\.[^.]+$/, '');
        rect.resize(width, height);
        rect.fills = [fill];
        (parent as ChildrenMixin).appendChild(rect);
        rect.x = cursor;
        rect.y = start.y;
        cursor += width + 40;
        created.push({ id: rect.id, name: rect.name, type: 'image', imageHash: image.hash, width, height });
    }
    return ok({ created });
};
