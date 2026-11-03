/** Pure helpers that turn Figma values into DesignSpec values. No `figma` global. */
import type { SpecLetterSpacing, SpecLineHeight, TokenType } from '../shared/design-spec';

type Rgba = { r: number; g: number; b: number; a?: number };

const byte = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();

/** 0-1 channels to `#RRGGBBAA`. */
export const rgbaToHex = (c: Rgba): string => `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${byte(c.a ?? 1)}`;

export function toSpecLineHeight(lh: { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number }): SpecLineHeight {
    return lh.unit === 'AUTO' ? { unit: 'AUTO' } : { unit: lh.unit, value: lh.value };
}

export const toSpecLetterSpacing = (ls: { unit: 'PIXELS' | 'PERCENT'; value: number }): SpecLetterSpacing => ({ unit: ls.unit, value: ls.value });

const TYPES: Record<string, TokenType> = { COLOR: 'color', FLOAT: 'float', STRING: 'string', BOOLEAN: 'boolean' };

/** Maps a Figma resolved type to a token type, or null for types a spec does not carry (such as EASING). */
export const tokenTypeOf = (resolvedType: string): TokenType | null => TYPES[resolvedType] ?? null;

/** Variant names like `Tone=Info, Size=Small` to `{ Tone: [...], Size: [...] }`, in first-seen order. */
export function axesFromVariantNames(names: string[]): Record<string, string[]> {
    const axes: Record<string, string[]> = {};
    for (const name of names) {
        for (const part of name.split(',')) {
            const eq = part.indexOf('=');
            if (eq < 0) continue;
            const axis = part.slice(0, eq).trim();
            const option = part.slice(eq + 1).trim();
            if (!axis || !option) continue;
            const list = (axes[axis] ??= []);
            if (!list.includes(option)) list.push(option);
        }
    }
    return axes;
}
