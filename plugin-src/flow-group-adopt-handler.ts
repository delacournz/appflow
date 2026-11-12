/**
 * adopt_flow_groups: turns hand-drawn group boxes and `Section Heading` instances on a flow board into flow groups.
 * Detection is pure (`planAdopt`); this file reads the page, runs it, creates the groups with one refit, and deletes the
 * old nodes only on request. Instances are removed as instances; their main components are never touched.
 */
import type { JsonObject, JsonValue } from '../shared/protocol';
import { loadScreens } from './board-ops';
import { boardsFor, rectOf, sceneById, type Board } from './flow';
import { createGroupsBatch, type GroupSpec } from './flow-groups';
import { planAdopt, type AdoptPlan, type Candidate, type PlannedGroup } from './flow-group-adopt';
import type { Rect } from './rect';
import { fail, ok, bool, type Handler } from './types';

const MAX_DEPTH = 4;
const MAX_NODES = 5000;

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function strokeVisible(n: SceneNode): boolean {
    if (!('strokes' in n)) return false;
    const w = 'strokeWeight' in n ? n.strokeWeight : 1;
    if (typeof w === 'number' && w <= 0) return false;
    return n.strokes.some((s) => s.visible !== false && (s.opacity ?? 1) > 0);
}

function fillAlphaOf(n: SceneNode): number {
    if (!('fills' in n)) return 0;
    const fills = n.fills;
    if (fills === figma.mixed) return 1;
    const own = 'opacity' in n ? n.opacity : 1;
    let max = 0;
    for (const f of fills) {
        if (f.visible === false) continue;
        max = Math.max(max, f.type === 'SOLID' ? (f.opacity ?? 1) : 1);
    }
    return max * own;
}

function textOf(n: SceneNode): string | undefined {
    if (n.type === 'TEXT') return n.characters;
    if (n.type === 'INSTANCE') {
        const t = n.findOne((c) => c.type === 'TEXT');
        return t && t.type === 'TEXT' ? t.characters : undefined;
    }
    return undefined;
}

/** Plain candidate data for every box/title-like node over the board area, skipping screens and the board's own layers. */
function collect(skip: ReadonlySet<string>, area: Rect): Candidate[] {
    const out: Candidate[] = [];
    const visit = (n: SceneNode, depth: number, parentId?: string): void => {
        if (out.length >= MAX_NODES || skip.has(n.id) || !n.visible || n.name.startsWith('Flow groups ·')) return;
        const rect = rectOf(n);
        if (!overlaps(rect, area)) return;
        if (n.type === 'RECTANGLE' || n.type === 'FRAME' || n.type === 'TEXT' || n.type === 'INSTANCE') {
            const text = textOf(n);
            out.push({
                id: n.id,
                type: n.type,
                name: n.name,
                rect,
                hasStroke: strokeVisible(n),
                fillAlpha: fillAlphaOf(n),
                ...(text === undefined ? {} : { text }),
                ...(parentId ? { parentId } : {}),
            });
        }
        if (n.type === 'INSTANCE' || !('children' in n) || depth >= MAX_DEPTH) return;
        for (const c of n.children) visit(c, depth + 1, n.id);
    };
    for (const c of figma.currentPage.children) visit(c, 0);
    return out;
}

const json = (v: unknown): JsonValue => v as JsonValue;

/** Parents first, so a child can take its screens from the parent that already holds them. */
function specsOf(groups: readonly PlannedGroup[]): GroupSpec[] {
    const parents = groups.filter((g) => !g.parentKey);
    const children = groups.filter((g) => g.parentKey);
    return [...parents, ...children].map((g) => ({
        key: g.key,
        name: g.name,
        screenIds: g.parentKey ? g.memberIds : g.allMemberIds,
        ...(g.parentKey ? { parentKey: g.parentKey } : {}),
    }));
}

async function adoptBoard(board: Board, dryRun: boolean, removeOld: boolean): Promise<JsonObject> {
    const { screens } = await loadScreens(board);
    const screenIds = new Set(screens.map((s) => s.node.id));
    const skip = new Set<string>([board.node.id, board.meta.arrowsGroupId, ...(board.meta.labelsGroupId ? [board.meta.labelsGroupId] : []), ...(board.meta.headingId ? [board.meta.headingId] : []), ...screenIds]);
    const candidates = collect(skip, rectOf(board.node));
    const plan: AdoptPlan = planAdopt({
        candidates,
        screens: screens.map((s) => ({ id: s.node.id, name: s.node.name, rect: rectOf(s.node) })),
    });
    const base = { boardId: board.node.id, groups: json(plan.groups), skipped: json(plan.skipped) };
    if (dryRun) {
        const wouldRemove = plan.groups.flatMap((g) => g.sourceNodeIds);
        return { dryRun: true, ...base, wouldRemove: removeOld ? wouldRemove : [], note: 'Nothing changed. Re-run with dryRun false to create the groups; removeOld true also deletes the old nodes (only with the user\'s say-so).' };
    }
    const batch = await createGroupsBatch(board, screens, specsOf(plan.groups));
    const made = new Set(batch.created.map((c) => c.key));
    const removed: string[] = [];
    if (removeOld) {
        for (const g of plan.groups) {
            if (!made.has(g.key)) continue;
            for (const id of g.sourceNodeIds) {
                const n = await sceneById(id);
                if (n && !n.removed) {
                    n.remove();
                    removed.push(id);
                }
            }
        }
    }
    return {
        dryRun: false,
        ...base,
        created: json(batch.created),
        errors: batch.errors,
        removed,
        ...(batch.fit ? { issues: json(batch.fit.issues), nesting: json(batch.fit.nesting) } : {}),
    };
}

export const adoptFlowGroups: Handler = async (args) => {
    const dryRun = bool(args, 'dryRun', true);
    const removeOld = bool(args, 'removeOld', false);
    const boards = await boardsFor(args);
    if (!boards.length) return fail('No adopted board on this page. Run adopt_board first.');
    const results: JsonObject[] = [];
    for (const b of boards) results.push(await adoptBoard(b, dryRun, removeOld));
    return ok({ dryRun, removeOld, boards: results });
};
