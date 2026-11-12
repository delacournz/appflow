import { describe, expect, test } from 'bun:test';

import { badgeLine, badgeSnap, linkBadges, orphanBadges, slotDistance, type BadgeCandidate, type BadgeScreen } from './badge-link';
import type { Rect } from './rect';
import { ROUTE_ABOVE } from './screen-group';

const frame = (x: number, y: number): Rect => ({ x, y, width: 393, height: 852 });
const screen = (id: string, name: string, x: number, y: number): BadgeScreen => ({ id, name, rect: frame(x, y) });
const slotBadge = (id: string, name: string, f: Rect): BadgeCandidate => ({ id, name: `Badge · ${name}`, rect: { x: f.x + f.width - 60, y: f.y - ROUTE_ABOVE, width: 60, height: 20 } });

describe('linkBadges', () => {
    test('a badge in its own slot links by name and by position', () => {
        const s = screen('1', 'Email', 0, 1000);
        expect(linkBadges([s], [slotBadge('b1', 'Email', s.rect)]).get('1')).toBe('b1');
    });

    test('a badge left behind 600px away still links by exact name', () => {
        const s = screen('1', 'Email', 0, 1600);
        const left = slotBadge('b1', 'Email', frame(0, 1000));
        expect(linkBadges([s], [left]).get('1')).toBe('b1');
    });

    test('same-named badges: the one nearest the slot wins, each badge once', () => {
        const a = screen('a', 'Home', 0, 1000);
        const b = screen('b', 'Home', 2000, 1000);
        const ba = slotBadge('ba', 'Home', a.rect);
        const bb = slotBadge('bb', 'Home', b.rect);
        const m = linkBadges([a, b], [bb, ba]);
        expect(m.get('a')).toBe('ba');
        expect(m.get('b')).toBe('bb');
    });

    test('a renamed screen is matched by position when its badge is in the slot', () => {
        const s = screen('1', 'Email v2', 0, 1000);
        const old = slotBadge('b1', 'Email', s.rect);
        expect(linkBadges([s], [old]).get('1')).toBe('b1');
    });

    test('a renamed screen whose badge was left behind is not guessed', () => {
        const s = screen('1', 'Email v2', 0, 1600);
        expect(linkBadges([s], [slotBadge('b1', 'Email', frame(0, 1000))]).has('1')).toBe(false);
    });

    test('claimed badges and skipped screens are left alone', () => {
        const s = screen('1', 'Email', 0, 1000);
        const b = slotBadge('b1', 'Email', s.rect);
        expect(linkBadges([s], [b], new Set(['b1'])).size).toBe(0);
        expect(linkBadges([s], [b], new Set(), new Set(['1'])).size).toBe(0);
    });

    test('a name match is not stolen by another screen position match', () => {
        const a = screen('a', 'A', 0, 1000);
        const b = screen('b', 'B', 0, 1000);
        const m = linkBadges([a, b], [slotBadge('bb', 'B', b.rect), slotBadge('ba', 'A', a.rect)]);
        expect(m.get('a')).toBe('ba');
        expect(m.get('b')).toBe('bb');
    });
});

describe('slotDistance', () => {
    test('is zero for a badge exactly in the slot line', () => {
        const f = frame(0, 1000);
        expect(slotDistance(f, { x: f.x + f.width - 60, y: f.y - ROUTE_ABOVE - 0, width: 60, height: 20 })).toBe(10);
    });
});

describe('badgeSnap', () => {
    const f = frame(0, 2000);
    const route: Rect = { x: 0, y: 2000 - ROUTE_ABOVE, width: 200, height: 28 };
    const badge = (x: number, y: number): Rect => ({ x, y, width: 60, height: 20 });

    test('a badge left behind 600px away snaps back flush right, centred on the route line', () => {
        const d = badgeSnap(f, [route], badge(333, 1400), 60);
        expect(d).toEqual({ dx: 0, dy: route.y + 4 - 1400 });
    });
    test('a badge already in its slot needs no move', () => {
        expect(badgeSnap(f, [route], badge(333, route.y + 4), 60)).toBeNull();
    });
    test('a route line left behind is ignored; the frame-relative offset is used', () => {
        const stray: Rect = { x: 0, y: 1400, width: 200, height: 28 };
        expect(badgeLine(f, [stray])).toBeNull();
        expect(badgeSnap(f, [stray], badge(333, 0), 60)).toEqual({ dx: 0, dy: 2000 - 60 });
    });
});

describe('orphanBadges', () => {
    const board: Rect = { x: 0, y: 0, width: 5000, height: 5000 };
    const b = (id: string, x: number, y: number): BadgeCandidate => ({ id, name: `Badge · ${id}`, rect: { x, y, width: 60, height: 20 } });
    test('badges on the board that no screen points at are orphans', () => {
        expect(orphanBadges([b('a', 100, 100), b('b', 900, 100), b('c', 2000, 3000)], new Set(['b']), board)).toEqual(['a', 'c']);
    });
    test('badges off the board belong to someone else and are left alone', () => {
        expect(orphanBadges([b('far', 9000, 100)], new Set(), board)).toEqual([]);
    });
});
