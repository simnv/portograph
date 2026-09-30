/**
 * One absolute work budget for a whole command.
 *
 * Stage policies (ADR-0006: ELK 10 s at ≤ 300 nodes, 20 s above; the router's own 30 s) are
 * *upper* bounds on a single attempt. They are not additive: several legal attempts — a
 * partitioned ELK run, one fallback run per tier band, then routing — would otherwise each start
 * a fresh timer and together exceed the command's own limit long before scoring begins. Every
 * attempt therefore asks this object what is really left and takes the smaller of the two.
 *
 * The budget measures wall time only. It does not interrupt anything: a synchronous stage that has
 * already started keeps running, which is why the CLI owns a hard outer boundary as well.
 */
export interface Budget {
  /** Wall milliseconds left before the deadline, never negative. */
  remainingMs(): number;
  /** The smaller of one stage policy and the global remainder. Zero means there is no time left. */
  share(stageMs: number): number;
}

/** Raised when a stage is reached with no budget left. The CLI reports it as a processing failure. */
export class CommandDeadlineError extends Error {
  constructor(public readonly totalMs: number, public readonly stage: string) {
    super(`Command deadline of ${totalMs} ms reached before ${stage}`);
    this.name = 'CommandDeadlineError';
  }
}

/** A budget that starts now and never resets. `now` is injectable so tests need no real waiting. */
export function createBudget(totalMs: number, now: () => number = Date.now): Budget {
  if (!Number.isFinite(totalMs) || totalMs <= 0) throw new Error('A command budget must be positive and finite');
  const started = now();
  const remainingMs = (): number => Math.max(0, totalMs - (now() - started));
  return { remainingMs, share: stageMs => Math.max(0, Math.min(stageMs, remainingMs())) };
}

/** The default for a library caller that owns no command deadline: every stage keeps its policy. */
export const UNBOUNDED_BUDGET: Budget = {
  remainingMs: () => Number.POSITIVE_INFINITY,
  share: stageMs => stageMs,
};

/**
 * Fixed times against the hard command deadline (side-faces.md, Section 19.5; ticket 137). Each is set from the private sheet at
 * 2 times slower than quiet and rounded up; none is read from the clock, so the layout never depends on the speed of the machine.
 * They are guards against the deadline: no gate cuts at 2x. Keep them here, so a change is one line.
 */

/** What a command keeps in its budget for the work after stage 7f: route, link labels, score, validation and the SVG (tickets 111, 137).
 * The sheet measures 1.1 s at 2x without the SVG and validation. The chord-clear step stops trying movers when less than this is left. */
export const POST_PLACEMENT_RESERVE_MS = 4000;
/** One placement re-run to stage 7e, fan or side. The sheet: 2.7 s quiet, 5.4 s at 2x. */
export const FAN_RERUN_MS = 6000;
/** One stage 7f. The sheet: 6.5 s quiet, 13.0 s at 2x. */
export const BANDS_MS = 14000;
/** What must be left to start any re-run, fan or side trial: the re-run, its 7f and the tail. One gate for every re-run (ticket 131). */
export const RERUN_GATE_MS = POST_PLACEMENT_RESERVE_MS + FAN_RERUN_MS + BANDS_MS;
