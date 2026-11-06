import { bannerName, cellRect, findDescendant, frameName, growBounds, labelName, overlapsAny, pickBanner, routeName } from './duplicate-plan';
import { ensureBadge } from './badge';
import { collectScreens, toLocal } from './flow';
import { isScreenGroupName, routeSlot, screenGroupName } from './screen-group';
import { fitRoute } from './anatomy';
import { badgeName } from './screen-status';
import { ARROW_KEY, BOARD_KEY, FLOW_NAMESPACE, SCREEN_KEY, parseBoardMeta, parseScreenMeta, type ScreenMeta } from './flowmeta';
import type { Rect } from './rect';
import { fail, ok, str, type Handler } from './types';

const norm = (id: string) => id.replace('-', ':');

async function sceneById(id: string): Promise<SceneNode | null> {
    const n = await figma.getNodeByIdAsync(norm(id));
    return n && 'visible' in n && !n.removed ? (n as SceneNode) : null;
}

function rectOf(n: SceneNode): Rect {
    const t = n.absoluteTransform;
    return { x: t[0][2], y: t[1][2], width: 'width' in n ? n.width : 0, height: 'height' in n ? n.height : 0 };
}

type FigTree = { name: string; node: SceneNode; children?: FigTree[] };

function toTree(node: SceneNode): FigTree {
    if (!('children' in node)) return { name: node.name, node };
    return { name: node.name, node, children: node.children.map(toTree) };
}

async function loadFontsOf(text: TextNode): Promise<void> {
    if (text.characters.length === 0) {
        if (text.fontName !== figma.mixed) await figma.loadFontAsync(text.fontName);
        return;
    }
    for (const f of text.getRangeAllFontNames(0, text.characters.length)) await figma.loadFontAsync(f);
}

async function setText(text: TextNode, value: string): Promise<void> {
    await loadFontsOf(text);
    text.characters = value;
}

/** Moves a node to an absolute top-left, whatever its parent's own offset. */
function moveToAbs(node: SceneNode, at: { x: number; y: number }): void {
    const parent = node.parent;
    if (!parent) return;
    const local = toLocal(parent, at);
    node.x = local.x;
    node.y = local.y;
}

function clearFlowData(root: SceneNode): void {
    const nodes: SceneNode[] = 'findAll' in root ? [root, ...root.findAll()] : [root];
    for (const n of nodes) {
        if (n.getSharedPluginData(FLOW_NAMESPACE, ARROW_KEY)) n.setSharedPluginData(FLOW_NAMESPACE, ARROW_KEY, '');
        if (n.getSharedPluginData(FLOW_NAMESPACE, BOARD_KEY)) n.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, '');
    }
}

/** Clones a text node sitting next to the screen and moves it by the same offset as the screen. */
async function cloneText(id: string | null, dx: number, dy: number, name: string, value: string | null): Promise<TextNode | null> {
    if (!id) return null;
    const src = await sceneById(id);
    if (!src || src.type !== 'TEXT') return null;
    const copy = src.clone();
    copy.x = src.x + dx;
    copy.y = src.y + dy;
    copy.name = name;
    if (value !== null) await setText(copy, value);
    return copy;
}

async function componentFor(id: string): Promise<ComponentNode> {
    const n = await figma.getNodeByIdAsync(norm(id));
    if (!n) throw new Error(`No node ${id}.`);
    if (n.type === 'COMPONENT') return n;
    if (n.type === 'COMPONENT_SET') return n.defaultVariant;
    throw new Error(`${id} is a ${n.type}, not a COMPONENT or COMPONENT_SET.`);
}

type Banner = { title: string; description: string; iconComponentId: string | undefined };

function parseBanner(raw: unknown): Banner | null | 'invalid' {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
    const o = raw as Record<string, unknown>;
    if (typeof o.title !== 'string' || typeof o.description !== 'string') return 'invalid';
    return { title: o.title, description: o.description, iconComponentId: typeof o.iconComponentId === 'string' && o.iconComponentId ? o.iconComponentId : undefined };
}

async function updateBanner(copy: SceneNode, banner: Banner): Promise<boolean> {
    const hit = pickBanner(toTree(copy));
    if (!hit) return false;
    const row = hit.node;
    if (!('findAll' in row)) return false;
    const tree = toTree(row);
    const title = findDescendant(tree, (n) => n.node.type === 'TEXT' && n.name.endsWith('ItemTitle'));
    const description = findDescendant(tree, (n) => n.node.type === 'TEXT' && n.name.endsWith('ItemDescription'));
    if (title && title.node.type === 'TEXT') await setText(title.node, banner.title);
    if (description && description.node.type === 'TEXT') await setText(description.node, banner.description);
    if (banner.iconComponentId) {
        const component = await componentFor(banner.iconComponentId);
        const icon = row.findOne((n) => n.type === 'INSTANCE');
        if (!icon || icon.type !== 'INSTANCE') throw new Error('The banner row has no icon instance to swap.');
        icon.swapComponent(component);
    }
    row.name = bannerName(banner.title);
    return true;
}

export const duplicateScreen: Handler = async (args) => {
    const id = str(args, 'id');
    const name = str(args, 'name');
    const col = args.col;
    const row = args.row;
    if (!id || !name) return fail('duplicate_screen needs id and name.');
    if (typeof col !== 'number' || !Number.isInteger(col) || typeof row !== 'number' || !Number.isInteger(row)) return fail('duplicate_screen needs integer col and row.');
    const route = str(args, 'route');
    const banner = parseBanner(args.banner);
    if (banner === 'invalid') return fail('banner needs a title and a description.');

    const src = await sceneById(id);
    if (!src) return fail(`No node ${id}.`);
    if (src.type !== 'FRAME') return fail(`${src.name} (${src.id}) is a ${src.type}, not a screen frame.`);
    const meta: ScreenMeta | null = parseScreenMeta(src.getSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY));
    if (!meta) return fail(`${src.name} (${src.id}) is not on an adopted board. Run adopt_board first.`);
    const boardNode = await sceneById(meta.boardId);
    if (!boardNode) return fail(`The board ${meta.boardId} is gone.`);
    const board = parseBoardMeta(boardNode.getSharedPluginData(FLOW_NAMESPACE, BOARD_KEY));
    if (!board) return fail(`${meta.boardId} has no flowbridge board data.`);

    const target = cellRect(board, col, row);
    const grouped = src.parent?.type === 'GROUP' && isScreenGroupName(src.parent.name) ? src.parent : null;
    const container = grouped ? grouped.parent : src.parent;
    const siblings = container && 'children' in container ? container.children : [];
    const frames = collectScreens(siblings).map((c) => c.frame).filter((f) => f.id !== boardNode.id);
    const clash = overlapsAny(target, frames.map(rectOf));
    if (clash !== -1) {
        const other = frames[clash] as SceneNode;
        return fail(`Cell (${col}, ${row}) is occupied by ${other.name} (${other.id}).`);
    }

    const origin = rectOf(src);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const [srcLabel, srcRoute, srcBadge] = await Promise.all([
        meta.labelId ? sceneById(meta.labelId) : null,
        meta.routeId ? sceneById(meta.routeId) : null,
        meta.badgeId ? sceneById(meta.badgeId) : null,
    ]);

    let copy: FrameNode;
    let label: TextNode | null;
    let routeText: TextNode | null;
    let groupCopy: GroupNode | null = null;
    let badgeCopy: SceneNode | null = null;
    if (grouped && container && 'children' in container) {
        groupCopy = grouped.clone();
        if (groupCopy.parent?.id !== container.id) container.insertChild(container.children.indexOf(grouped) + 1, groupCopy);
        groupCopy.x = grouped.x + dx;
        groupCopy.y = grouped.y + dy;
        groupCopy.name = screenGroupName(name);
        const twin = (n: SceneNode | null): SceneNode | null => {
            const at = n && n.parent?.id === grouped.id ? grouped.children.indexOf(n as SceneNode) : -1;
            return at === -1 || !groupCopy ? null : (groupCopy.children[at] ?? null);
        };
        const frameTwin = twin(src);
        if (!frameTwin || frameTwin.type !== 'FRAME') throw new Error(`Could not find the copied frame inside the cloned group of ${src.name}.`);
        copy = frameTwin;
        badgeCopy = twin(srcBadge);
        const labelTwin = twin(srcLabel);
        const routeTwin = twin(srcRoute);
        label = labelTwin?.type === 'TEXT' ? labelTwin : await cloneText(meta.labelId, dx, dy, labelName(name), name);
        routeText = routeTwin?.type === 'TEXT' ? routeTwin : await cloneText(meta.routeId, dx, dy, routeName(name), route ?? null);
        if (labelTwin?.type === 'TEXT') {
            labelTwin.name = labelName(name);
            await setText(labelTwin, name);
        }
        if (routeTwin?.type === 'TEXT') {
            routeTwin.name = routeName(name);
            if (route !== undefined) await setText(routeTwin, route);
        }
    } else {
        copy = src.clone();
        copy.x = src.x + dx;
        copy.y = src.y + dy;
        label = null;
        routeText = await cloneText(meta.routeId, dx, dy, routeName(name), route ?? null);
        if (routeText) {
            moveToAbs(routeText, routeSlot(target));
            await fitRoute(routeText, copy.width, null);
        }
        if (srcBadge?.type === 'GROUP') {
            badgeCopy = srcBadge.clone();
            badgeCopy.x = srcBadge.x + dx;
            badgeCopy.y = srcBadge.y + dy;
            badgeCopy.name = badgeName(name);
        }
    }
    copy.name = frameName(name);
    clearFlowData(groupCopy ?? copy);

    const fresh: ScreenMeta = {
        v: 1,
        kind: 'screen',
        boardId: meta.boardId,
        col,
        row,
        labelId: label?.id ?? null,
        routeId: routeText?.id ?? null,
        groupId: groupCopy?.id ?? null,
        build: { status: 'not-built' },
        badgeId: badgeCopy?.id ?? null,
    };
    copy.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(fresh));
    if (badgeCopy && fresh.build) await ensureBadge(copy, fresh, fresh.build);

    const bannerUpdated = banner ? await updateBanner(copy, banner) : false;

    const bounds = rectOf(boardNode);
    const grown = growBounds(bounds, [target, ...[label, routeText].flatMap((t) => (t ? [rectOf(t)] : []))], board.margin);
    if (grown.x !== bounds.x || grown.y !== bounds.y || grown.width !== bounds.width || grown.height !== bounds.height) {
        if (!('resize' in boardNode)) return fail(`The board ${boardNode.name} cannot be resized.`);
        boardNode.x += grown.x - bounds.x;
        boardNode.y += grown.y - bounds.y;
        boardNode.resize(grown.width, grown.height);
    }

    return ok({ id: copy.id, name: copy.name, groupId: groupCopy?.id ?? null, col, row, labelId: label?.id ?? null, routeId: routeText?.id ?? null, badgeId: badgeCopy?.id ?? null, bannerUpdated });
};
