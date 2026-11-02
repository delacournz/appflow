# figma-local-bridge

A local MCP server and a Figma development plugin that let an agent run Plugin API code in the open Figma desktop file. It needs no Figma MCP plan or Dev Mode seat.

```
agent ⇄ stdio MCP (src/server.ts) ⇄ ws://127.0.0.1:3055/plugin ⇄ plugin UI iframe ⇄ plugin main (Plugin API)
```

## Tools

- `figma_status`: whether the plugin is connected, plus the file, pages and selection.
- `figma_run({ code, timeoutMs? })`: runs `code` as the body of an async function, with `figma` in scope. It returns the value from `return` and any `console.log` lines.
- `figma_screenshot({ nodeId, scale? })`: exports the node as a PNG and returns the image.

Code runs with `documentAccess: "dynamic-page"`, so use the async APIs: `getNodeByIdAsync`, `setCurrentPageAsync` and `setReactionsAsync`.

## Setup

1. Register the server with Claude Code:
   `claude mcp add figma-bridge -s user -- bun run ~/Documents/Projects/figma-local-bridge/src/server.ts`
2. In the Figma desktop app, go to Plugins → Development → Import plugin from manifest… and pick `plugin/manifest.json`.
3. Open the file, then run Plugins → Development → **Local Agent Bridge**. Leave the window open. A green dot means it is connected.

To use another port, set `FIGMA_BRIDGE_PORT` on the server. Then change the port in the plugin window and add it to `devAllowedDomains` in the manifest.

## Security

The server listens on 127.0.0.1 only. Any process on this machine that can reach the port can run code in the open Figma file while the plugin window is open. Close the plugin when you are not using it.

## Test

`bun test`
