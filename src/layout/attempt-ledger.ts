import type { LayoutModel } from '../model/layout.js';
import { attemptCounters, type AttemptEntry, type PlacementEntry } from './attempt-counters.js';
import { blockedChords, isRoutedChord } from './frame-paths.js';
import { drawnOverlays, read } from './objective.js';

/**
 * The readers behind the invalidation counters of `attempt-counters.ts` (architecture ticket 13, phase 1). A snapshot is the set of routed chords,
 * the straight overlay links and the aligned routed links the model holds now; the difference of two snapshots is what a step lost and gained.
 * Every read here costs a pass over the links, so a caller asks `ledgerOn` first and reads nothing when it is off. Nothing here writes the model.
 */
export interface LedgerSnapshot {
  chords: ReadonlySet<string>;
  overlay: ReadonlySet<string>;
  aligned: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
}

/** Whether the invalidations that need a read of the model are counted: a test turned the ledger on, or a trace was asked for. */
export const ledgerOn = (traced: boolean): boolean => attemptCounters.ledger || traced;

export function ledgerSnapshot(model: LayoutModel): LedgerSnapshot {
  return {
    chords: new Set(model.links.filter(link => isRoutedChord(model, link)).map(link => link.id)),
    overlay: read(model, { overlays: drawnOverlays(model) }).overlay.straightIds ?? new Set(),
    aligned: read(model, { routed: { straight: 'aligned' } }).routed.straightIds ?? new Set(),
    blocked: new Set(blockedChords(model)),
  };
}

const missingFrom = (before: ReadonlySet<string>, after: ReadonlySet<string>): string[] => [...before].filter(id => !after.has(id));

/** What a step of 7f changed: the links it lost and the ones it gained. */
export function ledgerStep(before: LedgerSnapshot, after: LedgerSnapshot): { overlayLost: string[]; overlayGained: string[]; alignedLost: string[]; newlyBlocked: string[] } {
  return { overlayLost: missingFrom(before.overlay, after.overlay), overlayGained: missingFrom(after.overlay, before.overlay),
    alignedLost: missingFrom(before.aligned, after.aligned), newlyBlocked: missingFrom(after.blocked, before.blocked) };
}

/** Adds one 7f step to the counters and to the entry of the attempt, and gives the trace verdict that names it. */
export function countStep(before: LedgerSnapshot, after: LedgerSnapshot, entry: AttemptEntry): string {
  const step = ledgerStep(before, after), counts = attemptCounters.invalidations;
  counts.overlayStraightLost += step.overlayLost.length; counts.overlayStraightGained += step.overlayGained.length;
  counts.routedAlignedLost += step.alignedLost.length; counts.bodyOnFrozenChord += step.newlyBlocked.length;
  entry.overlayLost += step.overlayLost.length; entry.overlayGained += step.overlayGained.length;
  entry.alignedLost += step.alignedLost.length; entry.bodiesOnFrozenChord += step.newlyBlocked.length;
  return `overlay -${step.overlayLost.length}/+${step.overlayGained.length} aligned -${step.alignedLost.length} blocked +${step.newlyBlocked.length}`;
}

/** A new entry of the attempt log, for the run that starts now. */
export function startAttemptEntry(): AttemptEntry {
  const entry: AttemptEntry = { rounds: 0, openRounds: 0, chordRoundsMoved: 0, overlayLost: 0, overlayGained: 0, alignedLost: 0, bodiesOnFrozenChord: 0 };
  attemptCounters.attemptLog.push(entry);
  return entry;
}
/** A new entry of the placement log, for the run that starts now. */
export function startPlacementEntry(): PlacementEntry {
  const entry: PlacementEntry = { chordsLost: 0, overlayLost: 0, overlayGained: 0, centreOverlayLost: 0, centreOverlayGained: 0 };
  attemptCounters.placements.push(entry);
  return entry;
}

/** The same for one stage of 7a to 7e: the routed chords and the straight overlay links it lost and gained. */
export function countStage(stage: string, before: LedgerSnapshot, after: LedgerSnapshot, entry: PlacementEntry): void {
  const counts = attemptCounters.invalidations;
  const chords = missingFrom(before.chords, after.chords).length, lost = missingFrom(before.overlay, after.overlay).length, gained = missingFrom(after.overlay, before.overlay).length;
  counts.preRoutedChordLost += chords; counts.preOverlayStraightLost += lost; counts.preOverlayStraightGained += gained;
  entry.chordsLost += chords; entry.overlayLost += lost; entry.overlayGained += gained;
  if (stage === 'centre') { entry.centreOverlayLost += lost; entry.centreOverlayGained += gained; }
}
