/**
 * Stages 1 to 7e: one placement run. Its one input is the reservation ledger; its one assertion is the placement budget.
 */
import type { Course, LayoutModel, LayoutStage, Side } from '../model/index.js';
import { resolve } from '../resolve/index.js';
import { portKey, sidesOne } from '../layout/sides-one.js';
import { movesPort } from '../layout/course-rows.js';
import { sizeNodes } from '../layout/size.js';
import { skeleton } from '../layout/skeleton.js';
import { sidesTwo } from '../layout/sides-two.js';
import { rows } from '../layout/rows.js';
import { lanes } from '../layout/lanes.js';
import { flanks } from '../layout/flanks.js';
import { centre } from '../layout/centre.js';
import { bars } from '../layout/bars.js';
import { bundles } from '../layout/bundles.js';
import { elkDeadlineMs } from '../layout/elk-worker.js';
import { attemptCounters } from '../layout/attempt-counters.js';
import { pitchFloorsOf, nodeFloorsOf, coursesOf, declinedTrunksOf, laneKeysOf, sideHintsOf, spansOf, turnOf, type Reservations } from '../layout/reservations.js';
import { countStage, ledgerOn, ledgerSnapshot, startPlacementEntry, type LedgerSnapshot } from '../layout/attempt-ledger.js';
import { CommandDeadlineError } from './budget.js';
import { PlacementBudgetExceeded } from './limits.js';
import type { Env } from './env.js';

/**
 * Stages 1 to 7e, the placement the chords are decided on before 7f grows a gap, and so the placement a fan is measured on. Its one input is the ledger
 * (`src/layout/reservations.ts`): the pitch and node floors, side faces, lane owners, courses, spanning chords, turn order and declined trunks the run must keep, written on the
 * model it returns. `abort` is the deadline check of a trial; it reserves nothing.
 */
export async function place(env: Env, reservations: Reservations, abort?: (stage: string) => void): Promise<LayoutModel> {
  // The one assertion of the placement budget: a command places at most MAX_RERUNS + 1 times (the first run and the re-runs), whatever round asks. A slot is released
  // only before a run starts; a run that has started is spent, even when stage 7a refuses it at once, so `placements` never goes down.
  env.placements++; attemptCounters.placeStarts++;
  if (env.placements > env.placeCap) throw new PlacementBudgetExceeded(env.placements - 1);
  const stepIn = <T>(stage: LayoutStage, run: () => T): T => { abort?.(stage); return env.step(stage, run); };
  // The trunk joins a placement run found blocked (mesh-bus.md, section 12.4) are declined in the next: the ledger names them, or all of them once the budget is spent.
  const declinedTrunks = declinedTrunksOf(reservations);
  const resolved = stepIn('resolve', () => resolve(env.document, { ...(env.options.diagnostics ? { diagnostics: env.options.diagnostics } : {}), ...(declinedTrunks.size || declinedTrunks.all ? { declinedTrunks } : {}) }));
  resolved.reservations = JSON.parse(JSON.stringify(reservations)) as Reservations;
  if (env.staggerRows?.length) resolved.staggerRows = JSON.parse(JSON.stringify(env.staggerRows)) as typeof env.staggerRows;
  const courses = coursesOf(reservations), spans = spansOf(reservations);
  // A course face ranks above a hint (ticket 15): each end that does not keep its natural face names the port and the face.
  const courseFaces = new Map<string, Side>();
  for (const course of courses) {
    const link = resolved.links.find(item => item.id === course.link);
    for (const which of ['from', 'to'] as const) {
      const ref = link?.attachments?.[which] ?? link?.[which];
      if (ref !== undefined && 'ordinal' in ref && movesPort(course, which)) courseFaces.set(portKey(ref), course[which].face);
    }
  }
  for (const link of resolved.links) if (spans.has(link.id)) link.spanHint = true;
  const turn = turnOf(reservations);
  if (turn.all) resolved.turnOrder = true;
  else if (turn.links.length > 0) { resolved.turnOrder = true; resolved.turnLinks = [...turn.links]; }
  const hints = sideHintsOf(reservations), laneKeys = laneKeysOf(reservations);
  stepIn('sides-one', () => sidesOne(resolved, hints, laneKeys, courseFaces));
  if (courses.length) resolved.courses = JSON.parse(JSON.stringify(courses)) as Course[];
  // An approach (ticket 15, phase 6) is stored on the link and in its course; the port keeps its side.
  for (const course of courses) {
    const link = resolved.links.find(item => item.id === course.link);
    if (link === undefined) continue;
    for (const which of ['from', 'to'] as const) {
      const approach = course[which].approach;
      if (approach !== undefined) link.approach = { ...link.approach, [which]: approach };
    }
  }
  for (const [id, pitch] of pitchFloorsOf(reservations)) resolved.nodes[id]!.sidePitch = { ...resolved.nodes[id]!.sidePitch, ...pitch };
  // A hinted node keeps the size the measured run gave it, so the skeleton input is the same (a floor on `size`, not on `sizeFloor`, which alignment reads).
  const nodeFloors = nodeFloorsOf(reservations);
  for (const [id, size] of nodeFloors) resolved.nodes[id]!.size = { ...size };
  stepIn('size', () => sizeNodes(resolved));
  const sizes = new Map(Object.entries(resolved.nodes).map(([id, node]) => [id, { ...node.size! }] as const));

  abort?.('skeleton');
  if (env.budget.remainingMs() <= 0) throw new CommandDeadlineError(0, 'skeleton');
  const skeletonStarted = env.now();
  await skeleton(resolved, {
    ...(env.options.createElkAttempt ? { createAttempt: env.options.createElkAttempt } : {}),
    ...(env.clock ? { clock: env.clock } : {}),
    layoutBudgetMs: env.options.elkBudgetMs ?? elkDeadlineMs(Object.keys(resolved.nodes).length),
    budget: env.budget,
  });
  env.report('skeleton', skeletonStarted);

  // sidesTwo freezes port topology and publishes the first protected snapshot; every region rule
  // below returns a new one, and the previous value must not be used again.
  attemptCounters.placeRuns++;
  // The ledger reads the routed chords and the straight overlay links after each stage, only when a test or the trace asked for it.
  const ledger = ledgerOn(env.options.attemptTrace !== undefined);
  let model = stepIn('sides-two', () => sidesTwo(resolved, nodeFloors.size > 0 ? nodeFloors : undefined));
  let seen: LedgerSnapshot | undefined = ledger ? ledgerSnapshot(model) : undefined;
  const entry = ledger ? startPlacementEntry() : undefined;
  const account = (stage: string): void => { if (seen === undefined || entry === undefined) return; const now = ledgerSnapshot(model); countStage(stage, seen, now, entry); seen = now; };
  model = stepIn('rows', () => rows(model)); account('rows');
  model = stepIn('lanes', () => lanes(model)); account('lanes');
  model = stepIn('flanks', () => flanks(model)); account('flanks');
  model = stepIn('centre', () => centre(model)); account('centre');
  model = stepIn('bars', () => bars(model)); account('bars');
  model = stepIn('bundles', () => bundles(model)); account('bundles');
  env.stage3Sizes.set(model, sizes);
  return model;
}
