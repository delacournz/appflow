import type { JsonObject, JsonValue } from '../shared/protocol';
import { assignScreenTexts, inferGrid, longestSegmentMid, matchScreenAt, matchTrigger, modeOf, nearestUnclaimed, type TriggerCandidate } from './adopt';
import { classifyArrow, orderPath } from './flowlint';
import {
    ARROW_KEY,
    BOARD_KEY,
    FLOW_NAMESPACE,
    SCREEN_KEY,
    arrowGroupName,
    cellOfRect,
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
import { fail, ok, str, bool, type Handler } from './types';
import { assignLanes, type Exit, fanIndex, gutterKey, routeArrow, type Pt, type Rect, type Route } from './route';

const norm = (id: string) => id.replace('-', ':');
const DOT_SIZE = 10;

type Style = BoardMeta['arrowStyle'];
type Board = { node: SceneNode; meta: BoardMeta; arrows: SceneNode & ChildrenMixin };
type ArrowEntry = { group: GroupNode; meta: ArrowMeta };

async function sceneById(id: string): Promise<SceneNode | null> {
    const n = await figma.getNodeByIdAsync(norm(id));
    return n && 'visible' in n && !n.removed ? (n as SceneNode) : null;
}

/** The first descendant that passes a type guard. `findOne` does not narrow its result. */
function firstOf<T extends SceneNode>(root: ChildrenMixin, test: (n: SceneNode) => n is T): T | null {
    return root.findOne((n) => test(n)) as T | null;
}

function rectOf(n: SceneNode): Rect {
    const t = n.absoluteTransform;
    const w = 'width' in n ? n.width : 0;
    const h = 'height' in n ? n.height : 0;
    return { x: t[0][2], y: t[1][2], width: w, height: h };
}

/** Converts an absolute point to the coordinate space children of `parent` use. */
function toLocal(parent: BaseNode, p: Pt): Pt {
    let a: BaseNode | null = parent;
    while (a && (a.type === 'GROUP' || a.type === 'BOOLEAN_OPERATION')) a = a.parent;
    if (!a || a.type === 'PAGE' || a.type === 'DOCUMENT' || !('absoluteTransform' in a)) return p;
    const t = (a as SceneNode).absoluteTransform;
    return { x: p.x - t[0][2], y: p.y - t[1][2] };
}

function readMeta<T>(node: BaseNode, key: string, parse: (raw: string) => T | null): T | null {
    return parse(node.getSharedPluginData(FLOW_NAMESPACE, key));
}

async function loadBoard(boardId: string): Promise<Board> {
    const node = await sceneById(boardId);
    if (!node) throw new Error(`No board ${boardId}.`);
    const meta = readMeta(node, BOARD_KEY, parseBoardMeta);
    if (!meta) throw new Error(`${boardId} has no flowbridge board data. Run adopt_board first.`);
    const arrows = await figma.getNodeByIdAsync(meta.arrowsGroupId);
    if (!arrows || !('children' in arrows)) throw new Error(`The arrows group ${meta.arrowsGroupId} of board ${boardId} is gone.`);
    return { node, meta, arrows: arrows as SceneNode & ChildrenMixin };
}

function listArrows(board: Board): ArrowEntry[] {
    const out: ArrowEntry[] = [];
    for (const c of board.arrows.children) {
        if (c.type !== 'GROUP') continue;
        const meta = readMeta(c, ARROW_KEY, parseArrowMeta);
        if (meta && meta.boardId === board.node.id) out.push({ group: c, meta });
    }
    return out;
}

const gutterOf = (m: BoardMeta) => m.colWidth - m.screenW;

type Endpoints = { source: Rect; target: Rect; trigger: Rect | null; triggerMissing: boolean; exit: Exit };

async function endpointsOf(meta: ArrowMeta): Promise<Endpoints | null> {
    const [from, to] = await Promise.all([sceneById(meta.from), sceneById(meta.to)]);
    if (!from || !to) return null;
    const trig = meta.trigger ? await sceneById(meta.trigger) : null;
    return { source: rectOf(from), target: rectOf(to), trigger: trig ? rectOf(trig) : null, triggerMissing: !!meta.trigger && !trig, exit: meta.exit ?? 'side' };
}

type Plan = { id: string; route: Route | null; error: string | null };

/** Routes arrows in the order given, giving each its own lane when it shares a corridor with an earlier one. */
function planRoutes(meta: BoardMeta, items: { id: string; ends: Endpoints }[]): Plan[] {
    const gutter = gutterOf(meta);
    const first = items.map((it) => routeArrow({ ...it.ends, gutter, lane: 0 }));
    const fans = fanIndex(
        items.flatMap((it, i) => {
            const r = first[i] as ReturnType<typeof routeArrow>;
            if (!r.ok || (r.kind !== 'trigger' && r.kind !== 'gutter')) return [];
            const s = it.ends.source;
            const startY = (r.points[0] as Pt).y;
            const targetY = it.ends.target.y + it.ends.target.height / 2;
            return targetY >= startY ? [{ id: it.id, group: `${s.x}:${s.y}:${gutterKey(s, it.ends.target)}`, targetY }] : [];
        }),
    );
    const lanes = assignLanes(
        items.map((it, i) => {
            const r = first[i] as ReturnType<typeof routeArrow>;
            const ys = r.ok ? r.points.map((p) => p.y) : [0];
            const shared = r.ok && r.kind !== 'straight' && r.kind !== 'elbow' && !fans.has(it.id);
            return { key: shared ? gutterKey(it.ends.source, it.ends.target) : `solo:${it.id}`, yMin: Math.min(...ys), yMax: Math.max(...ys) };
        }),
    );
    return items.map((it, i) => {
        const lane = lanes[i] as number;
        const fan = fans.get(it.id);
        const r = fan ? routeArrow({ ...it.ends, gutter, lane: 0, fan }) : lane === 0 ? (first[i] as ReturnType<typeof routeArrow>) : routeArrow({ ...it.ends, gutter, lane });
        return r.ok ? { id: it.id, route: r, error: null } : { id: it.id, route: null, error: r.error };
    });
}

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

async function newLabel(parent: SceneNode & ChildrenMixin, style: Style, label: string): Promise<FrameNode> {
    const template = firstOf(parent, (n): n is FrameNode => n.type === 'FRAME' && n.name.startsWith('Label ·'));
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

async function applyRoute(parts: { vector: VectorNode; dot: EllipseNode; label: FrameNode }, route: Route, style: Style): Promise<void> {
    await writeVector(parts.vector, route.points, style);
    centre(parts.dot, route.dot);
    centre(parts.label, route.labelAnchor);
}

/** Keeps the arrows group above every screen of the board, so start dots stay visible. */
function raiseArrows(board: Board): void {
    const parent = board.arrows.parent;
    if (!parent || !('children' in parent)) return;
    const kids = parent.children;
    const at = kids.indexOf(board.arrows as SceneNode);
    const screenAbove = kids.some((k, i) => i > at && k.type === 'FRAME' && readMeta(k, SCREEN_KEY, parseScreenMeta)?.boardId === board.node.id);
    if (screenAbove) parent.insertChild(kids.length - 1, board.arrows as SceneNode);
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

    const existing = listArrows(board);
    const match = existing.find((a) => a.meta.from === from.id && a.meta.to === to.id && a.meta.trigger === (trigger?.id ?? null));
    const ends: Endpoints = { source: rectOf(from), target: rectOf(to), trigger: trigger ? rectOf(trigger) : null, triggerMissing: false, exit };

    const others = (await orderedEntries(existing.filter((a) => a !== match))).flatMap((o) => (o.ends ? [{ id: o.entry.group.id, ends: o.ends }] : []));
    const plans = planRoutes(board.meta, [...others, { id: 'new', ends }]);
    const mine = plans[plans.length - 1] as Plan;
    if (!mine.route) return fail(mine.error ?? 'Could not route the arrow.');
    const route = mine.route;

    let parts = match ? await partsOf(match.meta) : null;
    if (match && !parts) match.group.remove();
    const style = board.meta.arrowStyle;
    if (!parts) {
        const vector = await newVector(board.arrows, style, `Arrow · ${label}`);
        const dot = await newDot(board.arrows, style);
        const lab = await newLabel(board.arrows, style, label);
        parts = { vector, dot, label: lab };
    } else {
        await setLabelText(parts.label, label);
        parts.vector.name = `Arrow · ${label}`;
    }
    await applyRoute(parts, route, style);

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
        group = figma.group([parts.vector, parts.dot, parts.label], board.arrows);
    }
    group.name = arrowGroupName(from.name, to.name, label);
    writeArrowMeta(group, meta);
    raiseArrows(board);

    let prototypeUpdated = false;
    if (trigger && prototype) {
        if (!('reactions' in trigger)) return fail(`${trigger.name} cannot hold prototype reactions. The arrow was drawn (${group.id}).`);
        const next = setNavigateTarget(trigger.reactions as unknown as ReactionLike[], to.id);
        await trigger.setReactionsAsync(next.reactions as unknown as Reaction[]);
        prototypeUpdated = true;
    }

    return ok({
        arrowGroupId: group.id,
        points: pts(route),
        prototypeUpdated,
        backwards: route.backwards,
        updated: !!match,
    });
};

async function boardsFor(args: JsonObject): Promise<Board[]> {
    const id = str(args, 'boardId');
    if (id) return [await loadBoard(id)];
    const boards: Board[] = [];
    for (const n of figma.currentPage.children) {
        if (readMeta(n, BOARD_KEY, parseBoardMeta)) boards.push(await loadBoard(n.id));
    }
    return boards;
}

export const rerouteFlow: Handler = async (args) => {
    const only = Array.isArray(args.arrowIds) ? new Set(args.arrowIds.filter((x): x is string => typeof x === 'string').map(norm)) : null;
    const boards = await boardsFor(args);
    if (!boards.length) return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    const rerouted: string[] = [];
    const backwards: JsonObject[] = [];
    const deleted: JsonObject[] = [];
    const errors: JsonObject[] = [];
    const warnings: JsonObject[] = [];
    for (const board of boards) {
        const ordered = await orderedEntries(listArrows(board));
        for (const o of ordered) {
            if (!o.ends) deleted.push({ arrowGroupId: o.entry.group.id, name: o.entry.group.name, from: o.entry.meta.from, to: o.entry.meta.to });
        }
        const live = ordered.flatMap((o) => (o.ends ? [{ entry: o.entry, ends: o.ends }] : []));
        const plans = planRoutes(board.meta, live.map((l) => ({ id: l.entry.group.id, ends: l.ends })));
        for (const [i, l] of live.entries()) {
            const plan = plans[i] as Plan;
            if (only && !only.has(l.entry.group.id)) continue;
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
            await applyRoute(parts, plan.route, board.meta.arrowStyle);
            rerouted.push(l.entry.group.id);
            if (plan.route.backwards) backwards.push({ arrowGroupId: l.entry.group.id, from: l.entry.meta.from, to: l.entry.meta.to, label: l.entry.meta.label });
        }
        raiseArrows(board);
    }
    return ok({ boards: boards.map((b) => b.node.id), rerouted: rerouted.length, reroutedIds: rerouted, backwards, deleted, errors, warnings });
};

type Reason = 'no-arrowhead' | 'tail-outside-board' | 'no-source-screen' | 'no-target-screen' | 'no-start-dot' | 'no-label';

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

async function pageOf(node: BaseNode): Promise<void> {
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

    const siblings = parent.children.filter((c) => c.id !== boardNode.id && !groups.some((g) => g.id === c.id));
    const frames = siblings.filter((c): c is FrameNode => c.type === 'FRAME' && inside({ x: rectOf(c).x, y: rectOf(c).y }, bounds, 1) && rectOf(c).x + c.width <= bounds.x + bounds.width + 1 && rectOf(c).y + c.height <= bounds.y + bounds.height + 1);
    const w = modeOf(frames.map((f) => f.width), 1);
    const h = modeOf(frames.map((f) => f.height), 1);
    const screens = frames.filter((f) => w !== null && h !== null && Math.abs(f.width - w) <= 1 && Math.abs(f.height - h) <= 1);
    const ignoredFrames = frames.filter((f) => !screens.includes(f)).map((f) => ({ id: f.id, name: f.name }));
    if (!screens.length) return fail('No screen frames found inside the board bounds.');
    const screenRects = screens.map((s) => ({ id: s.id, node: s, rect: rectOf(s) }));

    const grid = inferGrid(screenRects.map((s) => s.rect));
    const colWidth = typeof args.colWidth === 'number' ? args.colWidth : grid.colWidth;
    const rowHeight = typeof args.rowHeight === 'number' ? args.rowHeight : grid.rowHeight;

    const texts = siblings.filter((c): c is TextNode => c.type === 'TEXT').map((t) => ({ id: t.id, name: t.name, rect: rectOf(t) }));
    const style = readStyle(groups);
    const boardMeta: BoardMeta = {
        v: 1,
        kind: 'board',
        originX: grid.originX,
        originY: grid.originY,
        colWidth,
        rowHeight,
        screenW: grid.screenW,
        screenH: grid.screenH,
        labelOffset: 72,
        margin: Math.round(grid.originX - bounds.x),
        headingId: null,
        arrowsGroupId: arrowsGroup.id,
        arrowStyle: style,
    };

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

    const allChildren = groups.flatMap((g) => [...g.children]);
    const dots = allChildren
        .filter((c): c is EllipseNode => c.type === 'ELLIPSE' && c.width <= 16 && c.height <= 16)
        .map((c) => ({ id: c.id, node: c, center: { x: rectOf(c).x + c.width / 2, y: rectOf(c).y + c.height / 2 } }));
    const labels = allChildren
        .filter((c): c is FrameNode => c.type === 'FRAME' && c.name.startsWith('Label ·'))
        .map((c) => ({ id: c.id, node: c, center: { x: rectOf(c).x + c.width / 2, y: rectOf(c).y + c.height / 2 } }));
    const claimed = new Set<string>();

    const unmatched: { id: string; name: string; reason: Reason }[] = [];
    const planned: { vector: VectorNode; dot: EllipseNode; label: FrameNode; labelText: string; from: string; to: string; trigger: string | null; points: Pt[] }[] = [];
    let outsideBoard = 0;

    for (const v of allChildren) {
        if (v.type !== 'VECTOR') continue;
        const net = v.vectorNetwork;
        const local = orderPath(net.vertices, net.segments);
        if (!local) {
            unmatched.push({ id: v.id, name: v.name, reason: 'no-arrowhead' });
            continue;
        }
        const t = v.absoluteTransform;
        const abs = local.map((p) => ({ x: t[0][0] * p.x + t[0][1] * p.y + t[0][2], y: t[1][0] * p.x + t[1][1] * p.y + t[1][2] }));
        const tail = abs[0] as Pt;
        const head = abs[abs.length - 1] as Pt;
        if (!inside(tail, bounds, 40)) {
            outsideBoard++;
            continue;
        }
        const source = matchScreenAt(tail, screenRects);
        if (!source) {
            unmatched.push({ id: v.id, name: v.name, reason: 'no-source-screen' });
            continue;
        }
        const target = matchScreenAt(head, screenRects, 14, source.id);
        if (!target) {
            unmatched.push({ id: v.id, name: v.name, reason: 'no-target-screen' });
            continue;
        }
        const dot = nearestUnclaimed(tail, dots, 12, claimed);
        if (!dot) {
            unmatched.push({ id: v.id, name: v.name, reason: 'no-start-dot' });
            continue;
        }
        const lab = nearestUnclaimed(longestSegmentMid(abs), labels, 60, claimed);
        if (!lab) {
            unmatched.push({ id: v.id, name: v.name, reason: 'no-label' });
            continue;
        }
        claimed.add(dot.id);
        claimed.add(lab.id);
        const trig = matchTrigger(tail, triggersIn(screenRects.find((s) => s.id === source.id) as (typeof screenRects)[number]), target.id);
        const textNode = firstOf(lab.node, (n): n is TextNode => n.type === 'TEXT');
        planned.push({
            vector: v,
            dot: dot.node,
            label: lab.node,
            labelText: textNode?.characters ?? v.name.replace(/^Arrow ·\s*/, ''),
            from: source.id,
            to: target.id,
            trigger: trig?.id ?? null,
            points: abs,
        });
    }

    if (!dryRun) {
        boardNode.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(boardMeta));
        for (const s of screenRects) {
            const cell = cellOfRect(s.rect, boardMeta);
            const found = assignScreenTexts(s.rect, texts);
            const meta: ScreenMeta = { v: 1, kind: 'screen', boardId: boardNode.id, col: cell.col, row: cell.row, ...found };
            s.node.setSharedPluginData(FLOW_NAMESPACE, SCREEN_KEY, JSON.stringify(meta));
        }
        for (const p of planned) {
            const container = p.vector.parent && 'children' in p.vector.parent ? p.vector.parent : arrowsGroup;
            const group = figma.group([p.vector, p.dot, p.label], container as BaseNode & ChildrenMixin);
            const fromName = screenRects.find((s) => s.id === p.from)?.node.name ?? p.from;
            const toName = screenRects.find((s) => s.id === p.to)?.node.name ?? p.to;
            group.name = arrowGroupName(fromName, toName, p.labelText);
            writeArrowMeta(group, {
                v: 1,
                kind: 'arrow',
                boardId: boardNode.id,
                from: p.from,
                to: p.to,
                trigger: p.trigger,
                label: p.labelText,
                mode: p.trigger ? 'trigger' : 'auto',
                vectorId: p.vector.id,
                dotId: p.dot.id,
                labelId: p.label.id,
            });
        }
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
        grid: { originX: boardMeta.originX, originY: boardMeta.originY, colWidth, rowHeight, screenW: boardMeta.screenW, screenH: boardMeta.screenH },
        arrowStyle: style as unknown as JsonObject,
        screens: screenRects.length,
        arrowsAdopted: planned.length,
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
