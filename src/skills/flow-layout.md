---
name: flow-layout
description: Lay out screen flows in Figma so they read left to right, with no arrows pointing or running back on themselves. Use before placing, moving or copying screens or drawing flow arrows. Use the board tools (adopt_board, move_screen, duplicate_screen, connect, reroute_flow) instead of hand-drawing vectors, and finish with lint_flow_layout and describe_board.
---

# Flow layout: read left to right

A flow board should read like a sentence: start at the top left, follow the main path to the right, and drop to a new row for branches. A reader should never have to follow an arrow backwards.

## Workflow

Use the tools in this order. Don't draw arrows or move screens with `use_figma` on a managed board. The tools keep the screens, labels, arrows and prototype in step.

1. **Get a board.** On an existing hand-built board, run `adopt_board` with `dryRun: true`, check the unmatched list, then run it for real. For a new flow, use `create_board`.
2. **Read it.** `describe_board` prints the grid as text, with one cell per screen, and lists every arrow with its trigger.
3. **Propose before you build.** Write the target layout as an ASCII grid in the same format and confirm it with the user before you move anything. Example:

   ```
         c0            c1              c2
   r0 | Verify ID  | Home·pending  |
   r1 | Bastion    | You're verified|
   r2 | Couldn't   | Expired       | Bastion·new link
   ```

4. **Place screens.**
   - `move_screen` moves a screen into a cell, together with its label and route text, and reroutes its arrows. Use `swap: true` to trade two cells.
   - `insert_columns` or `insert_rows` make room, and `compact_board` closes up gaps.
   - `duplicate_screen` adds a copy of a screen for another state. It can also change the screen's banner.
   - Never copy a screen in Figma by hand. A hand copy keeps the original's flow data and points at the wrong label.
5. **Connect.**
   - `connect({ from, to, trigger, label })` draws the arrow from the triggering control and points the trigger's prototype at the target.
   - Leave out `trigger` only for automatic transitions (a webhook, a timer, a redirect).
   - Use `exit: 'bottom'` for a target below and to the right when the gutter between them is busy.
6. **Reroute.** After any move outside these tools, run `reroute_flow`.
7. **Check.** Run `lint_flow_layout`, then `describe_board`, then one screenshot of the board region. Stop when all three are clean.

## Data model

Each node carries shared plugin data in the `flowbridge` namespace:

- **`board`** on the board background rectangle holds the grid (origin, column width, row height, screen size), the arrows group and the arrow style.
- **`screen`** on each screen frame holds `boardId`, `col`, `row`, `labelId` and `routeId`.
- **`arrow`** on each `Flow · A → B · label` group holds `from`, `to`, `trigger`, `label`, `mode` (`trigger` or `auto`), `exit`, and the vector, dot and label ids.

The screen anatomy:
- a 393×852 frame
- a label text 72 px above it
- a route text (the code path) 40 px above it

Arrows are a vector, a 10 px start dot and a label frame, grouped. The arrows group always sits above the screens.

## Rules

1. **The main path runs left to right.** Each next screen goes in the column to the right of the screen before it, on the same row.
2. **Arrows point right, down or up. Never left.** No segment of an arrow may move left, not even a short jog into a gutter.
3. **Branches go straight down.** A failure, an alternate outcome or a retry goes in the same column directly under its source screen. A second branch from the same screen goes in the next row down, or in the next column to the right.
4. **Overlays and entry points may go straight up.** A sheet or modal that opens over a screen, or a banner screen that leads into a step, sits directly above its target.
5. **A screen with an inbound arrow sits right of, or directly above or below, its source.** If a target would be to the left, move the target, don't bend the arrow. Move the screen's label and route text with it.
6. **Never route an arrow through a screen or its label.** Vertical arrows into a screen enter its top edge on the right side (about 340 px into a 393 px frame), clear of the label. Horizontal arrows enter the left edge.
7. **Arrows don't cross.** If two must, reorder their start points so they don't. When they can't be separated, cross once, at right angles.
8. **Labels sit on top of lines,** centred on a straight segment, and above every vector in z-order.
9. **Start an arrow at the control that triggers it.** When a button, row, tab or link causes the move, put the start dot just outside that control's edge (about 10 px, so it doesn't blend into the fill) and route from there: across to the gutter, then up or down, then into the target. Only an automatic transition (a timer, a webhook, a redirect) starts from the screen's edge. Keep arrow groups above the screens in layer order so start dots stay visible.
10. **One arrowhead per destination per source.** Don't merge two sources into one line. Draw each with its own arrowhead and label.

## Grid

- Use a fixed grid: one column per screen (screen width + a 300 px gutter) and one row per screen height + about 260 px for labels.
- Start the main path in the top-left cell. Put entry points (where the user arrives from) in the first column.
- When a branch needs room, push the later columns right. Grow the board to fit. Don't squeeze a screen into a gap on the left.
- After moving screens, close up any empty rows and columns the move leaves behind.

## Back navigation, loops and states

The rules cover forward flow. When a screen returns the user to an earlier step (Back, Start again, Try again), or the same screen appears in a different state:

- **Use state copies, not loops.** Place a copy of the target with `duplicate_screen` (for example "Step 1 · fix details" or "In-app browser · new link") to the right of or below the source, and `connect` to the copy. Change the copy's banner or copy text so it shows the state.
- Prefer a short label on the source's button ("→ Step 1") over a long arrow back.
- If a backwards arrow is unavoidable, `connect` draws it below the rows with its own arrowhead and returns `backwards: true`. `lint_flow_layout` will report it. Tell the user why it remains.

## Checklist before you finish

1. Run `lint_flow_layout` on the page or the board. Fix every `points-left` and `runs-left` issue by moving screens with `move_screen`, then run it again.
2. Run `describe_board` and fix every item under `issues`: stale screen data, two screens in one cell, missing endpoints.
3. Take one screenshot of the board region (`get_screenshot` with `nodeIds` or `region`). Check that nothing sits on a label, that no two arrows share an arrowhead, that crossings happen only where they can't be avoided, and that the main path is a single row.
4. Report which screens moved, any arrow you could not make point forwards, and any crossing that remains.
