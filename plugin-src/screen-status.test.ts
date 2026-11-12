import { describe, expect, test } from 'bun:test';

import { parseBuildStatus, type BuildStatus } from './flowmeta';
import { BADGE_SPECS, badgeName, badgePosition, buildStatusOf, statusFromBadgeText, statusFromInput, statusMark } from './screen-status';

const NOW = '2026-11-03T00:00:00.000Z';

describe('parseBuildStatus', () => {
    test('accepts each status', () => {
        const all: BuildStatus[] = [
            { status: 'not-built' },
            { status: 'built', verifiedAt: NOW, commit: 'abc1234', confidence: 'runtime', notes: null },
            { status: 'drift', verifiedAt: NOW, commit: null, notes: 'Title copy differs' },
        ];
        for (const s of all) expect(parseBuildStatus(s)).toEqual(s);
    });
    test('rejects bad shapes', () => {
        expect(parseBuildStatus(null)).toBeNull();
        expect(parseBuildStatus({ status: 'done' })).toBeNull();
        expect(parseBuildStatus({ status: 'built', verifiedAt: NOW, commit: null, confidence: 'guess', notes: null })).toBeNull();
        expect(parseBuildStatus({ status: 'built', commit: null, confidence: 'static', notes: null })).toBeNull();
        expect(parseBuildStatus({ status: 'drift', verifiedAt: NOW, commit: null, notes: '' })).toBeNull();
    });
});

describe('statusFromInput', () => {
    test('built needs a confidence', () => {
        expect(statusFromInput({ status: 'built' }, NOW)).toEqual({ ok: false, error: 'built needs confidence: "static" or "runtime".' });
        expect(statusFromInput({ status: 'built', confidence: 'runtime', commit: 'abc' }, NOW)).toEqual({
            ok: true,
            value: { status: 'built', verifiedAt: NOW, commit: 'abc', confidence: 'runtime', notes: null },
        });
    });
    test('drift needs notes', () => {
        expect(statusFromInput({ status: 'drift' }, NOW)).toEqual({ ok: false, error: 'drift needs notes listing what differs.' });
        expect(statusFromInput({ status: 'drift', notes: 'Button colour' }, NOW)).toEqual({
            ok: true,
            value: { status: 'drift', verifiedAt: NOW, commit: null, notes: 'Button colour' },
        });
    });
    test('not-built ignores the rest', () => {
        expect(statusFromInput({ status: 'not-built', notes: 'x' }, NOW)).toEqual({ ok: true, value: { status: 'not-built' } });
    });
    test('unknown status', () => {
        expect(statusFromInput({ status: 'shipped' }, NOW)).toMatchObject({ ok: false });
    });
});

describe('badge helpers', () => {
    test('name', () => expect(badgeName('Verified')).toBe('Badge · Verified'));
    test('specs for every status', () => {
        expect(BADGE_SPECS.built.text).toBe('Built');
        expect(BADGE_SPECS.drift.text).toBe('Drift');
        expect(BADGE_SPECS['not-built'].text).toBe('Not built');
    });
    test('marks', () => {
        expect(statusMark('built')).toBe('✓');
        expect(statusMark('drift')).toBe('~');
        expect(statusMark('not-built')).toBe('·');
    });
    test('missing build data reads as not built', () => {
        expect(buildStatusOf(undefined)).toEqual({ status: 'not-built' });
    });
    test('right-aligned to the frame and centred on the label line', () => {
        const frame = { x: 100, y: 1000, width: 393, height: 852 };
        const label = { x: 100, y: 920, width: 200, height: 24 };
        expect(badgePosition(frame, label, 80, { width: 60, height: 20 })).toEqual({ x: 433, y: 922 });
    });
    test('without a label it uses the label offset', () => {
        const frame = { x: 100, y: 1000, width: 393, height: 852 };
        expect(badgePosition(frame, null, 80, { width: 60, height: 20 })).toEqual({ x: 433, y: 920 });
    });
});

describe('statusFromBadgeText', () => {
    test('a Built or Drift badge is recovered as that status, marked as recovered', () => {
        expect(statusFromBadgeText('Built', NOW)).toEqual({ status: 'built', verifiedAt: NOW, commit: null, confidence: 'static', notes: 'Recovered from the badge; verify again.' });
        expect(statusFromBadgeText('Drift', NOW)).toEqual({ status: 'drift', verifiedAt: NOW, commit: null, notes: 'Recovered from the badge; verify again.' });
    });
    test('Not built and unknown text give nothing to recover', () => {
        expect(statusFromBadgeText('Not built', NOW)).toBeNull();
        expect(statusFromBadgeText('???', NOW)).toBeNull();
    });
});
