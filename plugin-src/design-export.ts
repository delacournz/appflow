/** `export_design_system`: the open file's local variables, text styles and components as a DesignSpec. */
import { CODE_ID_KEY, PLUGIN_DATA_NAMESPACE, tokenKey, type CodeSyntax, type DesignSpec, type SpecCollection, type SpecComponent, type SpecTextStyle, type SpecToken, type TokenValue } from '../shared/design-spec';
import type { JsonValue } from '../shared/protocol';
import { axesFromVariantNames, rgbaToHex, toSpecLetterSpacing, toSpecLineHeight, tokenTypeOf } from './design-read';
import { bool, ok, type Handler } from './types';

const codeIdOf = (item: PluginDataMixin): string | undefined => item.getSharedPluginData(PLUGIN_DATA_NAMESPACE, CODE_ID_KEY) || undefined;

async function keyOfVariable(id: string, known: Map<string, string>): Promise<string> {
    const cached = known.get(id);
    if (cached) return cached;
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v) return `?/${id}`;
    const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    const key = tokenKey(c?.name ?? '?', v.name);
    known.set(id, key);
    return key;
}

async function toTokenValue(value: VariableValue, known: Map<string, string>): Promise<TokenValue> {
    if (typeof value === 'number') return { kind: 'float', value };
    if (typeof value === 'string') return { kind: 'string', value };
    if (typeof value === 'boolean') return { kind: 'boolean', value };
    if ('type' in value && value.type === 'VARIABLE_ALIAS') return { kind: 'alias', to: await keyOfVariable(value.id, known) };
    return { kind: 'color', hex: rgbaToHex(value as RGBA) };
}

function codeSyntaxOf(v: Variable): CodeSyntax | undefined {
    const out: CodeSyntax = {};
    for (const p of ['WEB', 'ANDROID', 'iOS'] as const) {
        const s = v.codeSyntax[p];
        if (s) out[p] = s;
    }
    return Object.keys(out).length ? out : undefined;
}

async function exportCollections(): Promise<SpecCollection[]> {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const known = new Map<string, string>();
    const vars = new Map<string, Variable>();
    for (const c of collections) {
        for (const id of c.variableIds) {
            const v = await figma.variables.getVariableByIdAsync(id);
            if (!v) continue;
            vars.set(id, v);
            known.set(id, tokenKey(c.name, v.name));
        }
    }
    const out: SpecCollection[] = [];
    for (const c of collections) {
        const tokens: SpecToken[] = [];
        for (const id of c.variableIds) {
            const v = vars.get(id);
            const type = v ? tokenTypeOf(v.resolvedType) : null;
            if (!v || !type) continue;
            const values: Record<string, TokenValue> = {};
            for (const m of c.modes) {
                const raw = v.valuesByMode[m.modeId];
                if (raw !== undefined) values[m.name] = await toTokenValue(raw, known);
            }
            const codeId = codeIdOf(v);
            const codeSyntax = codeSyntaxOf(v);
            tokens.push({
                name: v.name,
                type,
                values,
                scopes: [...v.scopes],
                ...(codeId ? { codeId } : {}),
                ...(codeSyntax ? { codeSyntax } : {}),
                ...(v.description ? { description: v.description } : {}),
                figmaId: v.id,
            });
        }
        out.push({ name: c.name, modes: c.modes.map((m) => m.name), tokens, figmaId: c.id });
    }
    return out;
}

async function exportTextStyles(): Promise<SpecTextStyle[]> {
    return (await figma.getLocalTextStylesAsync()).map((s) => {
        const codeId = codeIdOf(s);
        return {
            name: s.name,
            fontFamily: s.fontName.family,
            fontStyle: s.fontName.style,
            fontSize: s.fontSize,
            lineHeight: toSpecLineHeight(s.lineHeight),
            letterSpacing: toSpecLetterSpacing(s.letterSpacing),
            ...(codeId ? { codeId } : {}),
            figmaId: s.id,
        };
    });
}

async function exportComponents(): Promise<SpecComponent[]> {
    await figma.loadAllPagesAsync();
    const out: SpecComponent[] = [];
    for (const node of figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })) {
        if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') continue;
        const codeId = codeIdOf(node);
        let axes: Record<string, string[]> = {};
        let defaults: Record<string, string> = {};
        if (node.type === 'COMPONENT_SET') {
            axes = axesFromVariantNames(node.children.map((c) => c.name));
            const d = node.defaultVariant;
            defaults = d?.variantProperties ? { ...d.variantProperties } : {};
        }
        out.push({ name: node.name, axes, defaults, ...(codeId ? { codeId } : {}), figmaId: node.id });
    }
    return out;
}

export const exportDesignSystem: Handler = async (args) => {
    const spec: DesignSpec = {
        collections: await exportCollections(),
        textStyles: await exportTextStyles(),
        components: bool(args, 'includeComponents', true) ? await exportComponents() : [],
    };
    return ok(spec as unknown as JsonValue);
};
