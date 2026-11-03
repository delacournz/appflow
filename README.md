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
| `figma_status` | Connection, file, pages and selection. Works when the plugin is closed. |
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

Prompts: `create_design_system_rules` (arguments `clientLanguages` and `clientFrameworks`), `flow_layout` and `verify_built`.

Skills (MCP resources): `skill://appflow/flow-layout/SKILL.md` and `skill://appflow/verify-built/SKILL.md`. The verify skill checks each screen's route code and the running app against its frame, then calls `set_screen_status`.

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

Several agent sessions can run the server at once. The first one to bind the port is the leader and holds the plugin socket. The others connect to it on `/peer` and relay their calls through it. When the leader exits, a follower takes the port and the plugin window reconnects within about 2 s.

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
