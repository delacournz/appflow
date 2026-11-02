---
name: flow-layout
description: Lay out screen flows in Figma so they read left to right, with no arrows pointing or running back on themselves. Use before placing screens or drawing flow arrows, and check with lint_flow_layout before you finish.
---

# Flow layout: read left to right

A flow board should read like a sentence: start at the top left, follow the main path to the right, and drop to a new row for branches. A reader should never have to follow an arrow backwards.

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

## Back navigation and loops

The rules cover forward flow. When a screen returns the user to an earlier step (Back, Start again, Try again):

- Prefer a short label on the source's button ("→ Step 1") over a long arrow back.
- If an arrow is needed, place a copy of the target screen (for example "Step 1 · fix details") to the right or below, and point to the copy.
- If a backwards arrow is unavoidable, route it below all rows, label it clearly, and expect `lint_flow_layout` to report it, then tell the user why it remains.

## Checklist before you finish

1. Run `lint_flow_layout` on the page or the board. Fix every `points-left` and `runs-left` issue by moving screens, then run it again.
2. Take one screenshot of the board and check that nothing sits on a label, nothing crosses unnecessarily, and the main path is a single row.
3. Report which screens moved and any arrow you could not make point forwards.
