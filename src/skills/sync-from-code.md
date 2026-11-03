---
name: sync-from-code
description: Make the open Figma file's variables, text styles and component variants match the code design system. Code is the source of truth. Dry run first, apply, then confirm only orphans are left.
---

# Sync the design system from code

Code is the source of truth. Figma variables, text styles and component variants are brought in line with the code tokens, type roles and `tv()` variants. A Figma value that differs from code is fixed in Figma, not reported as screen drift.

## When to run it

- Before checking screens with the `verify-built` skill, so colour and spacing differences that come from stale variables are fixed first.
- After a change to the token CSS, the type scale or a `*.variants.ts` file.
- When someone asks to "update Figma from code" or to "sync tokens, text styles or components".

## Before you start

1. Call `figma_status`. The plugin must be connected to the right file. For a first sync on a shared file, ask the user to duplicate the file and run it on the copy.
2. The project needs an `appflow.design.json` at `projectRoot` (see the README "Design sync" section). For a first sync on an existing file, add a `rename` seed that maps old Figma names to code names. Use `renameCandidates` from a dry run to find more.
3. Order matters: tokens, then text styles, then components. Component styling binds to the synced variables.

## Steps

1. **Dry run.** `sync_design_system({ projectRoot })`, or one of `sync_tokens`, `sync_text_styles` or `sync_components`. Each defaults to `dryRun: true` and returns one line per op:
   - `+` create, `~` update (rename, value, link), `?` Figma only (orphan).
   - Read `warnings`: values the extractor could not express.
   - Read `renameCandidates`: a Figma-only item whose value matches exactly one new code item. Add real ones to `rename` and run the dry run again, instead of creating a duplicate.
2. **Show the plan.** Summarise it for the user: how many creates, renames and value changes, and which items are Figma only. Get a yes before you apply to a shared file.
3. **Apply.** Run the same call with `dryRun: false`. Check `result.errors`. A missing font or a missing layer is reported, never guessed.
4. **Confirm.** Run the dry run again. Only `?` orphans should be left. If creates or updates remain, read the errors and fix the cause (a mapping, a font, a layer name).
5. **Orphans.** Report them. Pass `prune: true` only when the user says to delete those exact items. Figma-only components and axes are never deleted.

## Rules

- Never pass `prune: true` without the user's explicit say-so.
- Never edit variables by hand with `use_figma` to "fix" a plan. Change the code or `appflow.design.json`, then sync.
- A colour that differs between a screen and code because the Figma variable was stale is fixed by `sync_tokens`. It is not screen drift.
- Re-running a sync must give no new ops. If it does, that is a bug to report.
