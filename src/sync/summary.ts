/** A sync plan as one short line per op: `+` create, `~` update, `?` Figma only, `-` removal. */
import type { SyncOp } from '../../shared/design-ops';
import type { SpecLetterSpacing, SpecLineHeight, TokenValue } from '../../shared/design-spec';
import type { RenameCandidate, SyncPlan } from './diff';

const value = (v: TokenValue | null): string => {
    if (v === null) return '∅';
    switch (v.kind) {
        case 'color':
            return v.hex;
        case 'alias':
            return `@${v.to}`;
        default:
            return String(v.value);
    }
};

const metric = (m: SpecLineHeight | SpecLetterSpacing): string => ('value' in m ? `${Math.round(m.value * 100) / 100}${m.unit === 'PERCENT' ? '%' : 'px'}` : 'auto');

export function describeOp(op: SyncOp): string {
    switch (op.op) {
        case 'create-collection':
            return `+ collection ${op.collection} [${op.modes.join(', ')}]`;
        case 'add-mode':
            return `+ mode ${op.collection}/${op.mode}`;
        case 'create-token':
            return `+ ${op.collection}/${op.token.name} = ${Object.values(op.token.values).map(value).join(' | ')}`;
        case 'update-token': {
            const parts = [
                ...(op.rename ? [`→ ${op.rename.to}`] : []),
                ...op.values.map((c) => `${c.mode}: ${value(c.from)} → ${value(c.to)}`),
                ...(op.codeId ? [`link ${op.codeId}`] : op.codeSyntax ? ['code syntax'] : []),
            ];
            const [first = '', ...rest] = parts;
            return `~ ${op.collection}/${op.name}${first.startsWith('→') ? ` ${first}` : `; ${first}`}${rest.map((p) => `; ${p}`).join('')}`;
        }
        case 'orphan-token':
            return `? ${op.collection}/${op.name} (Figma only)`;
        case 'create-text-style':
            return `+ text style ${op.style.name}: ${op.style.fontFamily} ${op.style.fontStyle} ${op.style.fontSize}`;
        case 'update-text-style': {
            const changes = op.changes.map((c) => {
                if (c.field === 'lineHeight' || c.field === 'letterSpacing') return `${c.field} ${metric(c.from)} → ${metric(c.to)}`;
                return `${c.field} ${c.from} → ${c.to}`;
            });
            const parts = [...(op.rename ? [`→ ${op.rename.to}`] : []), ...changes, ...(op.codeId ? [`link ${op.codeId}`] : [])];
            return `~ text style ${op.name}: ${parts.join('; ')}`;
        }
        case 'orphan-text-style':
            return `? text style ${op.name} (Figma only)`;
        case 'create-component':
            return `+ component ${op.component.name}`;
        case 'add-variant-axis':
            return `+ ${op.component} ${op.axis}=${op.options.join('|')} (existing: ${op.existing})`;
        case 'add-variant-option':
            return `+ ${op.component} ${op.axis}=${op.option}`;
        case 'orphan-variant-option':
            return `? ${op.component} ${op.axis}=${op.option} (Figma only)`;
        case 'orphan-variant-axis':
            return `? ${op.component} ${op.axis} (Figma only)`;
        case 'rename-variant': {
            const options = Object.entries(op.options).map(([a, b]) => `${a}→${b}`);
            return `~ ${op.component} ${op.axis}${op.to === op.axis ? '' : ` → ${op.to}`}${options.length ? ` (${options.join(', ')})` : ''}`;
        }
        case 'link-component':
            return `~ component ${op.component}: link ${op.codeId ?? ''}`.trim();
        case 'orphan-component':
            return `? component ${op.component} (Figma only)`;
        case 'style-component':
            return `~ ${op.component}: style ${Object.keys(op.styles.base).length + Object.values(op.styles.variants).reduce((n, o) => n + Object.keys(o).length, 0)} class groups${op.styles.unknown.length ? `; ${op.styles.unknown.length} classes not expressible` : ''}`;
    }
}

export type PlanSummary = { counts: SyncPlan['counts']; renameCandidates: RenameCandidate[]; ops: string[] };

export const summarizePlan = (plan: SyncPlan): PlanSummary => ({ counts: plan.counts, renameCandidates: plan.renameCandidates, ops: plan.ops.map(describeOp) });
