import type { JsonObject, JsonValue } from '../shared/protocol';
import { assignScreenTexts, extrasFor, inferGrid, longestSegmentMid, matchTrigger, modeOf, type TriggerCandidate } from './adopt';
import { boardMissingMessage } from './board-missing';
import { MAX_OFFSET, pairLooseParts, planConsolidation, resolveArrowEnds, restoreDelta, type ScreenRef } from './arrow-adopt';
import { arrowsContainerName, isArrowsContainerType, recoverableArrowIds, recoveryIndex } from './arrow-recovery';
import { isLabelsContainerName, labelsContainerName, labelsToMigrate, stackingNeeds } from './arrow-labels';
import { linkBadges } from './badge-link';
import { classifyArrow, orderPath } from './flowlint';
import {
    ARROW_KEY,
    BOARD_KEY,
    FLOW_NAMESPACE,
    GROUP_LAYER_KEY,
    SCREEN_KEY,
    arrowGroupName,
    cellOfRect,
    destinationsOf,
    parseArrowMeta,
    parseBoardMeta,
    parseScreenMeta,
    setNavigateTarget,
    stableArrowOrder,
    type ArrowMeta,
    type BoardMeta,
    type ReactionLike,
    type ScreenMeta,
} from './flowmeta';
import { fitRoute } from './anatomy';
import { liftOutOfGroups } from './lift';
import { isScreenGroupName } from './screen-group';
import { fail, ok, str, bool, type Handler } from './types';
import { leadRoute, startLabelAnchor, type Exit, type Pt, type Rect, type Route } from './route';
import { clearLabel, labelObstacles, LABEL_PAD, separateLabels, titleTextRect, type GroupObstacle } from './route-avoid';
import { widenedBetween } from './grid';
import { planRoutes as planRoutesPure, type Endpoints, type Plan } from './route-plan';

const norm = (id: string) => id.replace('-', ':');
const DOT_SIZE = 10;

type Style = BoardMeta['arrowStyle'];
/** `labels` is the container holding every arrow label above all arrow lines; absent until `ensureLabels` runs on a board. */
export type Board = { node: SceneNode; meta: BoardMeta; arrows: SceneNode & ChildrenMixin; labels?: (SceneNode & ChildrenMixin) | null; recovered?: string };
type ArrowEntry = { group: GroupNode; meta: ArrowMeta };

export async function sceneById(id: string): Promise<SceneNode | null> {
    const n = await figma.getNodeByIdAsync(norm(id));
    return n && 'visible' in n && !n.removed ? (n as SceneNode) : null;
}

/** The first descendant that passes a type guard. `findOne` does not narrow its result. */
function firstOf<T extends SceneNode>(root: ChildrenMixin, test: (n: SceneNode) => n is T): T | null {
    return root.findOne((n) => test(n)) as T | null;
}

export function rectOf(n: SceneNode): Rect {
    const t = n.absoluteTransform;
    const w = 'width' in n ? n.width : 0;
    const h = 'height' in n ? n.height : 0;
    return { x: t[0][2], y: t[1][2], width: w, height: h };
}

/** Converts an absolute point to the coordinate space children of `parent` use. */
export function toLocal(parent: BaseNode, p: Pt): Pt {
    let a: BaseNode | null = parent;
    while (a && (a.type === 'GROUP' || a.type === 'BOOLEAN_OPERATION')) a = a.parent;
    if (!a || a.type === 'PAGE' || a.type === 'DOCUMENT' || !('absoluteTransform' in a)) return p;
    const t = (a as SceneNode).absoluteTransform;
    return { x: p.x - t[0][2], y: p.y - t[1][2] };
}

export function readMeta<T>(node: BaseNode, key: string, parse: (raw: string) => T | null): T | null {
    return parse(node.getSharedPluginData(FLOW_NAMESPACE, key));
}

export async function loadBoard(boardId: string): Promise<Board> {
    const node = await sceneById(boardId);
    if (!node) throw new Error(boardMissingMessage(boardId));
    const meta = readMeta(node, BOARD_KEY, parseBoardMeta);
    if (!meta) throw new Error(`${boardId} has no flowbridge board data. Run adopt_board first.`);
    let boardMeta = meta;
    let recovered: string | undefined;
    let arrows = await figma.getNodeByIdAsync(meta.arrowsGroupId);
    if (!arrows || arrows.removed || !isArrowsContainerType(arrows.type) || !('children' in arrows)) {
        const rebuilt = await rebuildArrowsContainer(node, meta);
        if (!rebuilt) throw new Error(`The arrows group ${meta.arrowsGroupId} of board ${boardId} is gone and no arrow data was found to rebuild it.`);
        arrows = rebuilt.container;
        boardMeta = { ...meta, arrowsGroupId: rebuilt.container.id };
        node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(boardMeta));
        recovered = `Arrows container ${meta.arrowsGroupId} was lost; rebuilt ${rebuilt.container.id} and moved ${rebuilt.moved} arrow groups into it.`;
    }
    const labelsNode = boardMeta.labelsGroupId ? await figma.getNodeByIdAsync(boardMeta.labelsGroupId) : null;
    const labels = labelsNode && 'children' in labelsNode && !labelsNode.removed ? (labelsNode as SceneNode & ChildrenMixin) : null;
    return { node, meta: boardMeta, arrows: arrows as SceneNode & ChildrenMixin, labels, ...(recovered ? { recovered } : {}) };
}

/**
 * Rebuilds a lost arrows container: a FRAME (never a group, which dissolves when emptied) with no fill, no clipping, at
 * 0,0 and 1x1 so children keep their absolute coordinates, directly below the labels container (else on top). Moves in
 * every node beside the board that carries arrow data for it. Null when there is none.
 */
async function rebuildArrowsContainer(boardNode: SceneNode, meta: BoardMeta): Promise<{ container: FrameNode; moved: number } | null> {
    const parent = boardNode.parent;
    if (!parent || !('children' in parent)) return null;
    const candidates = parent.children.map((c) => ({ node: c, boardId: readMeta(c, ARROW_KEY, parseArrowMeta)?.boardId ?? null }));
    const ids = new Set(recoverableArrowIds(candidates.map((c) => ({ id: c.node.id, boardId: c.boardId })), boardNode.id));
    const arrows = candidates.filter((c) => ids.has(c.node.id)).map((c) => c.node);
    if (!arrows.length) return null;
    const frame = figma.createFrame();
    frame.name = arrowsContainerName(boardNode.name);
    frame.fills = [];
    frame.clipsContent = false;
    frame.resize(1, 1);
    frame.x = 0;
    frame.y = 0;
    parent.insertChild(recoveryIndex(parent.children.map((c) => c.id), meta.labelsGroupId ?? null), frame);
    for (const n of arrows) moveInto(n, frame);
    return { container: frame, moved: arrows.length };
}

/**
 * The board's `Flow arrow labels · {board}` container, found by id, then by name beside the arrows container, else
 * created directly above the arrows container. Records its id on the board data, so every later run reuses it.
 */
export async function ensureLabels(board: Board): Promise<SceneNode & ChildrenMixin> {
    if (board.labels && !board.labels.removed) {
        const wanted = labelsContainerName(board.node.name, board.arrows.name);
        if (board.labels.name !== wanted && isLabelsContainerName(board.labels.name)) board.labels.name = wanted;
        return board.labels;
    }
    const parent = board.arrows.parent;
    if (!parent || !('children' in parent)) throw new Error(`The arrows group of board ${board.node.id} has no parent for a labels container.`);
    const name = labelsContainerName(board.node.name, board.arrows.name);
    let found = parent.children.find((c): c is FrameNode => c.type === 'FRAME' && isLabelsContainerName(c.name) && c.name === name) ?? null;
    if (!found) {
        found = figma.createFrame();
        found.name = name;
        found.fills = [];
        found.clipsContent = false;
        found.resize(1, 1);
        parent.insertChild(parent.children.indexOf(board.arrows as SceneNode) + 1, found);
        const at = toLocal(parent, rectOf(board.arrows));
        found.x = at.x;
        found.y = at.y;
    }
    board.labels = found;
    board.meta = { ...board.meta, labelsGroupId: found.id };
    board.node.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(board.meta));
    return found;
}

/** Moves `node` into `container` keeping its absolute position, whatever either container's own offset. */
export function moveInto(node: SceneNode, container: SceneNode & ChildrenMixin): void {
    const before = rectOf(node);
    container.appendChild(node);
    const d = restoreDelta(before, rectOf(node));
    if (Math.abs(d.x) > 0.01 || Math.abs(d.y) > 0.01) {
        node.x += d.x;
        node.y += d.y;
    }
}

/** Moves the labels of these arrows out of their arrow groups into the labels container. Idempotent; returns how many moved. */
export async function migrateLabels(board: Board, metas: readonly ArrowMeta[]): Promise<number> {
    const labels = await ensureLabels(board);
    const nodes = (await Promise.all(metas.map((m) => sceneById(m.labelId)))).flatMap((n) => (n ? [n] : []));
    const ids = new Set(labelsToMigrate(nodes.map((n) => ({ labelId: n.id, labelParentId: n.parent?.id ?? null })), labels.id));
    let moved = 0;
    for (const n of nodes) {
        if (!ids.has(n.id)) continue;
        moveInto(n, labels);
        moved++;
    }
    return moved;
}

export function listArrows(board: Board): ArrowEntry[] {
    const out: ArrowEntry[] = [];
    for (const c of board.arrows.children) {
        if (c.type !== 'GROUP') continue;
        const meta = readMeta(c, ARROW_KEY, parseArrowMeta);
        if (meta && meta.boardId === board.node.id) out.push({ group: c, meta });
    }
    return out;
}

/** Every screen frame that belongs to the board, with its rect. */
export function boardScreens(board: Board): { id: string; rect: Rect }[] {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return [];
    return collectScreens(parent.children)
        .filter((s) => readMeta(s.frame, SCREEN_KEY, parseScreenMeta)?.boardId === board.node.id)
        .map((s) => ({ id: s.frame.id, rect: rectOf(s.frame) }));
}

/** Rects only, for keeping lines out of screens that are not their ends. */
export const boardScreenRects = (board: Board): Rect[] => boardScreens(board).map((s) => s.rect);

/** The base gap between screen columns. Widened boundaries (extras) do not change it: lanes stay in the base gap. */
const gutterOf = (m: BoardMeta) => m.colWidth - m.screenW;

/**
 * Where labels must stop for an arrow whose source-to-target span crosses a widened column boundary: the end of the
 * base gutter beside the source. Undefined when the cells the two screens sit in are no further apart than the plain
 * grid makes them, so uniform boards behave as before. Bands make this depend on the rows of both screens, so it is
 * read off their cell rects (`widenedBetween`).
 */
function labelLimitOf(meta: BoardMeta, ends: { source: Rect; target: Rect }): number | undefined {
    return widenedBetween(meta, ends.source, ends.target) ? ends.source.x + ends.source.width + gutterOf(meta) : undefined;
}

async function endpointsOf(meta: ArrowMeta): Promise<Endpoints | null> {
    const [from, to] = await Promise.all([sceneById(meta.from), sceneById(meta.to)]);
    if (!from || !to) return null;
    const trig = meta.trigger ? await sceneById(meta.trigger) : null;
    return { source: rectOf(from), target: rectOf(to), trigger: trig ? rectOf(trig) : null, triggerMissing: !!meta.trigger && !trig, exit: meta.exit ?? 'side' };
}

/** Plans the board's arrows. `groups` are the board's group boxes and titles; without them the plan is the plain one. */
function planRoutes(meta: BoardMeta, items: { id: string; ends: Endpoints }[], groups: readonly GroupObstacle[] = [], screens: readonly Rect[] = []): Plan[] {
    return planRoutesPure({ gutter: gutterOf(meta), screens, rowGap: meta.rowHeight - meta.screenH, limits: items.map((it) => labelLimitOf(meta, it.ends)), boxes: groups.map((g) => ({ ...g.box, ...(g.strokeWeight ? { strokeWeight: g.strokeWeight } : {}) })), titles: groups.flatMap((g) => titleTextRect(g) ?? []) }, items);
}

type GroupObstacleLoader = (board: Board) => Promise<GroupObstacle[]>;
let loadGroupObstacles: GroupObstacleLoader | null = null;

/** flow-groups.ts registers how to read a board's group boxes (it imports this module, so it cannot be imported here). */
export function setGroupObstacleLoader(loader: GroupObstacleLoader): void {
    loadGroupObstacles = loader;
}
const obstaclesOf = async (board: Board): Promise<GroupObstacle[]> => (loadGroupObstacles ? loadGroupObstacles(board) : []);

async function paintFor(style: Style): Promise<SolidPaint> {
    const paint: SolidPaint = { type: 'SOLID', color: style.color };
    if (!style.strokeVariableId) return paint;
    const variable = await figma.variables.getVariableByIdAsync(style.strokeVariableId);
    return variable ? figma.variables.setBoundVariableForPaint(paint, 'color', variable) : paint;
}

async function writeVector(v: VectorNode, points: readonly Pt[], style: Style): Promise<void> {
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const last = points.length - 1;
    const vertices: VectorVertex[] = points.map((p, i) => ({
        x: p.x - minX,
        y: p.y - minY,
        strokeCap: i === last ? 'ARROW_LINES' : 'NONE',
        strokeJoin: 'MITER',
        cornerRadius: style.cornerRadius,
    }));
    const segments: VectorSegment[] = points.slice(1).map((_, i) => ({ start: i, end: i + 1 }));
    await v.setVectorNetworkAsync({ vertices, segments, regions: [] });
    const at = toLocal(v.parent ?? figma.currentPage, { x: minX, y: minY });
    v.x = at.x;
    v.y = at.y;
}

function centre(node: SceneNode & LayoutMixin, anchor: Pt): void {
    const at = toLocal(node.parent ?? figma.currentPage, { x: anchor.x - node.width / 2, y: anchor.y - node.height / 2 });
    node.x = at.x;
    node.y = at.y;
}

async function labelFont(): Promise<FontName> {
    for (const font of [{ family: 'Archivo', style: 'Medium' }, { family: 'Inter', style: 'Medium' }]) {
        try {
            await figma.loadFontAsync(font);
            return font;
        } catch {
            continue;
        }
    }
    const fallback = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(fallback);
    return fallback;
}

async function setLabelText(frame: FrameNode, label: string): Promise<void> {
    let text = firstOf(frame, (n): n is TextNode => n.type === 'TEXT');
    if (!text) {
        text = figma.createText();
        frame.appendChild(text);
    }
    const font = text.fontName === figma.mixed ? await labelFont() : text.fontName;
    await figma.loadFontAsync(font);
    text.fontName = font;
    text.characters = label;
    text.name = label;
    frame.name = `Label · ${label}`;
}

async function newDot(parent: SceneNode & ChildrenMixin, style: Style): Promise<EllipseNode> {
    const template = firstOf(parent, (n): n is EllipseNode => n.type === 'ELLIPSE' && n.name === 'Start');
    const dot = template ? template.clone() : figma.createEllipse();
    if (!template) {
        dot.resize(DOT_SIZE, DOT_SIZE);
        dot.fills = [await paintFor(style)];
        dot.name = 'Start';
    }
    parent.appendChild(dot);
    return dot;
}

async function newLabel(parent: SceneNode & ChildrenMixin, style: Style, label: string, alsoFrom: (SceneNode & ChildrenMixin) | null = null): Promise<FrameNode> {
    const isLabel = (n: SceneNode): n is FrameNode => n.type === 'FRAME' && n.name.startsWith('Label ·');
    const template = firstOf(parent, isLabel) ?? (alsoFrom ? firstOf(alsoFrom, isLabel) : null);
    let frame: FrameNode;
    if (template) {
        frame = template.clone();
    } else {
        frame = figma.createFrame();
        frame.layoutMode = 'HORIZONTAL';
        frame.primaryAxisSizingMode = 'AUTO';
        frame.counterAxisSizingMode = 'AUTO';
        frame.paddingLeft = frame.paddingRight = 12;
        frame.paddingTop = frame.paddingBottom = 6;
        frame.cornerRadius = 6;
        frame.fills = [{ type: 'SOLID', color: { r: 0.039, g: 0.039, b: 0.039 } }];
        frame.strokes = [await paintFor(style)];
        const text = figma.createText();
        const font = await labelFont();
        text.fontName = font;
        text.fontSize = 16;
        text.fills = [{ type: 'SOLID', color: { r: 0.949, g: 0.949, b: 0.949 } }];
        frame.appendChild(text);
    }
    parent.appendChild(frame);
    await setLabelText(frame, label);
    return frame;
}

async function newVector(parent: SceneNode & ChildrenMixin, style: Style, name: string): Promise<VectorNode> {
    const v = figma.createVector();
    parent.appendChild(v);
    v.name = name;
    v.fills = [];
    v.strokes = [await paintFor(style)];
    v.strokeWeight = style.weight;
    v.strokeJoin = 'MITER';
    return v;
}

async function partsOf(meta: ArrowMeta): Promise<{ vector: VectorNode; dot: EllipseNode; label: FrameNode } | null> {
    const [vector, dot, label] = await Promise.all([sceneById(meta.vectorId), sceneById(meta.dotId), sceneById(meta.labelId)]);
    if (vector?.type !== 'VECTOR' || dot?.type !== 'ELLIPSE' || label?.type !== 'FRAME') return null;
    return { vector, dot, label };
}

/** Draws a route. With group obstacles, the label is re-centred clear of box strokes and titles; returns why when it cannot be. */
async function applyRoute(parts: { vector: VectorNode; dot: EllipseNode; label: FrameNode }, route: Route, style: Style, groups: readonly GroupObstacle[] = []): Promise<string | null> {
    await writeVector(parts.vector, route.points, style);
    centre(parts.dot, route.dot);
    const size = { width: parts.label.width, height: parts.label.height };
    const anchor = startLabelAnchor(route, size);
    if (!groups.length) {
        centre(parts.label, anchor);
        return null;
    }
    const placed = clearLabel(leadRoute(route, anchor), size, labelObstacles(groups));
    centre(parts.label, placed.ok ? placed.anchor : anchor);
    return placed.ok ? null : placed.blocked;
}

/**
 * Board-wide label pass, run after the arrows are drawn so every label has its real size. Slides each label in
 * `placed` (already in `stableArrowOrder`) along its own path until it clears the other labels, `fixed` ones
 * included, and the group strokes and titles. Returns the ids it could not clear.
 */
async function separateBoardLabels(placed: { id: string; route: Route; label: FrameNode }[], fixed: readonly FrameNode[], groups: readonly GroupObstacle[]): Promise<string[]> {
    const items = placed.map((p) => {
        const r = rectOf(p.label);
        const anchor = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        return { id: p.id, route: leadRoute(p.route, anchor), anchor, size: { width: r.width, height: r.height } };
    });
    const res = separateLabels(items, labelObstacles(groups), LABEL_PAD, fixed.map(rectOf));
    for (const [i, p] of placed.entries()) {
        const at = res.anchors.get(p.id);
        const was = (items[i] as (typeof items)[number]).anchor;
        if (at && (at.x !== was.x || at.y !== was.y)) centre(p.label, at);
    }
    return res.blocked;
}

export type ScreenNode = { frame: FrameNode; group: GroupNode | null };

/**
 * Screen frame candidates under a container: frames directly in it, frames one level inside a `Screen · …` group,
 * and the same inside sections. Callers still check each frame's meta or size.
 */
export function collectScreens(children: readonly SceneNode[], depth = 0): ScreenNode[] {
    const out: ScreenNode[] = [];
    for (const c of children) {
        if (c.type === 'FRAME') out.push({ frame: c, group: null });
        else if (c.type === 'GROUP' && isScreenGroupName(c.name)) {
            for (const k of c.children) if (k.type === 'FRAME') out.push({ frame: k, group: c });
        } else if (c.type === 'SECTION' && depth < 2) out.push(...collectScreens(c.children, depth + 1));
    }
    return out;
}

/** Text layers a screen's label and route can be, at the top level, inside `Screen · …` groups and inside sections. */
export function collectTexts(children: readonly SceneNode[], depth = 0): TextNode[] {
    const out: TextNode[] = [];
    for (const c of children) {
        if (c.type === 'TEXT') out.push(c);
        else if (c.type === 'GROUP' && isScreenGroupName(c.name)) out.push(...c.children.filter((k): k is TextNode => k.type === 'TEXT'));
        else if (c.type === 'SECTION' && depth < 2) out.push(...collectTexts(c.children, depth + 1));
    }
    return out;
}

/** `Badge · {name}` pills: loose at the top level, inside `Screen · …` groups and inside sections. */
export function collectBadges(children: readonly SceneNode[], depth = 0): GroupNode[] {
    const out: GroupNode[] = [];
    for (const c of children) {
        if (c.type !== 'GROUP' && c.type !== 'SECTION') continue;
        if (c.type === 'GROUP' && c.name.startsWith('Badge · ')) out.push(c);
        else if ((c.type === 'GROUP' && isScreenGroupName(c.name)) || (c.type === 'SECTION' && depth < 2)) out.push(...collectBadges(c.children, depth + 1));
    }
    return out;
}

export const groupIdOf = (n: ScreenNode): string | null => n.group?.id ?? null;

function holdsScreen(node: SceneNode, boardId: string, depth = 0): boolean {
    if (node.type === 'FRAME') return readMeta(node, SCREEN_KEY, parseScreenMeta)?.boardId === boardId;
    if ((node.type === 'GROUP' || node.type === 'SECTION') && depth < 3) return node.children.some((k) => holdsScreen(k, boardId, depth + 1));
    return false;
}

/**
 * Keeps the arrows container above every screen of the board (frames and `Screen · …` groups), so start dots stay
 * visible, and the labels container directly above it, so every label paints over every line.
 */
export function raiseArrows(board: Board): void {
    const parent = board.arrows.parent;
    if (!parent || !('children' in parent)) return;
    const labels = board.labels && !board.labels.removed && board.labels.parent === parent ? board.labels : null;
    const need = stackingNeeds(parent.children.map((k) => k.id), (id) => {
        const k = parent.children.find((c) => c.id === id);
        return !!k && k.id !== labels?.id && holdsScreen(k, board.node.id);
    }, board.arrows.id, labels?.id ?? null);
    if (need.raiseArrows) parent.insertChild(parent.children.length - 1, board.arrows as SceneNode);
    if (need.placeLabels && labels) {
        const a = parent.children.indexOf(board.arrows as SceneNode);
        const l = parent.children.indexOf(labels as SceneNode);
        parent.insertChild(l > a ? a + 1 : a, labels as SceneNode);
    }
}

function writeArrowMeta(group: GroupNode, meta: ArrowMeta): void {
    group.setSharedPluginData(FLOW_NAMESPACE, ARROW_KEY, JSON.stringify(meta));
}

const pts = (route: Route): JsonValue => route.points.map((p) => ({ x: p.x, y: p.y }));

async function orderedEntries(entries: ArrowEntry[]): Promise<{ entry: ArrowEntry; ends: Endpoints | null }[]> {
    const withEnds = await Promise.all(entries.map(async (entry) => ({ entry, ends: await endpointsOf(entry.meta) })));
    const live = withEnds.filter((e): e is { entry: ArrowEntry; ends: Endpoints } => e.ends !== null);
    const sorted = stableArrowOrder(live.map((e) => ({ id: e.entry.group.id, sourceX: e.ends.source.x, targetY: e.ends.target.y, e })));
    return [...sorted.map((s) => s.e), ...withEnds.filter((e) => e.ends === null)];
}

export const connect: Handler = async (args) => {
    const fromId = str(args, 'from');
    const toId = str(args, 'to');
    const label = str(args, 'label');
    if (!fromId || !toId || !label) return fail('connect needs from, to and label.');
    const triggerId = str(args, 'trigger') ?? null;
    const prototype = bool(args, 'prototype', true);
    const exit: Exit = str(args, 'exit') === 'bottom' ? 'bottom' : 'side';
    const [from, to] = await Promise.all([sceneById(fromId), sceneById(toId)]);
    if (!from) return fail(`No node ${fromId}.`);
    if (!to) return fail(`No node ${toId}.`);
    const trigger = triggerId ? await sceneById(triggerId) : null;
    if (triggerId && !trigger) return fail(`No node ${triggerId}.`);

    const boardId = str(args, 'boardId') ?? readMeta(from, SCREEN_KEY, parseScreenMeta)?.boardId;
    if (!boardId) return fail(`${from.name} (${from.id}) is not on an adopted board. Run adopt_board, or pass boardId.`);
    const board = await loadBoard(boardId);
    const labelsBox = await ensureLabels(board);

    const existing = listArrows(board);
    const match = existing.find((a) => a.meta.from === from.id && a.meta.to === to.id && a.meta.trigger === (trigger?.id ?? null));
    const ends: Endpoints = { source: rectOf(from), target: rectOf(to), trigger: trigger ? rectOf(trigger) : null, triggerMissing: false, exit };

    const others = (await orderedEntries(existing.filter((a) => a !== match))).flatMap((o) => (o.ends ? [{ id: o.entry.group.id, ends: o.ends }] : []));
    const groups = await obstaclesOf(board);
    const plans = planRoutes(board.meta, [...others, { id: 'new', ends }], groups, boardScreenRects(board));
    const mine = plans[plans.length - 1] as Plan;
    if (!mine.route) return fail(mine.error ?? 'Could not route the arrow.');
    const route = mine.route;

    let parts = match ? await partsOf(match.meta) : null;
    if (match && !parts) {
        const staleLabel = await sceneById(match.meta.labelId);
        if (staleLabel && staleLabel.parent !== match.group) staleLabel.remove();
        match.group.remove();
    }
    const style = board.meta.arrowStyle;
    if (!parts) {
        const vector = await newVector(board.arrows, style, `Arrow · ${label}`);
        const dot = await newDot(board.arrows, style);
        const lab = await newLabel(labelsBox, style, label, board.arrows);
        parts = { vector, dot, label: lab };
    } else {
        if (parts.label.parent !== labelsBox) moveInto(parts.label, labelsBox);
        await setLabelText(parts.label, label);
        parts.vector.name = `Arrow · ${label}`;
    }
    const blocked = await applyRoute(parts, route, style, groups);
    const fixedLabels = (await Promise.all(existing.filter((a) => a !== match).map((a) => partsOf(a.meta)))).flatMap((p) => (p ? [p.label] : []));
    const crowded = (await separateBoardLabels([{ id: 'new', route, label: parts.label }], fixedLabels, groups)).length > 0;

    const meta: ArrowMeta = {
        v: 1,
        kind: 'arrow',
        boardId: board.node.id,
        from: from.id,
        to: to.id,
        trigger: trigger?.id ?? null,
        label,
        mode: trigger ? 'trigger' : 'auto',
        ...(exit === 'bottom' ? { exit } : {}),
        vectorId: parts.vector.id,
        dotId: parts.dot.id,
        labelId: parts.label.id,
    };
    let group: GroupNode;
    if (match && parts.vector.parent === match.group) {
        group = match.group;
    } else {
        group = figma.group([parts.vector, parts.dot], board.arrows);
    }
    group.name = arrowGroupName(from.name, to.name, label);
    writeArrowMeta(group, meta);
    raiseArrows(board);

    let prototypeUpdated = false;
    if (trigger && prototype) {
        if (!('reactions' in trigger)) return fail(`${trigger.name} cannot hold prototype reactions. The arrow was drawn (${group.id}).`);
        const next = setNavigateTarget(trigger.reactions as unknown as ReactionLike[], to.id);
        const destinations = (await Promise.all(destinationsOf(next.reactions).map(sceneById))).filter((n): n is SceneNode => n !== null);
        await liftOutOfGroups([from, to, ...destinations], () => trigger.setReactionsAsync(next.reactions as unknown as Reaction[]));
        prototypeUpdated = true;
    }

    return ok({
        arrowGroupId: group.id,
        points: pts(route),
        prototypeUpdated,
        backwards: route.backwards,
        updated: !!match,
        ...(blocked || crowded || mine.warning || board.recovered
            ? { warnings: [...(board.recovered ? [board.recovered] : []), ...(blocked ? [`label overlaps a group box: ${blocked}`] : []), ...(crowded ? ['label overlaps another arrow label and no spot on its path is clear'] : []), ...(mine.warning ? [mine.warning] : [])] }
            : {}),
    });
};

export async function boardsFor(args: JsonObject): Promise<Board[]> {
    const id = str(args, 'boardId');
    if (id) return [await loadBoard(id)];
    const boards: Board[] = [];
    for (const n of figma.currentPage.children) {
        if (readMeta(n, BOARD_KEY, parseBoardMeta)) boards.push(await loadBoard(n.id));
    }
    return boards;
}

/** Redraws the arrows of the given boards from the current screen and trigger positions. Shared by reroute_flow and the grid tools. */
export async function rerouteBoards(boards: Board[], only: Set<string> | null = null): Promise<JsonObject> {
    const rerouted: string[] = [];
    const backwards: JsonObject[] = [];
    const deleted: JsonObject[] = [];
    const errors: JsonObject[] = [];
    const warnings: JsonObject[] = [];
    let obstacleCount = 0;
    for (const board of boards) {
        board.node.locked = true;
        if (board.recovered) warnings.push({ boardId: board.node.id, warning: board.recovered });
        const entries = listArrows(board);
        await migrateLabels(board, entries.map((e) => e.meta));
        const ordered = await orderedEntries(entries);
        for (const o of ordered) {
            if (!o.ends) deleted.push({ arrowGroupId: o.entry.group.id, name: o.entry.group.name, from: o.entry.meta.from, to: o.entry.meta.to });
        }
        const live = ordered.flatMap((o) => (o.ends ? [{ entry: o.entry, ends: o.ends }] : []));
        const groups = await obstaclesOf(board);
        obstacleCount += groups.length;
        const plans = planRoutes(board.meta, live.map((l) => ({ id: l.entry.group.id, ends: l.ends })), groups, boardScreenRects(board));
        const drawn: { id: string; route: Route; label: FrameNode }[] = [];
        const kept: FrameNode[] = [];
        for (const [i, l] of live.entries()) {
            const plan = plans[i] as Plan;
            if (only && !only.has(l.entry.group.id)) {
                const keptParts = await partsOf(l.entry.meta);
                if (keptParts) kept.push(keptParts.label);
                continue;
            }
            if (plan.warning) warnings.push({ arrowGroupId: l.entry.group.id, label: l.entry.meta.label, warning: plan.warning });
            if (l.ends.triggerMissing) warnings.push({ arrowGroupId: l.entry.group.id, warning: 'trigger node is gone; routed from the screen edge' });
            if (!plan.route) {
                errors.push({ arrowGroupId: l.entry.group.id, error: plan.error });
                continue;
            }
            const parts = await partsOf(l.entry.meta);
            if (!parts) {
                errors.push({ arrowGroupId: l.entry.group.id, error: 'vector, dot or label is missing from the arrow group' });
                continue;
            }
            const blocked = await applyRoute(parts, plan.route, board.meta.arrowStyle, groups);
            if (blocked) warnings.push({ arrowGroupId: l.entry.group.id, label: l.entry.meta.label, warning: `label overlaps a group box: ${blocked}` });
            rerouted.push(l.entry.group.id);
            drawn.push({ id: l.entry.group.id, route: plan.route, label: parts.label });
            if (plan.route.backwards) backwards.push({ arrowGroupId: l.entry.group.id, from: l.entry.meta.from, to: l.entry.meta.to, label: l.entry.meta.label });
        }
        for (const id of await separateBoardLabels(drawn, kept, groups)) {
            const meta = live.find((l) => l.entry.group.id === id)?.entry.meta;
            warnings.push({ arrowGroupId: id, label: meta?.label ?? '', warning: 'label overlaps another arrow label and no spot on its path is clear' });
        }
        raiseArrows(board);
    }
    return { boards: boards.map((b) => b.node.id), rerouted: rerouted.length, groupObstacles: obstacleCount, reroutedIds: rerouted, backwards, deleted, errors, warnings };
}

export const rerouteFlow: Handler = async (args) => {
    const only = Array.isArray(args.arrowIds) ? new Set(args.arrowIds.filter((x): x is string => typeof x === 'string').map(norm)) : null;
    const boards = await boardsFor(args);
    if (!boards.length) return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    return ok(await rerouteBoards(boards, only));
};

type Reason = 'no-arrowhead' | 'tail-outside-board' | 'no-source-screen' | 'no-target-screen' | 'ambiguous-source' | 'ambiguous-target' | 'same-screen' | 'incomplete-group' | 'no-start-dot' | 'no-label';

const inside = (p: Pt, r: Rect, pad = 0) => p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;

function hasNavigate(n: SceneNode): string | null | undefined {
    if (!('reactions' in n)) return undefined;
    for (const r of n.reactions as unknown as ReactionLike[]) {
        for (const a of [...(r.actions ?? []), ...(r.action ? [r.action] : [])]) {
            if (a.type === 'NODE') return typeof a.destinationId === 'string' ? a.destinationId : null;
        }
    }
    return undefined;
}

export async function pageOf(node: BaseNode): Promise<void> {
    let p: BaseNode | null = node;
    while (p && p.type !== 'PAGE') p = p.parent;
    if (p && p.type === 'PAGE' && figma.currentPage.id !== p.id) await figma.setCurrentPageAsync(p);
}

export const adoptBoard: Handler = async (args) => {
    const id = str(args, 'boardNodeId');
    if (!id) return fail('adopt_board needs boardNodeId.');
    const dryRun = bool(args, 'dryRun', false);
    const boardNode = await sceneById(id);
    if (!boardNode) return fail(`No node ${id}.`);
    await pageOf(boardNode);
    const parent = boardNode.parent;
    if (!parent || !('children' in parent)) return fail('The board has no parent to search.');
    const bounds = rectOf(boardNode);

    const arrowIds = Array.isArray(args.arrowsGroupIds) ? args.arrowsGroupIds.filter((x): x is string => typeof x === 'string') : [];
    const groups: (SceneNode & ChildrenMixin)[] = [];
    if (arrowIds.length) {
        for (const g of arrowIds) {
            const n = await sceneById(g);
            if (!n || !('children' in n)) return fail(`No arrows group ${g}.`);
            groups.push(n as SceneNode & ChildrenMixin);
        }
    } else {
        const candidates = parent.children.filter((c): c is GroupNode => c.type === 'GROUP' && c.name.startsWith('Flow arrows'));
        const suffix = boardNode.name.replace(/^Board\s*·\s*/, '').trim();
        const named = candidates.filter((c) => suffix && c.name.includes(suffix));
        const pick = named.length ? named : candidates.length === 1 ? candidates : [];
        if (!pick.length) return fail('Could not tell which group holds this board\'s arrows. Pass arrowsGroupIds.');
        groups.push(...pick);
    }
    const arrowsGroup = groups[0] as SceneNode & ChildrenMixin;

    const prevBoardMeta = readMeta(boardNode, BOARD_KEY, parseBoardMeta);
    const labelsHolder =
        (prevBoardMeta?.labelsGroupId ? parent.children.find((c) => c.id === prevBoardMeta.labelsGroupId) : null) ??
        parent.children.find((c) => 'children' in c && isLabelsContainerName(c.name) && c.name === labelsContainerName(boardNode.name, arrowsGroup.name)) ??
        null;
    const labelsKids = labelsHolder && 'children' in labelsHolder ? [...labelsHolder.children] : [];
    const siblings = parent.children.filter((c) => c.id !== boardNode.id && c.id !== labelsHolder?.id && !groups.some((g) => g.id === c.id) && !c.getSharedPluginData(FLOW_NAMESPACE, GROUP_LAYER_KEY));
    const found = collectScreens(siblings).filter((c) => {
        const r = rectOf(c.frame);
        return inside({ x: r.x, y: r.y }, bounds, 1) && r.x + c.frame.width <= bounds.x + bounds.width + 1 && r.y + c.frame.height <= bounds.y + bounds.height + 1;
    });
    const frames = found.map((c) => c.frame);
    const w = modeOf(frames.map((f) => f.width), 1);
    const h = modeOf(frames.map((f) => f.height), 1);
    const screens = found.filter((c) => w !== null && h !== null && Math.abs(c.frame.width - w) <= 1 && Math.abs(c.frame.height - h) <= 1);
    const ignoredFrames = found.filter((c) => !screens.includes(c)).map((c) => ({ id: c.frame.id, name: c.frame.name }));
    if (!screens.length) return fail('No screen frames found inside the board bounds.');
    const screenRects = screens.map((s) => ({ id: s.frame.id, node: s.frame, rect: rectOf(s.frame), groupId: groupIdOf(s) }));

    const grid = inferGrid(screenRects.map((s) => s.rect));
    const colWidth = typeof args.colWidth === 'number' ? args.colWidth : grid.colWidth;
    const rowHeight = typeof args.rowHeight === 'number' ? args.rowHeight : grid.rowHeight;
    const extras = colWidth === grid.colWidth && rowHeight === grid.rowHeight ? { colExtra: grid.colExtra, rowExtra: grid.rowExtra } : extrasFor(screenRects.map((s) => s.rect), colWidth, rowHeight);

    const texts = collectTexts(siblings).map((t) => ({ id: t.id, name: t.name, rect: rectOf(t) }));
    const style = readStyle(groups);
    const prevBoard = readMeta(boardNode, BOARD_KEY, parseBoardMeta);
    const overridden = typeof args.colWidth === 'number' || typeof args.rowHeight === 'number';
    const fresh: BoardMeta = {
        v: 1,
        kind: 'board',
        originX: grid.originX,
        originY: grid.originY,
        colWidth,
        rowHeight,
        ...(extras.colExtra ? { colExtra: extras.colExtra } : {}),
        ...(extras.rowExtra ? { rowExtra: extras.rowExtra } : {}),
        screenW: grid.screenW,
        screenH: grid.screenH,
        labelOffset: 80,
        margin: Math.round(grid.originX - bounds.x),
        headingId: null,
        arrowsGroupId: arrowsGroup.id,
        arrowStyle: style,
    };
    const rerun = !!prevBoard && !overridden;
    const boardMeta: BoardMeta = prevBoard && rerun ? { ...prevBoard, arrowsGroupId: arrowsGroup.id } : fresh;

    const triggerCache = new Map<string, TriggerCandidate[]>();
    const triggersIn = (s: { id: string; node: FrameNode }): TriggerCandidate[] => {
        const hit = triggerCache.get(s.id);
        if (hit) return hit;
        const list = s.node
            .findAll((n) => hasNavigate(n) !== undefined)
            .map((n) => ({ id: n.id, rect: rectOf(n), destinationId: hasNavigate(n) ?? null }));
        triggerCache.set(s.id, list);
        return list;
    };

    const refs: ScreenRef[] = screenRects.map((s) => ({ id: s.id, name: s.node.name, rect: s.rect }));
    const unmatched: { id: string; name: string; reason: Reason; candidates?: string[] }[] = [];
    type Plan1 = { vector: VectorNode; dot: EllipseNode; label: FrameNode; labelText: string; from: string; to: string; trigger: string | null; points: Pt[]; holder: GroupNode | null; stale: boolean; prior: ArrowMeta | null };
    const planned: Plan1[] = [];
    let outsideBoard = 0;
    let arrowsKept = 0;

    const absPoints = (v: VectorNode): Pt[] | null => {
        const local = orderPath(v.vectorNetwork.vertices, v.vectorNetwork.segments);
        if (!local) return null;
        const t = v.absoluteTransform;
        return local.map((p) => ({ x: t[0][0] * p.x + t[0][1] * p.y + t[0][2], y: t[1][0] * p.x + t[1][1] * p.y + t[1][2] }));
    };
    const triggerFor = (fromId: string, toId: string, tail: Pt, stale: boolean): string | null => {
        const src = screenRects.find((r) => r.id === fromId);
        if (!src) return null;
        const list = triggersIn(src);
        if (!stale) return matchTrigger(tail, list, toId)?.id ?? null;
        const toTarget = list.filter((t) => t.destinationId === toId);
        return toTarget.length === 1 ? (toTarget[0] as TriggerCandidate).id : null;
    };
    const textOf = (label: FrameNode, fallback: string): string => firstOf(label, (n): n is TextNode => n.type === 'TEXT')?.characters ?? fallback;

    /** Arrow groups that already exist (loose or stale-linked): a group holding a vector, a start dot and a label. */
    const holders: GroupNode[] = [];
    const findHolders = (c: SceneNode & ChildrenMixin, depth: number): void => {
        for (const k of c.children) {
            if (k.type !== 'GROUP' && k.type !== 'FRAME') continue;
            if (k.type === 'GROUP' && k.children.some((x) => x.type === 'VECTOR')) holders.push(k);
            else if (depth < 3) findHolders(k, depth + 1);
        }
    };
    for (const g of groups) findHolders(g, 0);

    for (const h of holders) {
        const v = h.children.find((x): x is VectorNode => x.type === 'VECTOR');
        const dot = h.children.find((x): x is EllipseNode => x.type === 'ELLIPSE');
        const priorMeta = readMeta(h, ARROW_KEY, parseArrowMeta);
        const lab =
            h.children.find((x): x is FrameNode => x.type === 'FRAME' && x.name.startsWith('Label ·')) ??
            h.children.find((x): x is FrameNode => x.type === 'FRAME') ??
            labelsKids.find((x): x is FrameNode => x.type === 'FRAME' && x.id === priorMeta?.labelId);
        if (!v || !dot || !lab) {
            unmatched.push({ id: h.id, name: h.name, reason: 'incomplete-group' });
            continue;
        }
        const prior = readMeta(h, ARROW_KEY, parseArrowMeta);
        if (prior && prior.vectorId === v.id && prior.dotId === dot.id && prior.labelId === lab.id && screenRects.some((s) => s.id === prior.from) && screenRects.some((s) => s.id === prior.to) && prior.boardId === boardNode.id) {
            arrowsKept++;
            continue;
        }
        const pts0 = absPoints(v);
        if (!pts0) {
            unmatched.push({ id: h.id, name: h.name, reason: 'no-arrowhead' });
            continue;
        }
        const tail = pts0[0] as Pt;
        const head = pts0[pts0.length - 1] as Pt;
        const ends = resolveArrowEnds(tail, head, refs, { from: prior?.from, to: prior?.to, groupName: h.name });
        if (!ends.ok) {
            unmatched.push({ id: h.id, name: h.name, reason: ends.reason, ...(ends.candidates ? { candidates: ends.candidates } : {}) });
            continue;
        }
        planned.push({
            vector: v,
            dot,
            label: lab,
            labelText: textOf(lab, prior?.label ?? v.name.replace(/^Arrow ·\s*/, '')),
            from: ends.from.id,
            to: ends.to.id,
            trigger: triggerFor(ends.from.id, ends.to.id, tail, ends.stale),
            points: pts0,
            holder: h,
            stale: ends.stale,
            prior,
        });
    }

    const holderParts = new Set(holders.flatMap((h) => h.children.map((x) => x.id)));
    const looseNodes = groups.flatMap((g) => [...g.children]).filter((c) => !holderParts.has(c.id));
    const dots = looseNodes
        .filter((c): c is EllipseNode => c.type === 'ELLIPSE' && c.width <= 16 && c.height <= 16)
        .map((c) => ({ id: c.id, node: c, at: { x: rectOf(c).x + c.width / 2, y: rectOf(c).y + c.height / 2 } }));
    const labels = looseNodes
        .filter((c): c is FrameNode => c.type === 'FRAME' && c.name.startsWith('Label ·'))
        .map((c) => ({ id: c.id, node: c, at: { x: rectOf(c).x + c.width / 2, y: rectOf(c).y + c.height / 2 } }));
    const looseVectors: { node: VectorNode; abs: Pt[] }[] = [];
    for (const v of looseNodes) {
        if (v.type !== 'VECTOR') continue;
        const abs = absPoints(v);
        if (!abs) {
            unmatched.push({ id: v.id, name: v.name, reason: 'no-arrowhead' });
            continue;
        }
        if (!inside(abs[0] as Pt, bounds, MAX_OFFSET)) {
            outsideBoard++;
            continue;
        }
        looseVectors.push({ node: v, abs });
    }
    const paired = pairLooseParts(
        looseVectors.map((l) => ({ id: l.node.id, tail: l.abs[0] as Pt, mid: longestSegmentMid(l.abs) })),
        dots,
        labels,
    );
    for (const u of paired.unpaired) {
        const l = looseVectors.find((x) => x.node.id === u.vectorId) as (typeof looseVectors)[number];
        unmatched.push({ id: l.node.id, name: l.node.name, reason: u.reason });
    }
    for (const pr of paired.pairs) {
        const l = looseVectors.find((x) => x.node.id === pr.vectorId) as (typeof looseVectors)[number];
        const dot = dots.find((d) => d.id === pr.dotId) as (typeof dots)[number];
        const lab = labels.find((x) => x.id === pr.labelId) as (typeof labels)[number];
        const tail = l.abs[0] as Pt;
        const head = l.abs[l.abs.length - 1] as Pt;
        const ends = resolveArrowEnds(tail, head, refs);
        if (!ends.ok) {
            unmatched.push({ id: l.node.id, name: l.node.name, reason: ends.reason, ...(ends.candidates ? { candidates: ends.candidates } : {}) });
            continue;
        }
        planned.push({
            vector: l.node,
            dot: dot.node,
            label: lab.node,
            labelText: textOf(lab.node, l.node.name.replace(/^Arrow ·\s*/, '')),
            from: ends.from.id,
            to: ends.to.id,
            trigger: triggerFor(ends.from.id, ends.to.id, tail, ends.stale),
            points: l.abs,
            holder: null,
            stale: ends.stale,
            prior: null,
        });
    }

    const badgeCandidates = collectBadges(siblings).map((n) => ({ id: n.id, name: n.name, rect: rectOf(n) }));
    const prevScreens = new Map(screenRects.map((s) => [s.id, readMeta(s.node, SCREEN_KEY, parseScreenMeta)]));
    const own = (id: string) => {
        const m = prevScreens.get(id);
        return m && m.boardId === boardNode.id ? m : null;
    };
    const liveBadge = new Set(badgeCandidates.map((b) => b.id));
    const keptBadge = new Set(screenRects.flatMap((s) => (own(s.id)?.badgeId && liveBadge.has(own(s.id)?.badgeId as string) ? [own(s.id)?.badgeId as string] : [])));
    const badgeLinks = linkBadges(
        refs,
        badgeCandidates,
        keptBadge,
        new Set(screenRects.filter((s) => own(s.id)?.badgeId && liveBadge.has(own(s.id)?.badgeId as string)).map((s) => s.id)),
    );

    if (!dryRun) {
        boardNode.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(boardMeta));
        boardNode.locked = true;
        for (const s of screenRects) {
            const cell = cellOfRect(s.rect, boardMeta);
            const assigned = assignScreenTexts(s.rect, texts);
            const prev = own(s.id);
            const badgeId = badgeLinks.get(s.id) ?? (prev?.badgeId && liveBadge.has(prev.badgeId) ? prev.badgeId : null);
            const meta: ScreenMeta = {
                ...(prev ?? {}),
                v: 1,
                kind: 'screen',
                boardId: boardNode.id,
                col: cell.col,
                row: cell.row,
                labelId: assigned.labelId ?? prev?.labelId ?? null,
                routeId: assigned.routeId ?? prev?.routeId ?? null,
                groupId: s.groupId,
                ...(badgeId ? { badgeId } : {}),
            };
            s.node.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(meta));
            const routeNode = meta.routeId ? await sceneById(meta.routeId) : null;
            if (routeNode?.type === 'TEXT') await fitRoute(routeNode, s.node.width, null);
        }
        const adopted: Board = { node: boardNode, meta: boardMeta, arrows: arrowsGroup, labels: labelsHolder && 'children' in labelsHolder ? (labelsHolder as SceneNode & ChildrenMixin) : null };
        if (planned.length || arrowsKept || labelsHolder) await ensureLabels(adopted);
        const labelsBox = adopted.labels ?? null;
        if (labelsBox) {
            boardMeta.labelsGroupId = labelsBox.id;
            boardNode.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(boardMeta));
        }
        for (const p of planned) {
            const container = p.vector.parent && 'children' in p.vector.parent ? p.vector.parent : arrowsGroup;
            const group = p.holder ?? figma.group([p.vector, p.dot], container as BaseNode & ChildrenMixin);
            if (labelsBox && p.label.parent !== labelsBox) moveInto(p.label, labelsBox);
            const fromName = screenRects.find((s) => s.id === p.from)?.node.name ?? p.from;
            const toName = screenRects.find((s) => s.id === p.to)?.node.name ?? p.to;
            group.name = arrowGroupName(fromName, toName, p.labelText);
            const keepTrigger = p.prior?.trigger && (await sceneById(p.prior.trigger)) ? p.prior.trigger : p.trigger;
            writeArrowMeta(group, {
                v: 1,
                kind: 'arrow',
                boardId: boardNode.id,
                from: p.from,
                to: p.to,
                trigger: keepTrigger,
                label: p.labelText,
                mode: keepTrigger ? 'trigger' : 'auto',
                ...(p.prior?.exit ? { exit: p.prior.exit } : {}),
                vectorId: p.vector.id,
                dotId: p.dot.id,
                labelId: p.label.id,
            });
        }
        if (labelsBox) {
            for (const h of holders) {
                const inside = h.removed ? undefined : h.children.find((x): x is FrameNode => x.type === 'FRAME' && x.name.startsWith('Label ·'));
                if (inside && h.children.some((x) => x.type === 'VECTOR')) moveInto(inside, labelsBox);
            }
        }
    }

    const consolidation = planConsolidation(groups.map((g) => ({ id: g.id, childIds: g.children.map((c) => c.id) })));
    let arrowsConsolidated = 0;
    if (!dryRun && consolidation) {
        for (const m of consolidation.moves) {
            const node = await sceneById(m.nodeId);
            if (!node || !('x' in node)) continue;
            const before = rectOf(node);
            arrowsGroup.appendChild(node);
            const d = restoreDelta(before, rectOf(node));
            if (Math.abs(d.x) > 0.01 || Math.abs(d.y) > 0.01) {
                node.x += d.x;
                node.y += d.y;
            }
            arrowsConsolidated++;
        }
        for (const id of consolidation.emptied) {
            const extra = await sceneById(id);
            if (extra && 'children' in extra && !extra.children.length) extra.remove();
        }
    } else if (consolidation) {
        arrowsConsolidated = consolidation.moves.length;
    }

    const preview: JsonObject[] = planned.map((p) => ({
        vector: p.vector.id,
        label: p.labelText,
        from: p.from,
        to: p.to,
        trigger: p.trigger,
        mode: p.trigger ? 'trigger' : 'auto',
        heading: classifyArrow(p.points).heading,
    }));
    return ok({
        boardId: boardNode.id,
        dryRun,
        grid: { originX: boardMeta.originX, originY: boardMeta.originY, colWidth, rowHeight, ...(extras.colExtra ? { colExtra: extras.colExtra } : {}), ...(extras.rowExtra ? { rowExtra: extras.rowExtra } : {}), screenW: boardMeta.screenW, screenH: boardMeta.screenH },
        arrowStyle: style as unknown as JsonObject,
        screens: screenRects.length,
        arrowsAdopted: planned.length,
        arrowsConsolidated,
        arrowsRelinked: planned.filter((p) => p.holder).length,
        arrowsStale: planned.filter((p) => p.stale).length,
        arrowsAlreadyAdopted: arrowsKept,
        badgesLinked: badgeLinks.size,
        reran: rerun,
        arrowsWithTrigger: planned.filter((p) => p.trigger).length,
        unmatched,
        outsideBoard,
        ignoredFrames,
        arrows: preview,
    });
};

function readStyle(groups: (SceneNode & ChildrenMixin)[]): Style {
    for (const g of groups) {
        const v = firstOf(g, (n): n is VectorNode => n.type === 'VECTOR');
        if (!v) continue;
        const paint = v.strokes[0];
        if (!paint || paint.type !== 'SOLID') continue;
        const bound = paint.boundVariables?.color;
        const vertexRadius = Math.max(0, ...v.vectorNetwork.vertices.map((x) => x.cornerRadius ?? 0));
        const nodeRadius = typeof v.cornerRadius === 'number' ? v.cornerRadius : 0;
        return {
            strokeVariableId: bound ? bound.id : null,
            color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
            weight: typeof v.strokeWeight === 'number' ? v.strokeWeight : 2,
            cornerRadius: Math.max(vertexRadius, nodeRadius),
        };
    }
    return { strokeVariableId: null, color: { r: 0.576, g: 0.839, b: 0.933 }, weight: 2, cornerRadius: 20 };
}
