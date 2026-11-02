import type { JsonObject } from '../shared/protocol';
import { renderBoard, type BoardArrow, type BoardDescription, type BoardScreen } from './board-text';
import { collectScreens, loadBoard, readMeta, rectOf, sceneById, type Board } from './flow';
import { ARROW_KEY, BOARD_KEY, SCREEN_KEY, parseArrowMeta, parseBoardMeta, parseScreenMeta } from './flowmeta';
import { fail, num, ok, str, type Handler } from './types';

const DEFAULT_WIDTH = 16;

async function screensOf(board: Board): Promise<BoardScreen[]> {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return [];
    const out: BoardScreen[] = [];
    for (const { frame: c } of collectScreens(parent.children)) {
        const meta = readMeta(c, SCREEN_KEY, parseScreenMeta);
        if (!meta || meta.boardId !== board.node.id) continue;
        const label = meta.labelId ? await sceneById(meta.labelId) : null;
        const r = rectOf(c);
        out.push({ id: c.id, name: c.name, col: meta.col, row: meta.row, x: r.x, y: r.y, labelX: label ? rectOf(label).x : null });
    }
    return out;
}

async function arrowsOf(board: Board): Promise<BoardArrow[]> {
    const out: BoardArrow[] = [];
    for (const g of board.arrows.children) {
        if (g.type !== 'GROUP') continue;
        const meta = readMeta(g, ARROW_KEY, parseArrowMeta);
        if (!meta || meta.boardId !== board.node.id) continue;
        const trigger = meta.trigger ? await sceneById(meta.trigger) : null;
        out.push({ from: meta.from, to: meta.to, label: meta.label, mode: meta.mode, triggerName: trigger?.name ?? null, exit: meta.exit });
    }
    return out;
}

async function describeOne(board: Board, width: number): Promise<BoardDescription> {
    const [screens, arrows] = await Promise.all([screensOf(board), arrowsOf(board)]);
    return renderBoard({ boardId: board.node.id, name: board.node.name, meta: board.meta, screens, arrows }, width);
}

export const describeBoard: Handler = async (args: JsonObject) => {
    const width = num(args, 'width') ?? DEFAULT_WIDTH;
    const id = str(args, 'boardId');
    const boards: Board[] = [];
    if (id) {
        boards.push(await loadBoard(id));
    } else {
        for (const n of figma.currentPage.children) {
            if (readMeta(n, BOARD_KEY, parseBoardMeta)) boards.push(await loadBoard(n.id));
        }
    }
    if (!boards.length) return fail('No adopted boards on this page. Run adopt_board first, or pass boardId.');
    const described = await Promise.all(boards.map((b) => describeOne(b, width)));
    return ok({ boards: described as unknown as JsonObject[] });
};
