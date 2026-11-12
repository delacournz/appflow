/** Pure checks that a board's prototype reactions and its arrows tell the same story. No `figma` global. */

/**
 * A NAVIGATE reaction found on a board screen (`nodeId === screenId`) or one of its descendants. `trigger` is the
 * reaction trigger type. `nodeName` and `ancestorNames` (the node's parents up to, not including, the screen) are
 * optional: names help people find the control and drive the tab-bar exemption.
 */
export type ProtoReaction = { nodeId: string; screenId: string; trigger: string; destinationId: string; nodeName?: string; ancestorNames?: string[] };
/** `label` and `triggerAncestorNames` (names of the trigger node and its parents) are optional and only used to find tab roots. */
export type ProtoArrow = { id: string; from: string; to: string; trigger: string | null; label?: string; triggerName?: string; triggerAncestorNames?: string[] };

/** Layers that hold persistent navigation: a reaction on one, or inside one, needs no arrow of its own. */
export const TAB_BAR_NAME = /tab ?bar|bottom ?nav|navigation ?bar/i;
/** Names of the controls behind tab arrows: `Hotspot · Pay`, or anything with Tab in it. */
export const TAB_TRIGGER_NAME = /^Hotspot ·|tab/i;

/** A screen's name without its state suffix: `Account · verify your identity` is `Account`. */
export const baseName = (screenName: string): string => (screenName.split(' · ')[0] ?? screenName).trim();

/** True when `nodeName` ends in `· <tab>` for one of the tab names (`Hotspot · Pay`). */
export function endsWithTab(nodeName: string | undefined, tabNames: ReadonlySet<string>): boolean {
    const m = nodeName ? /·\s*([^·]+?)\s*$/.exec(nodeName) : null;
    return !!m && tabNames.has((m[1] as string).trim());
}

/** Labels of the arrows that reach tab roots (Home, Pay, Activity, Account). */
export const TAB_ARROW_LABEL = /^tap (home|pay|activity|account)\b/i;
export type ProtoScreen = { id: string; name: string };

/** `triggerName` is the name of the control holding the reaction, when known. */
export type PrototypeIssue =
    | { kind: 'prototype-mismatch'; severity: 'warning'; arrowId: string; sourceName: string; targetName: string; reactionNodeId: string; triggerName: string | null; destinationId: string | null }
    | { kind: 'prototype-without-arrow'; severity: 'warning'; sourceName: string; targetName: string; reactionNodeId: string; triggerName: string | null; destinationId: string }
    | { kind: 'auto-arrow-no-prototype'; severity: 'info'; arrowId: string; sourceName: string; targetName: string; reactionNodeId: string; triggerName: string | null; destinationId: string };

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
export function lintPrototype(screens: readonly ProtoScreen[], arrows: readonly ProtoArrow[], rawReactions: readonly ProtoReaction[]): { issues: PrototypeLintIssue[]; exemptCount: number } {
    const name = (id: string) => screens.find((s) => s.id === id)?.name ?? id;
    const isScreen = (id: string) => screens.some((s) => s.id === id);
    const reactions = dedupeReactions(rawReactions);
    const tabRoots = new Set(
        arrows
            .filter((a) => (a.label !== undefined && TAB_ARROW_LABEL.test(a.label)) || (a.triggerAncestorNames ?? []).some((n) => TAB_BAR_NAME.test(n)) || (a.triggerName !== undefined && TAB_TRIGGER_NAME.test(a.triggerName)))
            .map((a) => a.to),
    );
    const rootBases = new Set([...tabRoots].map((id) => baseName(name(id))));
    let exemptCount = 0;
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
                triggerName: a.triggerName ?? actual?.nodeName ?? null,
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
                triggerName: null,
                destinationId: a.to,
                message: `Auto arrow ${a.id} (${name(a.from)} to ${name(a.to)}) has no matching prototype: ${name(a.from)} has no AFTER_TIMEOUT and no reaction to ${name(a.to)}`,
            });
        }
    }
    for (const r of reactions) {
        if (!isScreen(r.destinationId) || r.destinationId === r.screenId) continue;
        if (arrows.some((a) => a.from === r.screenId && a.to === r.destinationId)) continue;
        if ([r.nodeName ?? '', ...(r.ancestorNames ?? [])].some((n) => TAB_BAR_NAME.test(n)) || tabRoots.has(r.destinationId) || rootBases.has(baseName(name(r.destinationId))) || endsWithTab(r.nodeName, rootBases)) {
            exemptCount++;
            continue;
        }
        out.push({
            kind: 'prototype-without-arrow',
            severity: 'warning',
            sourceName: name(r.screenId),
            targetName: name(r.destinationId),
            reactionNodeId: r.nodeId,
            triggerName: r.nodeName ?? null,
            destinationId: r.destinationId,
            message: `${r.trigger} reaction on ${r.nodeId} in ${name(r.screenId)} navigates to ${name(r.destinationId)}, but no arrow connects them`,
        });
    }
    return { issues: out, exemptCount };
}

/**
 * One reaction per (node, destination). A reaction read from a layer inside an instance (`I{instance};{inner}` ids) is a
 * copy of one on the instance when that has the same destination: the copy is dropped and the instance's kept.
 */
export function dedupeReactions(reactions: readonly ProtoReaction[]): ProtoReaction[] {
    const outerOf = (id: string): string | null => {
        const m = /^I([^;]+);/.exec(id);
        return m ? (m[1] as string) : null;
    };
    const seen = new Set<string>();
    const out: ProtoReaction[] = [];
    for (const r of reactions) {
        const key = `${r.nodeId}>${r.destinationId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const outer = outerOf(r.nodeId);
        if (outer && reactions.some((o) => o.nodeId === outer && o.destinationId === r.destinationId)) continue;
        out.push(r);
    }
    return out;
}
