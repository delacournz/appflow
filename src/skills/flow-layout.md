---
name: flow-layout
description: Lay out screen flows in Figma so they read left to right, with no arrows pointing or running back on themselves. Use before placing, moving or copying screens or drawing flow arrows. Use the board tools (adopt_board, move_screen, duplicate_screen, connect, reroute_flow) instead of hand-drawing vectors, and finish with lint_flow_layout and describe_board.
---

# Flow layout: read left to right

A flow board should read like a sentence: start at the top left, follow the main path to the right, and drop to a new row for branches. A reader should never have to follow an arrow backwards.

## Workflow

Use the tools in this order. Don't draw arrows or move screens with `use_figma` on a managed board. The tools keep the screens, route texts, arrows and prototype in step.

1. **Get a board.** On an existing hand-built board, run `adopt_board` with `dryRun: true`, check the unmatched list, then run it for real. For a new flow, use `create_board`. On an older adopted board whose screens sit in `Screen · …` groups, run `ungroup_screens` once.
2. **Read it.** `describe_board` prints the grid as text, with one cell per screen, and lists every arrow with its trigger.
3. **Propose before you build.** Write the target layout as an ASCII grid in the same format and confirm it with the user before you move anything. Example:

   ```
         c0            c1              c2
   r0 | Verify ID  | Home·pending  |
   r1 | Bastion    | You're verified|
   r2 | Couldn't   | Expired       | Bastion·new link
   ```

4. **Place screens.**
   - `move_screen` moves a screen into a cell, together with its route text and badge, and reroutes its arrows. Use `swap: true` to trade two cells.
   - `insert_columns` or `insert_rows` make room, and `compact_board` closes up gaps.
   - `duplicate_screen` adds a copy of a screen for another state. It can also change the screen's banner.
   - Never copy a screen in Figma by hand. A hand copy keeps the original's flow data and points at the wrong route text and badge.
5. **Connect.**
   - `connect({ from, to, trigger, label })` draws the arrow from the triggering control and points the trigger's prototype at the target.
   - Leave out `trigger` only for automatic transitions (a webhook, a timer, a redirect).
   - Use `exit: 'bottom'` for a target below and to the right when the gutter between them is busy.
6. **Reroute.** After any move outside these tools, run `reroute_flow`.
7. **Check.** Run `lint_flow_layout`, then `describe_board`, then one screenshot of the board region. Stop when all three are clean.

## Data model

Each node carries shared plugin data in the `flowbridge` namespace:

- **`board`** on the board background rectangle holds the grid (origin, column width, row height, screen size), the arrows group and the arrow style.
- **`screen`** on each screen frame holds `boardId`, `col`, `row`, `labelId` (null: screens have no label text), `routeId`, `badgeId` and `groupId` (null: screens are not grouped).
- **`arrow`** on each `Flow · A → B · label` group holds `from`, `to`, `trigger`, `label`, `mode` (`trigger` or `auto`), `exit`, and the vector, dot and label ids.

Screens are **top-level frames** (393×852). Figma prototyping needs this: flow starting points and Play fail on a grouped frame, and prototype reactions cannot be set on one. Figma draws its own title above each frame, and that title is the screen name. There is no label text.

Each screen is three loose siblings on the page (or in a section):
- the frame, named after the screen
- the route text, `Route · {name}` (the code path), at the frame's left edge, 72 px above the frame (clear of Figma's frame title)
- the build badge, `Badge · {name}`, a pill right-aligned with the frame and centred on the route line

Use absolute positions. The tools move the frame, route text and badge together, so never move one of them by hand. `adopt_board` and `duplicate_screen` leave screens ungrouped.

Boards made while screens were grouped have `Screen · {name}` groups and `Label · {name}` texts. Run `ungroup_screens` once on them (try `dryRun: true` first). It moves each frame out of its group, deletes the label text (`keepLabels: true` keeps it), moves the route text and badge to the slots above, and is idempotent. Do not use `group_screens` unless the user asks for groups: it breaks prototype Play and starting points.

Arrows are a vector, a 10 px start dot and a label frame, grouped. The arrows group always sits above the screens.

## Rules

1. **The main path runs left to right.** Each next screen goes in the column to the right of the screen before it, on the same row.
2. **Arrows point right or down at the head, and never run left,** with one exception: a bottom-exit detour (rule 11) runs left once, inside a row gap, never through a screen.
3. **Branches go straight down.** A failure, an alternate outcome or a retry goes in the same column directly under its source screen. A second branch from the same screen goes in the next row down, or in the next column to the right.
4. **Overlays and entry points may go straight up.** A sheet or modal that opens over a screen, or a banner screen that leads into a step, sits directly above its target.
5. **A screen with an inbound arrow sits right of, or directly above or below, its source.** If a target would be to the left, move the target, don't bend the arrow. Move the screen's route text and badge with it.
6. **Never route an arrow through a screen or its label.** A target directly below its source is entered on its top edge (a straight bottom-to-top line). Every other target is entered on its left edge, heading right. Arrows never start on a screen's left or top edge and never end on its right or bottom edge (`starts-wrong-side`, `ends-wrong-side`).
7. **Arrows don't cross.** If two must, reorder their start points so they don't. When they can't be separated, cross once, at right angles.
8. **Labels sit on top of lines,** centred on a straight segment, and above every vector in z-order.
9. **Start an arrow at the control that triggers it.** When a button, row, tab or link causes the move, put the start dot just outside that control's edge (about 10 px, so it doesn't blend into the fill) and route from there: across to the gutter, then up or down, then into the target. Only an automatic transition (a timer, a webhook, a redirect) starts from the screen's edge. Keep arrow groups above the screens in layer order so start dots stay visible.
10. **Arrows into one target merge.** Each runs into one shared trunk lane in the gutter before the target, then one shared final run into the left edge, so the heads coincide. Merged runs are not `lines-overlap`. Labels sit on each arrow's own first segment next to its source, never on shared runs.
11. **Start only on a bottom or right edge; end only on a left or top edge.** A target in the same column that is not directly below (above it, far below it, or to the left) is reached by leaving the source's bottom (at the trigger's x, else the centre), dropping into the row gap below the source, running left along the gap into the gutter left of the target, running up or down to the target's middle and entering its left edge.
12. **Arrows and prototype agree.** A triggered arrow's trigger navigates to the arrow's target. Every NAVIGATE reaction between two screens of the board has an arrow. An arrow with no trigger should have a frame-level AFTER_TIMEOUT or some reaction to its target (`prototype-mismatch`, `prototype-without-arrow`, `auto-arrow-no-prototype`, the last informational). Overlays, back actions and other pages are ignored. Tab bars are exempt (a layer named tab bar, bottom nav or navigation bar, or a reaction to a tab root): persistent navigation needs no arrow per screen. Fix a mismatch by pointing the reaction or reconnecting the arrow with `connect`, never by deleting the arrow.

## Grid

- Use a fixed grid: one column per screen (screen width + a 300 px gutter) and one row per screen height + about 260 px for the route text and arrows.
- Start the main path in the top-left cell. Put entry points (where the user arrives from) in the first column.
- When a branch needs room, push the later columns right. Grow the board to fit. Don't squeeze a screen into a gap on the left.
- After moving screens, close up any empty rows and columns the move leaves behind.

## Groups

Wrap related screens (a feature, a sub-flow such as "Passkeys" or "Device signing") in a labelled box so the board reads when zoomed out. Group when 2+ screens form a named unit; do not box every screen.

- `create_flow_group { name, screenIds | cells }` (defaults to the selection), `update_flow_group { groupId, name?, add?, remove?, parentId?, style? }`, `delete_flow_group { groupId }` (screens stay). `move_screen` and `duplicate_screen` take `group` to join or leave one; a duplicate joins its source's group.
- Spacing and refit are automatic. By default spacing is uniform: one column pitch and one row pitch for the whole board, grown to fit the widest group boundary (title bar, 12 px line, 160 px padding), so every column shares one x and every row one y and all gaps are equal. `reroute_flow { spacing: "banded" }` switches to per-region extras instead (`"uniform"` switches back and clears them). Screens shift to make room, and every box refits when screens are added, moved or removed, then arrows reroute. Never hand-size or hand-move a box, never edit the gaps yourself.
- Never draw boxes by hand and never use `group_screens` for this (it breaks prototype Play). Screens stay top-level frames.
- Arrow lines may cross a box stroke. A box and its title never cross screens, route text, badges, arrow labels or other boxes.
- One level of nesting: a child group sits fully inside a parent (`parentId`). A child of a child is rejected.
- A tool says the board background is missing (someone deleted it): run `repair_board` (dry run first). Never redraw the background by hand.
- Old hand-drawn boxes and Section Heading instances: run `adopt_flow_groups` (dry run first) to turn them into real groups.
- Afterwards run `lint_flow_layout`: `layoutIssues` must be empty (group-crosses-content, group-crosses-label, group-overlaps-group, group-encloses-foreign, title-overlaps, nesting kinds, label-overlaps-label, lines-overlap, line-crosses-title). `describe_board` shows the group tree and flags empty or stale groups.

## Back navigation, loops and states

The rules cover forward flow. When a screen returns the user to an earlier step (Back, Start again, Try again), or the same screen appears in a different state:

- **Use state copies, not loops.** Place a copy of the target with `duplicate_screen` (for example "Step 1 · fix details" or "In-app browser · new link") to the right of or below the source, and `connect` to the copy. Change the copy's banner or copy text so it shows the state.
- Prefer a short label on the source's button ("→ Step 1") over a long arrow back.
- If a backwards arrow is unavoidable, `connect` draws it below the rows with its own arrowhead and returns `backwards: true`. `lint_flow_layout` will report it. Tell the user why it remains.

## Checklist before you finish

1. Run `lint_flow_layout` on the page or the board. Fix every `points-left` and `runs-left` issue by moving screens with `move_screen`, and every `layoutIssues` entry by fixing group membership with `update_flow_group` (boxes refit themselves), then run it again.
2. Run `describe_board` and fix every item under `issues`: stale screen data, two screens in one cell, missing endpoints.
3. Take one screenshot of the board region (`get_screenshot` with `nodeIds` or `region`). Check that nothing sits on a label, that no two arrows share an arrowhead, that crossings happen only where they can't be avoided, and that the main path is a single row.
4. Report which screens moved, any arrow you could not make point forwards, and any crossing that remains.
