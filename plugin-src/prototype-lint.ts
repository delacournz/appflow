/** Pure checks that a board's prototype reactions and its arrows tell the same story. No `figma` global. */

/** A NAVIGATE reaction found on a board screen (`nodeId === screenId`) or one of its descendants. `trigger` is the reaction trigger type. */
export type ProtoReaction = { nodeId: string; screenId: string; trigger: string; destinationId: string };
export type ProtoArrow = { id: string; from: string; to: string; trigger: string | null };
export type ProtoScreen = { id: string; name: string };

export type PrototypeIssue =
    | { kind: 'prototype-mismatch'; severity: 'warning'; arrowId: string; sourceName: string; targetName: string; reactionNodeId: string; destinationId: string | null }
    | { kind: 'prototype-without-arrow'; severity: 'warning'; sourceName: string; targetName: string; reactionNodeId: string; destinationId: string }
    | { kind: 'auto-arrow-no-prototype'; severity: 'info'; arrowId: string; sourceName: string; targetName: string; reactionNodeId: string; destinationId: string };

export type PrototypeLintIssue = PrototypeIssue & { message: string };

/** Issues that do not fail `lint_flow_layout`. */
export const isInformational = (i: { severity?: string }): boolean => i.severity === 'info';

/**
 * - `prototype-mismatch`: an arrow's trigger has no navigate reaction to the arrow's target (none at all, or only to other nodes).
 * - `prototype-without-arrow`: a navigate reaction, on a screen or inside it (screen-level timers included), goes to another
 *   screen of the board and no arrow covers that from/to pair. Reactions to anything that is not a board screen are ignored.
 * - `auto-arrow-no-prototype` (informational): an arrow with no trigger whose source has neither a frame-level
 *   AFTER_TIMEOUT nor any reaction to that target.
 */
export function lintPrototype(screens: readonly ProtoScreen[], arrows: readonly ProtoArrow[], reactions: readonly ProtoReaction[]): PrototypeLintIssue[] {
    const name = (id: string) => screens.find((s) => s.id === id)?.name ?? id;
    const isScreen = (id: string) => screens.some((s) => s.id === id);
    const out: PrototypeLintIssue[] = [];
    for (const a of arrows) {
        if (a.trigger) {
            const own = reactions.filter((r) => r.nodeId === a.trigger);
            if (own.some((r) => r.destinationId === a.to)) continue;
            const actual = own.find((r) => isScreen(r.destinationId)) ?? own[0];
            const dest = actual?.destinationId ?? null;
            out.push({
                kind: 'prototype-mismatch',
                severity: 'warning',
                arrowId: a.id,
                sourceName: name(a.from),
                targetName: name(a.to),
                reactionNodeId: a.trigger,
                destinationId: dest,
                message: dest
                    ? `Arrow ${a.id} (${name(a.from)} to ${name(a.to)}) has trigger ${a.trigger}, but its prototype goes to ${name(dest)} (${dest})`
                    : `Arrow ${a.id} (${name(a.from)} to ${name(a.to)}) has trigger ${a.trigger}, which has no navigate reaction`,
            });
        } else {
            const mine = reactions.filter((r) => r.screenId === a.from);
            if (mine.some((r) => r.nodeId === a.from && r.trigger === 'AFTER_TIMEOUT') || mine.some((r) => r.destinationId === a.to)) continue;
            out.push({
                kind: 'auto-arrow-no-prototype',
                severity: 'info',
                arrowId: a.id,
                sourceName: name(a.from),
                targetName: name(a.to),
                reactionNodeId: a.from,
                destinationId: a.to,
                message: `Auto arrow ${a.id} (${name(a.from)} to ${name(a.to)}) has no matching prototype: ${name(a.from)} has no AFTER_TIMEOUT and no reaction to ${name(a.to)}`,
            });
        }
    }
    for (const r of reactions) {
        if (!isScreen(r.destinationId) || r.destinationId === r.screenId) continue;
        if (arrows.some((a) => a.from === r.screenId && a.to === r.destinationId)) continue;
        out.push({
            kind: 'prototype-without-arrow',
            severity: 'warning',
            sourceName: name(r.screenId),
            targetName: name(r.destinationId),
            reactionNodeId: r.nodeId,
            destinationId: r.destinationId,
            message: `${r.trigger} reaction on ${r.nodeId} in ${name(r.screenId)} navigates to ${name(r.destinationId)}, but no arrow connects them`,
        });
    }
    return out;
}
