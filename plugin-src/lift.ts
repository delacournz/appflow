/**
 * Figma's plugin API rejects a prototype reaction whose source or destination screen sits inside a group
 * ("destination ... was rejected"), though the editor itself allows it. Screens on a board live in
 * `Screen · …` groups, so prototype writes lift them out for the call and put them back afterwards.
 * Groups have no coordinate system of their own, so the move does not shift anything on the canvas,
 * and reactions survive the regroup.
 */

/** The slice of a Figma node this needs; real nodes satisfy it, and tests use fakes. */
export type LiftNode = {
    type: string;
    parent: LiftNode | null;
    readonly children?: readonly LiftNode[];
    insertChild?(index: number, child: LiftNode): void;
};

type Restore = () => void;

function lift(frame: LiftNode): Restore | null {
    const group = frame.parent;
    const host = group?.parent;
    if (group?.type !== 'GROUP' || !host?.insertChild || !group.insertChild || !group.children || !host.children) return null;
    const index = group.children.indexOf(frame);
    host.insertChild(host.children.indexOf(group) + 1, frame);
    return () => group.insertChild?.(index, frame);
}

/** Runs `work` with each grouped screen moved beside its group, then restores every screen to its group and index. */
export async function liftOutOfGroups<T>(frames: readonly LiftNode[], work: () => Promise<T>): Promise<T> {
    const restores: Restore[] = [];
    try {
        for (const f of new Set(frames)) {
            const r = lift(f);
            if (r) restores.push(r);
        }
        return await work();
    } finally {
        for (const r of restores.reverse()) r();
    }
}
