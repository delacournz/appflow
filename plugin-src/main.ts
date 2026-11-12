import type { PluginCommand } from '../shared/protocol';
import { downloadAssets, getScreenshot, uploadAssets } from './assets';
import { componentRefs, getContextForCodeConnect, resolveComponent } from './codeconnect';
import { generateDiagram, htmlBuild, useFigma } from './create';
import { badgeScreens, setScreenStatus } from './badge';
import { adoptBoard, setGroupObstacleLoader } from './flow';
import { adoptFlowGroups } from './flow-group-adopt-handler';
import { connectWithGroups, createFlowGroup, deleteFlowGroup, groupObstacles, rerouteFlowWithGroups, updateFlowGroup } from './flow-groups';

setGroupObstacleLoader(groupObstacles);
import { lintFlowLayout } from './flowlint';
import { getDesignContext, getFigjam, getLibraries, getMetadata, getVariableDefs, searchDesignSystem, status, whoami } from './inspect';
import { describeBoard } from './describe';
import { duplicateScreen } from './duplicate';
import { applyDesignOps } from './design-apply';
import { exportDesignSystem } from './design-export';
import { groupScreens, ungroupScreens } from './group-screens';
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
    connect: connectWithGroups,
    reroute_flow: rerouteFlowWithGroups,
    create_flow_group: createFlowGroup,
    update_flow_group: updateFlowGroup,
    delete_flow_group: deleteFlowGroup,
    adopt_flow_groups: adoptFlowGroups,
    adopt_board: adoptBoard,
    describe_board: describeBoard,
    create_board: createBoard,
    move_screen: moveScreen,
    insert_columns: insertColumns,
    insert_rows: insertRows,
    compact_board: compactBoard,
    duplicate_screen: duplicateScreen,
    group_screens: groupScreens,
    ungroup_screens: ungroupScreens,
    set_screen_status: setScreenStatus,
    badge_screens: badgeScreens,
    export_design_system: exportDesignSystem,
    apply_design_ops: applyDesignOps,
};

declare const __BUILD__: string;

type UiMessage = { type: 'hello' } | { type: 'command'; id: string; cmd: PluginCommand };

figma.showUI(__html__, { width: 300, height: 140, themeColors: true });

const randomId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * An id kept in the document, so the server can tell files apart when
 * figma.fileKey is unavailable. A view-only file cannot store it, so it gets
 * an id for this run only.
 */
function docId(): string {
    try {
        const stored = figma.root.getSharedPluginData('appflow', 'docId');
        if (stored) return stored;
        const id = randomId();
        figma.root.setSharedPluginData('appflow', 'docId', id);
        return id;
    } catch {
        return randomId();
    }
}

const DOC_ID = docId();

/** Tells the server this file is the one the user is working in, at most every 2 s. */
let lastActivity = 0;
function activity() {
    const now = Date.now();
    if (now - lastActivity < 2000) return;
    lastActivity = now;
    figma.ui.postMessage({ type: 'activity' });
}
figma.on('selectionchange', activity);
figma.on('currentpagechange', activity);

figma.ui.onmessage = async (msg: UiMessage) => {
    if (msg.type === 'hello') {
        figma.ui.postMessage({ type: 'hello', fileName: figma.root.name, editorType: figma.editorType, build: __BUILD__, fileKey: figma.fileKey ?? null, docId: DOC_ID });
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
