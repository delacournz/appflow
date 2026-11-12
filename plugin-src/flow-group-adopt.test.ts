import { describe, expect, test } from 'bun:test';
import { planAdopt, type Candidate, type ScreenRect } from './flow-group-adopt';

const scr = (id: string, x: number, y: number): ScreenRect => ({ id, name: id, rect: { x, y, width: 100, height: 200 } });
const box = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Candidate> = {}): Candidate => ({
    id, type: 'RECTANGLE', name: 'Rectangle', rect: { x, y, width: w, height: h }, hasStroke: true, fillAlpha: 0, ...extra,
});
const text = (id: string, t: string, x: number, y: number, w = 100, h = 20): Candidate => ({
    id, type: 'TEXT', name: t, text: t, rect: { x, y, width: w, height: h }, hasStroke: false, fillAlpha: 1,
});
const heading = (id: string, name: string, x: number, y: number, w: number, h: number, t?: string): Candidate => ({
    id, type: 'INSTANCE', name, ...(t ? { text: t } : {}), rect: { x, y, width: w, height: h }, hasStroke: false, fillAlpha: 1,
});

describe('planAdopt boxes', () => {
    const screens = [scr('s1', 100, 100), scr('s2', 300, 100), scr('s3', 900, 100)];

    test('stroked empty box around screens with title above', () => {
        const r = planAdopt({ screens, candidates: [box('b1', 50, 50, 450, 300), text('t1', 'Login', 60, 10)] });
        expect(r.groups).toHaveLength(1);
        expect(r.groups[0]).toMatchObject({ name: 'Login', memberIds: ['s1', 's2'], sourceNodeIds: ['b1', 't1'] });
    });

    test('title inside top edge works, far text ignored', () => {
        const r = planAdopt({ screens, candidates: [box('b1', 50, 50, 450, 300), text('t1', 'Inside', 60, 55), text('far', 'Far', 60, -2000)] });
        expect(r.groups[0]?.name).toBe('Inside');
    });

    test('title must overlap horizontally', () => {
        const r = planAdopt({ screens, candidates: [box('b1', 50, 50, 450, 300), text('t1', 'Side', 2000, 10)] });
        expect(r.groups[0]?.name).toBe('Group 1');
    });

    test('filled, unstroked and non-containing boxes are not groups', () => {
        const r = planAdopt({
            screens,
            candidates: [box('f', 50, 50, 450, 300, { fillAlpha: 0.9 }), box('n', 50, 50, 450, 300, { hasStroke: false }), box('p', 150, 50, 100, 100)],
        });
        expect(r.groups).toHaveLength(0);
    });

    test('low alpha fill allowed', () => {
        expect(planAdopt({ screens, candidates: [box('b', 50, 50, 450, 300, { fillAlpha: 0.2 })] }).groups).toHaveLength(1);
    });

    test('screens and excluded layers are not boxes', () => {
        const r = planAdopt({
            screens,
            candidates: [box('s1', 100, 100, 100, 200, { type: 'FRAME' }), box('bg', 0, 0, 5000, 5000, { name: 'Board background · X' }), box('h', 0, 0, 5000, 5000, { type: 'FRAME', name: 'Flow groups · X' })],
        });
        expect(r.groups).toHaveLength(0);
    });

    test('nesting sets parentKey and innermost owns screens', () => {
        const r = planAdopt({
            screens,
            candidates: [box('outer', 40, 40, 1100, 400), box('inner', 80, 80, 250, 240), text('to', 'Outer', 50, 5), text('ti', 'Inner', 90, 50)],
        });
        const outer = r.groups.find((g) => g.name === 'Outer');
        const inner = r.groups.find((g) => g.name === 'Inner');
        expect(inner?.parentKey).toBe(outer?.key);
        expect(inner?.memberIds).toEqual(['s1']);
        expect(outer?.memberIds).toEqual(['s2', 's3']);
        expect(outer?.allMemberIds.sort()).toEqual(['s1', 's2', 's3']);
        expect(outer?.parentKey).toBeUndefined();
    });

    test('depth beyond one level is skipped', () => {
        const r = planAdopt({ screens: [scr('s1', 200, 200)], candidates: [box('a', 0, 0, 1000, 1000), box('b', 100, 100, 600, 600), box('c', 150, 150, 300, 400)] });
        expect(r.groups).toHaveLength(2);
        expect(r.skipped.some((s) => s.id === 'c' && /nest/i.test(s.reason))).toBe(true);
    });
});

describe('planAdopt section headings', () => {
    test('heading instance titles a box (text or name suffix)', () => {
        const r = planAdopt({
            screens: [scr('s1', 100, 100)],
            candidates: [box('b', 50, 50, 300, 300), heading('h', 'Section Heading · KYC', 50, 0, 300, 40)],
        });
        expect(r.groups[0]).toMatchObject({ name: 'KYC', sourceNodeIds: ['b', 'h'] });
        const r2 = planAdopt({
            screens: [scr('s1', 100, 100)],
            candidates: [box('b', 50, 50, 300, 300), heading('h', 'Section Heading', 50, 0, 300, 40, 'Real title')],
        });
        expect(r2.groups[0]?.name).toBe('Real title');
    });

    test('heading without box groups screens below until next heading', () => {
        const screens = [scr('a', 120, 400), scr('b', 400, 400), scr('c', 120, 2000), scr('out', 9000, 400), scr('above', 120, -500)];
        const r = planAdopt({
            screens,
            candidates: [heading('h1', 'Section Heading · Tabs', 100, 100, 1000, 100), heading('h2', 'Section Heading · KYC', 100, 1500, 1000, 100)],
        });
        const tabs = r.groups.find((g) => g.name === 'Tabs');
        const kyc = r.groups.find((g) => g.name === 'KYC');
        expect(tabs?.memberIds).toEqual(['a', 'b']);
        expect(kyc?.memberIds).toEqual(['c']);
        expect(tabs?.sourceNodeIds).toEqual(['h1']);
    });

    test('heading band skips screens already in boxes', () => {
        const r = planAdopt({
            screens: [scr('a', 120, 1000), scr('b', 400, 1000)],
            candidates: [box('bx', 100, 980, 200, 260), heading('h1', 'Section Heading · Tabs', 100, -100, 1000, 100)],
        });
        expect(r.groups.find((g) => g.name === 'Tabs')?.memberIds).toEqual(['b']);
    });

    test('empty heading band is skipped', () => {
        const r = planAdopt({ screens: [], candidates: [heading('h1', 'Section Heading · X', 100, 100, 1000, 100)] });
        expect(r.groups).toHaveLength(0);
        expect(r.skipped).toHaveLength(1);
    });
});
