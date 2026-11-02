// Local Agent Bridge: the plugin's main thread. Receives commands from the UI
// iframe (which holds the WebSocket to the local MCP server), runs them against
// the Plugin API, and posts the reply back.

figma.showUI(__html__, { width: 280, height: 132, themeColors: true });

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Makes a value safe to JSON-encode: nodes become {id, type, name}, symbols and bytes become strings. */
function toJson(value, seen = new Set(), depth = 0) {
  if (value === undefined || value === null) return null;
  if (value === figma.mixed) return '<mixed>';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'bigint' || type === 'symbol' || type === 'function') return String(value);
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value.id === 'string' && typeof value.type === 'string' && 'removed' in value) {
    return { id: value.id, type: value.type, name: value.name };
  }
  if (seen.has(value) || depth > 20) return '<circular>';
  seen.add(value);
  const out = Array.isArray(value)
    ? value.map((v) => toJson(v, seen, depth + 1))
    : Object.fromEntries(Object.keys(value).map((k) => [k, toJson(value[k], seen, depth + 1)]));
  seen.delete(value);
  return out;
}

function errorText(error) {
  if (error && error.message) return error.stack ? `${error.message}\n${error.stack}` : error.message;
  return String(error);
}

async function run(code) {
  const logs = [];
  const capture = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(toJson(a)))).join(' '));
  const console = { log: capture, info: capture, warn: capture, error: capture };
  try {
    const fn = new AsyncFunction('figma', 'console', code);
    const result = await fn(figma, console);
    return { ok: true, result: toJson(result), logs };
  } catch (error) {
    const tail = logs.length ? `\n\nconsole:\n${logs.join('\n')}` : '';
    return { ok: false, error: errorText(error) + tail };
  }
}

async function screenshot(nodeId, scale) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !('exportAsync' in node)) return { reply: { ok: false, error: `No exportable node ${nodeId}` } };
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  return { reply: { ok: true, result: { nodeId, name: node.name, width: node.width, height: node.height, scale } }, bytes };
}

function status() {
  return {
    ok: true,
    result: {
      fileName: figma.root.name,
      editorType: figma.editorType,
      page: { id: figma.currentPage.id, name: figma.currentPage.name },
      pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
      selection: figma.currentPage.selection.map((n) => ({ id: n.id, type: n.type, name: n.name })),
    },
  };
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'hello') {
    figma.ui.postMessage({ type: 'hello', fileName: figma.root.name });
    return;
  }
  if (msg.type !== 'command') return;
  const { id, cmd } = msg;
  try {
    if (cmd.type === 'run') figma.ui.postMessage({ type: 'reply', id, reply: await run(cmd.code) });
    else if (cmd.type === 'screenshot') {
      const { reply, bytes } = await screenshot(cmd.nodeId, cmd.scale);
      figma.ui.postMessage({ type: 'reply', id, reply, bytes });
    } else figma.ui.postMessage({ type: 'reply', id, reply: status() });
  } catch (error) {
    figma.ui.postMessage({ type: 'reply', id, reply: { ok: false, error: errorText(error) } });
  }
};
