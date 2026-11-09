/**
 * The group lift round (D-Q5, ticket 08): decided at placement, judged on the published result. The command runs once with no lift; the float
 * components are measured on its published model (`measureLifts`); each candidate, widest estimated gain first, runs the whole command once
 * more with the record as stage-1 band input (`LayoutOptions.fixedLifts`) and is kept only when its published result passes `judgeLift`.
 * At most `LIFT_TRIALS` trials per command (R4); each trial run has its own placement cap and shares the caller's one budget, so a deadline
 * ends the whole command and never picks a layout.
 */
import type { Diagnostic, GroupLift, LayoutModel } from '../model/index.js';
import { LIFT_AREA_TOLERANCE, LIFT_SIZE_CAP, LIFT_TRIALS, liftSize, liftEntry, measureLifts } from '../layout/lift.js';
import { judgeLift } from '../layout/lift-judge.js';
import type { LayoutOptions } from './options.js';
import { restoreLayoutModel } from '../layout/mutation.js';
import { serializeLayoutModel } from '../model/model.js';
import { isDeadlineError } from './deadline.js';
import { PlacementRefusal } from '../layout/placement-refusal.js';

/**
 * The lift decision of one command whose document has a float component in the first slice (`layoutOnce` runs any other document once,
 * with no record). The
 * no-lift run is the first baseline; a kept trial is the next. The tolerant area judge reads the no-lift run and the kept run with the least area. The published
 * model of the best run carries the command's whole record (a restore of its JSON with the record and the notes, so the record is validated).
 */
export async function decideLifts(document: LayoutModel['document'], options: LayoutOptions, run: (options: LayoutOptions) => Promise<LayoutModel>): Promise<LayoutModel> {
  let best = await run({ ...options, fixedLifts: [] });
  const noLift = best;
  let smallest = best;
  const areaOf = (m: LayoutModel): number => (m.canvas?.width ?? 0) * (m.canvas?.height ?? 0);
  const record: GroupLift[] = [], notes: Diagnostic[] = [], decided = new Set<string>();
  let trials = 0;
  const note = (code: string, message: string, entry: GroupLift, severity: Diagnostic['severity'] = 'info'): void => {
    notes.push({ stage: 'placement', severity, code, message, owners: entry.units.map(id => ({ kind: 'group' as const, id })) });
  };
  for (;;) {
    const candidate = measureLifts(best, decided)[0];
    if (candidate === undefined) break;
    for (const id of candidate.component.units) decided.add(id);
    const name = candidate.component.units.join(', ');
    if (candidate.offset === 0) {
      const entry = liftEntry(best, candidate, 0, candidate.reason!);
      record.push(entry);
      if (candidate.component.scope !== undefined) note('GROUP_LIFT_OUT_OF_SLICE', `The float component ${name} is not tried: ${candidate.reason}.`, entry);
      continue;
    }
    if (liftSize(document) > LIFT_SIZE_CAP) {
      const reason = `capped: the sheet has ${liftSize(document)} nodes and links, above the lift size cap of ${LIFT_SIZE_CAP}`;
      const entry = liftEntry(best, candidate, 0, reason);
      record.push(entry);
      note('GROUP_LIFT_SIZE_CAPPED', `The float component ${name} is not tried: the sheet has ${liftSize(document)} nodes and links, above the lift size cap of ${LIFT_SIZE_CAP}.`, entry);
      continue;
    }
    if (trials >= LIFT_TRIALS) {
      const entry = liftEntry(best, candidate, 0, `capped: the sheet has made its ${LIFT_TRIALS} lift trials`);
      record.push(entry);
      note('GROUP_LIFT_CAPPED', `The float component ${name} is not tried: the sheet has made its ${LIFT_TRIALS} lift trials.`, entry);
      continue;
    }
    trials++;
    let entry = liftEntry(best, candidate, candidate.offset, 'trial');
    // A trial whose run throws is declined: by name when placement refused it (`PlacementRefusal`), with a warning for any other error. A
    // deadline (the command's or a per-attempt timer of ELK or the router) ends the whole command (R4, `isDeadlineError`).
    let faulted = false;
    const attempt = async (tried: GroupLift): Promise<{ trial?: LayoutModel; reason?: string; verdict?: ReturnType<typeof judgeLift> }> => {
      let trial: LayoutModel | undefined;
      try { trial = await run({ ...options, fixedLifts: [...record, tried] }); } catch (error) {
        if (isDeadlineError(error)) throw error;
        if (!(error instanceof PlacementRefusal)) faulted = true;
        const reason = `the command ${error instanceof PlacementRefusal ? 'refused' : 'failed on'} it (${String((error as Error).message ?? error).slice(0, 240)})`;
        options.testLiftTrace?.({ entry: tried, routedBase: best, routedTrial: undefined, reason });
        return { reason };
      }
      const verdict = judgeLift(best, trial, new Set(tried.sideEntry ?? []), { noLift, smallest, T: LIFT_AREA_TOLERANCE });
      options.testLiftTrace?.({ entry: tried, routedBase: best, routedTrial: trial, reason: verdict.reason });
      return { trial, verdict, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) };
    };
    let { trial, reason, verdict } = await attempt(entry);
    // Choice S8: a declined side-entry rise falls back once to the best rise that keeps every feeder above its fed unit, inside the trial cap.
    if (reason !== undefined && candidate.fallback !== undefined && trials < LIFT_TRIALS) {
      trials++;
      const second = liftEntry(best, candidate, candidate.fallback, 'trial');
      const result = await attempt(second);
      if (result.reason === undefined) { entry = second; candidate.offset = candidate.fallback; ({ trial, reason, verdict } = result); }
      else reason = `${reason}; the fallback of ${candidate.fallback} band${candidate.fallback > 1 ? 's' : ''}: ${result.reason}`;
    }
    if (reason === undefined) {
      entry.straight = verdict!.straight;
      entry.reason = `rose ${candidate.offset} whole band${candidate.offset > 1 ? 's' : ''}${entry.push ? ` and pushed the units below band ${entry.push.at} down ${entry.push.by}` : ''}: canvas ${Math.round(verdict!.area[0])} to ${Math.round(verdict!.area[1])} px²${verdict!.tolerated ? ` (tolerated: narrower or nearer square, at most ${LIFT_AREA_TOLERANCE * 100} % above the smallest ${Math.round(areaOf(smallest))} px²)` : ''}`;
      record.push(entry);
      note('GROUP_LIFT_TAKEN', `The float component ${name} rises ${candidate.offset} whole band${candidate.offset > 1 ? 's' : ''}: canvas area ${Math.round(verdict!.area[0])} to ${Math.round(verdict!.area[1])} px².`, entry);
      best = trial!;
      if (areaOf(best) < areaOf(smallest)) smallest = best;
    } else {
      const declined = liftEntry(best, candidate, 0, `declined after a trial of ${candidate.offset} band${candidate.offset > 1 ? 's' : ''}${entry.sideEntry ? ` (side entries ${entry.sideEntry.join(', ')})` : ''}: ${reason}`);
      record.push(declined);
      note('GROUP_LIFT_DECLINED', `The float component ${name} does not rise ${candidate.offset} band${candidate.offset > 1 ? 's' : ''}: ${reason}.`, declined, faulted ? 'warning' : 'info');
    }
  }
  // The published geometry is the best run's; its record and notes become the command's (declined entries move no band).
  const copy = JSON.parse(serializeLayoutModel(best)) as LayoutModel;
  copy.groupLifts = record;
  copy.diagnostics.push(...notes);
  return restoreLayoutModel(JSON.stringify(copy));
}
