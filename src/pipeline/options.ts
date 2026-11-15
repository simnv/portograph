/** The options and progress events of `layout`: the public surface of the pipeline seam. */
import type { Course, Diagnostic, GroupLift, LayoutModel, LayoutStage, Size } from '../model/index.js';
import type { CreateElkAttempt, ElkClock } from '../layout/elk-worker.js';
import type { CreateRouteAttempt } from '../route/index.js';
import type { AttemptTraceEvent } from '../layout/placement-attempt.js';
import type { SideHints } from '../layout/side-hints.js';
import type { SideOffer } from '../layout/side-measure.js';
import type { judgeTrial } from '../layout/side-judge.js';
import type { Budget } from './budget.js';

export interface LayoutProgress {
  stage: LayoutStage;
  /** True for the stage of a side trial (its 7f and its route), which the command reports a second time. */
  trial?: true;
  /** Wall time this stage took, measured by the caller's clock. */
  durationMs: number;
  /** What the shared budget had left when the stage finished; `Infinity` when unbounded. */
  remainingMs: number;
}

export interface LayoutOptions {
  /**
   * Parse diagnostics, passed straight to `resolve`. Omitting them silently drops every source
   * path and warning the parser produced, so a CLI or any other orchestrator must pass them.
   */
  diagnostics?: readonly Diagnostic[];
  /** Stage 4. A Node caller passes `createNodeElkFactory()`; a browser caller the browser factory. */
  createElkAttempt?: CreateElkAttempt;
  /** Stage 8. Required only when the region rules leave a remainder. */
  createRouteAttempt?: CreateRouteAttempt;
  /** The command's one remaining-work budget. Every ELK attempt and the router draw from it. */
  budget?: Budget;
  /** Stage-4 policy ceiling; ADR-0006's node-count rule when omitted. */
  elkBudgetMs?: number;
  /** Stage-8 policy ceiling. */
  routeBudgetMs?: number;
  /** Stage 8 throws on a skipped required checkpoint instead of removing the link; for tests of the router's reservations. */
  strictCheckpoints?: boolean;
  /**
   * Test only. Every hit (or `'sampled'` for power-of-two hits `1, 2, 4, 8, ...` per cache and model) of a read cache keyed by object
   * identity (architecture-2 ticket 60) computes its answer again and throws on a difference. Its own option: `strictCheckpoints` changes
   * stage 8 and throws on 7 corpus sheets for reasons that are not the caches.
   */
  checkCaches?: boolean | 'all' | 'sampled';
  clock?: ElkClock;
  onProgress?: (progress: LayoutProgress) => void;
  /** Opt-in per-pass trace of the 7f placement attempt (pass, short model hash, verdict). Off by default; never written into the layout. */
  attemptTrace?: (event: AttemptTraceEvent) => void;
  /** Test only. Side hints for every placement run (port key to `left` or `right`); no measure offers one yet (ticket 115). */
  testSideHints?: SideHints;
  /** Test only: called after the side trial is judged, with the offer, the two routed models and the verdict. */
  testSideProbe?: (event: { offer: SideOffer; routedBase: LayoutModel; routedTrial: LayoutModel; verdict: ReturnType<typeof judgeTrial> }) => void;
  /** Test only. Stage-3 node size floors for every placement run: the sizes a measured run built its skeleton graph from (side-faces.md, Section 8). */
  testNodeFloors?: ReadonlyMap<string, Size>;
  /** Test only. Courses (ticket 15) for every placement run, before the course round has any say. */
  testCourses?: readonly Course[];
  /** Test only (architecture ticket 24, phase 2). `true` forces the turn order on every placement run: stage 5 orders the ports of a face by the planned first turn of their links. */
  testTurnOrder?: boolean;
  /** Test only (ticket 24): the links whose faces every placement run orders by their turns, and no other face (see `LayoutModel.turnLinks`). */
  testTurnLinks?: readonly string[];
  /** Test only. `false` skips the overlay round (ticket 15, phase 7): the overlay links keep the chord or the derived path they had before the rule of Q1. */
  testOverlayCourses?: boolean;
  /** Test only (architecture ticket 22, phase 2): the ids of the links that every placement run reserves as spanning chords, before the span round has any say. */
  testSpanHints?: readonly string[];
  /** Test only. Replaces `MAX_RERUNS` for one command. */
  testMaxReruns?: number;
  /** Test only. Called with the wall time of each placement run, measure, 7f, route and score-ready stage, and the budget left (ticket 115 timing). */
  testTiming?: (label: string, durationMs: number, remainingMs: number) => void;
  /** Test only (the side probe of ticket 117). Called with the offer, and with the trial and its verdict; it changes nothing. */
  /** Test only: rebuild the unmoved baseline even when the filter finds no offer (counts the filter's misses). */
  testRebuildAlways?: boolean;
  testSideTrace?: (event: Record<string, unknown>) => void;
  /** Internal (D-Q5): the lift record every placement run of this command applies; no lift is decided (the runs of `decideLifts`). */
  fixedLifts?: GroupLift[];
  /** Test only (D-Q5): no lift decision; the record stays absent (the no-lift drawing of a sheet). */
  testLiftOff?: boolean;
  /** Test only (D-Q5): each lift trial, with the published baseline and the published trial (undefined when the run refused it). */
  testLiftTrace?: (event: { entry: GroupLift; routedBase: LayoutModel; routedTrial: LayoutModel | undefined; reason: string | undefined }) => void;
}
