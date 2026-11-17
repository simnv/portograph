/**
 * The first placement run and the state the rounds start from. The ledger starts with what the test options force; a trunk join that the run finds blocked is declined by one
 * re-run, which shares `MAX_RERUNS` (mesh-bus.md, section 12.4).
 */
import type { LayoutModel } from '../model/index.js';
import type { BlockBoxPad, BlockRowGap } from '../model/layout.js';
import { SolidBlockRefusal, TrunkBlocked, producerRefusal } from '../layout/placement-refusal.js';
import { FAN_WRAP_DECLINED, placedExtent, staggerRefusal, staggerTrigger, wrapGateDecline, type GateDecline } from '../layout/stagger.js';
import { aspectAim, aspectGap } from '../layout/aspect.js';
import { ASPECT_EPS } from '../layout/tolerance.js';
import { EPS } from '../geometry/planar.js';
import { blockBoxPadsAsked, blockRowGapsAsked, blockRoomBound, roomShort } from '../layout/block-pads.js';

/** The placements the block box paddings may spend per command (R4): each reads the paddings of the one before (`blockBoxPadsAsked`). */
import type { Diagnostic } from '../model/index.js';
import { nodeFloors as floorEntries, reserve as addReservations, courseEntries, declinedTrunksOf, declineStagger, declineTrunk, sideFaces, spanEntries, turnEntries, type Reservations } from '../layout/reservations.js';
import type { Env } from './env.js';
import { restoreLayoutModel } from '../layout/mutation.js';
import type { State } from './state.js';

/** A 7f trial that ran on a placement: the placement and what the trial gave (a refusal is an `Error`). */
export interface RanTrial { model: LayoutModel; banded: LayoutModel | Error }
/**
 * The 7f trial of `model` taken from one that ran already (dense-16x9 ticket 21): a 7f trial reads the placed model alone, so a trial that
 * ran on the same model object, frozen since, gave what a new one gives. A refusal reads as no banded model, as `trial` returns it.
 * `undefined` when the trial must run: no trial ran, it ran on another model, or the model is not frozen.
 */
export function takenTrial(ran: RanTrial | undefined, model: LayoutModel): { banded: LayoutModel | undefined } | undefined {
  if (ran === undefined || ran.model !== model || !Object.isFrozen(model)) return undefined;
  return { banded: ran.banded instanceof Error ? undefined : ran.banded };
}

export async function firstState(env: Env): Promise<State> {
  const options = env.options;
// D-Q5: a lift trial run (and the no-lift run, with `[]`) applies its lift record from the first placement on.
if (options.fixedLifts !== undefined) env.groupLifts = JSON.parse(JSON.stringify(options.fixedLifts)) as typeof options.fixedLifts;
// A fan of chords whose neighbours stand closer than the chord clearance is spread by placement, not found by routing (ticket 89):
// the placed chords say the pitch each face needs, and placement runs again with those floors until no face needs more.
let first!: LayoutModel;
// What every placement run is told to keep: the test's node floors first, then what the rounds keep.
let kept: Reservations = [...floorEntries(options.testNodeFloors ?? new Map(), 'initial', 0), ...sideFaces(options.testSideHints ?? new Map(), new Map(), 'initial', 0),
  // The courses every placement run reserves (ticket 15): the test's, or the ones the course round keeps.
  ...courseEntries(options.testCourses ?? [], undefined, 'initial', 0),
  // The links every placement run reserves as spanning chords (ticket 22): the test's, or the ones the span round keeps.
  ...spanEntries(options.testSpanHints ?? [], 'initial', 0),
  // Whether every placement run orders the ports of a face by the planned first turn (ticket 24): forced by the test option, or set by a kept turn round.
  ...turnEntries(options.testTurnOrder === true, options.testTurnLinks ?? [], false, 'initial', 0, options.testTurnExcept ?? [])];
// A trunk with no admissible side is declined by one placement re-run, which shares `MAX_RERUNS` (mesh-bus.md, section 12.4).
const placeFirst = async (): Promise<void> => {
for (;;) {
  // The last run the budget allows declines every trunk, so that it cannot be blocked and no run past the budget is needed.
  if (env.reruns >= env.maxReruns) kept = addReservations(kept, declineTrunk(undefined, 'the placement budget is spent', env.placements));
  // Likewise it chooses no stagger (ticket 51): it keeps the rows it is given and records nothing, so no stagger can refuse it.
  if (env.reruns >= env.maxReruns) {
    env.arranged = true;
  }
  try { first = await env.timed('place', () => env.place(kept)); break; } catch (error) {
    if (error instanceof SolidBlockRefusal) {
      // Every failed probe excludes at least one new named block. The finite candidate set
      // bounds retries; unrelated accepted blocks never lose ownership to a wildcard.
      if ([...error.blocks.keys()].every(id => env.declinedSolidBlocks?.has(id))) throw error;
      env.declinedSolidBlocks = new Map([...(env.declinedSolidBlocks ?? []), ...error.blocks]);
      // A probe inside an exempt trial is that trial's credit already (`Env.exemptPlacing`, the one owner rule): it is not credited again.
      if (!env.exemptPlacing) env.blockProbes++;
      continue;
    }
    // A stagger stage 5 chose that a later stage of the same run cannot keep (ticket 51): the next attempt keeps those rows one line and
    // records why. Each attempt declines at least one group, so the attempts end; they share `MAX_RERUNS`.
    if (staggerRefusal(error) && env.arrangedRows?.length) {
      // The refused groups when the refusal names them, else every row the attempt chose.
      const named = env.arrangedRows.filter(group => error.owners.some(owner => owner.kind === 'group' && owner.id === group));
      // A refusal that names only groups stage 5 did not choose (a row the width-budget search gave) is not this run's choice: it stands.
      if (!named.length && error.owners.some(owner => owner.kind === 'group')) throw error;
      const declined = named.length ? named : env.arrangedRows;
      env.declinedArrangements = new Map([...(env.declinedArrangements ?? []), ...declined.map(group => [group, error.message] as const)]);
      env.reruns++;
      continue;
    }
    if (!(error instanceof TrunkBlocked) || declinedTrunksOf(kept).has(error.key)) throw error;
    kept = addReservations(kept, declineTrunk(error.key, error.why, env.placements));
    env.reruns++;
    options.testSideTrace?.({ ev: 'trunk-blocked', key: error.key, reruns: env.reruns, left: env.maxReruns - env.reruns });
  }
}
};
await placeFirst();
// The acceptance gate of the staggers stage 5 chose (fan wrap, D-Q4; ADR-0024, second amendment; dense-16x9 ticket 22): each row is judged on
// its own, greedy in the stage-5 order (widest first). A row keeps its two lines only when the complete placement with it beats the placement
// with the rows kept so far (`wrapGateDecline`: nearer the aspect aim, or less area at an equal gap; no more planned bends; no link held
// straight at the 7f trial of the placement lost, a reading of the trial, not of the published sheet (dense-16x9 ticket 35); no separation shorter; a fan wrap, the block trigger, keeps the area rule of D-Q4: less area). Each trial is a placement of the first run's choice in keep mode with only those rows staggered (every other chosen row a `row`),
// and its 7f run as a trial: the same publication checks as every placement. A stagger refusal or a producer refusal (DR-11) of a trial
// declines that row by name, never thrown. The trials spend no `MAX_RERUNS` (`env.exemptPlacing`: `env.gateRuns` lifts the cap by their placements), so the
// gate is always available; the state (the ledger, the declined blocks, the re-run count) of the run it keeps is the state the command goes on
// with. With N chosen rows the gate costs one plain placement plus at most N row trials: the trial of every chosen row together is the first
// run itself.
const chosen = (first.staggerRows ?? []).map(row => row.group)
  .filter(group => (env.arrangedRows ?? []).includes(group) && first.groupArrangements?.[group]?.chosen === 'stagger');
const gateNotes: Diagnostic[] = [];
/** The last 7f trial of this function and its placement: first the one the stagger gate ran on the placement it kept (dense-16x9 ticket 21). */
let ran: RanTrial | undefined;
if (chosen.length) {
  type Snapshot = { [K in 'declinedSolidBlocks' | 'arranged' | 'staggerRows' | 'groupArrangements' | 'arrangedRows' | 'declinedArrangements']: Env[K] | undefined }
    & Pick<Env, 'blockProbes' | 'reruns'> & { kept: Reservations };
  const snapshot = (): Snapshot => ({ kept, declinedSolidBlocks: env.declinedSolidBlocks, blockProbes: env.blockProbes, reruns: env.reruns, arranged: env.arranged,
    staggerRows: env.staggerRows, groupArrangements: env.groupArrangements, arrangedRows: env.arrangedRows, declinedArrangements: env.declinedArrangements });
  const restore = (state: Snapshot): void => {
    kept = state.kept; env.blockProbes = state.blockProbes; env.reruns = state.reruns;
    if (state.declinedSolidBlocks === undefined) delete env.declinedSolidBlocks; else env.declinedSolidBlocks = state.declinedSolidBlocks;
    if (state.arranged === undefined) delete env.arranged; else env.arranged = state.arranged;
    if (state.staggerRows === undefined) delete env.staggerRows; else env.staggerRows = state.staggerRows;
    if (state.groupArrangements === undefined) delete env.groupArrangements; else env.groupArrangements = state.groupArrangements;
    if (state.arrangedRows === undefined) delete env.arrangedRows; else env.arrangedRows = state.arrangedRows;
    if (state.declinedArrangements === undefined) delete env.declinedArrangements; else env.declinedArrangements = state.declinedArrangements;
  };
  // A stagger refusal or a producer refusal in 7f declines the trial's lines by name: every model here is a trial. Any other error (a deadline
  // included) ends the command.
  const banded = async (model: LayoutModel): Promise<LayoutModel | Error> => {
    try { return (await env.bands(model, true)).model; } catch (error) { if (staggerRefusal(error) || producerRefusal(error)) return error; throw error; }
  };
  interface Trial { rows: readonly string[]; model: LayoutModel; banded: LayoutModel | Error; state: Snapshot }
  const saved = snapshot(), rowsOf = new Map(first.staggerRows!.map(row => [row.group, row])), record = first.groupArrangements!;
  const declined = `the acceptance gate declined the two lines (${FAN_WRAP_DECLINED} names why)`;
  const whole: Trial = { rows: chosen, model: first, banded: await banded(first), state: saved };
  /** The first run's choice placed again with only `rows` staggered. A placement refusal of the lines is the trial's answer, not an error. */
  const placeWith = async (rows: readonly string[]): Promise<Trial | Error> => {
    restore(saved);
    const own = JSON.parse(JSON.stringify(record)) as NonNullable<LayoutModel['groupArrangements']>;
    for (const id of chosen) if (!rows.includes(id)) own[id] = { chosen: 'row', reason: declined };
    env.arranged = true; env.groupArrangements = own;
    if (rows.length) env.staggerRows = JSON.parse(JSON.stringify(rows.map(id => rowsOf.get(id)!))) as NonNullable<Env['staggerRows']>; else delete env.staggerRows;
    if (env.declinedSolidBlocks !== undefined) env.declinedSolidBlocks = new Map(env.declinedSolidBlocks);
    // Every placement of a trial (one, or more when a trunk join or a block is declined) stays counted in `placements` and is lifted from the
    // cap as it starts (`env.exemptPlacing`), so the rounds after the gate have the placements they would have had without it (R4: one count).
    env.exemptPlacing = (env.exemptPlacing ?? 0) + 1;
    try { await placeFirst(); } catch (error) {
      if (rows.length && (staggerRefusal(error) || producerRefusal(error))) return error as Error;
      throw error;
    } finally { env.exemptPlacing--; }
    return { rows, model: first, banded: await banded(first), state: snapshot() };
  };
  // The placement without any of the chosen rows: the first baseline. A refusal in its 7f leaves the lines the only placement that stands.
  let best = await placeWith([]) as Trial;
  const keep: string[] = [], declines: { id: string; decline: GateDecline }[] = [];
  for (const id of chosen) {
    const rows = [...keep, id], trial = rows.length === chosen.length ? whole : await placeWith(rows);
    const decline: GateDecline | undefined = trial instanceof Error ? { clause: 'placement', text: `the placement refused them: ${trial.message}` }
      : trial.banded instanceof Error ? { clause: 'trial', text: `7f refused them: ${trial.banded.message}` }
      : best.banded instanceof Error ? undefined : wrapGateDecline(trial.banded, best.banded, staggerTrigger(rowsOf.get(id)!));
    if (decline !== undefined) { declines.push({ id, decline }); continue; }
    keep.push(id); best = trial as Trial;
  }
  restore(best.state); first = best.model;
  // Every decline of the gate is in the ledger, with its clause and the links it names (`staggerDeclined`, dense-16x9 ticket 35): every later run
  // reads it, none decides the row again, the checks table holds it (`RESERVATION_CHECKS`), and publication names it (`FAN_WRAP_DECLINED`).
  // The kept placement carries the same entries, as the replay of a refused chord does (`refuseCrowdedChords`): the published ledger holds every
  // decline, and the restore checks it. Its geometry is the kept trial's, so the gate's 7f trial of it stands (`takenTrial`).
  const entries = declines.flatMap(({ id, decline }) => declineStagger(id, decline.text, decline.clause, 'initial', env.placements, decline.links));
  if (entries.length) {
    kept = addReservations(kept, entries);
    first = restoreLayoutModel(JSON.stringify({ ...best.model, reservations: addReservations(best.model.reservations ?? [], entries) }));
    // The stage-3 sizes are keyed by the placed model object (`movedFloor`): the copy keys the same sizes, or a round's floors would read none.
    const sizes = env.stage3Sizes.get(best.model);
    if (sizes !== undefined) env.stage3Sizes.set(first, sizes);
  }
  ran = { model: first, banded: best.banded };
}
// Stage 5 of this run chose each group's arrangement (ticket 51). Every later placement run of the command keeps that choice, not a new one,
// also when this run chose nothing.
env.arranged = true;
if (first.groupArrangements !== undefined) {
  env.groupArrangements = JSON.parse(JSON.stringify(first.groupArrangements)) as typeof first.groupArrangements;
  if (first.staggerRows !== undefined) env.staggerRows = JSON.parse(JSON.stringify(first.staggerRows)) as typeof first.staggerRows;
}
// The gap of every flat solid block (dense-16x9 ticket 04, slice 3; ADR-0025, amendment of 2026-11-16) is chosen on the complete placement.
// The first run placed every flat gap at its floor (the densest sheet). Its 7f trial gives the placed extent W x H (`placedExtent`, the
// extent the stagger gate reads; no routing pass); the sheet wants the height W / aim. The flat gaps share max(0, W / aim - H) equally,
// each clamped to [its floor, its 34 degree demand], and one more placement stands at those gaps. It is kept only when its 7f trial stands
// nearer the aim than the floor placement (the width can move); else the floor stands. Bound (R4): one placement more per command for all
// flat blocks together, outside the placement cap as the gate trials are (`env.gateRuns`), and two 7f trials.
// A 7f trial reads the placed model alone. A trial of the model the last trial ran on (the placement the stagger gate kept, whose trial the
// gate ran, or the last room placement, which the gap choice reads again) takes that result and does not run again (`takenTrial`, dense-16x9
// ticket 21); a refusal there is the refusal here. The room rounds and the gap choice read this one trial.
const trial = async (model: LayoutModel): Promise<LayoutModel | undefined> => {
  const taken = takenTrial(ran, model);
  if (taken !== undefined) return taken.banded;
  let banded: LayoutModel | Error;
  try { banded = (await env.bands(model, true)).model; } catch (error) { if (staggerRefusal(error) || producerRefusal(error)) banded = error as Error; else throw error; }
  ran = { model, banded };
  return banded instanceof Error ? undefined : banded;
};
// The room of the flat block members (dense-16x9 ticket 04, slice 3, step 2): the side padding of each box a member would leave through a
// corner (`blockBoxPadsAsked`) and the row gap beside an end node whose neighbour reaches past the face (`blockRowGapsAsked`), read on the 7f
// trial of the complete placement at each member's angle at the block's floor, and placed again with them as placement inputs
// (`env.blockBoxPads`, `env.blockRowGaps`). A placement with more room moves the members, so the next trial reads them again; the records only
// grow. The placement with the room stands whatever its aspect: it buys the members' straight chords (ADR-0025, amendment of 2026-11-17).
// The rounds run to the fixed point: a trial that asks for no more than the records hold. Bound (R4): one placement per flat member at most
// (`blockRoomBound`), outside the placement cap (`env.exemptPlacing`); the trial after the last placement is read too, and a room still short
// there is named (`BLOCK_ROOM_UNSETTLED`, R6). A refused placement keeps the one before it (`BLOCK_ROOM_REFUSED`).
const describe = (pads: readonly BlockBoxPad[], gaps: readonly BlockRowGap[]): string => [...pads.map(item => `${item.box} ${item.side} side ${item.pad.toFixed(2)} px`),
  ...gaps.map(item => `${item.left} to ${item.right} gap ${item.gap.toFixed(2)} px`)].join(', ');
if ((first.blockReservations ?? []).some(record => record.mode === 'flat')) {
  // The bound is read once, when a reading first asks for room (a sheet that asks none needs none).
  let bound: number | undefined;
  for (let round = 0; ; round++) {
    const placed = await trial(first);
    if (placed === undefined) break;
    const asked = blockBoxPadsAsked(placed), gaps = blockRowGapsAsked(placed);
    const short = roomShort(asked, gaps, env.blockBoxPads ?? [], env.blockRowGaps ?? []);
    if (!short.length) break;
    bound ??= options.testBlockRoomBound ?? blockRoomBound(first);
    if (round >= bound) {
      gateNotes.push({ stage: 'placement', severity: 'warning', code: 'BLOCK_ROOM_UNSETTLED', owners: short.flatMap(item => item.owners),
        message: `The room of the flat block members did not settle in ${bound} placements: ${short.map(item => item.text).join(', ')} still short; the members it would hold may fall back.` });
      break;
    }
    const saved = { kept, declinedSolidBlocks: env.declinedSolidBlocks, blockProbes: env.blockProbes, reruns: env.reruns, model: first, pads: env.blockBoxPads, gaps: env.blockRowGaps };
    if (asked.length) env.blockBoxPads = asked;
    if (gaps.length) env.blockRowGaps = gaps;
    if (env.declinedSolidBlocks !== undefined) env.declinedSolidBlocks = new Map(env.declinedSolidBlocks);
    let refused: string | undefined;
    // Each placement of the round, its retries included, is credited outside the cap as it starts (`env.exemptPlacing`).
    env.exemptPlacing = (env.exemptPlacing ?? 0) + 1;
    try { await placeFirst(); } catch (error) {
      if (!(staggerRefusal(error) || producerRefusal(error))) throw error;
      refused = (error as Error).message;
    } finally { env.exemptPlacing--; }
    if (refused !== undefined) {
      kept = saved.kept; env.blockProbes = saved.blockProbes; env.reruns = saved.reruns; first = saved.model;
      if (saved.declinedSolidBlocks === undefined) delete env.declinedSolidBlocks; else env.declinedSolidBlocks = saved.declinedSolidBlocks;
      if (saved.pads === undefined) delete env.blockBoxPads; else env.blockBoxPads = saved.pads;
      if (saved.gaps === undefined) delete env.blockRowGaps; else env.blockRowGaps = saved.gaps;
      gateNotes.push({ stage: 'placement', severity: 'warning', code: 'BLOCK_ROOM_REFUSED', owners: [],
        message: `The placement with the block reservations ${describe(asked, gaps)} was refused (${refused}); the placement before it stands.` });
      break;
    }
    // One note names the room that stands: a later round replaces it.
    for (let at = gateNotes.length - 1; at >= 0; at--) if (gateNotes[at]!.code === 'BLOCK_ROOM') gateNotes.splice(at, 1);
    gateNotes.push({ stage: 'placement', severity: 'info', code: 'BLOCK_ROOM', owners: [],
      message: `The flat block members take room: ${describe(asked, gaps)}.` });
  }
}
const flat = (first.blockReservations ?? []).filter(record => record.mode === 'flat');
if (flat.length) {
  const floorBanded = await trial(first), floorBox = floorBanded === undefined ? undefined : placedExtent(floorBanded);
  const aim = aspectAim(env.document);
  let extra = floorBox === undefined ? 0 : Math.max(0, floorBox.width / aim - floorBox.height);
  // Each flat tier gap: its floor (the gap the floor placement holds) and its room up to the largest 34 degree demand of its flat blocks.
  const room = new Map<number, number>();
  for (const record of flat) room.set(record.below, Math.max(room.get(record.below) ?? 0, record.target - record.chosen));
  const open = [...room].filter(([, value]) => value > EPS).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const share = new Map<number, number>();
  for (const [index, [below, value]] of open.entries()) {
    const part = Math.min(value, extra / (open.length - index));
    share.set(below, part); extra -= part;
  }
  if ([...share.values()].some(value => value > EPS)) {
    const saved = { kept, declinedSolidBlocks: env.declinedSolidBlocks, blockProbes: env.blockProbes, reruns: env.reruns, floor: first };
    env.flatBlockGaps = flat.map(record => ({ family: record.family, gap: record.chosen + (share.get(record.below) ?? 0) }));
    if (env.declinedSolidBlocks !== undefined) env.declinedSolidBlocks = new Map(env.declinedSolidBlocks);
    let refused: string | undefined;
    // Every placement of the trial, its retries included, is credited outside the cap as it starts (`env.exemptPlacing`), before `place`
    // checks the cap: a command that spent its allowance before still has this trial (R4; review 1, finding 2).
    env.exemptPlacing = (env.exemptPlacing ?? 0) + 1;
    try { await placeFirst(); } catch (error) {
      if (!(staggerRefusal(error) || producerRefusal(error))) throw error;
      refused = (error as Error).message;
    } finally { env.exemptPlacing--; }
    const chosenBanded = refused === undefined ? await trial(first) : undefined, chosenBox = chosenBanded === undefined ? undefined : placedExtent(chosenBanded);
    const nearer = floorBox !== undefined && chosenBox !== undefined
      && aspectGap(chosenBox.width, chosenBox.height, aim) < aspectGap(floorBox.width, floorBox.height, aim) - ASPECT_EPS;
    if (!nearer) {
      kept = saved.kept; env.blockProbes = saved.blockProbes; env.reruns = saved.reruns; first = saved.floor; delete env.flatBlockGaps;
      if (saved.declinedSolidBlocks === undefined) delete env.declinedSolidBlocks; else env.declinedSolidBlocks = saved.declinedSolidBlocks;
      gateNotes.push({ stage: 'placement', severity: 'info', code: 'FLAT_BLOCK_GAP_FLOOR', owners: [],
        message: `The flat solid blocks keep their floor gaps: the placement at the aspect gaps ${refused !== undefined ? `was refused (${refused})` : 'stands no nearer the aspect aim'}.` });
    } else {
      gateNotes.push({ stage: 'placement', severity: 'info', code: 'FLAT_BLOCK_GAP_CHOSEN', owners: [],
        message: `The flat solid blocks take the aspect gaps: ${env.flatBlockGaps.map(item => `${item.family} ${item.gap.toFixed(2)} px`).join(', ')}.` });
    }
  }
}
return { kept7e: first, base: first, baseMoved: false, kept, cuts: [], sideNotes: [], keptNotes: gateNotes, promised: new Map(), refused: new Set(), trialLinks: new Map(), silent: false, sideRound: 0, unmovedRebuilt: false };
}
