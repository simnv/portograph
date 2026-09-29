import type { LayoutModel } from '../model/index.js';
import { gates } from './gates.js';
import { EPS } from './geometry.js';
import { advisories, metrics, weightedScore } from './metrics.js';
import { segments, validate } from './model.js';
import type { ScoreAssertion, ScoreCounters, ScoreOptions, ScoreReport } from './types.js';

export type { GateId, GateResult, GateViolation, ScoreAdvisory, ScoreAssertion, ScoreCounters, ScoreMetrics, ScoreOptions, ScoreReport, ScoreSnapshot } from './types.js';

/** Validate and score final model geometry. Timings never participate in the snapshot or Q. */
export function score(layout: LayoutModel, options: ScoreOptions = {}): ScoreReport {
  const nodeCount = Object.keys(layout.nodes).length;
  if (nodeCount > 1000 && !options.force) throw new Error('Scoring more than 1000 nodes requires force: true (--force)');
  if (options.baseline !== undefined && (!Number.isFinite(options.baseline) || options.baseline < 0 || options.baseline > 1)) throw new Error('Approved baseline must be finite and within [0, 1]');
  validate(layout);
  const routed = segments(layout);
  const counters: ScoreCounters = {
    overlaps: 0, bundledLength: 0, barCross: 0, labelHits: 0, labelsOmitted: layout.labels.filter(l => l.omitted).length,
    stubs: layout.links.filter(l => l.technique === 'stub').length, removedLinks: layout.links.filter(l => l.removed === true).length, groupLinks: layout.groupLinks.length, lanesUsed: 0,
    inversions: layout.bundles.reduce((sum, b) => sum + (b.inversions ?? 0), 0), fallbackUsed: layout.fallbackUsed ?? false, deadlineHit: layout.deadlineHit ?? false,
  };
  const gateResults = gates(layout, routed, counters), values = metrics(layout, routed), Q = weightedScore(values);
  const finite = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value)
    : value !== null && typeof value === 'object' ? Object.values(value).every(finite) : true;
  if (!finite({ values, Q, counters })) throw new Error('Layout geometry exceeds the finite score range');
  const assertions: ScoreAssertion[] = [];
  if (options.golden) assertions.push({ code: 'golden-crossings', passed: values.crossings.count === 0, actual: values.crossings.count, expected: 0, tolerance: 0 });
  if (options.baseline !== undefined) assertions.push({ code: 'baseline', passed: Math.abs(Q - options.baseline) <= 0.05 + EPS, actual: Q, expected: options.baseline, tolerance: 0.05 });
  return {
    snapshot: { Q, passed: Object.values(gateResults).every(g => g.passed || g.severity === 'warning') && assertions.every(a => a.passed), nodeCount, gates: gateResults, metrics: values, counters, canvas: layout.canvas ? { ...layout.canvas } : null, advisories: advisories(values, nodeCount), assertions },
    runtime: { ...(layout.runtime.totalMs !== undefined ? { totalMs: layout.runtime.totalMs } : {}), stages: layout.runtime.stages.map(s => ({ ...s })) },
  };
}
