import type { LayoutRuntime, Rect } from '../model/index.js';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';
export interface GateViolation { code: string; elements: string[]; message: string }
export interface GateResult { passed: boolean; severity: 'error' | 'warning'; violations: GateViolation[] }
export interface ScoreMetrics {
  crossings: { value: number; count: number; routedLinks: number; ratio: number };
  bends: { value: number; mean: number; max: number; total: number };
  continuity: { value: number; eligible: number; alternating: number };
  compactness: { value: number; global: number; groups: Record<string, number> };
  gridAlignment: number;
  flow: { value: number; downward: number; eligible: number };
  aspectRatio: number;
  segmentUniformity: { value: number; mean: number; std: number; count: number };
  symmetry: number;
}
export interface ScoreCounters {
  overlaps: number; bundledLength: number; barCross: number; labelHits: number;
  labelsOmitted: number; stubs: number; removedLinks: number; groupLinks: number; lanesUsed: number;
  inversions: number; fallbackUsed: boolean; deadlineHit: boolean;
  /** The mesh buses drawn; present only when there is one, so a model without a bus keeps the counters it always had. */
  meshBuses?: number;
  /** The routed segments that cross a mesh bus riser (mesh-bus.md, section 11.5); no gate reads them. */
  riserCrossings?: number;
}
export interface ScoreAdvisory { metric: string; actual: number; target: number; relation: '<=' | '>=' }
export interface ScoreAssertion { code: 'golden-crossings' | 'baseline'; passed: boolean; actual: number; expected: number; tolerance: number }
export interface ScoreOptions { force?: boolean; golden?: boolean; baseline?: number }
export interface ScoreSnapshot {
  Q: number;
  passed: boolean;
  nodeCount: number;
  gates: Record<GateId, GateResult>;
  metrics: ScoreMetrics;
  counters: ScoreCounters;
  canvas: Rect | null;
  advisories: ScoreAdvisory[];
  assertions: ScoreAssertion[];
}
export interface ScoreReport { snapshot: ScoreSnapshot; runtime: LayoutRuntime }
