/**
 * DesignSpec: the shared, tool-neutral shape of a design system. Code
 * extractors (server) and the Figma export (plugin) both produce one, and the
 * diff engine compares two of them. Plain types only, so the plugin bundle
 * stays free of zod.
 *
 * Tokens are addressed by a token key, `Collection/name`, for example
 * `Tokens/color/muted-foreground`. Aliases point at another token key.
 */
import type { ComponentStyles } from './design-style';

export type TokenType = 'color' | 'float' | 'string' | 'boolean';

export type TokenValue =
    | { kind: 'color'; hex: string }
    | { kind: 'float'; value: number }
    | { kind: 'string'; value: string }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'alias'; to: string };

export type CodeSyntax = { WEB?: string; ANDROID?: string; iOS?: string };

export type SpecToken = {
    name: string;
    type: TokenType;
    /** One value per mode name of the collection. */
    values: Record<string, TokenValue>;
    /** Stable id of the code token, such as `css:--muted-foreground`. Stored in Figma as shared plugin data. */
    codeId?: string;
    scopes?: string[];
    codeSyntax?: CodeSyntax;
    description?: string;
    /** Where the token came from: `file:line` for code, unused for Figma. */
    source?: string;
    figmaId?: string;
};

export type SpecCollection = {
    name: string;
    modes: string[];
    tokens: SpecToken[];
    figmaId?: string;
};

export type SpecLineHeight = { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };
export type SpecLetterSpacing = { unit: 'PIXELS' | 'PERCENT'; value: number };

export type SpecTextStyle = {
    name: string;
    fontFamily: string;
    fontStyle: string;
    fontSize: number;
    lineHeight: SpecLineHeight;
    letterSpacing: SpecLetterSpacing;
    codeId?: string;
    source?: string;
    figmaId?: string;
};

export type SpecComponent = {
    name: string;
    /** Variant axes and their options, in order. Empty for a component without variants. */
    axes: Record<string, string[]>;
    defaults: Record<string, string>;
    /** Per-slot styling read from code classes. Code only; a Figma export has none. */
    styles?: ComponentStyles;
    codeId?: string;
    source?: string;
    figmaId?: string;
};

export type DesignSpec = {
    collections: SpecCollection[];
    textStyles: SpecTextStyle[];
    components: SpecComponent[];
};

/** Shared plugin data namespace and key that hold a Figma item's code id. */
export const PLUGIN_DATA_NAMESPACE = 'appflow';
export const CODE_ID_KEY = 'codeId';

export const tokenKey = (collection: string, name: string): string => `${collection}/${name}`;

export const emptySpec = (): DesignSpec => ({ collections: [], textStyles: [], components: [] });

/**
 * Normalises a colour to `#RRGGBBAA` upper case. Accepts `#RGB`, `#RGBA`,
 * `#RRGGBB` and `#RRGGBBAA`. Returns null for anything else.
 */
export function normalizeHex(input: string): string | null {
    const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input.trim());
    if (!m || m[1] === undefined) return null;
    let h = m[1].toUpperCase();
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return h.length === 6 ? `#${h}FF` : `#${h}`;
}
