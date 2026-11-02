import type { PluginCommand } from '../shared/protocol';
import { downloadAssets, getScreenshot, uploadAssets } from './assets';
import { componentRefs, getContextForCodeConnect, resolveComponent } from './codeconnect';
import { generateDiagram, htmlBuild, useFigma } from './create';
import { adoptBoard, connect, rerouteFlow } from './flow';
import { lintFlowLayout } from './flowlint';
import { getDesignContext, getFigjam, getLibraries, getMetadata, getVariableDefs, searchDesignSystem, status, whoami } from './inspect';
import { describeBoard } from './describe';
import { duplicateScreen } from './duplicate';
import { groupScreens } from './group-screens';
import { errorText } from './nodes';
import { compactBoard, createBoard, insertColumns, insertRows, moveScreen } from './gridtools';
import { fail, type Handler, type MainReply } from './types';

const handlers: Record<string, Handler> = {
    figma_status: status,
    whoami,
    get_metadata: getMetadata,
    get_figjam: getFigjam,
    get_variable_defs: getVariableDefs,
    get_design_context: getDesignContext,
    search_design_system: searchDesignSystem,
    get_libraries: getLibraries,
    get_screenshot: getScreenshot,
    download_assets: downloadAssets,
    upload_assets: uploadAssets,
    use_figma: useFigma,
    generate_diagram: generateDiagram,
    html_build: htmlBuild,
    get_context_for_code_connect: getContextForCodeConnect,
    resolve_component: resolveComponent,
    component_refs: componentRefs,
    lint_flow_layout: lintFlowLayout,
    connect,
    reroute_flow: rerouteFlow,
    adopt_board: adoptBoard,
    describe_board: describeBoard,
    create_board: createBoard,
    move_screen: moveScreen,
    insert_columns: insertColumns,
    insert_rows: insertRows,
    compact_board: compactBoard,
    duplicate_screen: duplicateScreen,
    group_screens: groupScreens,
};

declare const __BUILD__: string;

type UiMessage = { type: 'hello' } | { type: 'command'; id: string; cmd: PluginCommand };

figma.showUI(__html__, { width: 300, height: 140, themeColors: true });

figma.ui.onmessage = async (msg: UiMessage) => {
    if (msg.type === 'hello') {
        figma.ui.postMessage({ type: 'hello', fileName: figma.root.name, editorType: figma.editorType, build: __BUILD__ });
        return;
    }
    if (msg.type !== 'command') return;
    const handler = handlers[msg.cmd.tool];
    let reply: MainReply;
    try {
        reply = handler ? await handler(msg.cmd.args ?? {}) : fail(`The plugin has no tool "${msg.cmd.tool}": the running plugin build (${__BUILD__}) is stale. Re-run Plugins → Development → AppFlow to load the latest build.`);
    } catch (error) {
        reply = fail(errorText(error));
    }
    figma.ui.postMessage({ type: 'reply', id: msg.id, reply });
};
