import { routeWidth } from './screen-group';

/**
 * Fixes a route text to one truncated line that stops short of the badge: fixed width, auto height, one line, ending
 * ellipsis. `badgeWidth` is null when the screen has no badge.
 */
export async function fitRoute(route: TextNode, frameWidth: number, badgeWidth: number | null): Promise<void> {
    if (route.characters.length) for (const f of route.getRangeAllFontNames(0, route.characters.length)) await figma.loadFontAsync(f);
    else if (route.fontName !== figma.mixed) await figma.loadFontAsync(route.fontName);
    route.textAutoResize = 'HEIGHT';
    route.resize(routeWidth(frameWidth, badgeWidth), route.height);
    route.maxLines = 1;
    route.textTruncation = 'ENDING';
}
