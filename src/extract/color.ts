/** sRGB hex, OKLCH and `color-mix(in oklch, …)`, enough to resolve Tailwind v4 theme colours to hex. */
import { normalizeHex } from '../../shared/design-spec';

export type Oklch = { l: number; c: number; h: number; alpha: number };

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const byte = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0').toUpperCase();
const ACHROMATIC = 1e-4;

export function hexToOklch(hex: string): Oklch {
    const n = normalizeHex(hex);
    if (!n) throw new Error(`Not a hex colour: ${hex}`);
    const ch = (i: number) => Number.parseInt(n.slice(i, i + 2), 16) / 255;
    const [r, g, b] = [toLinear(ch(1)), toLinear(ch(3)), toLinear(ch(5))];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const c = Math.hypot(A, B);
    const h = c < ACHROMATIC ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
    return { l: L, c, h, alpha: ch(7) };
}

export function oklchToHex({ l: L, c, h, alpha }: Oklch): string {
    const rad = (h * Math.PI) / 180;
    const A = c * Math.cos(rad);
    const B = c * Math.sin(rad);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    return `#${byte(toGamma(r))}${byte(toGamma(g))}${byte(toGamma(b))}${byte(alpha)}`;
}

/** `weight` is the share of `a`, 0 to 1. Hue takes the shorter arc; an achromatic side borrows the other's hue. */
export function mixOklch(a: Oklch, b: Oklch, weight: number): string {
    const w = clamp(weight);
    let ha = a.h;
    let hb = b.h;
    if (a.c < ACHROMATIC) ha = hb;
    if (b.c < ACHROMATIC) hb = ha;
    let d = hb - ha;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return oklchToHex({ l: a.l * w + b.l * (1 - w), c: a.c * w + b.c * (1 - w), h: (ha + d * (1 - w) + 360) % 360, alpha: a.alpha * w + b.alpha * (1 - w) });
}

const num = (s: string, percentOf = 1): number | null => {
    const t = s.trim();
    if (t.endsWith('%')) {
        const v = Number(t.slice(0, -1));
        return Number.isFinite(v) ? (v / 100) * percentOf : null;
    }
    const v = Number(t);
    return t !== '' && Number.isFinite(v) ? v : null;
};

function args(value: string, fn: string): { parts: string[]; alpha: string | undefined } | null {
    const m = new RegExp(`^${fn}\\((.*)\\)$`, 'i').exec(value.trim());
    if (!m || m[1] === undefined) return null;
    const [main = '', alpha] = m[1].split('/');
    const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
    if (alpha === undefined && parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
    return { parts, alpha };
}

/** A literal colour (hex, `oklch()`, `rgb()`/`rgba()`) as `#RRGGBBAA`, or null. */
export function parseColor(value: string): string | null {
    const v = value.trim();
    if (v.startsWith('#')) return normalizeHex(v);
    const ok = args(v, 'oklch');
    if (ok && ok.parts.length === 3) {
        const [l, c, h] = [num(ok.parts[0] ?? '', 1), num(ok.parts[1] ?? '', 0.4), num(ok.parts[2] ?? '', 360)];
        const alpha = ok.alpha === undefined ? 1 : num(ok.alpha, 1);
        if (l === null || c === null || h === null || alpha === null) return null;
        return oklchToHex({ l, c, h, alpha });
    }
    const rgb = args(v, 'rgba?');
    if (rgb && rgb.parts.length === 3) {
        const [r, g, b] = rgb.parts.map((p) => num(p, 255));
        const alpha = rgb.alpha === undefined ? 1 : num(rgb.alpha, 1);
        if (r == null || g == null || b == null || alpha === null) return null;
        return `#${byte(r / 255)}${byte(g / 255)}${byte(b / 255)}${byte(alpha)}`;
    }
    return null;
}
