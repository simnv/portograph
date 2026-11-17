/**
 * Stages 1 to 7e: one placement run. Its one input is the reservation ledger; its one assertion is the placement budget.
 */
import type { Course, LayoutModel, LayoutStage, Side } from '../model/index.js';
import type { PairPitch } from '../model/layout.js';
import { addPairPitches } from '../layout/pair-pitch.js';
import { resolve } from '../resolve/index.js';
import { STEEP_PREMISE, unheldSteepBlocks } from '../layout/placement-inputs.js';
import { PostconditionRefusal } from '../layout/placement-refusal.js';
import { portKey, sidesOne } from '../layout/sides-one.js';
import { movesPort } from '../layout/course-rows.js';
import { sizeNodes } from '../layout/size.js';
import { skeleton } from '../layout/skeleton.js';
import { sidesTwo, type Arrange } from '../layout/sides-two.js';
import { rows } from '../layout/rows.js';
import { lanes } from '../layout/lanes.js';
import { flanks } from '../layout/flanks.js';
import { centre } from '../layout/centre.js';
import { bars } from '../layout/bars.js';
import { bundles } from '../layout/bundles.js';
import { elkDeadlineMs } from '../layout/elk-worker.js';
import { attemptCounters } from '../layout/attempt-counters.js';
import { farEndOrderOf, pairFloorsOf, pitchFloorsOf, nodeFloorsOf, coursesOf, declinedStaggersOf, declinedTrunksOf, laneKeysOf, sideHintsOf, spansOf, turnOf, type Reservations } from '../layout/reservations.js';
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
  // The original rounds have MAX_RERUNS + 1 placements; ticket 83 adds at most one failed probe per named block.
  // Every started run stays counted. The probes preserve the legacy optimisation allowance when a block is declined.
  env.placements++; attemptCounters.placeStarts++;
  // A placement of an exempt trial stands outside the cap: it is credited as it starts, before the check (`env.exemptPlacing`).
  if (env.exemptPlacing) env.gateRuns++;
  // The placements of the fan-wrap acceptance gate's comparison run are outside the cap as well (`env.gateRuns`).
  if (env.placements - env.blockProbes - env.gateRuns - env.farEndRuns > env.placeCap) throw new PlacementBudgetExceeded(env.placements - 1);
  const stepIn = <T>(stage: LayoutStage, run: () => T): T => { abort?.(stage); return env.step(stage, run); };
  // The trunk joins a placement run found blocked (mesh-bus.md, section 12.4) are declined in the next: the ledger names them, or all of them once the budget is spent.
  const declinedTrunks = declinedTrunksOf(reservations);
  const resolved = stepIn('resolve', () => resolve(env.document, { ...(env.declinedSolidBlocks ? { declinedSolidBlocks: env.declinedSolidBlocks } : {}), ...(env.options.diagnostics ? { diagnostics: env.options.diagnostics } : {}), ...(declinedTrunks.size || declinedTrunks.all ? { declinedTrunks } : {}), ...(env.groupLifts !== undefined ? { groupLifts: env.groupLifts } : {}) }));
  resolved.reservations = JSON.parse(JSON.stringify(reservations)) as Reservations;
  // A stagger the ledger declines stands one line in this run, with its reason (dense-16x9 ticket 22, review 2): the record is read, not decided again.
  const declinedStaggers = declinedStaggersOf(reservations);
  const staggerRows = env.staggerRows?.filter(row => !declinedStaggers.has(row.group));
  if (staggerRows?.length) resolved.staggerRows = JSON.parse(JSON.stringify(staggerRows)) as typeof staggerRows;
  if (env.flatBlockGaps?.length) resolved.flatBlockGaps = JSON.parse(JSON.stringify(env.flatBlockGaps)) as typeof env.flatBlockGaps;
  if (env.steepBlocks?.length) resolved.steepBlocks = [...env.steepBlocks];
  if (env.blockBoxPads?.length) resolved.blockBoxPads = JSON.parse(JSON.stringify(env.blockBoxPads)) as typeof env.blockBoxPads;
  if (env.blockRowGaps?.length) resolved.blockRowGaps = JSON.parse(JSON.stringify(env.blockRowGaps)) as typeof env.blockRowGaps;
  if (env.groupArrangements !== undefined) {
    resolved.groupArrangements = JSON.parse(JSON.stringify(env.groupArrangements)) as typeof env.groupArrangements;
    // A row a later placement refused takes the ledger's sentence. A row the acceptance gate declined keeps the record the gate wrote, which
    // points at FAN_WRAP_DECLINED (dense-16x9 ticket 35): the note reads the same entry.
    for (const [group, { clause, reason }] of declinedStaggers) {
      if (clause === 'later-placement') resolved.groupArrangements![group] = { chosen: 'row', reason: `a later placement refused the two lines: ${reason}` };
    }
  }
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
  if (resolved.turnOrder === true && turn.except.length > 0) resolved.turnExcept = [...turn.except];
  // The far-end orders the ledger reserves (ticket 07): stage 5 seats those faces in them, in place of the order of the far ends as they stand then.
  const farEnd = farEndOrderOf(reservations);
  if (farEnd.length > 0) resolved.farEndOrder = farEnd;
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
  // The neighbour-pair floors of the fans (dense-16x9 ticket 04): sizing reads their sum, the installers each pair.
  for (const [id, faces] of pairFloorsOf(reservations)) for (const [side, entries] of Object.entries(faces) as ['top' | 'bottom', PairPitch[]][]) {
    addPairPitches(resolved.nodes[id]!, side, entries);
  }
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
  env.arrangedRows = [];
  const arrange: Arrange = env.arranged ? { mode: 'keep' } : { mode: 'decide', declined: env.declinedArrangements ?? new Map() };
  let model = stepIn('sides-two', () => sidesTwo(resolved, nodeFloors.size > 0 ? nodeFloors : undefined, arrange));
  // The groups stage 5 of this run chose itself (tickets 51 and 52): its staggers (not rows the width-budget search gave) and its columns.
  env.arrangedRows = arrange.mode === 'decide' && model.groupArrangements !== undefined
    ? [...(env.staggerRows?.length ? [] : (model.staggerRows ?? []).map(row => row.group)),
      ...Object.keys(model.groupArrangements).filter(id => model.groupArrangements![id]!.chosen === 'column').sort()] : [];
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
  // The premise of the input `steepBlocks` (dense-16x9 ticket 29, review 2): every block it names stands recorded under the cap in this run, or the
  // leg pitch stage 6 reserved for it promised an angle the block does not hold. The run is refused by name (a producer refusal): a trial withdraws,
  // and the leg-pitch rounds of `initial.ts` drop the named blocks from the input.
  const unheld = unheldSteepBlocks(model);
  if (unheld.length) throw new PostconditionRefusal('bundles', unheld.map(family => ({ kind: STEEP_PREMISE, subject: family, detail: 'the leg pitch was reserved at the 34 degree angle and the block is not recorded under the cap' })));
  return model;
}
