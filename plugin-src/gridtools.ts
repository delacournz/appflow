import type { JsonObject } from '../shared/protocol';
import { applyExtras, applyMoves, cellsOf, loadScreens, resizeBoard, writeScreen, type Screen, type StaleFix } from './board-ops';
import { loadBoard, readMeta, rectOf, rerouteBoards, sceneById, type Board } from './flow';
import { checkGroupArg, refitGroups, setScreenGroup } from './flow-groups';
import { BOARD_KEY, FLOW_NAMESPACE, parseBoardMeta, SCREEN_KEY, parseScreenMeta, type BoardMeta } from './flowmeta';
import { boardBounds, compactedExtras, compactPlan, planMove, shiftedExtras, shiftPlan, type GridMeta, type Move, type ExtrasPair } from './grid';
import { fail, num, ok, str, bool, type Handler, type MainReply } from './types';

const DEFAULT_ARROW_STYLE: BoardMeta['arrowStyle'] = { strokeVariableId: null, color: { r: 0.576, g: 0.839, b: 0.933 }, weight: 2, cornerRadius: 20 };
const DARK_FILL: SolidPaint = { type: 'SOLID', color: { r: 0.067, g: 0.067, b: 0.067 } };

async function finish(board: Board, screens: Screen[], stale: StaleFix[], moves: Move[], shrink: boolean, extras?: ExtrasPair): Promise<MainReply> {
    if (extras) applyExtras(board, extras);
    const moved = await applyMoves(board, screens, moves);
    const fit = await refitGroups(board, screens);
    const size = await resizeBoard(board, screens, shrink, fit.extent);
    const reroute = await rerouteBoards([board]);
    return ok({ boardId: board.node.id, moved, stale: stale.map((s) => ({ ...s, fixedTo: { ...s.fixedTo } })), board: size, reroute, ...(fit.active ? { groups: fit.summary } : {}) });
}

const wholeNumber = (v: number | undefined, fallback: number, min: number): number | null => {
    const n = v ?? fallback;
    return Number.isInteger(n) && n >= min ? n : null;
};

export const moveScreen: Handler = async (args) => {
    const id = str(args, 'id');
    const col = num(args, 'col');
    const row = num(args, 'row');
    if (!id || col === undefined || row === undefined) return fail('move_screen needs id, col and row.');
    const node = await sceneById(id);
    if (!node) return fail(`No node ${id}.`);
    const stored = readMeta(node, SCREEN_KEY, parseScreenMeta);
    if (!stored) return fail(`${node.name} (${node.id}) is not an adopted screen. Run adopt_board first.`);
    const board = await loadBoard(stored.boardId);
    const { screens, stale } = await loadScreens(board);
    const plan = planMove(cellsOf(screens), node.id, col, row, bool(args, 'swap', false));
    if (!plan.ok) return fail(plan.error);
    const groupArg = str(args, 'group');
    if (groupArg !== undefined) {
        const target = await checkGroupArg(board.node.id, groupArg);
        if (!target.ok) return fail(target.error);
        const set = await setScreenGroup(board, screens, node.id, target.groupId);
        if (!set.ok) return fail(set.error);
    }
    return finish(board, screens, stale, plan.moves, false);
};

async function insertAlong(args: JsonObject, axis: 'col' | 'row'): Promise<MainReply> {
    const tool = axis === 'col' ? 'insert_columns' : 'insert_rows';
    const boardId = str(args, 'boardId');
    const after = num(args, 'after');
    if (!boardId || after === undefined) return fail(`${tool} needs boardId and after.`);
    const count = wholeNumber(num(args, 'count'), 1, 1);
    if (count === null || count > 50) return fail('count must be a whole number from 1 to 50.');
    if (!Number.isInteger(after) || after < -1) return fail('after must be a whole number, -1 or more (-1 inserts before the first).');
    const board = await loadBoard(boardId);
    const { screens, stale } = await loadScreens(board);
    return finish(board, screens, stale, shiftPlan(cellsOf(screens), axis, after, count), false, shiftedExtras(board.meta, axis, after, count));
}

export const insertColumns: Handler = (args) => insertAlong(args, 'col');
export const insertRows: Handler = (args) => insertAlong(args, 'row');

export const compactBoard: Handler = async (args) => {
    const boardId = str(args, 'boardId');
    if (!boardId) return fail('compact_board needs boardId.');
    const board = await loadBoard(boardId);
    const { screens, stale } = await loadScreens(board);
    return finish(board, screens, stale, compactPlan(cellsOf(screens)), true, compactedExtras(board.meta, cellsOf(screens)));
};

async function fontFor(text: TextNode): Promise<FontName> {
    const current = text.fontName;
    const candidates: FontName[] = [...(current === figma.mixed ? [] : [current]), { family: 'Inter', style: 'Bold' }, { family: 'Inter', style: 'Regular' }];
    for (const font of candidates) {
        try {
            await figma.loadFontAsync(font);
            return font;
        } catch {
            continue;
        }
    }
    throw new Error('Could not load a font for the board heading.');
}

async function findStyleBoard(): Promise<Board | null> {
    for (const n of figma.currentPage.children) {
        if (!readMeta(n, BOARD_KEY, parseBoardMeta)) continue;
        try {
            return await loadBoard(n.id);
        } catch {
            continue;
        }
    }
    return null;
}

export const createBoard: Handler = async (args) => {
    const name = str(args, 'name');
    if (!name) return fail('create_board needs name.');
    const colWidth = num(args, 'colWidth') ?? 700;
    const rowHeight = num(args, 'rowHeight') ?? 1112;
    const screenW = num(args, 'screenW') ?? 393;
    const screenH = num(args, 'screenH') ?? 852;
    const cols = wholeNumber(num(args, 'cols'), 4, 1);
    const rows = wholeNumber(num(args, 'rows'), 2, 1);
    if (cols === null || rows === null || cols > 50 || rows > 50) return fail('cols and rows must be whole numbers from 1 to 50.');
    if (![colWidth, rowHeight, screenW, screenH].every((n) => n > 0)) return fail('colWidth, rowHeight, screenW and screenH must be positive.');
    if (colWidth < screenW || rowHeight < screenH) return fail('colWidth and rowHeight must be at least the screen size, or the screens overlap.');

    const page = figma.currentPage;
    const styleBoard = await findStyleBoard();
    const margin = styleBoard?.meta.margin ?? 80;
    const labelOffset = styleBoard?.meta.labelOffset ?? 80;
    const arrowStyle = styleBoard?.meta.arrowStyle ?? DEFAULT_ARROW_STYLE;

    const rects = page.children.map(rectOf);
    const x = num(args, 'x') ?? (rects.length ? Math.max(...rects.map((r) => r.x + r.width)) + 200 : 0);
    const y = num(args, 'y') ?? (rects.length ? Math.min(...rects.map((r) => r.y)) : 0);

    const grid: GridMeta = { originX: x + margin, originY: y + margin + labelOffset, colWidth, rowHeight, screenW, screenH, labelOffset, margin };
    const bounds = boardBounds(grid, [{ col: cols - 1, row: rows - 1 }]);

    const styleBg = styleBoard?.node;
    let bg: RectangleNode;
    if (styleBg?.type === 'RECTANGLE') {
        bg = styleBg.clone();
        bg.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, '');
    } else {
        bg = figma.createRectangle();
        const fills = styleBg && 'fills' in styleBg && styleBg.fills !== figma.mixed ? styleBg.fills : [DARK_FILL];
        bg.fills = fills;
        if (styleBg && 'cornerRadius' in styleBg && typeof styleBg.cornerRadius === 'number') bg.cornerRadius = styleBg.cornerRadius;
    }
    page.appendChild(bg);
    bg.name = `Board background · ${name}`;
    bg.x = bounds.x;
    bg.y = bounds.y;
    bg.resize(bounds.width, bounds.height);

    const headingNode = styleBoard?.meta.headingId ? await sceneById(styleBoard.meta.headingId) : null;
    const headingStyle = headingNode?.type === 'TEXT' ? headingNode : (page.children.find((c): c is TextNode => c.type === 'TEXT' && c.name.startsWith('Board ·')) ?? null);
    const heading = headingStyle ? headingStyle.clone() : figma.createText();
    page.appendChild(heading);
    await figma.loadFontAsync(await fontFor(heading));
    heading.fontName = await fontFor(heading);
    if (!headingStyle) {
        heading.fontSize = 48;
        heading.fills = [{ type: 'SOLID', color: { r: 0.949, g: 0.949, b: 0.949 } }];
    }
    heading.characters = `Board · ${name}`;
    heading.name = `Board · ${name}`;
    heading.x = bounds.x;
    heading.y = bounds.y - heading.height - 24;

    const arrows = figma.createFrame();
    page.appendChild(arrows);
    arrows.name = `Flow arrows · ${name}`;
    arrows.fills = [];
    arrows.clipsContent = false;
    arrows.resize(1, 1);
    arrows.x = bounds.x;
    arrows.y = bounds.y;

    const meta: BoardMeta = { v: 1, kind: 'board', ...grid, headingId: heading.id, arrowsGroupId: arrows.id, arrowStyle };
    bg.setSharedPluginData(FLOW_NAMESPACE, BOARD_KEY, JSON.stringify(meta));

    return ok({
        boardId: bg.id,
        headingId: heading.id,
        arrowsGroupId: arrows.id,
        bounds,
        grid: { originX: grid.originX, originY: grid.originY, colWidth, rowHeight, screenW, screenH, cols, rows },
        styledFrom: styleBoard ? styleBoard.node.id : null,
    });
};
