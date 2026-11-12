import type { JsonObject } from '../shared/protocol';
import { boardsFor, collectBadges, collectScreens, raiseArrows, readMeta, rectOf, sceneById, type Board } from './flow';
import { orphanBadges } from './badge-link';
import { FLOW_NAMESPACE, SCREEN_KEY, parseScreenMeta, type BuildStatus, type ScreenMeta } from './flowmeta';
import { fitRoute } from './anatomy';
import { badgeFallbackOffset } from './screen-group';
import { BADGE_SPECS, badgeName, badgePosition, buildStatusOf, statusFromInput, type StatusInput } from './screen-status';
import { bool, fail, ok, type Handler } from './types';

const PAD_X = 8;
const HEIGHT = 20;
const FONT: FontName = { family: 'Inter', style: 'Medium' };
const FONT_SIZE = 11;

const writeScreen = (frame: FrameNode, meta: ScreenMeta): void => frame.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(meta));

/** The pill's parts. The badge is a GROUP (not a frame) so screen scans never mistake it for a screen. */
function partsOf(node: SceneNode | null): { group: GroupNode; pill: RectangleNode; text: TextNode } | null {
    if (!node || node.type !== 'GROUP') return null;
    const pill = node.children.find((k): k is RectangleNode => k.type === 'RECTANGLE');
    const text = node.children.find((k): k is TextNode => k.type === 'TEXT');
    return pill && text ? { group: node, pill, text } : null;
}

async function fontFor(label: SceneNode | null): Promise<FontName> {
    const wanted = label?.type === 'TEXT' && label.fontName !== figma.mixed ? label.fontName : FONT;
    try {
        await figma.loadFontAsync(wanted);
        return wanted;
    } catch {
        await figma.loadFontAsync(FONT);
        return FONT;
    }
}

/**
 * Creates or updates the screen's `Badge · {name}` pill, right-aligned with the frame and centred on the text line
 * above it (the route text, or the label on boards that still have one). The pill is a loose sibling of the frame, or
 * sits in the frame's `Screen · …` group on older grouped boards.
 */
export async function ensureBadge(frame: FrameNode, meta: ScreenMeta, build: BuildStatus): Promise<GroupNode> {
    const holder = frame.parent;
    if (!holder || !('children' in holder) || holder.type === 'DOCUMENT') throw new Error(`${frame.name} (${frame.id}) sits in a parent that cannot hold a badge.`);
    const [label, route] = await Promise.all([meta.labelId ? sceneById(meta.labelId) : null, meta.routeId ? sceneById(meta.routeId) : null]);
    const line = label ?? route;
    const spec = BADGE_SPECS[build.status];
    const font = await fontFor(label ?? route);

    let parts = partsOf(meta.badgeId ? await sceneById(meta.badgeId) : null);
    const created = !parts;
    if (!parts) {
        const text = figma.createText();
        text.fontName = font;
        text.fontSize = FONT_SIZE;
        text.textAutoResize = 'WIDTH_AND_HEIGHT';
        text.characters = spec.text;
        const pill = figma.createRectangle();
        pill.cornerRadius = HEIGHT / 2;
        holder.appendChild(pill);
        holder.appendChild(text);
        const g = figma.group([pill, text], holder);
        parts = { group: g, pill, text };
    }
    const { pill, text } = parts;
    await figma.loadFontAsync(text.fontName === figma.mixed ? font : text.fontName);
    text.characters = spec.text;
    text.fills = [{ type: 'SOLID', color: spec.textColor }];
    pill.fills = [{ type: 'SOLID', color: spec.fill }];
    const width = Math.ceil(text.width) + PAD_X * 2;
    pill.resize(width, HEIGHT);

    const at = badgePosition(rectOf(frame), line ? rectOf(line) : null, badgeFallbackOffset(HEIGHT), { width, height: HEIGHT });
    const now = rectOf(pill);
    pill.x += at.x - now.x;
    pill.y += at.y - now.y;
    text.x = pill.x + PAD_X;
    text.y = pill.y + (HEIGHT - text.height) / 2;

    if (route?.type === 'TEXT') await fitRoute(route, frame.width, width);
    parts.group.name = badgeName(frame.name);
    if (created || parts.group.parent?.id !== holder.id) holder.insertChild(Math.min(holder.children.indexOf(frame) + 1, holder.children.length), parts.group);
    return parts.group;
}

async function screenFrame(id: string): Promise<{ frame: FrameNode; meta: ScreenMeta } | string> {
    const node = await sceneById(id);
    if (!node) return `No node ${id}.`;
    if (node.type !== 'FRAME') return `${node.name} (${node.id}) is a ${node.type}, not a screen frame.`;
    const meta = readMeta(node, SCREEN_KEY, parseScreenMeta);
    if (!meta) return `${node.name} (${node.id}) is not on an adopted board. Run adopt_board first.`;
    return { frame: node, meta };
}

type Entry = StatusInput & { id?: unknown };

export const setScreenStatus: Handler = async (args) => {
    const raw = args.screens;
    if (!Array.isArray(raw) || !raw.length) return fail('set_screen_status needs screens: [{ id, status, confidence?, commit?, notes? }].');
    const now = new Date().toISOString();
    const done: JsonObject[] = [];
    const errors: JsonObject[] = [];
    const boards = new Map<string, Board>();
    for (const item of raw) {
        const e = (typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}) as Entry;
        const id = typeof e.id === 'string' ? e.id : '';
        if (!id) {
            errors.push({ id: null, error: 'Each screen needs an id.' });
            continue;
        }
        const status = statusFromInput(e, now);
        if (!status.ok) {
            errors.push({ id, error: status.error });
            continue;
        }
        const found = await screenFrame(id);
        if (typeof found === 'string') {
            errors.push({ id, error: found });
            continue;
        }
        const { frame, meta } = found;
        try {
            const board = boards.get(meta.boardId) ?? (await boardsFor({ boardId: meta.boardId }))[0];
            if (!board) throw new Error(`The board ${meta.boardId} is gone.`);
            boards.set(meta.boardId, board);
            const badge = await ensureBadge(frame, meta, status.value);
            writeScreen(frame, { ...meta, build: status.value, badgeId: badge.id });
            done.push({ id: frame.id, name: frame.name, status: status.value.status, badgeId: badge.id });
        } catch (error) {
            errors.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    for (const b of boards.values()) raiseArrows(b);
    return ok({ updated: done, errors });
};

export const badgeScreens: Handler = async (args) => {
    const dryRun = bool(args, 'dryRun', false);
    const boards = await boardsFor(args);
    if (!boards.length) return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    const added: JsonObject[] = [];
    const refreshed: JsonObject[] = [];
    const skipped: JsonObject[] = [];
    const removed: JsonObject[] = [];
    for (const board of boards) {
        const parent = board.node.parent;
        if (!parent || !('children' in parent)) continue;
        for (const { frame } of collectScreens(parent.children)) {
            const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
            if (!meta || meta.boardId !== board.node.id) continue;
            const has = partsOf(meta.badgeId ? await sceneById(meta.badgeId) : null);
            const build = buildStatusOf(meta.build);
            const row = { id: frame.id, name: frame.name, status: build.status };
            if (dryRun) {
                (has ? refreshed : added).push(row);
                continue;
            }
            const badge = await ensureBadge(frame, meta, build);
            writeScreen(frame, { ...meta, build, badgeId: badge.id });
            (has ? refreshed : added).push({ ...row, badgeId: badge.id });
        }
        const referenced = new Set<string>();
        for (const { frame } of collectScreens(parent.children)) {
            const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
            if (meta?.badgeId) referenced.add(meta.badgeId);
        }
        const badges = collectBadges(parent.children);
        const orphans = orphanBadges(badges.map((b) => ({ id: b.id, name: b.name, rect: rectOf(b) })), referenced, rectOf(board.node));
        for (const id of orphans) {
            const node = badges.find((b) => b.id === id);
            if (!node) continue;
            const found = node.findOne((n) => n.type === 'TEXT');
            const text = found?.type === 'TEXT' ? found.characters : null;
            removed.push({ id, name: node.name, text });
            if (!dryRun) node.remove();
        }
        if (!dryRun) raiseArrows(board);
    }
    return ok({ dryRun, boards: boards.map((b) => b.node.id), added, refreshed, removed, skipped });
};
