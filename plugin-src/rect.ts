export type Rect = { x: number; y: number; width: number; height: number };

/** The smallest rect covering every input, or null when there are none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
    if (!rects.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** A region argument as a Rect, or null when it is not four finite numbers with a positive size. */
export function parseRegion(value: unknown): Rect | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    const { x, y, width, height } = v;
    if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    if ((width as number) <= 0 || (height as number) <= 0) return null;
    return { x: x as number, y: y as number, width: width as number, height: height as number };
}
