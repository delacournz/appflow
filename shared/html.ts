/**
 * The layout the plugin UI measures from rendered HTML and the plugin's main
 * thread turns into layers. Positions are relative to the parent box.
 */

export type Color = { r: number; g: number; b: number; a: number };

export type HtmlBox = {
    kind: 'box';
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    bg: Color | null;
    radius: [number, number, number, number];
    border: { width: number; color: Color } | null;
    shadow: { x: number; y: number; blur: number; spread: number; color: Color } | null;
    opacity: number;
    clip: boolean;
    children: HtmlLayer[];
};

export type HtmlText = {
    kind: 'text';
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    font: { family: string; weight: number; italic: boolean; size: number; lineHeight: number | null; letterSpacing: number };
    color: Color;
    align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
    decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
};

export type HtmlSvg = { kind: 'svg'; name: string; x: number; y: number; w: number; h: number; svg: string };

/** `bytes` is set by the UI before posting to the main thread. */
export type HtmlImage = { kind: 'image'; name: string; x: number; y: number; w: number; h: number; bytes: Uint8Array | null };

export type HtmlLayer = HtmlBox | HtmlText | HtmlSvg | HtmlImage;
