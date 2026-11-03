/** Sync plan ops, shared by the diff engine (server) and the applier (plugin). Plain types only. */
import type { CodeSyntax, SpecComponent, SpecLetterSpacing, SpecLineHeight, SpecTextStyle, SpecToken, TokenValue } from './design-spec';
import type { ComponentStyles } from './design-style';

export type ValueChange = { mode: string; from: TokenValue | null; to: TokenValue };
export type Rename = { from: string; to: string };

export type TextStyleChange =
    | { field: 'fontFamily' | 'fontStyle'; from: string; to: string }
    | { field: 'fontSize'; from: number; to: number }
    | { field: 'lineHeight'; from: SpecLineHeight; to: SpecLineHeight }
    | { field: 'letterSpacing'; from: SpecLetterSpacing; to: SpecLetterSpacing };

export type SyncOp =
    | { op: 'create-collection'; collection: string; modes: string[] }
    | { op: 'add-mode'; collection: string; mode: string }
    | { op: 'create-token'; collection: string; token: SpecToken }
    | { op: 'update-token'; collection: string; name: string; figmaId?: string; values: ValueChange[]; rename?: Rename; codeId?: string; codeSyntax?: CodeSyntax }
    | { op: 'orphan-token'; collection: string; name: string; figmaId?: string }
    | { op: 'create-text-style'; style: SpecTextStyle }
    | { op: 'update-text-style'; name: string; figmaId?: string; changes: TextStyleChange[]; rename?: Rename; codeId?: string }
    | { op: 'orphan-text-style'; name: string; figmaId?: string }
    | { op: 'create-component'; component: SpecComponent }
    | { op: 'add-variant-axis'; component: string; figmaId?: string; axis: string; options: string[]; /** The option existing variants take. */ existing: string }
    | { op: 'rename-variant'; component: string; figmaId?: string; axis: string; to: string; options: Record<string, string> }
    | { op: 'add-variant-option'; component: string; figmaId?: string; axis: string; option: string }
    | { op: 'orphan-variant-option'; component: string; figmaId?: string; axis: string; option: string }
    | { op: 'orphan-variant-axis'; component: string; figmaId?: string; axis: string }
    | { op: 'link-component'; component: string; figmaId?: string; rename?: Rename; codeId?: string }
    | { op: 'orphan-component'; component: string; figmaId?: string }
    /** Paint each variant of a component set from its code classes. Built by the sync tool, never by the diff. */
    | { op: 'style-component'; component: string; figmaId?: string; axes: Record<string, string[]>; styles: ComponentStyles; layers?: Record<string, string> };

export type ComponentOp = Exclude<SyncOp, TokenOp | TextStyleOp>;

export type TokenOp = Extract<SyncOp, { op: 'create-collection' | 'add-mode' | 'create-token' | 'update-token' | 'orphan-token' }>;
export type TextStyleOp = Extract<SyncOp, { op: 'create-text-style' | 'update-text-style' | 'orphan-text-style' }>;

const TOKEN_OPS: ReadonlySet<string> = new Set(['create-collection', 'add-mode', 'create-token', 'update-token', 'orphan-token']);
const TEXT_STYLE_OPS: ReadonlySet<string> = new Set(['create-text-style', 'update-text-style', 'orphan-text-style']);
export const isTokenOp = (op: SyncOp): op is TokenOp => TOKEN_OPS.has(op.op);
export const isTextStyleOp = (op: SyncOp): op is TextStyleOp => TEXT_STYLE_OPS.has(op.op);
export const isComponentOp = (op: SyncOp): op is ComponentOp => !TOKEN_OPS.has(op.op) && !TEXT_STYLE_OPS.has(op.op);

/** What the plugin did with a list of ops. */
export type ApplyResult = {
    applied: number;
    created: string[];
    updated: string[];
    removed: string[];
    skipped: { op: string; name: string; reason: string }[];
    errors: { op: string; name: string; error: string }[];
};
