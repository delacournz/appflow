/**
 * Tailwind classes to Figma properties, bound to code tokens where a class names one.
 *
 * `tokens` maps a code token name (`color/muted`, `spacing/button-lg`) to its float value, or null for a
 * colour. Classes it cannot express (state prefixes, arbitrary values, layout-only utilities) come back in
 * `unknown`; they are never dropped silently.
 */
import { mergeDecls, type Amount, type Side, type StyleDecl } from '../../shared/design-style';

export type Interpretation = { decls: StyleDecl[]; unknown: string[] };
type Tokens = ReadonlyMap<string, number | null>;

const SCALE = 4;
const WEIGHTS: Record<string, string> = { thin: 'Thin', extralight: 'ExtraLight', light: 'Light', normal: 'Regular', medium: 'Medium', semibold: 'SemiBold', bold: 'Bold', extrabold: 'ExtraBold', black: 'Black' };
const COUNTER: Record<string, 'MIN' | 'CENTER' | 'MAX'> = { start: 'MIN', center: 'CENTER', end: 'MAX' };
const PRIMARY: Record<string, 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'> = { start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN' };
const PADDING: Record<string, Side[]> = { p: ['top', 'right', 'bottom', 'left'], px: ['left', 'right'], py: ['top', 'bottom'], pt: ['top'], pr: ['right'], pb: ['bottom'], pl: ['left'], ps: ['left'], pe: ['right'] };

/** A spacing amount: a scale step (`1.5` is 6), `px`, or a `spacing/<name>` token. */
function spacing(rest: string, tokens: Tokens): Amount | null {
    if (rest === 'px') return { value: 1 };
    if (/^\d+(\.\d+)?$/.test(rest)) return { value: Number(rest) * SCALE };
    const token = `spacing/${rest}`;
    if (tokens.has(token)) {
        const v = tokens.get(token);
        return v == null ? { token } : { token, value: v };
    }
    return null;
}

const colour = (rest: string, tokens: Tokens): string | null => (tokens.has(`color/${rest}`) ? `color/${rest}` : null);

function one(cls: string, tokens: Tokens): StyleDecl[] | null {
    if (cls.includes(':') || cls.includes('[')) return null;
    const dash = cls.indexOf('-');
    const head = dash < 0 ? cls : cls.slice(0, dash);
    const rest = dash < 0 ? '' : cls.slice(dash + 1);

    switch (head) {
        case 'bg': {
            if (rest === 'transparent') return [{ kind: 'fill-none' }];
            const t = colour(rest, tokens);
            return t ? [{ kind: 'fill', token: t }] : null;
        }
        case 'border': {
            if (rest === '') return [{ kind: 'stroke-weight', value: 1 }];
            if (rest === 'transparent') return [{ kind: 'stroke-none' }];
            if (/^\d+$/.test(rest)) return [{ kind: 'stroke-weight', value: Number(rest) }];
            const t = colour(rest, tokens);
            return t ? [{ kind: 'stroke', token: t }] : null;
        }
        case 'rounded': {
            if (rest === 'none') return [{ kind: 'radius', value: 0 }];
            const token = `radius/${rest}`;
            if (tokens.has(token)) {
                const v = tokens.get(token);
                return [v == null ? { kind: 'radius', token } : { kind: 'radius', token, value: v }];
            }
            return rest === 'full' ? [{ kind: 'radius', value: 9999 }] : null;
        }
        case 'h':
        case 'w':
        case 'size': {
            const a = spacing(rest, tokens);
            if (!a) return null;
            const axes: ('width' | 'height')[] = head === 'h' ? ['height'] : head === 'w' ? ['width'] : ['width', 'height'];
            return axes.map((axis) => ({ kind: 'size', axis, ...a }));
        }
        case 'gap': {
            const a = spacing(rest.replace(/^[xy]-/, ''), tokens);
            return a ? [{ kind: 'gap', ...a }] : null;
        }
        case 'text': {
            const c = colour(rest, tokens);
            if (c) return [{ kind: 'text-fill', token: c }];
            const token = `text/${rest}`;
            if (!tokens.has(token)) return null;
            const v = tokens.get(token);
            return [v == null ? { kind: 'font-size', token } : { kind: 'font-size', token, value: v }];
        }
        case 'font': {
            const style = WEIGHTS[rest];
            return style ? [{ kind: 'font-weight', style }] : null;
        }
        case 'opacity':
            return /^\d+$/.test(rest) ? [{ kind: 'opacity', value: Number(rest) / 100 }] : null;
        case 'flex':
            return rest === 'row' ? [{ kind: 'layout', mode: 'HORIZONTAL' }] : rest === 'col' ? [{ kind: 'layout', mode: 'VERTICAL' }] : null;
        case 'items': {
            const v = COUNTER[rest];
            return v ? [{ kind: 'align', axis: 'counter', value: v }] : null;
        }
        case 'justify': {
            const v = PRIMARY[rest];
            return v ? [{ kind: 'align', axis: 'primary', value: v }] : null;
        }
    }
    const sides = PADDING[head];
    if (sides) {
        const a = spacing(rest, tokens);
        return a ? sides.map((side) => ({ kind: 'padding', side, ...a })) : null;
    }
    return null;
}

export function interpretClasses(classes: string, tokens: Tokens): Interpretation {
    const decls: StyleDecl[][] = [];
    const unknown: string[] = [];
    for (const cls of classes.split(/\s+/).filter(Boolean)) {
        const d = one(cls, tokens);
        if (d) decls.push(d);
        else unknown.push(cls);
    }
    return { decls: mergeDecls(...decls), unknown };
}
