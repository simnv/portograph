/**
 * Producer postconditions of stages 7e and 7f (DR-11, D-Q3; ADR-0010).
 *
 * The callbacks of `bundles` and `bands` are empty: their producers run after the rule checks of the transaction, so those checks never see what
 * the producers write. This module judges the producer output instead. It reads the net draft after every dependent rebuild and before commit,
 * against the entry model of the transaction, with the shared predicates in their absolute form (no move is proposed). Publication and restore
 * stay the second boundary.
 *
 * A finding names the reservation kind it breaks. The transient kinds (`move-reservations.ts`) are read as "no worse than at entry", because a
 * transaction cannot be blamed for a breach that stood before it; the stored ledger is read through `holds`. No check reads a diagnostic (R5).
 */
import type { LayoutModel } from '../model/layout.js';
import { riserNoDeeper, riserPenetrations, sideLaneFindings, spanBreaches, validateLanes } from './lanes.js';
import { foreignOverExtensions, trunkHeads } from './trunk.js';
import { blockedChords } from './frame-paths.js';
import { holds } from './reservation-checks.js';
import { groupExitViolations, missingGroupExits } from './group-exit-check.js';

/**
 * The kinds a postcondition reads. `laneSide` is the lanes clear of every occupied box and no group across a lane it stood beside; `frozenChord`
 * a frozen chord newly blocked; `groupExit` a reserved exit broken by a box, or a required exit missing; `stored` a ledger entry newly failed.
 */
export type PostconditionKind = 'riserKeepOut' | 'trunkExtension' | 'laneSide' | 'frozenChord' | 'sideAlignment' | 'spanCorridor' | 'groupExit' | 'stored';

export interface PostconditionViolation {
  rule: 'bundles' | 'bands';
  kind: PostconditionKind;
  /** The group, lane, link or ledger entry the finding is about. */
  subject: string;
  detail: string;
}

/** Test and measurement only: called with every violation of every judged transaction. Unset in production. */
export const postconditionSink: { hook?: (violation: PostconditionViolation) => void } = {};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Every violation of the net draft `after` of `rule`, against the entry model `before`. A check that cannot read its input is a violation (R6). */
export function postconditionViolations(before: LayoutModel, after: LayoutModel, rule: 'bundles' | 'bands'): PostconditionViolation[] {
  const out: PostconditionViolation[] = [];
  const add = (kind: PostconditionKind, subject: string, detail: string): void => { out.push({ rule, kind, subject, detail }); };
  const attempt = (kind: PostconditionKind, run: () => void): void => {
    try { run(); } catch (error) { add(kind, 'check', `the check could not read the draft: ${message(error)}`); }
  };
  // Riser keep-out: no routed port stands deeper in a riser keep-out than it stood at entry.
  attempt('riserKeepOut', () => {
    if (!(after.meshBuses ?? []).some(bus => bus.riser !== undefined && bus.cross !== undefined)) return;
    for (const group of Object.values(after.groups)) {
      const was = before.groups[group.id];
      if (group.bounds === undefined || was?.bounds === undefined) continue;
      if (!riserNoDeeper(riserPenetrations(before, was), riserPenetrations(after, group))) add('riserKeepOut', group.id, `a port of ${group.id} stands deeper in a riser keep-out than at entry`);
    }
  });
  // Trunk extension: no foreign unit stands across a bar extension it did not stand across at entry.
  attempt('trunkExtension', () => {
    const was = new Map(trunkHeads(before).map(head => [head.id, new Set(foreignOverExtensions(before, head).map(item => `${item.group}|${item.bus}`))]));
    for (const head of trunkHeads(after)) for (const item of foreignOverExtensions(after, head)) {
      if (!was.get(head.id)?.has(`${item.group}|${item.bus}`)) add('trunkExtension', item.group, `${item.group} stands across the bar extension ${item.bus} of ${head.id}`);
    }
  });
  // Lane sides: the lanes stand clear of every occupied box, and no group changed side of a lane it stood beside at entry and stands beside now.
  attempt('laneSide', () => {
    try { validateLanes(after); } catch (error) { add('laneSide', 'lanes', message(error)); }
    const beside = (box: { y: number; height: number }, lane: { bounds: { y: number; height: number } }): boolean => box.y < lane.bounds.y + lane.bounds.height && lane.bounds.y < box.y + box.height;
    const straddles = (box: { x: number; width: number }, x: number): boolean => box.x < x && x < box.x + box.width;
    for (const lane of after.lanes) {
      const old = before.lanes.find(item => item.id === lane.id);
      if (old === undefined) continue;
      for (const group of Object.values(after.groups)) {
        const was = before.groups[group.id]?.bounds, now = group.bounds;
        if (was === undefined || now === undefined || group.id === lane.group) continue;
        if (!beside(was, old) || !beside(now, lane) || straddles(was, old.x) || straddles(now, lane.x)) continue;
        if ((was.x + was.width / 2 >= old.x) !== (now.x + now.width / 2 >= lane.x)) add('laneSide', group.id, `${group.id} changed side of lane ${lane.id}`);
      }
    }
  });
  // Frozen chords: no frozen chord is blocked that was clear at entry.
  attempt('frozenChord', () => {
    const was = new Set(blockedChords(before));
    for (const id of blockedChords(after)) if (!was.has(id)) add('frozenChord', id, `the frozen chord ${id} is blocked and was clear at entry`);
  });
  // Side alignment: no new side-lane finding (the far port of a seated side lane off its lane, a lane inside a frame).
  attempt('sideAlignment', () => {
    const key = (item: { code: string; owners?: readonly object[] }): string => `${item.code}|${JSON.stringify(item.owners ?? [])}`;
    const was = new Set(sideLaneFindings(before).map(key));
    for (const item of sideLaneFindings(after)) if (!was.has(key(item))) add('sideAlignment', key(item), `${item.code}: ${item.message}`);
  });
  // Span corridor: no wall stands in a span corridor that did not stand in it at entry.
  attempt('spanCorridor', () => {
    const was = spanBreaches(before);
    for (const key of spanBreaches(after)) if (!was.has(key)) add('spanCorridor', key, `a wall stands in the span corridor: ${key}`);
  });
  // Group exit: every reserved exit holds on the boxes of the draft, and every required exit is reserved unless the geometry blocks it.
  attempt('groupExit', () => {
    for (const item of groupExitViolations(after)) add('groupExit', `${item.link}:${item.end}`, `the exit ${item.link}:${item.end} is broken (${item.why}${item.box === undefined ? '' : ` by ${item.box}`})`);
    for (const item of missingGroupExits(after)) add('groupExit', `${item.link}:${item.end}`, `the exit ${item.link}:${item.end} is required, free and not reserved`);
  });
  // Stored kinds: no ledger entry fails that held at entry.
  attempt('stored', () => {
    const was = new Set(holds(before.reservations ?? [], before).map(item => item.id));
    for (const failure of holds(after.reservations ?? [], after)) if (!was.has(failure.id)) add('stored', `${failure.kind}:${failure.id}`, failure.why);
  });
  return out;
}

/** Judge the net draft of 7e or 7f before commit. Every violation goes to the sink; none refuses yet (DR-11, step 1: output neutral). */
export function judgePostconditions(before: LayoutModel, after: LayoutModel, rule: 'bundles' | 'bands'): void {
  for (const violation of postconditionViolations(before, after, rule)) postconditionSink.hook?.(violation);
}
