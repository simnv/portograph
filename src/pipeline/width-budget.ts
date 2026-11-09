/** Automatic row selection under a published canvas width budget (ticket 166). */
import type { Diagnostic, LayoutModel, StaggerRow } from '../model/layout.js';
import type { NormalisedDocument } from '../model/document.js';
import type { LayoutOptions } from './options.js';
import { score } from '../score/index.js';
import { staggerCandidates } from '../layout/stagger.js';
import { restoreLayoutModel } from '../layout/mutation.js';
import { PLACEMENT_EPS } from '../layout/tolerance.js';
import { pathBends } from '../layout/objective.js';
import { isDeadlineError } from './deadline.js';

type Run = (document: NormalisedDocument, options: LayoutOptions, rows?: StaggerRow[]) => Promise<LayoutModel>;

/** A staggered member's routed links are complete vertical drops, including through the near line. */
function straightDrops(model: LayoutModel): boolean {
  const members = new Set((model.staggerRows ?? []).flatMap(row => row.order));
  return model.links.filter(link => link.layer === 'routed' && link.attachments
    && [link.attachments.from.node, link.attachments.to.node].some(id => members.has(id)))
    .every(link => link.removed !== true && link.path !== undefined && link.path.segments.length > 0
      && pathBends(link) === 0
      && link.path.segments.every(segment => Math.abs(segment.from.x - segment.to.x) <= PLACEMENT_EPS));
}

export async function fitWidthBudget(input: NormalisedDocument, options: LayoutOptions, run: Run): Promise<LayoutModel> {
  const budget = input.layout!.maxWidth!;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('layout.maxWidth must be positive and finite');
  // An operational input: already-fitting output has the exact normal document projection too.
  const document: NormalisedDocument = { ...input, layout: { ...input.layout } };
  delete document.layout!.maxWidth;
  if (Object.keys(document.layout!).length === 0) delete document.layout;
  let best = await run(document, options);
  if (best.canvas!.width <= budget) return best;
  // The group lift (D-Q5) is decided once, by the first run; every stagger trial applies its record (`fixedLifts`) and decides none, so a
  // command runs at most 1 + LIFT_TRIALS lift runs and then one run per stagger trial. The lift notes of the first run stay the command's.
  const first = best;
  const trialOptions: LayoutOptions = first.groupLifts !== undefined ? { ...options, fixedLifts: first.groupLifts } : options;
  const liftNotes = first.diagnostics.filter(note => note.code.startsWith('GROUP_LIFT_'));
  const notes: Diagnostic[] = [];
  const tried = new Set<string>();
  // Each normal row is visited once, widest first. This finite traversal bounds the complete pipeline trials.
  for (;;) {
    const row = staggerCandidates(best).find(row => !tried.has(row.group));
    if (row === undefined) break;
    tried.add(row.group);
    let trial: LayoutModel;
    try { trial = await run(document, trialOptions, [...(best.staggerRows ?? []), row]); }
    catch (error) {
      // A deadline ends the command; it never chooses which geometry to publish (R4).
      if (isDeadlineError(error)) throw error;
      notes.push({ stage: 'placement', severity: 'warning', code: 'ROW_STAGGER_REFUSED', owners: [{ kind: 'group', id: row.group }],
        message: `The stagger trial was refused: ${String(error)}` });
      continue;
    }
    const report = score(trial).snapshot;
    const failed = Object.entries(report.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);
    if (trial.canvas!.width >= best.canvas!.width - PLACEMENT_EPS || report.counters.removedLinks > 0
      || failed.length > 0 || !straightDrops(trial)) {
      notes.push({ stage: 'placement', severity: 'info', code: 'ROW_STAGGER_REFUSED', owners: [{ kind: 'group', id: row.group }],
        message: `The stagger trial was refused: width ${trial.canvas!.width.toFixed(2)} px; failed gates ${failed.join(', ') || 'none'}; removed ${report.counters.removedLinks}; vertical drops ${straightDrops(trial)}.` });
      continue;
    }
    best = trial;
    if (best.canvas!.width <= budget) break;
  }
  if (best.canvas!.width > budget) notes.push({ stage: 'placement', severity: 'warning', code: 'WIDTH_BUDGET_UNMET',
    message: `The narrowest valid result tried is ${best.canvas!.width.toFixed(2)} px wide; the width budget is ${budget} px.` });
  if (best !== first) notes.unshift(...liftNotes);
  return notes.length === 0 ? best : restoreLayoutModel(JSON.stringify({ ...best, diagnostics: [...best.diagnostics, ...notes] }));
}
