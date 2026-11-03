/**
 * `apply_design_ops`: applies token and text style ops from a sync plan. Ops run in phases (collections, then
 * creates and renames, then values, then removals) so an alias can point at a token created in the same run.
 * Orphans are removed only with `prune: true`. Component ops are reported as skipped.
 */
import type { ApplyResult, SyncOp, TextStyleChange, TokenOp } from '../shared/design-ops';
import { CODE_ID_KEY, PLUGIN_DATA_NAMESPACE, tokenKey, type CodeSyntax, type SpecTextStyle, type TokenValue } from '../shared/design-spec';
import type { JsonValue } from '../shared/protocol';
import { componentOp, styleComponent, type ComponentState } from './design-components';
import { fontAvailable, hexToRgba, modeIdFor, phaseOf } from './design-write';
import { bool, ok, type Handler } from './types';

/** An op that was deliberately not applied. */
class Skip extends Error {}

const RESOLVED: Record<string, VariableResolvedDataType> = { color: 'COLOR', float: 'FLOAT', string: 'STRING', boolean: 'BOOLEAN' };

type State = {
    result: ApplyResult;
    collections: Map<string, VariableCollection>;
    /** Token key (`Collection/name`) to variable, kept current through renames and creates. */
    vars: Map<string, Variable>;
    fonts: Font[] | null;
};

const nameOf = (op: SyncOp): string => {
    switch (op.op) {
        case 'create-collection':
        case 'add-mode':
            return op.collection;
        case 'create-token':
            return tokenKey(op.collection, op.token.name);
        case 'update-token':
        case 'orphan-token':
            return tokenKey(op.collection, op.name);
        case 'create-text-style':
            return op.style.name;
        case 'update-text-style':
        case 'orphan-text-style':
            return op.name;
        case 'create-component':
            return op.component.name;
        default:
            return op.component;
    }
};

async function load(): Promise<Pick<State, 'collections' | 'vars'>> {
    const collections = new Map<string, VariableCollection>();
    const vars = new Map<string, Variable>();
    for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
        collections.set(c.name, c);
        for (const id of c.variableIds) {
            const v = await figma.variables.getVariableByIdAsync(id);
            if (v) vars.set(tokenKey(c.name, v.name), v);
        }
    }
    return { collections, vars };
}

function toFigmaValue(value: TokenValue, s: State): VariableValue {
    switch (value.kind) {
        case 'color':
            return hexToRgba(value.hex);
        case 'float':
        case 'string':
        case 'boolean':
            return value.value;
        case 'alias': {
            const target = s.vars.get(value.to);
            if (!target) throw new Error(`alias target ${value.to} does not exist`);
            return figma.variables.createVariableAlias(target);
        }
    }
}

function setValue(v: Variable, c: VariableCollection, mode: string, value: TokenValue, s: State): void {
    const modeId = modeIdFor(c.modes, mode);
    if (!modeId) throw new Error(`collection ${c.name} has no mode ${mode}`);
    v.setValueForMode(modeId, toFigmaValue(value, s));
}

function link(v: Variable, codeId: string | undefined, codeSyntax: CodeSyntax | undefined): void {
    if (codeId) v.setSharedPluginData(PLUGIN_DATA_NAMESPACE, CODE_ID_KEY, codeId);
    for (const p of ['WEB', 'ANDROID', 'iOS'] as const) {
        const syntax = codeSyntax?.[p];
        if (syntax) v.setVariableCodeSyntax(p, syntax);
    }
}

async function variableFor(op: Extract<TokenOp, { figmaId?: string }>, s: State): Promise<Variable> {
    const v = (op.figmaId ? await figma.variables.getVariableByIdAsync(op.figmaId) : null) ?? s.vars.get(tokenKey(op.collection, op.name));
    if (!v) throw new Error('variable not found');
    return v;
}

async function collectionOf(v: Variable): Promise<VariableCollection> {
    const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    if (!c) throw new Error('collection not found');
    return c;
}

/** Phase 0 and 1: structure and names. Returns a phase-2 step that sets values, if the op has any. */
async function structure(op: TokenOp, s: State): Promise<(() => Promise<void>) | null> {
    switch (op.op) {
        case 'create-collection': {
            const c = figma.variables.createVariableCollection(op.collection);
            const [first, ...rest] = op.modes;
            if (first && c.modes[0]) c.renameMode(c.modes[0].modeId, first);
            for (const m of rest) c.addMode(m);
            s.collections.set(op.collection, c);
            s.result.created.push(c.id);
            return null;
        }
        case 'add-mode': {
            const c = s.collections.get(op.collection);
            if (!c) throw new Error('collection not found');
            c.addMode(op.mode);
            s.result.updated.push(c.id);
            return null;
        }
        case 'create-token': {
            const c = s.collections.get(op.collection);
            if (!c) throw new Error('collection not found');
            const type = RESOLVED[op.token.type];
            if (!type) throw new Error(`unsupported type ${op.token.type}`);
            const v = figma.variables.createVariable(op.token.name, c, type);
            v.scopes = (op.token.scopes ?? []) as VariableScope[];
            if (op.token.description) v.description = op.token.description;
            link(v, op.token.codeId, op.token.codeSyntax);
            s.vars.set(tokenKey(c.name, v.name), v);
            s.result.created.push(v.id);
            return async () => {
                for (const [mode, value] of Object.entries(op.token.values)) setValue(v, c, mode, value, s);
            };
        }
        case 'update-token': {
            const v = await variableFor(op, s);
            const c = await collectionOf(v);
            if (op.rename) {
                s.vars.delete(tokenKey(c.name, v.name));
                v.name = op.rename.to;
                s.vars.set(tokenKey(c.name, v.name), v);
            }
            link(v, op.codeId, op.codeSyntax);
            s.result.updated.push(v.id);
            return op.values.length === 0
                ? null
                : async () => {
                      for (const change of op.values) setValue(v, c, change.mode, change.to, s);
                  };
        }
        case 'orphan-token':
            return null;
    }
}

async function fontFor(family: string, style: string, s: State): Promise<FontName> {
    s.fonts ??= await figma.listAvailableFontsAsync();
    if (!fontAvailable(s.fonts, family, style)) throw new Error(`font ${family} ${style} is not available in Figma`);
    const font = { family, style };
    await figma.loadFontAsync(font);
    return font;
}

async function writeStyle(style: TextStyle, spec: Pick<SpecTextStyle, 'fontFamily' | 'fontStyle'> & Partial<SpecTextStyle>, s: State): Promise<void> {
    style.fontName = await fontFor(spec.fontFamily, spec.fontStyle, s);
    if (spec.fontSize !== undefined) style.fontSize = spec.fontSize;
    if (spec.lineHeight) style.lineHeight = spec.lineHeight;
    if (spec.letterSpacing) style.letterSpacing = spec.letterSpacing;
}

function changed(changes: TextStyleChange[]): Partial<SpecTextStyle> {
    const out: Partial<SpecTextStyle> = {};
    for (const c of changes) {
        switch (c.field) {
            case 'fontFamily':
            case 'fontStyle':
                out[c.field] = c.to;
                break;
            case 'fontSize':
                out.fontSize = c.to;
                break;
            case 'lineHeight':
                out.lineHeight = c.to;
                break;
            case 'letterSpacing':
                out.letterSpacing = c.to;
                break;
        }
    }
    return out;
}

async function textStyleOp(op: Extract<SyncOp, { op: 'create-text-style' | 'update-text-style' }>, s: State): Promise<void> {
    if (op.op === 'create-text-style') {
        const style = figma.createTextStyle();
        try {
            await writeStyle(style, op.style, s);
        } catch (error) {
            style.remove();
            throw error;
        }
        style.name = op.style.name;
        if (op.style.codeId) style.setSharedPluginData(PLUGIN_DATA_NAMESPACE, CODE_ID_KEY, op.style.codeId);
        s.result.created.push(style.id);
        return;
    }
    const found = op.figmaId ? await figma.getStyleByIdAsync(op.figmaId) : null;
    if (!found || found.type !== 'TEXT') throw new Error('text style not found');
    const style = found as TextStyle;
    const next = changed(op.changes);
    await writeStyle(style, { ...next, fontFamily: next.fontFamily ?? style.fontName.family, fontStyle: next.fontStyle ?? style.fontName.style }, s);
    if (op.rename) style.name = op.rename.to;
    if (op.codeId) style.setSharedPluginData(PLUGIN_DATA_NAMESPACE, CODE_ID_KEY, op.codeId);
    s.result.updated.push(style.id);
}

async function remove(op: Extract<SyncOp, { op: 'orphan-token' | 'orphan-text-style' }>, s: State): Promise<void> {
    if (op.op === 'orphan-token') {
        const v = await variableFor(op, s);
        s.vars.delete(tokenKey(op.collection, op.name));
        s.result.removed.push(v.id);
        v.remove();
        return;
    }
    const style = op.figmaId ? await figma.getStyleByIdAsync(op.figmaId) : null;
    if (!style) throw new Error('text style not found');
    s.result.removed.push(style.id);
    style.remove();
}

export const applyDesignOps: Handler = async (args) => {
    const ops = (Array.isArray(args.ops) ? args.ops : []) as unknown as SyncOp[];
    const prune = bool(args, 'prune', false);
    const s: State = { ...(await load()), fonts: null, result: { applied: 0, created: [], updated: [], removed: [], skipped: [], errors: [] } };
    const later: { op: SyncOp; step: () => Promise<void> }[] = [];
    let componentState: ComponentState | null = null;
    // Built on first use (phase 1 component ops or phase 2 styling), after phase 1 token renames.
    const components = (): ComponentState => {
        if (componentState) return componentState;
        const byName = new Map<string, Variable>();
        for (const [key, v] of s.vars) {
            const name = key.slice(key.indexOf('/') + 1);
            if (!byName.has(name) || key.startsWith('Primitives/') === false) byName.set(name, v);
        }
        componentState = { result: s.result, byName, fonts: s.fonts, created: new Map() };
        return componentState;
    };
    const run = async (op: SyncOp, fn: () => Promise<void>) => {
        try {
            await fn();
            s.result.applied++;
        } catch (error) {
            if (error instanceof Skip) {
                s.result.skipped.push({ op: op.op, name: nameOf(op), reason: error.message });
                return;
            }
            s.result.errors.push({ op: op.op, name: nameOf(op), error: error instanceof Error ? error.message : String(error) });
        }
    };

    for (const op of [...ops].sort((a, b) => phaseOf(a) - phaseOf(b))) {
        switch (op.op) {
            case 'create-collection':
            case 'add-mode':
            case 'create-token':
            case 'update-token':
                await run(op, async () => {
                    const step = await structure(op, s);
                    if (step) later.push({ op, step });
                });
                break;
            case 'create-text-style':
            case 'update-text-style':
                await run(op, () => textStyleOp(op, s));
                break;
            case 'orphan-token':
            case 'orphan-text-style':
                // Values must land before anything is removed, in case a value aliased the orphan.
                break;
            case 'style-component':
                await run(op, async () => {
                    const problems = await styleComponent(op, components());
                    for (const p of problems) s.result.errors.push({ op: op.op, name: op.component, error: p });
                });
                break;
            default:
                await run(op, async () => {
                    const outcome = await componentOp(op, components(), prune);
                    if (outcome !== 'done') throw new Skip(outcome);
                });
        }
    }
    for (const { op, step } of later) {
        try {
            await step();
        } catch (error) {
            s.result.errors.push({ op: op.op, name: nameOf(op), error: error instanceof Error ? error.message : String(error) });
        }
    }
    for (const op of ops) {
        if (op.op !== 'orphan-token' && op.op !== 'orphan-text-style') continue;
        if (!prune) s.result.skipped.push({ op: op.op, name: nameOf(op), reason: 'orphan kept: pass prune: true to remove it' });
        else await run(op, () => remove(op, s));
    }
    return ok(s.result as unknown as JsonValue);
};
