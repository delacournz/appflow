# appflow

A local MCP server plus a Figma development plugin. It exposes the Figma MCP server's tools, with the same names, against the file open in the Figma desktop app. No Figma MCP plan or Dev Mode seat needed.

```
agent ⇄ stdio MCP (src/server.ts) ⇄ ws://localhost:3055/plugin ⇄ plugin UI iframe ⇄ plugin main (Plugin API)
```

The MCP side is built on the official [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/) (`@modelcontextprotocol/server` v2). `src/mcp.ts` registers the tools, skill resources and prompts, `src/tools.ts` defines the tools with Zod schemas, and `src/server.ts` serves them over stdio.

## Tools

Most tools take an optional `nodeId` (`193:443` or `193-443`). Without one they use the current selection.

| Tool | What it does locally |
| --- | --- |
| `figma_status` | Connection, file, pages and selection. Works when the plugin is closed. With several files open and none chosen, lists them. |
| `list_files` | The Figma files running AppFlow (name, fileKey, docId, editor, last activity) and this session's pinned file. |
| `select_file` | Pins the file this session works on. Omit `file` to clear the pin. |
| `whoami` | The signed-in user and the file. Plans and seats are not visible to a plugin. |
| `get_metadata` | XML outline: IDs, names, types, positions, sizes and text. |
| `get_screenshot` | PNG of a node. |
| `get_design_context` | React with Tailwind (or inline CSS) JSX from Figma's CSS. Instances become `<Component props />`. Also returns bound variables and a screenshot. |
| `get_variable_defs` | Variables and styles used in a node, resolved to values. |
| `get_figjam` | XML of stickies, shapes, connectors and sections, plus a screenshot. |
| `search_design_system` | Local components, sets, variables and styles, plus variables from enabled libraries. |
| `get_libraries` | Enabled libraries and the remote components in use. |
| `download_assets` | Exports nodes and image fills to files under `~/.appflow/downloads` or `outDir`. |
| `upload_assets` | Places local PNG, JPG, GIF, WebP or SVG files. SVGs become vectors. |
| `use_figma` | Runs Plugin API JavaScript. It returns the returned value and `console.log` lines. |
| `html_to_figma` | Renders HTML in the plugin window and rebuilds it as frames, text, SVG and images. |
| `generate_diagram` | Mermaid flowcharts: shapes and connectors in FigJam, frames and arrows in design files. |
| `set_screen_status` | Records whether flow-board screens are built (`built` / `drift` / `not-built`) and shows a Built, Drift or Not built badge above each screen. Follow the `verify-built` skill first. |
| `badge_screens` | Adds or refreshes the build badge on every grouped screen of a board. |
| `get_context_for_code_connect` | Properties, variants, nested instances and text layers of a component. |
| `get_code_connect_suggestions` / `get_code_connect_map` / `add_code_connect_map` / `send_code_connect_mappings` | Code Connect mappings, stored locally in `~/.appflow/code-connect.json`. They are not synced with Figma's Code Connect. |
| `export_design_system` | The file's local variables (modes, aliases, scopes, code syntax, code ids), text styles and components with their variant axes, as DesignSpec JSON. |
| `diff_design_system` | Compares the project's code design system with the file. Code is the source of truth. Returns create, update and orphan ops plus rename candidates. Changes nothing. |
| `sync_tokens` | Makes the file's variables match the code tokens: creates collections, modes and variables (with scopes, code syntax and code ids), renames matched variables to code names, sets values and aliases. Dry run by default; Figma-only variables are removed only with `prune: true`. |
| `sync_text_styles` | Makes the file's text styles match the code type roles. A font that Figma does not have is an error, never a guess. Dry run and prune as above. |
| `sync_design_system` | Runs `sync_tokens`, `sync_text_styles` and `sync_components` in that order (or the kinds in `include`) with the same `dryRun` and `prune`. Returns one result per kind. |
| `sync_components` | Makes component sets match the code components (tailwind-variants): renames axes and options per the mapping, adds missing axes and options (cloned from the default variant), creates missing sets on a "Code components" page and, with `styling` (default true), paints each variant from its code classes, bound to the synced variables. Run `sync_tokens` first. |

Prompts: `create_design_system_rules` (arguments `clientLanguages` and `clientFrameworks`), `flow_layout`, `verify_built` and `sync_from_code`.

Skills (MCP resources): `skill://appflow/flow-layout/SKILL.md`, `skill://appflow/verify-built/SKILL.md` and `skill://appflow/sync-from-code/SKILL.md`. The verify skill checks each screen's route code and the running app against its frame, then calls `set_screen_status`. The sync skill runs a dry run, applies it, and confirms that only orphans are left.

### Design sync

Code is the source of truth for tokens, text styles and component variants. Put an `appflow.design.json` at the project root:

```json
{
  "sources": [{ "kind": "tailwind-css", "paths": ["src/styles/tokens.css", "src/styles/theme.css"], "modes": ["dark"], "textStylePrefix": "Sony FT/" }],
  "rename": { "tokens": { "Tokens/text/text-2": "Tokens/color/muted-foreground" }, "textStyles": {}, "components": { "Notice": "Alert" } },
  "ignore": { "tokens": ["Primitives/*"], "textStyles": [], "components": [] }
}
```

- `sources` lists where the code spec comes from. Paths must stay inside the project.
  - `tailwind-css` reads Tailwind v4 / Uniwind CSS in cascade order. `@theme` `--color-<ramp>-<step>` literals become `Primitives` (`glacier/500`). `@theme inline` `--color-X: var(--X)` becomes `Tokens` `color/X`, with one value per `@variant light|dark` (limit them with `modes`). `--radius-*`, `--spacing-*` and `--text-*` become floats; `--radius` is `radius/base`. A `var()` to another token is an alias. `calc()`, `oklch()`, `rgb()` and `color-mix(in oklch, …)` are resolved. `--text-<role>` with `--line-height`, `--letter-spacing` or `--font-weight` becomes a text style named `textStylePrefix` + `Role name`. Anything else is reported as a warning. Options: `modes`, `primitives`, `tokens` (collection names), `textStylePrefix`, `fontFamily`.
  - `tailwind-variants` maps a component name to the `path#export` of its `tv()` result, or to `{ "ref": "…", "axes": ["status", "variant"] }` to pick the axes that become variants (leave behaviour flags such as `isLoading` out; `[]` for none). An axis left out is fixed at its code default, so its default classes still style the component. Only listed files are imported, in a child `bun` process with the project as its working directory, so the project's imports and tsconfig paths resolve and none of its code runs in the server. It runs after the token sources, so classes bind to their tokens.
  - `spec-json` is a DesignSpec file (`shared/design-spec.ts`); missing lists default to empty.
- `rename` maps a Figma token key (`Collection/name`), text style name or component name to its code name. It seeds the first match.
- `variants` maps a Figma component's axis to its code axis and options: `{ "Notice": { "Tone": { "axis": "status", "options": { "Error": "destructive" } } } }`.
- `variantDefaults` sets the option existing variants take when an axis is added: `{ "Alert": { "variant": "notice" } }`. Default: the code default.
- `layers` maps a code slot to the Figma layer it styles: `{ "Notice": { "title": "Text", "indicator": "Icon" } }`. Default: a layer named like the slot; `root` is the variant itself. Map a slot to `"root"` to paint the variant with it (an OTP `slot` that is the whole component), or to `""` to skip a slot the Figma component does not draw. Several components can use one `tv()` export (`List row` and `Toggle row` both on `item`); each pairs with the Figma component of its own name. A single component (not a variant set) is linked and styled but gets no axes.
- `ignore` takes globs where `*` matches anything, `/` included. They apply to both sides.

Matching order: the code id stored on the Figma item (shared plugin data `appflow` / `codeId`), then `rename`, then the same name. Floats match within 0.001 and colours within 1 per channel. A code literal equals a Figma alias that resolves to it, so links to primitives survive. Line heights and tracking compare in px at the font size, so `-1%` at 22 equals `-0.22px`. Two single-mode collections match whatever their modes are called. Figma items that match nothing are reported as orphans and are never removed by a diff. An orphan with exactly one unclaimed code lookalike is listed as a rename candidate.

Styling reads `bg-*`, `border-*`, `rounded-*`, `h-*`/`w-*`/`size-*`, `p*-*`, `gap-*`, `text-<size|colour>`, `font-<weight>`, `opacity-*`, `flex-row`/`flex-col`, `items-*` and `justify-*`. A class that names a token binds its variable; scale steps (`gap-1.5`) become numbers. Everything else, including state prefixes (`active:`) and arbitrary values, is listed as not expressible. A layer whose code fixes both width and height but sets no padding (an icon button) gets those padding sides zeroed, so padding left over from the design cannot push the size out.

Plans come back as one line per op (`+` create, `~` update, `?` Figma only); pass `verbose: true` for the full JSON. Run a sync with `dryRun` first, read the plan, then run it with `dryRun: false`; the result includes what is left, which should be orphans only.

Drift check: with the plugin open on the file, this exits 1 when Figma is behind the code (orphans do not count):

```sh
bun run scripts/call.ts diff_design_system '{"projectRoot":"/path/to/app","includeComponents":true}' \
  | jq -e '.counts.create + .counts.update == 0'
```

### Not available locally

These need Figma's cloud: `create_new_file`, `generate_figma_design`, `send_code_to_figma`, `generate_image`, `get_motion_context`, the shader tools, the generative plugin tools and the Weave tools.

### Limits compared with the cloud server

- Library search covers variables only. The plugin API cannot search library components. Library components that are already used in the file do appear in `get_libraries`.
- `html_to_figma` does not fetch remote images or fonts. Inline them as data URLs.
- `generate_diagram` supports Mermaid flowcharts only.

Code runs with `documentAccess: "dynamic-page"`, so use the async APIs: `getNodeByIdAsync`, `setCurrentPageAsync` and `setReactionsAsync`.

## Setup

1. Run `bun install && bun run build`.
2. Register the server with Claude Code:
   `claude mcp add appflow -s user -- bun run ~/Documents/Projects/appflow/src/server.ts`
3. In the Figma desktop app, go to Plugins → Development → Import plugin from manifest… and pick `plugin/manifest.json`.
4. Open the file, then run Plugins → Development → **AppFlow**. Leave the window open. A green dot means it is connected.

Several agent sessions can run the server at once. The first one to bind the port is the leader and holds the plugin sockets. The others connect to it on `/peer` and relay their calls through it. When the leader exits, a follower takes the port and the plugin windows reconnect within about 2 s.

### Several Figma files

Run AppFlow in as many files as you like; each window keeps its own connection. Every tool that talks to the plugin takes an optional `file`: a fileKey, a figma.com URL (a branch URL picks the branch) or the file name (exact, else a unique part of it). A call goes to:

1. the file named by `file`;
2. else the file this agent session pinned with `select_file`;
3. else the only open file.

With two or more files open and neither of the first two, the call fails and lists the files. It never guesses. A pin is per agent session and survives the plugin reconnecting. If the pinned file closes, calls fail until it is back or another file is pinned.

The fileKey comes from `figma.fileKey`, which needs `enablePrivatePluginApi` in the manifest. The plugin also stores a `docId` in the file's shared plugin data (`appflow` / `docId`) so files can be told apart without a key. A duplicated file keeps the same docId; target it by fileKey or name. The one-shot CLI takes `--file`: `bun run scripts/call.ts figma_status --file "Wallet app"`.

Environment:

- `APPFLOW_PORT` (default 3055): to change it, also change the port in the plugin window and in `devAllowedDomains`.
- `APPFLOW_HOME` (default `~/.appflow`): where downloads and the Code Connect store go.

## Security

The server listens on 127.0.0.1 only. Any process on this machine that can reach the port can run code in the open Figma file while the plugin window is open. Close the plugin when you are not using it.

## Develop

Plugin source is in `plugin-src/` and the window is in `ui-src/`. `plugin/code.js` and `plugin/ui.html` are generated.

```sh
bun run build      # bundle the plugin
bun test           # unit tests
bun run typecheck  # server, plugin and UI
```
