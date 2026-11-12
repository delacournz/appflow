/**
 * Flow groups: labelled boxes (a stroked rectangle plus a title bar frame holding the name) around sets of screens on a board.
 *
 * Membership lives in plugin data: a `group` meta on the rectangle (its node id is the group id) and `flowGroupId` on each
 * screen. Screens stay top-level frames, so prototype Play keeps working. The boxes sit in an unclipped `Flow groups · {board}`
 * frame placed just above the board background and below every screen; the arrows frame stays on top of all of it.
 *
 * `refitGroups` is the one place geometry is decided: it widens the board's column/row boundaries so boxes and titles fit
 * (shifting the screens after each boundary), then fits every box to its members' footprints, children first. It never calls
 * `finish` or `rerouteBoards`, so hooks can call it freely; callers reroute afterwards when `extrasChanged`.
 */
import type { JsonObject, JsonValue } from '../shared/protocol';
import { applyBanded, applyExtras, applyMoves, applyPitch, setSpacing, cellsOf, loadScreens, resizeBoard, setGapExtra, snapBadges, writeScreen, type Screen } from './board-ops';
import { basePitchOf, growPitch, pitchFromNeeds, samePitch, spacingOf } from './pitch';
import { addBands, gapDeficits, hasDeficits, type Block, type Deficits } from './gap-fix';
import { boardsFor, connect, listArrows, loadBoard, readMeta, rectOf, rerouteBoards, rerouteFlow, sceneById, toLocal, type Board } from './flow';
import {
    TITLE_COLOR,
    TITLE_FILL,
    TITLE_PAD_X,
    fitBox,
    groupConflicts,
    memberContentRect,
    titleLineOf,
    validateNesting,
    titleHeightOf,
    type ConflictContent,
    type ConflictGroup,
    type FittedBox,
    type GroupIssue,
    type NestingIssue,
} from './flow-group';
import {
    extrasMoves,
    groupBoundaryExtras,
    groupBoundaryNeeds,
    internalArrowRects,
    sameBoxes,
    hexToRgb,
    holderIndex,
    holderName,
    mergeStyle,
    planAssign,
    planCreateGroup,
    planDeleteGroup,
    planUpdateGroup,
    reconcileMembership,
    rectName,
    sameExtras,
    titleName,
    type GroupRec,
} from './flow-group-plan';
import { FLOW_NAMESPACE, GROUP_KEY, GROUP_LAYER_KEY, SCREEN_KEY, parseGroupMeta, parseScreenMeta, type GroupMeta, type GroupStyle } from './flowmeta';
import { defaultMetrics } from './flow-group';
import type { Rect } from './rect';
import { cleanExtras, type ExtrasInput } from './tracks';
import { unionRect } from './rect';
import { fail, ok, str, bool, type Handler } from './types';

const norm = (id: string) => id.replace('-', ':');
const bandsJson = (extras: ExtrasInput | undefined): JsonObject[] => cleanExtras(extras).map((b) => ({ at: b.at, from: b.from, to: b.to, px: b.px }));
/** Plugin data on the holder frame: the board's meta, name and rect, so a deleted background could be rebuilt. */
const BOARD_BACKUP_KEY = 'board-backup';
const TITLE_FONT: FontName = { family: 'Inter', style: 'Bold' };

/** `title` is the title bar frame; a legacy plain TEXT title is kept until the next paint replaces it with a bar. */
export type LoadedGroup = { id: string; rect: RectangleNode; title: FrameNode | TextNode | null; meta: GroupMeta };

const recOf = (g: LoadedGroup): GroupRec => ({ id: g.id, name: g.meta.name, ...(g.meta.parentId ? { parentId: g.meta.parentId } : {}), screenIds: g.meta.screenIds, style: g.meta.style });

const metricsOf = (style: GroupStyle) => ({ padding: style.padding, strokeWeight: style.strokeWeight, titleSize: style.titleSize });

const defaultStyle = (nested: boolean): GroupStyle => ({ color: '#FFFFFF', titleFill: TITLE_FILL, titleColor: TITLE_COLOR, ...defaultMetrics(nested) });

const boardNameOf = (board: Board): string => board.node.name.replace(/^Board background\s*·\s*/, '');

function findHolder(board: Board): FrameNode | null {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return null;
    for (const c of parent.children) if (c.type === 'FRAME' && c.getSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY) === board.node.id) return c;
    return null;
}

/** Puts the holder just above the board background, below the screens. Cheap to repeat. */
function placeHolder(board: Board, holder: FrameNode): void {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return;
    const at = holderIndex(parent.children.map((c) => c.id), board.node.id, holder.id);
    if (parent.children.indexOf(holder) !== at) parent.insertChild(at, holder);
}

function ensureHolder(board: Board): FrameNode {
    const existing = findHolder(board);
    const holder = existing ?? figma.createFrame();
    if (!existing) {
        const at = rectOf(board.node);
        holder.fills = [];
        holder.clipsContent = false;
        holder.resize(1, 1);
        holder.x = at.x;
        holder.y = at.y;
        holder.setSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY, board.node.id);
    }
    holder.name = holderName(boardNameOf(board));
    placeHolder(board, holder);
    return holder;
}

export async function loadGroups(board: Board): Promise<LoadedGroup[]> {
    const holder = findHolder(board);
    if (!holder) return [];
    const out: LoadedGroup[] = [];
    for (const c of holder.children) {
        if (c.type !== 'RECTANGLE') continue;
        const meta = readMeta(c, GROUP_KEY, parseGroupMeta);
        if (!meta || meta.boardId !== board.node.id) continue;
        const t = await sceneById(meta.titleId);
        out.push({ id: c.id, rect: c, title: t?.type === 'FRAME' || t?.type === 'TEXT' ? t : null, meta: { ...meta, rectId: c.id } });
    }
    return out;
}

/**
 * Group boxes and title bars as label obstacles for the router. Registered from main.ts (not here): flow.ts and this
 * module import each other, so a top-level registration here runs before flow.ts initialises its loader slot.
 */
export const groupObstacles = async (board: Board) =>
    (await loadGroups(board)).map((g) => {
        const box = rectOf(g.rect);
        const t = g.title ? rectOf(g.title) : null;
        return { box, title: { x: box.x, y: t ? t.y : box.y, width: box.width, height: t ? t.height : 0 }, strokeWeight: g.meta.style.strokeWeight, titleChars: g.meta.name.length };
    });

const writeGroup = (g: LoadedGroup): void => g.rect.setSharedPluginData(FLOW_NAMESPACE, GROUP_KEY, JSON.stringify(g.meta));

function setFlowGroup(s: Screen, id: string | null): void {
    if ((s.meta.flowGroupId ?? null) === id) return;
    s.meta = { ...s.meta, flowGroupId: id };
    writeScreen(s.node, s.meta);
}

/** Brings stored membership in line with the screens that exist (see `reconcileMembership`), writing only when `write`. */
function reconcile(groups: LoadedGroup[], screens: Screen[], write: boolean): void {
    const r = reconcileMembership(groups.map(recOf), screens.map((s) => ({ id: s.node.id, flowGroupId: s.meta.flowGroupId })));
    for (const rec of r.groups) {
        const g = groups.find((x) => x.id === rec.id);
        if (!g || !r.changedGroups.includes(rec.id)) continue;
        const { parentId: _drop, ...rest } = g.meta;
        g.meta = { ...rest, screenIds: rec.screenIds, ...(rec.parentId ? { parentId: rec.parentId } : {}) };
        if (write) writeGroup(g);
    }
    for (const fix of r.screenFixes) {
        const s = screens.find((x) => x.node.id === fix.screenId);
        if (!s) continue;
        if (write) setFlowGroup(s, fix.flowGroupId);
        else s.meta = { ...s.meta, flowGroupId: fix.flowGroupId };
    }
}

export type Footprint = { frame: Rect; route: Rect | null; badge: Rect | null; content: Rect };

export async function footprintOf(s: Screen): Promise<Footprint> {
    const [route, label, badge] = await Promise.all([
        s.meta.routeId ? sceneById(s.meta.routeId) : null,
        s.meta.labelId ? sceneById(s.meta.labelId) : null,
        s.meta.badgeId ? sceneById(s.meta.badgeId) : null,
    ]);
    const frame = rectOf(s.node);
    const text = unionRect([route, label].flatMap((n) => (n ? [rectOf(n)] : [])));
    const badgeRect = badge ? rectOf(badge) : null;
    return { frame, route: text, badge: badgeRect, content: memberContentRect(frame, text ?? undefined, badgeRect ?? undefined) };
}

function place(holder: FrameNode, node: SceneNode & LayoutMixin, at: { x: number; y: number }): void {
    const p = toLocal(holder, at);
    node.x = p.x;
    node.y = p.y;
}

/** Draws one group's box and title at `fit`. Returns the title's real rect (its height is known only after rendering). */
async function paintGroup(holder: FrameNode, g: LoadedGroup, fit: FittedBox): Promise<Rect> {
    const { style, name } = g.meta;
    const rect = g.rect;
    rect.visible = true;
    rect.name = rectName(name);
    rect.fills = [];
    rect.strokes = [{ type: 'SOLID', color: hexToRgb(style.color) }];
    rect.strokeWeight = style.strokeWeight;
    rect.strokeAlign = 'INSIDE';
    rect.resize(fit.box.width, fit.box.height);
    place(holder, rect, fit.box);

    const height = titleHeightOf(style.titleSize);
    const bar = await titleBarFor(holder, g);
    bar.visible = true;
    bar.name = titleName(name);
    bar.fills = [{ type: 'SOLID', color: hexToRgb(style.titleFill) }];
    bar.layoutMode = 'HORIZONTAL';
    bar.primaryAxisSizingMode = 'FIXED';
    bar.counterAxisSizingMode = 'FIXED';
    bar.primaryAxisAlignItems = 'MIN';
    bar.counterAxisAlignItems = 'CENTER';
    bar.paddingLeft = TITLE_PAD_X;
    bar.paddingRight = TITLE_PAD_X;
    bar.paddingTop = Math.round((height - titleLineOf(style.titleSize)) / 2);
    bar.paddingBottom = bar.paddingTop;
    bar.clipsContent = true;
    bar.resize(fit.box.width, height);
    const text = bar.children.find((c): c is TextNode => c.type === 'TEXT') ?? figma.createText();
    if (text.parent !== bar) bar.appendChild(text);
    await figma.loadFontAsync(TITLE_FONT);
    text.fontName = TITLE_FONT;
    text.fontSize = style.titleSize;
    text.lineHeight = { unit: 'PIXELS', value: titleLineOf(style.titleSize) };
    text.fills = [{ type: 'SOLID', color: hexToRgb(style.titleColor) }];
    text.textAlignHorizontal = 'LEFT';
    text.textTruncation = 'ENDING';
    text.maxLines = 1;
    if (text.characters !== name) text.characters = name;
    // A FILL/HUG text child with HEIGHT auto-resize collapses to 0 width in a fixed bar, so pin an explicit width.
    text.layoutGrow = 0;
    text.textAutoResize = 'NONE';
    text.resize(Math.max(1, fit.box.width - TITLE_PAD_X * 2), titleLineOf(style.titleSize));
    text.name = name;
    const at = { x: fit.box.x, y: fit.box.y - height };
    place(holder, bar, at);
    return { x: at.x, y: at.y, width: fit.box.width, height };
}

/**
 * The group's title bar frame. A group drawn with a plain TEXT title (or whose title is gone) gets a new bar and its
 * `titleId` is updated, so old boards migrate on the next refit.
 */
async function titleBarFor(holder: FrameNode, g: LoadedGroup): Promise<FrameNode> {
    if (g.title && g.title.type === 'FRAME') return g.title;
    if (g.title) g.title.remove();
    const bar = figma.createFrame();
    holder.appendChild(bar);
    g.title = bar;
    g.meta = { ...g.meta, titleId: bar.id };
    writeGroup(g);
    return bar;
}

/** Banded fixes measured from the drawn boxes. */
type Bonus = Pick<Deficits, 'colExtra' | 'rowExtra'>;

export type RefitResult = {
    /** The board has at least one flow group. */
    active: boolean;
    /** Union of every box and title, or null. The board background must hold it (see `resizeBoard`). */
    extent: Rect | null;
    extrasChanged: boolean;
    /** Screens shifted because the boundaries changed. */
    shifted: number;
    issues: GroupIssue[];
    nesting: NestingIssue[];
    emptyGroups: string[];
    /** Extra room the drawn boxes still need (see gap-fix.ts); empty when every gap is wide enough. */
    deficits: Deficits;
    boxes: { id: string; name: string; parentId?: string; box: Rect; title: Rect; strokeWeight: number }[];
    summary: JsonObject;
};

const INACTIVE: RefitResult = { active: false, extent: null, extrasChanged: false, shifted: 0, issues: [], nesting: [], emptyGroups: [], deficits: { colExtra: [], rowExtra: [], uniform: { col: 0, row: 0 } }, boxes: [], summary: {} };

const json = (v: unknown): JsonValue => v as JsonValue;

/**
 * Recomputes the board's boundary extras from its groups, shifts the screens after every changed boundary, then fits and
 * redraws every box and title. A board with groups lets groups own its extras: they are replaced by what the groups need.
 * With no groups left, extras are only cleared when `releaseExtras` (the last group was just deleted).
 */
export async function refitGroups(board: Board, screens: Screen[], opts: { releaseExtras?: boolean; bonus?: Bonus; pitchExtra?: { col: number; row: number } } = {}): Promise<RefitResult> {
    const groups = await loadGroups(board);
    const holder = findHolder(board);
    const leftovers = !!(board.meta.colExtra || board.meta.rowExtra || board.meta.gapExtra || board.meta.baseColWidth !== undefined);
    if (!groups.length && !(opts.releaseExtras && leftovers)) {
        if (holder && !holder.children.length) holder.remove();
        return INACTIVE;
    }
    reconcile(groups, screens, true);

    const cells = cellsOf(screens);
    let extrasChanged = false;
    let shifted = 0;
    const allMoves = () => cells.map((c) => ({ id: c.id, from: { col: c.col, row: c.row }, to: { col: c.col, row: c.row } }));
    if (spacingOf(board.meta) === 'uniform') {
        const base = basePitchOf(board.meta);
        const needs = groups.length ? groupBoundaryNeeds(groups.map(recOf), cells, { ...base, screenW: board.meta.screenW, screenH: board.meta.screenH }) : { col: 0, row: 0 };
        const more = opts.pitchExtra ?? { col: 0, row: 0 };
        const pitch = pitchFromNeeds(base, { col: needs.col + more.col, row: needs.row + more.row });
        const m = board.meta;
        const dirty = !samePitch(pitch, { colWidth: m.colWidth, rowHeight: m.rowHeight }) || !!(m.colExtra || m.rowExtra || m.gapExtra) || m.spacing !== 'uniform';
        if (dirty) {
            applyPitch(board, base, pitch, groups.length > 0);
            shifted = (await applyMoves(board, screens, allMoves())).length;
            extrasChanged = true;
        }
    } else {
        if (!groups.length) setGapExtra(board, null);
        const restored = board.meta.baseColWidth !== undefined || board.meta.baseRowHeight !== undefined;
        if (restored) applyBanded(board);
        const desired = groupBoundaryExtras(groups.map(recOf), cells, board.meta, opts.bonus ?? board.meta.gapExtra);
        if (restored || !sameExtras(board.meta.colExtra, desired.colExtra) || !sameExtras(board.meta.rowExtra, desired.rowExtra)) {
            const moves = restored ? allMoves() : extrasMoves(cells, board.meta, desired);
            applyExtras(board, desired);
            shifted = (await applyMoves(board, screens, moves)).length;
            extrasChanged = true;
        }
    }
    if (!groups.length) {
        if (holder && !holder.children.length) holder.remove();
        return { ...INACTIVE, extrasChanged, shifted };
    }

    const layer = ensureHolder(board);
    board.node.locked = true;
    layer.locked = true;
    layer.setSharedPluginData(FLOW_NAMESPACE, BOARD_BACKUP_KEY, JSON.stringify({ meta: board.meta, name: board.node.name, rect: rectOf(board.node) }));
    await snapBadges(screens);
    const prints = new Map<string, Footprint>();
    for (const s of screens) prints.set(s.node.id, await footprintOf(s));
    const arrowRects = await internalArrowsOf(board);
    const inside = internalArrowRects(groups.map(recOf), arrowRects);
    const membersOf = (g: LoadedGroup): Rect[] => [
        ...g.meta.screenIds.flatMap((id) => {
            const p = prints.get(id);
            return p ? [p.content] : [];
        }),
        ...(inside.get(g.id) ?? []),
    ];

    const fitted = new Map<string, FittedBox>();
    const children = groups.filter((g) => g.meta.parentId);
    const tops = groups.filter((g) => !g.meta.parentId);
    for (const g of children) {
        const m = membersOf(g);
        if (m.length) fitted.set(g.id, fitBox(m, [], metricsOf(g.meta.style)));
    }
    for (const g of tops) {
        const m = membersOf(g);
        const kids = children.flatMap((k) => (k.meta.parentId === g.id && fitted.has(k.id) ? [fitted.get(k.id) as FittedBox] : []));
        if (m.length || kids.length) fitted.set(g.id, fitBox(m, kids, metricsOf(g.meta.style)));
    }

    const emptyGroups: string[] = [];
    const boxes: RefitResult['boxes'] = [];
    for (const g of [...tops, ...children]) {
        const fit = fitted.get(g.id);
        if (!fit) {
            g.rect.visible = false;
            if (g.title) g.title.visible = false;
            emptyGroups.push(g.id);
            continue;
        }
        const title = await paintGroup(layer, g, fit);
        g.rect.locked = true;
        if (g.title) g.title.locked = true;
        boxes.push({ id: g.id, name: g.meta.name, ...(g.meta.parentId ? { parentId: g.meta.parentId } : {}), box: fit.box, title, strokeWeight: g.meta.style.strokeWeight });
        layer.appendChild(g.rect);
        if (g.title) layer.appendChild(g.title);
    }

    const contents: ConflictContent[] = [];
    for (const s of screens) {
        const p = prints.get(s.node.id) as Footprint;
        contents.push({ kind: 'screen', id: s.node.id, rect: p.frame, ...(s.meta.flowGroupId ? { ownerGroupId: s.meta.flowGroupId } : {}) });
        if (p.route && s.meta.routeId) contents.push({ kind: 'route', id: s.meta.routeId, rect: p.route });
        if (p.badge && s.meta.badgeId) contents.push({ kind: 'badge', id: s.meta.badgeId, rect: p.badge });
    }
    for (const a of listArrows(board)) {
        const label = await sceneById(a.meta.labelId);
        if (label) contents.push({ kind: 'label', id: a.meta.labelId, rect: rectOf(label) });
    }
    const conflictGroups: ConflictGroup[] = boxes.map((b) => ({ id: b.id, ...(b.parentId ? { parentId: b.parentId } : {}), box: b.box, title: b.title, strokeWeight: b.strokeWeight }));
    const issues = groupConflicts(conflictGroups, contents);
    const nesting = validateNesting(conflictGroups);
    const extent = unionRect(boxes.flatMap((b) => [b.box, b.title]));

    const familyOf = (id: string): string[] => [...(groups.find((g) => g.id === id)?.meta.screenIds ?? []), ...groups.filter((k) => k.meta.parentId === id).flatMap((k) => k.meta.screenIds)];
    const cellOfId = new Map(cells.map((c) => [c.id, { col: c.col, row: c.row }]));
    const blocks: Block[] = [
        ...boxes.map((b) => ({
            id: b.id,
            rect: unionRect([b.box, b.title]) as Rect,
            cells: familyOf(b.id).flatMap((id) => (cellOfId.has(id) ? [cellOfId.get(id) as { col: number; row: number }] : [])),
            grouped: true,
            ...(b.parentId ? { parentId: b.parentId } : {}),
        })),
        ...screens
            .filter((s) => !groups.some((g) => g.meta.screenIds.includes(s.node.id)))
            .map((s) => ({ id: s.node.id, rect: (prints.get(s.node.id) as Footprint).content, cells: [{ col: s.meta.col, row: s.meta.row }], grouped: false })),
    ];
    const deficits = gapDeficits(blocks);

    const summary: JsonObject = {
        count: groups.length,
        extrasChanged,
        shifted,
        ...(issues.length ? { issues: json(issues) } : {}),
        ...(nesting.length ? { nesting: json(nesting) } : {}),
        ...(emptyGroups.length ? { emptyGroups } : {}),
    };
    return { active: true, extent, extrasChanged, shifted, issues, nesting, emptyGroups, deficits, boxes, summary: hasDeficits(deficits) ? { ...summary, gapDeficits: json(deficits) } : summary };
}

/** Each arrow's ends and the rects of its label and line, for boxes that must wrap arrows running inside them. */
async function internalArrowsOf(board: Board): Promise<{ from: string; to: string; rects: Rect[] }[]> {
    const out: { from: string; to: string; rects: Rect[] }[] = [];
    for (const a of listArrows(board)) {
        const nodes = await Promise.all([sceneById(a.meta.labelId), sceneById(a.meta.vectorId)]);
        out.push({ from: a.meta.from, to: a.meta.to, rects: nodes.flatMap((n) => (n ? [rectOf(n)] : [])) });
    }
    return out;
}

const MAX_SETTLE = 6;

/**
 * After arrows were rerouted, refit again: boxes now wrap the labels that landed inside them, and the conflict check sees the
 * final label positions. Repeats (reroute, refit) until the boxes stop changing, at most 6 times. It also grows the board's extras by whatever the drawn boxes still lack (gap-fix.ts), keeping them on the board
 * so extras only grow within a settle. Returns the last fit.
 */
async function settleBoard(board: Board, screens: Screen[], first: RefitResult, reroute: JsonObject): Promise<{ fit: RefitResult; reroute: JsonObject; passes: number }> {
    let fit = first;
    let last = reroute;
    let passes = 0;
    const uniform = spacingOf(board.meta) === 'uniform';
    let bonus: Bonus = board.meta.gapExtra ?? { colExtra: [], rowExtra: [] };
    let more = { col: 0, row: 0 };
    let previous: { col: number; row: number } | null = null;
    while (fit.active && passes < MAX_SETTLE) {
        const short = hasDeficits(fit.deficits);
        if (short && uniform) {
            const step = growPitch(basePitchOf(board.meta), more, fit.deficits.uniform, previous);
            previous = fit.deficits.uniform;
            if (step.stop && step.more.col === more.col && step.more.row === more.row) break;
            more = step.more;
        } else if (short) {
            bonus = { colExtra: addBands(bonus.colExtra, fit.deficits.colExtra), rowExtra: addBands(bonus.rowExtra, fit.deficits.rowExtra) };
            setGapExtra(board, bonus);
        }
        const again = await refitGroups(board, screens, uniform ? { pitchExtra: more } : { bonus });
        passes++;
        const settled = !short && !again.extrasChanged && sameBoxes(fit.boxes, again.boxes);
        fit = again;
        if (settled && !hasDeficits(again.deficits)) break;
        await resizeBoard(board, screens, false, fit.extent);
        last = await rerouteBoards([board]);
    }
    return { fit, reroute: last, passes };
}

/** Refit, grow the background, redraw every arrow, then settle. The tail of every group tool. */
async function syncBoard(board: Board, screens: Screen[], opts: { releaseExtras?: boolean } = {}): Promise<{ fit: RefitResult; size: { width: number; height: number }; reroute: JsonObject }> {
    const first = await refitGroups(board, screens, opts);
    const size = await resizeBoard(board, screens, false, first.extent);
    const rerouted = await rerouteBoards([board]);
    const { fit, reroute } = await settleBoard(board, screens, first, rerouted);
    return { fit, size: await resizeBoard(board, screens, false, fit.extent), reroute };
}

const rerouteBrief = (r: JsonObject): JsonObject => ({ rerouted: r.rerouted ?? 0, errors: r.errors ?? [], warnings: r.warnings ?? [] });

const strList = (args: JsonObject, key: string): string[] | undefined => {
    const v = args[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '').map(norm) : undefined;
};

type Target = { board: Board; screens: Screen[]; picked: string[] };

/** The board and the screens a create_flow_group call means: screenIds, else cells, else the selection. */
async function resolveTarget(args: JsonObject): Promise<Target | { error: string }> {
    const ids = strList(args, 'screenIds');
    const cells = Array.isArray(args.cells) ? args.cells : undefined;
    let boardId = str(args, 'boardId');
    const selected = figma.currentPage.selection.filter((n): n is FrameNode => n.type === 'FRAME');
    if (!boardId) {
        const hint = ids?.[0] ?? (cells ? undefined : selected[0]?.id);
        const node = hint ? await sceneById(hint) : null;
        boardId = node ? (readMeta(node, SCREEN_KEY, parseScreenMeta)?.boardId ?? undefined) : undefined;
    }
    if (!boardId) {
        const boards = await boardsFor({});
        if (boards.length === 1) boardId = (boards[0] as Board).node.id;
    }
    if (!boardId) return { error: 'Could not tell which board. Pass boardId, or select screens on an adopted board.' };
    const board = await loadBoard(boardId);
    const { screens } = await loadScreens(board);
    let picked: string[];
    if (ids) picked = ids;
    else if (cells) {
        picked = [];
        for (const c of cells) {
            const col = typeof c === 'object' && c !== null && !Array.isArray(c) ? c.col : undefined;
            const row = typeof c === 'object' && c !== null && !Array.isArray(c) ? c.row : undefined;
            const hit = screens.find((s) => s.meta.col === col && s.meta.row === row);
            if (!hit) return { error: `No screen at cell (${String(col)}, ${String(row)}).` };
            picked.push(hit.node.id);
        }
    } else {
        picked = selected.map((n) => n.id).filter((id) => screens.some((s) => s.node.id === id));
        if (!picked.length) return { error: 'Pass screenIds or cells, or select screens of the board.' };
    }
    return { board, screens, picked };
}

const describeScreens = (screens: Screen[], ids: readonly string[]): JsonObject[] =>
    ids.flatMap((id) => {
        const s = screens.find((x) => x.node.id === id);
        return s ? [{ id, name: s.node.name, col: s.meta.col, row: s.meta.row }] : [];
    });

const boxOf = (fit: RefitResult, id: string): JsonObject => {
    const b = fit.boxes.find((x) => x.id === id);
    return b ? { box: { ...b.box }, title: { ...b.title } } : {};
};

function takeFromParent(groups: LoadedGroup[], parentId: string | undefined, taken: readonly string[]): void {
    const parent = parentId ? groups.find((g) => g.id === parentId) : undefined;
    if (!parent || !taken.length) return;
    parent.meta = { ...parent.meta, screenIds: parent.meta.screenIds.filter((id) => !taken.includes(id)) };
    writeGroup(parent);
}

export const createFlowGroup: Handler = async (args) => {
    const name = str(args, 'name');
    if (!name) return fail('create_flow_group needs name.');
    const dryRun = bool(args, 'dryRun', false);
    const parentId = str(args, 'parentId')?.replace('-', ':');
    const target = await resolveTarget(args);
    if ('error' in target) return fail(target.error);
    const { board, screens, picked } = target;
    const groups = await loadGroups(board);
    reconcile(groups, screens, !dryRun);

    const plan = planCreateGroup(groups.map(recOf), { name, screenIds: picked, parentId }, new Set(screens.map((s) => s.node.id)));
    if (!plan.ok) return fail(plan.error);
    const base = defaultStyle(!!plan.parentId);
    const styled = mergeStyle(base, args.style);
    if (!styled.ok) return fail(styled.error);

    if (dryRun) {
        const next: GroupRec[] = [
            ...groups.map(recOf).map((g) => (g.id === plan.parentId ? { ...g, screenIds: g.screenIds.filter((id) => !plan.takeFromParent.includes(id)) } : g)),
            { id: 'new', name: plan.name, ...(plan.parentId ? { parentId: plan.parentId } : {}), screenIds: plan.screenIds, style: styled.style },
        ];
        const base = { ...basePitchOf(board.meta), screenW: board.meta.screenW, screenH: board.meta.screenH };
        if (spacingOf(board.meta) === 'uniform') {
            const pitch = pitchFromNeeds(base, groupBoundaryNeeds(next, cellsOf(screens), base));
            return ok({
                dryRun: true,
                boardId: board.node.id,
                name: plan.name,
                ...(plan.parentId ? { parentId: plan.parentId } : {}),
                screens: describeScreens(screens, plan.screenIds),
                movedFromParent: plan.takeFromParent,
                spacing: 'uniform',
                pitch: { colWidth: pitch.colWidth, rowHeight: pitch.rowHeight },
                screensShifted: samePitch(pitch, { colWidth: board.meta.colWidth, rowHeight: board.meta.rowHeight }) ? 0 : screens.length,
            });
        }
        const extras = groupBoundaryExtras(next, cellsOf(screens), board.meta);
        return ok({
            dryRun: true,
            boardId: board.node.id,
            name: plan.name,
            ...(plan.parentId ? { parentId: plan.parentId } : {}),
            screens: describeScreens(screens, plan.screenIds),
            movedFromParent: plan.takeFromParent,
            extras: { colExtra: bandsJson(extras.colExtra), rowExtra: bandsJson(extras.rowExtra) },
            screensShifted: extrasMoves(cellsOf(screens), board.meta, extras).length,
        });
    }

    const layer = ensureHolder(board);
    const rect = figma.createRectangle();
    layer.appendChild(rect);
    const title = figma.createFrame();
    layer.appendChild(title);
    const meta: GroupMeta = { boardId: board.node.id, name: plan.name, screenIds: plan.screenIds, rectId: rect.id, titleId: title.id, ...(plan.parentId ? { parentId: plan.parentId } : {}), style: styled.style };
    const created: LoadedGroup = { id: rect.id, rect, title, meta };
    writeGroup(created);
    takeFromParent(groups, plan.parentId, plan.takeFromParent);
    for (const id of plan.screenIds) {
        const s = screens.find((x) => x.node.id === id);
        if (s) setFlowGroup(s, rect.id);
    }

    const { fit, size, reroute } = await syncBoard(board, screens);
    return ok({
        groupId: rect.id,
        titleId: title.id,
        boardId: board.node.id,
        name: plan.name,
        ...(plan.parentId ? { parentId: plan.parentId } : {}),
        screens: describeScreens(screens, plan.screenIds),
        ...boxOf(fit, rect.id),
        extras: { colExtra: bandsJson(board.meta.colExtra), rowExtra: bandsJson(board.meta.rowExtra) },
        screensShifted: fit.shifted,
        board: size,
        issues: json(fit.issues),
        nesting: json(fit.nesting),
        reroute: rerouteBrief(reroute),
    });
};

async function groupContext(groupId: string): Promise<{ board: Board; screens: Screen[]; groups: LoadedGroup[]; group: LoadedGroup } | { error: string }> {
    const node = await sceneById(groupId);
    const meta = node ? readMeta(node, GROUP_KEY, parseGroupMeta) : null;
    if (!node || !meta) return { error: `${groupId} is not a flow group. Use the groupId from create_flow_group or describe_board.` };
    const board = await loadBoard(meta.boardId);
    const { screens } = await loadScreens(board);
    const groups = await loadGroups(board);
    reconcile(groups, screens, true);
    const group = groups.find((g) => g.id === node.id);
    return group ? { board, screens, groups, group } : { error: `${groupId} is not in the flow groups of its board.` };
}

export const updateFlowGroup: Handler = async (args) => {
    const groupId = str(args, 'groupId');
    if (!groupId) return fail('update_flow_group needs groupId.');
    const ctx = await groupContext(groupId);
    if ('error' in ctx) return fail(ctx.error);
    const { board, screens, groups, group } = ctx;
    const parentArg = args.parentId;
    if (parentArg !== undefined && parentArg !== null && typeof parentArg !== 'string') return fail('parentId must be a group id or null.');

    const plan = planUpdateGroup(
        groups.map(recOf),
        group.id,
        { name: str(args, 'name'), add: strList(args, 'add'), remove: strList(args, 'remove'), parentId: typeof parentArg === 'string' ? parentArg.replace('-', ':') : parentArg },
        new Set(screens.map((s) => s.node.id)),
    );
    if (!plan.ok) return fail(plan.error);
    const styled = mergeStyle(group.meta.style, args.style);
    if (!styled.ok) return fail(styled.error);

    const { parentId: _old, ...rest } = group.meta;
    group.meta = { ...rest, name: plan.name, screenIds: plan.screenIds, ...(plan.parentId ? { parentId: plan.parentId } : {}), style: styled.style };
    writeGroup(group);
    takeFromParent(groups, plan.parentId, plan.takeFromParent);
    for (const id of plan.removed) {
        const s = screens.find((x) => x.node.id === id);
        if (s) setFlowGroup(s, null);
    }
    for (const id of plan.screenIds) {
        const s = screens.find((x) => x.node.id === id);
        if (s) setFlowGroup(s, group.id);
    }

    const { fit, size, reroute } = await syncBoard(board, screens);
    return ok({
        groupId: group.id,
        boardId: board.node.id,
        name: plan.name,
        ...(plan.parentId ? { parentId: plan.parentId } : {}),
        screens: describeScreens(screens, plan.screenIds),
        ...boxOf(fit, group.id),
        extras: { colExtra: bandsJson(board.meta.colExtra), rowExtra: bandsJson(board.meta.rowExtra) },
        screensShifted: fit.shifted,
        board: size,
        issues: json(fit.issues),
        nesting: json(fit.nesting),
        reroute: rerouteBrief(reroute),
    });
};

export const deleteFlowGroup: Handler = async (args) => {
    const groupId = str(args, 'groupId');
    if (!groupId) return fail('delete_flow_group needs groupId.');
    const ctx = await groupContext(groupId);
    if ('error' in ctx) return fail(ctx.error);
    const { board, screens, groups, group } = ctx;
    const plan = planDeleteGroup(groups.map(recOf), group.id);
    if (!plan.ok) return fail(plan.error);

    for (const id of plan.promote) {
        const kid = groups.find((g) => g.id === id);
        if (!kid) continue;
        const { parentId: _p, ...rest } = kid.meta;
        kid.meta = rest;
        writeGroup(kid);
    }
    for (const id of plan.screenIds) {
        const s = screens.find((x) => x.node.id === id);
        if (s) setFlowGroup(s, null);
    }
    group.rect.remove();
    if (group.title) group.title.remove();

    const remaining = groups.length - 1;
    const { fit, size, reroute } = await syncBoard(board, screens, { releaseExtras: remaining === 0 });
    return ok({
        deleted: group.id,
        boardId: board.node.id,
        freedScreens: plan.screenIds,
        promoted: plan.promote,
        extras: { colExtra: bandsJson(board.meta.colExtra), rowExtra: bandsJson(board.meta.rowExtra) },
        screensShifted: fit.shifted,
        board: size,
        issues: json(fit.issues),
        reroute: rerouteBrief(reroute),
    });
};

/**
 * Validates the `group` argument of move_screen / duplicate_screen: a flow group id on the same board, or "none". Returns
 * the id to assign, null for none, or an error. Used before any node is touched.
 */
export async function checkGroupArg(boardId: string, raw: string): Promise<{ ok: true; groupId: string | null } | { ok: false; error: string }> {
    if (raw === 'none') return { ok: true, groupId: null };
    const board = await loadBoard(boardId);
    const id = raw.replace('-', ':');
    const groups = await loadGroups(board);
    if (!groups.some((g) => g.id === id)) return { ok: false, error: `${raw} is not a flow group on board ${boardId}.` };
    return { ok: true, groupId: id };
}

/** Moves one screen into a group (null = none) in storage. The caller then refits (`finish`, or `joinAndRefit`). */
export async function setScreenGroup(board: Board, screens: Screen[], screenId: string, groupId: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
    const groups = await loadGroups(board);
    reconcile(groups, screens, true);
    const plan = planAssign(groups.map(recOf), screenId, groupId);
    if (!plan.ok) return plan;
    for (const c of plan.changes) {
        const g = groups.find((x) => x.id === c.id);
        if (!g) continue;
        g.meta = { ...g.meta, screenIds: c.screenIds };
        writeGroup(g);
    }
    const s = screens.find((x) => x.node.id === screenId);
    if (s) setFlowGroup(s, groupId);
    return { ok: true };
}

/**
 * After duplicate_screen: files the copy in `groupId` (when given), then refits, grows the background and reroutes. Skips
 * everything on a board without groups, so such boards behave as before. Returns null when skipped.
 */
export async function joinAndRefit(boardId: string, screenId: string, groupId: string | null): Promise<JsonObject | null> {
    const board = await loadBoard(boardId);
    if (!(await loadGroups(board)).length) return null;
    const { screens } = await loadScreens(board);
    if (groupId) {
        const r = await setScreenGroup(board, screens, screenId, groupId);
        if (!r.ok) return { error: r.error };
    }
    const { fit, size, reroute } = await syncBoard(board, screens);
    return { ...fit.summary, board: size, reroute: rerouteBrief(reroute) };
}

/** reroute_flow: refits every grouped board first, so a hand-moved screen pulls its box along. */
export const rerouteFlowWithGroups: Handler = async (args) => {
    const boards = await boardsFor(args);
    const mode = str(args, 'spacing');
    if (mode !== undefined && mode !== 'uniform' && mode !== 'banded') return fail('spacing must be "uniform" or "banded".');
    if (mode) for (const board of boards) setSpacing(board, mode);
    const fits: JsonObject[] = [];
    const first = new Map<string, RefitResult>();
    for (const board of boards) {
        if (!(await loadGroups(board)).length) continue;
        const { screens } = await loadScreens(board);
        const fit = await refitGroups(board, screens);
        await resizeBoard(board, screens, false, fit.extent);
        first.set(board.node.id, fit);
    }
    const reply = await rerouteFlow(args);
    for (const board of boards) {
        const fit0 = first.get(board.node.id);
        if (!fit0) continue;
        const { screens } = await loadScreens(board);
        const settled = await settleBoard(board, screens, fit0, {});
        await resizeBoard(board, screens, false, settled.fit.extent);
        fits.push({ boardId: board.node.id, spacing: spacingOf(board.meta), pitch: { colWidth: board.meta.colWidth, rowHeight: board.meta.rowHeight }, settlePasses: settled.passes, ...settled.fit.summary });
    }
    if (!reply.ok || !fits.length || typeof reply.result !== 'object' || reply.result === null || Array.isArray(reply.result)) return reply;
    return ok({ ...reply.result, groups: fits });
};

/** connect: after the arrow and its label exist, refit and report any box the label now crosses. */
export const connectWithGroups: Handler = async (args) => {
    const reply = await connect(args);
    if (!reply.ok || typeof reply.result !== 'object' || reply.result === null || Array.isArray(reply.result)) return reply;
    const fromId = str(args, 'from');
    const from = fromId ? await sceneById(fromId) : null;
    const boardId = str(args, 'boardId') ?? (from ? readMeta(from, SCREEN_KEY, parseScreenMeta)?.boardId : undefined);
    if (!boardId) return reply;
    const board = await loadBoard(boardId);
    if (!(await loadGroups(board)).length) return reply;
    const { screens } = await loadScreens(board);
    let fit = await refitGroups(board, screens);
    let reroute: JsonObject | null = null;
    if (fit.extrasChanged) {
        await resizeBoard(board, screens, false, fit.extent);
        reroute = await rerouteBoards([board]);
    }
    fit = (await settleBoard(board, screens, fit, {})).fit;
    return ok({ ...reply.result, groups: fit.summary, ...(reroute ? { reroute: rerouteBrief(reroute) } : {}) }, { logs: reply.logs });
};

export type GroupSpec = { key: string; name: string; screenIds: string[]; parentKey?: string };
export type BatchCreated = { key: string; groupId: string; titleId: string; name: string };

/**
 * Creates several groups (parents before children) with one refit and reroute at the end, for adopt_flow_groups.
 * A spec the membership rules refuse is reported in `errors` and skipped.
 */
export async function createGroupsBatch(board: Board, screens: Screen[], specs: readonly GroupSpec[]): Promise<{ created: BatchCreated[]; errors: string[]; fit: RefitResult | null; reroute: JsonObject | null }> {
    const groups = await loadGroups(board);
    reconcile(groups, screens, true);
    const onBoard = new Set(screens.map((s) => s.node.id));
    const created: BatchCreated[] = [];
    const errors: string[] = [];
    const idOf = new Map<string, string>();
    for (const spec of specs) {
        const parentId = spec.parentKey ? idOf.get(spec.parentKey) : undefined;
        if (spec.parentKey && !parentId) {
            errors.push(`${spec.name}: its parent group was not created.`);
            continue;
        }
        const plan = planCreateGroup(groups.map(recOf), { name: spec.name, screenIds: spec.screenIds, parentId }, onBoard);
        if (!plan.ok) {
            errors.push(`${spec.name}: ${plan.error}`);
            continue;
        }
        const layer = ensureHolder(board);
        const rect = figma.createRectangle();
        layer.appendChild(rect);
        const title = figma.createFrame();
        layer.appendChild(title);
        const meta: GroupMeta = { boardId: board.node.id, name: plan.name, screenIds: plan.screenIds, rectId: rect.id, titleId: title.id, ...(plan.parentId ? { parentId: plan.parentId } : {}), style: defaultStyle(!!plan.parentId) };
        const made: LoadedGroup = { id: rect.id, rect, title, meta };
        writeGroup(made);
        takeFromParent(groups, plan.parentId, plan.takeFromParent);
        groups.push(made);
        for (const id of plan.screenIds) {
            const s = screens.find((x) => x.node.id === id);
            if (s) setFlowGroup(s, rect.id);
        }
        idOf.set(spec.key, rect.id);
        created.push({ key: spec.key, groupId: rect.id, titleId: title.id, name: plan.name });
    }
    if (!created.length) return { created, errors, fit: null, reroute: null };
    const { fit, reroute } = await syncBoard(board, screens);
    return { created, errors, fit, reroute };
}
