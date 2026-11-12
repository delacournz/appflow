import type { JsonObject } from '../shared/protocol';
import { loadScreens } from './board-ops';
import { collectBadges, collectScreens, listArrows, readMeta, rectOf, sceneById, type Board } from './flow';
import { orphanBadges } from './badge-link';
import { SCREEN_KEY, parseScreenMeta } from './flowmeta';
import type { Rect } from './route';
import type { ConflictContent, ConflictGroup } from './flow-group';
import { footprintOf, loadGroups } from './flow-groups';
import { orderPath } from './flowlint';
import { lintArrows, lintGroups, type ArrowShape, type LayoutIssue, type OrphanBadgeIssue, type TitleText } from './group-lint';
import { titleTextRect } from './route-avoid';

/** An arrow's absolute path (rounded like `lintFlowLayout`), or null when its vector is gone or not a single-headed line. */
async function pathOf(vectorId: string): Promise<{ x: number; y: number }[] | null> {
    const n = await sceneById(vectorId);
    if (n?.type !== 'VECTOR') return null;
    const local = orderPath(n.vectorNetwork.vertices, n.vectorNetwork.segments);
    if (!local) return null;
    const [[a, b, tx], [c, d, ty]] = n.absoluteTransform;
    return local.map((p) => ({ x: Math.round(a * p.x + b * p.y + tx), y: Math.round(c * p.x + d * p.y + ty) }));
}

/** The text area of a group's title: its real character count when the title holds text, else the router's default guess. */
function titleTextOf(box: Rect, bar: Rect, title: SceneNode): Rect | null {
    const text = title.type === 'TEXT' ? title : title.type === 'FRAME' ? title.children.find((k): k is TextNode => k.type === 'TEXT') : undefined;
    return titleTextRect({ box, title: bar, ...(text ? { titleChars: text.characters.length } : {}) });
}

/** Arrow-level checks: label vs label, collinear lines, lines through title text. Never repaints. */
async function arrowIssues(board: Board, titles: TitleText[]): Promise<{ issues: LayoutIssue[]; counts: Record<string, number> }> {
    const arrows: ArrowShape[] = [];
    for (const a of listArrows(board)) {
        const points = await pathOf(a.meta.vectorId);
        if (!points) continue;
        const label = await sceneById(a.meta.labelId);
        arrows.push({ id: a.group.id, points, label: label ? rectOf(label) : null });
    }
    return lintArrows(arrows, titles);
}

/** The layout part of lint_flow_layout for one board: reads the drawn boxes and arrows (never repaints) and checks them against the board's content. */
/** `orphan-badge`: a build badge on the board that no screen points at. `badge_screens` removes them. */
function orphanBadgeIssues(board: Board): (OrphanBadgeIssue & { message: string })[] {
    const parent = board.node.parent;
    if (!parent || !('children' in parent)) return [];
    const referenced = new Set<string>();
    for (const { frame } of collectScreens(parent.children)) {
        const meta = readMeta(frame, SCREEN_KEY, parseScreenMeta);
        if (meta?.badgeId) referenced.add(meta.badgeId);
    }
    const badges = collectBadges(parent.children).map((b) => ({ id: b.id, name: b.name, rect: rectOf(b) }));
    return orphanBadges(badges, referenced, rectOf(board.node)).map((id) => ({
        kind: 'orphan-badge' as const,
        badgeId: id,
        message: `Badge ${badges.find((b) => b.id === id)?.name ?? id} belongs to no screen. Run badge_screens to remove it.`,
    }));
}

export async function boardLayoutLint(board: Board): Promise<{ boardId: string; issues: JsonObject[]; counts: Record<string, number> } | null> {
    const loaded = (await loadGroups(board)).filter((g) => g.rect.visible);
    const titles: TitleText[] = [];
    for (const g of loaded) {
        if (!g.title) continue;
        const text = titleTextOf(rectOf(g.rect), rectOf(g.title), g.title);
        if (text) titles.push({ id: g.id, text });
    }
    const arrowPart = await arrowIssues(board, titles);
    const orphans = orphanBadgeIssues(board);
    if (orphans.length) {
        arrowPart.issues.push(...orphans);
        arrowPart.counts['orphan-badge'] = orphans.length;
    }
    if (!loaded.length) return arrowPart.issues.length ? { boardId: board.node.id, issues: arrowPart.issues as unknown as JsonObject[], counts: arrowPart.counts } : null;
    const { screens } = await loadScreens(board);
    const contents: ConflictContent[] = [];
    for (const s of screens) {
        const p = await footprintOf(s);
        contents.push({ kind: 'screen', id: s.node.id, rect: p.frame, ...(s.meta.flowGroupId ? { ownerGroupId: s.meta.flowGroupId } : {}) });
        if (p.route && s.meta.routeId) contents.push({ kind: 'route', id: s.meta.routeId, rect: p.route });
        if (p.badge && s.meta.badgeId) contents.push({ kind: 'badge', id: s.meta.badgeId, rect: p.badge });
    }
    for (const a of listArrows(board)) {
        const label = await sceneById(a.meta.labelId);
        if (label) contents.push({ kind: 'label', id: a.meta.labelId, rect: rectOf(label) });
    }
    const groups: ConflictGroup[] = loaded.map((g) => {
        const box = rectOf(g.rect);
        return { id: g.id, ...(g.meta.parentId ? { parentId: g.meta.parentId } : {}), box, title: g.title ? rectOf(g.title) : { x: box.x, y: box.y, width: 0, height: 0 } };
    });
    const r = lintGroups(groups, contents);
    const counts = { ...r.counts };
    for (const [k, v] of Object.entries(arrowPart.counts)) counts[k] = (counts[k] ?? 0) + v;
    return { boardId: board.node.id, issues: [...r.issues, ...arrowPart.issues] as unknown as JsonObject[], counts };
}

