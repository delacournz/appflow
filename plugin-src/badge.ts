import type { JsonObject } from '../shared/protocol';
import { boardsFor, collectScreens, raiseArrows, readMeta, rectOf, sceneById, type Board } from './flow';
import { FLOW_NAMESPACE, SCREEN_KEY, parseScreenMeta, type BuildStatus, type ScreenMeta } from './flowmeta';
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
 * Creates or updates the screen's `Badge · {name}` pill, right-aligned with the frame on the label line, inside the
 * screen group above the label. Needs the screen group.
 */
export async function ensureBadge(frame: FrameNode, meta: ScreenMeta, build: BuildStatus, labelOffset: number): Promise<GroupNode> {
    const group = meta.groupId ? await sceneById(meta.groupId) : null;
    if (!group || group.type !== 'GROUP' || frame.parent?.id !== group.id) throw new Error(`${frame.name} (${frame.id}) is not in its "Screen · …" group. Run group_screens first.`);
    const label = meta.labelId ? await sceneById(meta.labelId) : null;
    const spec = BADGE_SPECS[build.status];
    const font = await fontFor(label);

    let parts = partsOf(meta.badgeId ? await sceneById(meta.badgeId) : null);
    if (!parts) {
        const text = figma.createText();
        text.fontName = font;
        text.fontSize = FONT_SIZE;
        text.textAutoResize = 'WIDTH_AND_HEIGHT';
        text.characters = spec.text;
        const pill = figma.createRectangle();
        pill.cornerRadius = HEIGHT / 2;
        group.appendChild(pill);
        group.appendChild(text);
        const g = figma.group([pill, text], group);
        parts = { group: g, pill, text };
    }
    const { pill, text } = parts;
    await figma.loadFontAsync(text.fontName === figma.mixed ? font : text.fontName);
    text.characters = spec.text;
    text.fills = [{ type: 'SOLID', color: spec.textColor }];
    pill.fills = [{ type: 'SOLID', color: spec.fill }];
    const width = Math.ceil(text.width) + PAD_X * 2;
    pill.resize(width, HEIGHT);

    const at = badgePosition(rectOf(frame), label ? rectOf(label) : null, labelOffset, { width, height: HEIGHT });
    const origin = rectOf(group);
    const local = { x: group.x + (at.x - origin.x), y: group.y + (at.y - origin.y) };
    pill.x = local.x;
    pill.y = local.y;
    text.x = local.x + PAD_X;
    text.y = local.y + (HEIGHT - text.height) / 2;

    parts.group.name = badgeName(frame.name);
    group.appendChild(parts.group);
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
            const badge = await ensureBadge(frame, meta, status.value, board.meta.labelOffset);
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
    for (const board of boards) {
        const parent = board.node.parent;
        if (!parent || !('children' in parent)) continue;
        for (const { frame, group } of collectScreens(parent.children)) {
            const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
            if (!meta || meta.boardId !== board.node.id) continue;
            if (!group || meta.groupId !== group.id) {
                skipped.push({ id: frame.id, name: frame.name, reason: 'Not in its "Screen · …" group. Run group_screens first.' });
                continue;
            }
            const has = partsOf(meta.badgeId ? await sceneById(meta.badgeId) : null);
            const build = buildStatusOf(meta.build);
            const row = { id: frame.id, name: frame.name, status: build.status };
            if (dryRun) {
                (has ? refreshed : added).push(row);
                continue;
            }
            const badge = await ensureBadge(frame, meta, build, board.meta.labelOffset);
            writeScreen(frame, { ...meta, build, badgeId: badge.id });
            (has ? refreshed : added).push({ ...row, badgeId: badge.id });
        }
        if (!dryRun) raiseArrows(board);
    }
    return ok({ dryRun, boards: boards.map((b) => b.node.id), added, refreshed, skipped });
};
