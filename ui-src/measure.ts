import type { Color, HtmlBox, HtmlLayer, HtmlText } from '../shared/html';

/**
 * Renders HTML in a hidden iframe at the requested width and measures every
 * visible box and text run, so the plugin can rebuild it as layers.
 * Elements with nothing to draw are flattened into their parent.
 */

const color = (value: string): Color | null => {
    const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!m) return null;
    const parts = (m[1] as string).split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r = 0, g = 0, b = 0, a = 1] = parts;
    if (a === 0) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a };
};

const px = (v: string) => parseFloat(v) || 0;

function shadowOf(value: string): HtmlBox['shadow'] {
    if (!value || value === 'none' || value.includes('inset')) return null;
    const c = /rgba?\([^)]+\)/.exec(value);
    const nums = value.replace(/rgba?\([^)]+\)/, '').trim().split(/\s+/).map(px);
    const col = c ? color(c[0]) : null;
    if (!col) return null;
    return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color: col };
}

function label(el: Element): string {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
}

const ALIGN: Record<string, HtmlText['align']> = { center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' };

function textLayer(node: Text, cs: CSSStyleDeclaration, origin: DOMRect): HtmlText | null {
    let text = node.textContent ?? '';
    if (!/\S/.test(text)) return null;
    if (!cs.whiteSpace.startsWith('pre')) text = text.replace(/\s+/g, ' ').trim();
    if (cs.textTransform === 'uppercase') text = text.toUpperCase();
    else if (cs.textTransform === 'lowercase') text = text.toLowerCase();
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const c = color(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    return {
        kind: 'text',
        name: text.slice(0, 40),
        x: r.left - origin.left,
        y: r.top - origin.top,
        w: r.width,
        h: r.height,
        text,
        font: {
            family: cs.fontFamily,
            weight: parseInt(cs.fontWeight, 10) || 400,
            italic: cs.fontStyle === 'italic',
            size: px(cs.fontSize),
            lineHeight: cs.lineHeight === 'normal' ? null : px(cs.lineHeight),
            letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
        },
        color: { ...c, a: c.a * px(cs.opacity || '1') },
        align: ALIGN[cs.textAlign] ?? 'LEFT',
        decoration: cs.textDecorationLine.includes('underline') ? 'UNDERLINE' : cs.textDecorationLine.includes('line-through') ? 'STRIKETHROUGH' : 'NONE',
    };
}

async function imageBytes(img: HTMLImageElement): Promise<Uint8Array | null> {
    try {
        if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d')?.drawImage(img, 0, 0);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    } catch {
        return null;
    }
}

type Budget = { left: number };

async function walkEl(el: Element, origin: DOMRect, budget: Budget): Promise<HtmlLayer[]> {
    if (budget.left-- <= 0) return [];
    const win = el.ownerDocument.defaultView as Window;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || px(cs.opacity) === 0) return [];
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const base = { name: label(el), x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };

    if (tag === 'svg') return [{ kind: 'svg', ...base, svg: el.outerHTML }];
    if (tag === 'img') return [{ kind: 'image', ...base, bytes: await imageBytes(el as HTMLImageElement) }];
    if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'template') return [];

    const bg = color(cs.backgroundColor);
    const bw = px(cs.borderTopWidth);
    const border = bw > 0 && cs.borderTopStyle !== 'none' ? { width: bw, color: color(cs.borderTopColor) ?? { r: 0, g: 0, b: 0, a: 1 } } : null;
    const shadow = shadowOf(cs.boxShadow);
    const clip = cs.overflow === 'hidden' || cs.overflow === 'clip';
    const opacity = px(cs.opacity || '1');
    const radius: HtmlBox['radius'] = [px(cs.borderTopLeftRadius), px(cs.borderTopRightRadius), px(cs.borderBottomRightRadius), px(cs.borderBottomLeftRadius)];
    const draws = Boolean(bg || border || shadow || clip || opacity < 1);
    const childOrigin = draws ? r : origin;

    const children: HtmlLayer[] = [];
    for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            const t = textLayer(child as Text, cs, childOrigin);
            if (t) children.push(t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            children.push(...(await walkEl(child as Element, childOrigin, budget)));
        }
    }
    if (!draws) return children;
    return [{ kind: 'box', ...base, bg, radius, border, shadow, opacity, clip, children }];
}

export async function measureHtml(html: string, width: number, height: number | null, maxLayers = 3000): Promise<HtmlBox> {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height ?? 800}px;border:0;visibility:hidden`;
    document.body.appendChild(frame);
    try {
        await new Promise<void>((resolve) => {
            frame.onload = () => resolve();
            frame.srcdoc = html;
        });
        const doc = frame.contentDocument as Document;
        await doc.fonts.ready;
        await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true })))));
        const fullHeight = height ?? Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
        frame.style.height = `${fullHeight}px`;
        const win = frame.contentWindow as Window;
        const rootBg = color(win.getComputedStyle(doc.body).backgroundColor) ?? color(win.getComputedStyle(doc.documentElement).backgroundColor) ?? { r: 1, g: 1, b: 1, a: 1 };
        const origin = new DOMRect(0, 0, width, fullHeight);
        const children = await walkEl(doc.body, origin, { left: maxLayers });
        return {
            kind: 'box',
            name: doc.title || 'HTML',
            x: 0,
            y: 0,
            w: width,
            h: fullHeight,
            bg: rootBg,
            radius: [0, 0, 0, 0],
            border: null,
            shadow: null,
            opacity: 1,
            clip: true,
            children,
        };
    } finally {
        frame.remove();
    }
}
