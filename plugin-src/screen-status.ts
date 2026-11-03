/** Pure helpers for screen build status and its badge. No `figma` global. */
import { parseBuildStatus, type BuildState, type BuildStatus, type Rgb } from './flowmeta';
import type { Rect } from './rect';

export type BadgeSpec = { text: string; fill: Rgb; textColor: Rgb };

const hex = (h: string): Rgb => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });

export const BADGE_SPECS: Record<BuildState, BadgeSpec> = {
    built: { text: 'Built', fill: hex('#1F9D55'), textColor: hex('#FFFFFF') },
    drift: { text: 'Drift', fill: hex('#E5A50A'), textColor: hex('#1A1A1A') },
    'not-built': { text: 'Not built', fill: hex('#3A3A3C'), textColor: hex('#A1A1A6') },
};

export const badgeName = (name: string): string => `Badge · ${name}`;

const MARKS: Record<BuildState, string> = { built: '✓', drift: '~', 'not-built': '·' };
export const statusMark = (s: BuildState): string => MARKS[s];

export const buildStatusOf = (build: BuildStatus | undefined): BuildStatus => build ?? { status: 'not-built' };

export type StatusInput = { status?: unknown; confidence?: unknown; commit?: unknown; notes?: unknown };

export type StatusResult = { ok: true; value: BuildStatus } | { ok: false; error: string };

const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Turns tool input into a stored status. Built needs a confidence; drift needs notes saying what differs. */
export function statusFromInput(input: StatusInput, now: string): StatusResult {
    const commit = optStr(input.commit);
    const notes = optStr(input.notes);
    switch (input.status) {
        case 'not-built':
            return { ok: true, value: { status: 'not-built' } };
        case 'built': {
            if (input.confidence !== 'static' && input.confidence !== 'runtime') return { ok: false, error: 'built needs confidence: "static" or "runtime".' };
            return { ok: true, value: { status: 'built', verifiedAt: now, commit, confidence: input.confidence, notes } };
        }
        case 'drift': {
            if (!notes) return { ok: false, error: 'drift needs notes listing what differs.' };
            const value: BuildStatus = { status: 'drift', verifiedAt: now, commit, notes };
            return parseBuildStatus(value) ? { ok: true, value } : { ok: false, error: 'Invalid drift status.' };
        }
        default:
            return { ok: false, error: `Unknown status ${JSON.stringify(input.status)}. Use "built", "drift" or "not-built".` };
    }
}

/** Top-left of the badge: right edge flush with the frame, centred on the label line (or the label offset above the frame). */
export function badgePosition(frame: Rect, label: Rect | null, labelOffset: number, badge: { width: number; height: number }): { x: number; y: number } {
    const x = frame.x + frame.width - badge.width;
    const y = label ? label.y + (label.height - badge.height) / 2 : frame.y - labelOffset;
    return { x, y };
}
