---
name: verify-built
description: Check which screens on a Figma flow board are built in code and still match the design, then record it with set_screen_status so each screen shows a Built, Drift or Not built badge. Use when asked to mark screens built, audit build progress, check design drift, or after building or changing a screen.
---

# Verify built screens

Each screen on an adopted flow board has a badge above its top-right corner:

| Badge | Status | Meaning |
| --- | --- | --- |
| Built (green) | `built` | The route exists and the code and running app match the frame. |
| Drift (amber) | `drift` | The route exists, but the code or the app differs from the frame. |
| Not built (grey) | `not-built` | There is no code for this screen or state yet. |

Only `set_screen_status` changes a badge. Never edit badges with `use_figma`, and never mark a screen built because its file exists.

## Workflow

### 1. List the screens

1. Call `figma_status`, then `describe_board`.
2. Work from `screens[]`. Each entry has `{ id, name, route, status, verifiedAt }`.
3. Scope the run: every screen, or only the screens or routes the user named. If the user just built something, check those screens first.
4. If `issues` says a screen has no build badge, run `badge_screens`.

### 2. Check each screen

**Find the code.**
- `route` is the code path, for example `src/app/(auth)/email-code.tsx`.
- No route text, or the file does not exist: mark it `not-built` and go on to the next screen.

**Find the state.**
- A name like `Check your email · checking` is the base screen in one state.
- Find how the code reaches that state: a prop, query status, store value, or a param.
- If the code has no such state, the screen is `not-built`, even when the base screen is built.

**Static check: code against design.** Call `get_design_context` and `get_variable_defs` on the frame `id`, then compare with the route's component and what it renders:
- **Copy:** every visible string matches word for word, including placeholders, helper and error text.
- **Components:** the matching code component is used (see `get_code_connect_map`), not a hand-rolled copy.
- **Tokens:** colours, spacing, radii and type use the project's tokens, not hard-coded values. Code tokens are master: if the frame's colour differs only because its Figma variable is stale, that is not screen drift. Run the `sync-from-code` skill (`skill://appflow/sync-from-code/SKILL.md`) to fix the variable, then compare again.
- **Structure:** elements appear in the same order and grouping.
- **Behaviour:** each arrow out of this screen in `describe_board` (`--label--> Target [trigger: …]`) has a control that navigates to the target's route.

**Runtime check: app against design.** Run the app with the project's device workflow (for example `warden ui`: claim a device, open the app, go to the route and state).
- Capture the accessibility snapshot (`snapshot -i` or equivalent), plus a screenshot.
- Call `get_screenshot` on the frame.
- Compare text, order, visibility and layout. A screenshot alone is not proof. Check the snapshot text and elements.
- Release the device when done.

**Decide.**

| What you found | Status | Fields |
| --- | --- | --- |
| Static and runtime checks both match | `built` | `confidence: "runtime"` |
| Static check matches, the app could not run or the state can't be reached | `built` | `confidence: "static"`, and `notes` saying why |
| The code exists but anything differs | `drift` | `notes`: a short list of each difference, for example "Title says 'Check email', design says 'Check your email'" |
| No code for the screen or state | `not-built` | none |

Small platform differences (status bar, safe-area insets, font hinting) are not drift. Copy, colour, missing elements, wrong order or a wrong navigation target are drift.

### 3. Record

1. Get the commit: `git rev-parse --short HEAD`. Note in the report if the tree is dirty.
2. Make one `set_screen_status` call with every checked screen:

   ```json
   { "screens": [
     { "id": "12:34", "status": "built", "confidence": "runtime", "commit": "a1b2c3d" },
     { "id": "12:99", "status": "drift", "commit": "a1b2c3d", "notes": "Resend link missing; code input uses 6 cells, design 8" },
     { "id": "13:02", "status": "not-built" }
   ] }
   ```
3. Fix every entry in `errors` and call it again for those screens.
4. Run `describe_board` again. The grid marks show `✓` built, `~` drift and `·` not built.

### 4. Report

Reply with a table: screen · status · confidence · notes. Then list the drift items as follow-up work.

Don't fix code during a verify run unless the user asked you to. When you fix a drift, verify that screen again and record it.

## When to verify again

- After you build or change code under a screen's route, verify that screen before you finish.
- After a design changes, verify the screens that changed. A screen that was built may now be drift.
- `duplicate_screen` copies start as Not built.
