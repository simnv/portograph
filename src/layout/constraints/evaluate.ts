import type { LayoutModel } from '../../model/layout.js';
import { ownerId, type Constraint, type FindingClass, type Residual, type Term } from './types.js';

/** Residuals under this size (px) are float noise of the placement stages, as `PLACEMENT_EPS` is. */
export const RESIDUAL_TOLERANCE = 0.01;

/** The x a term reads in a layout; `undefined` when its owner is absent from it. */
export function termValue(model: LayoutModel, term: Term): number | undefined {
  if (term.at === 'fixed') return term.offset;
  if (term.at === 'group') {
    const x = model.groups[term.owner]?.bounds?.x;
    return x === undefined ? undefined : x + term.offset;
  }
  const box = model.frames?.find(frame => frame.id === term.owner)?.box;
  if (!box) return undefined;
  return (term.at === 'frame-left' ? box.x : box.x + box.width) + term.offset;
}

/**
 * Why a violated entry is a legacy exception: the layout itself declares the case, with a warning that names an owner of the entry.
 * Only diagnostics the pipeline raised count; the evaluator invents no exception.
 */
function declared(model: LayoutModel, constraint: Constraint): string | undefined {
  const owners = new Set(constraint.owners);
  for (const item of model.diagnostics) {
    if (item.severity === 'info' || !item.owners?.some(owner => owners.has(ownerId(owner) ?? ''))) continue;
    if (item.code.startsWith('COLUMN_AXIS') || item.code.startsWith('STRAIGHT_LINK') || item.code.startsWith('GROUP_GRID')) return item.code;
  }
  return undefined;
}

/** The class of a violated hard entry. Soft entries are measured, not classified. */
export function classify(model: LayoutModel, constraint: Constraint): { class: FindingClass; reason?: string | undefined } {
  if (constraint.support === 'unsupported') return { class: 'unsupported', reason: constraint.note };
  const legacy = declared(model, constraint);
  if (legacy !== undefined) return { class: 'legacy-exception', reason: `the layout declares ${legacy} for an owner` };
  if (constraint.contract === 'translation') return { class: 'translation-error', reason: constraint.note };
  return { class: 'invariant-violation', reason: constraint.source };
}

/** Signed residuals of the catalogue on a layout. Direct arithmetic at today's coordinates: no solver. */
export function evaluate(model: LayoutModel, catalogue: readonly Constraint[]): Residual[] {
  return catalogue.map((constraint): Residual => {
    if (constraint.support === 'unsupported' || !constraint.a || !constraint.b) {
      return { constraint, violated: false, class: 'unsupported', reason: constraint.note };
    }
    const a = termValue(model, constraint.a), b = termValue(model, constraint.b);
    if (a === undefined || b === undefined) return { constraint, violated: false, class: 'unsupported', reason: 'an owner is absent from this layout' };
    const residual = b - a - constraint.bound;
    if (constraint.strength === 'soft') return { constraint, residual, violated: false };
    if (residual >= -RESIDUAL_TOLERANCE) return { constraint, residual, violated: false };
    return { constraint, residual, violated: true, ...classify(model, constraint) };
  });
}

export interface Summary {
  /** Entries by `kind`, then by class (`ok`, a finding class, `soft`). */
  byKind: Record<string, Record<string, number>>;
  /** Sum of |residual| in px by soft kind, and the count of entries straight to within half a pixel. */
  soft: Record<string, { entries: number; total: number; straight: number }>;
}

export function summarise(residuals: readonly Residual[]): Summary {
  const byKind: Summary['byKind'] = {}, soft: Summary['soft'] = {};
  for (const item of residuals) {
    const row = (byKind[item.constraint.kind] ??= {});
    const label = item.class ?? (item.constraint.strength === 'soft' ? 'soft' : item.violated ? 'violated' : 'ok');
    row[label] = (row[label] ?? 0) + 1;
    if (item.constraint.strength === 'soft' && item.residual !== undefined) {
      const bucket = (soft[item.constraint.kind] ??= { entries: 0, total: 0, straight: 0 });
      bucket.entries++;
      bucket.total += Math.abs(item.residual);
      if (Math.abs(item.residual) < 0.5) bucket.straight++;
    }
  }
  return { byKind, soft };
}
