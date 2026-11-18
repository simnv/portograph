/**
 * The typed refusal of a placement run (architecture 2, ticket 04). A round offers a trial; the placement run, the 7e checks or stage 7f may refuse it for a reason the
 * layout expects. Each expected refusal is thrown as a `PlacementRefusal` at its source, so a round tells it from a bug by its class and its `code`, never by the text of its
 * message. A leaf module: every producer may throw it, and it imports nothing.
 */
import type { Owner } from '../model/index.js';

/**
 * What refused: a side hint, a course, a span corridor, a trunk join, the centring invariant, the skeleton (ELK), a bundle path, the placement budget, a reservation of
 * the ledger, a stagger reservation (its seat, its stage-5 proof or its validator; ticket 51), a solid block, or a producer postcondition of 7e or 7f (DR-11).
 */
export const REFUSAL_CODES = ['side', 'course', 'span', 'trunk', 'centring', 'skeleton', 'bundle', 'budget', 'ledger', 'stagger', 'solid-block', 'postcondition'] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];
/** Whether `code` is one of the closed set of refusal codes (`REFUSAL_CODES`). */
export const isRefusalCode = (code: unknown): code is RefusalCode => typeof code === 'string' && (REFUSAL_CODES as readonly string[]).includes(code);

export interface RefusalDetail {
  /** The pipeline or model stage that refused, when the source knows it. */
  stage?: string;
  /** The ids of the ledger entries the refusal answers for. */
  reservationIds?: readonly string[];
  /** The nodes, ports or links the refusal names. */
  owners?: readonly Owner[];
  /**
   * The value a catch caught, when this refusal is built from one (dense-16x9 ticket 56, review 2). The key present marks the refusal as caught,
   * also when the caught value is `undefined` or `null` (a rejection with no reason); a refusal built from a measurement leaves it out.
   */
  cause?: unknown;
}

export class PlacementRefusal extends Error {
  readonly code: RefusalCode;
  readonly stage: string | undefined;
  readonly reservationIds: readonly string[];
  readonly owners: readonly Owner[];
  declare readonly cause: unknown;
  /** Whether a catch built this refusal from a caught value (`cause`, which may be `undefined` or `null`). */
  readonly caught: boolean;
  constructor(code: RefusalCode, message: string, detail: RefusalDetail = {}) {
    super(message);
    this.code = code; this.stage = detail.stage; this.reservationIds = detail.reservationIds ?? []; this.owners = detail.owners ?? [];
    this.caught = Object.hasOwn(detail, 'cause');
    if (this.caught) this.cause = detail.cause;
  }
}

/**
 * Whether `error` is a placement reason (dense-16x9 ticket 56, the fallback of a default-on run): a `PlacementRefusal` with a code of the closed
 * set, built from a measurement, or built in a catch from a value that is itself such a refusal (reviews 1 and 2, R6). A refusal built from a
 * worker bug, a reader exception, a deadline, a timeout or a rejection with no reason is none.
 */
export function qualifyingRefusal(error: unknown): error is PlacementRefusal {
  return error instanceof PlacementRefusal && isRefusalCode(error.code) && (!error.caught || qualifyingRefusal(error.cause));
}

/** A placement run refused a side hint (not a candidate, a lateral vote, a floor below the content). The side round drops the offer; every other error is a bug. */
export class SideHintRefusal extends PlacementRefusal {
  constructor(message: string, detail: RefusalDetail & { code?: RefusalCode } = {}) { super(detail.code ?? 'side', message, detail); }
}

/** Stage 5 found a foreign unit beside a member row of a trunk join on both sides: the join is declined by one placement re-run (`trunk-blocked`, mesh-bus.md, section 12.4). */
export class TrunkBlocked extends SideHintRefusal {
  constructor(public readonly key: string, public readonly why: string) { super(`The trunk join ${key} is blocked: ${why}`, { code: 'trunk' }); }
}

/** A refusal that stage 7f may also give (a trial's bands run): the centring invariant and the budget are the command's, never a trial's. */
export const refusedAtBands = (error: unknown): error is PlacementRefusal => error instanceof PlacementRefusal && error.code !== 'centring' && error.code !== 'budget';

/**
 * A refusal of a producer of 7e or 7f (DR-11): a postcondition of the net draft (`PostconditionRefusal`) or a bundle path with no room
 * (`BundleFeasibilityError`, code `bundle`; W09 can end there when its guard refuses the room). Every round withdraws its trial on one, at its
 * placement run and at its 7f run alike; the main line fails by name. One rule for every round: the round runner (`round.ts`) asks it before the
 * round's own `tolerates`.
 */
export const producerRefusal = (error: unknown): error is PlacementRefusal => error instanceof PlacementRefusal && (error.code === 'postcondition' || error.code === 'bundle');

/** The whole block is declined before freeze; the next run restores its original placement owners. */
export class SolidBlockRefusal extends PlacementRefusal {
  constructor(readonly blocks: ReadonlyMap<string, string>) {
    super('solid-block', [...blocks].map(([id, why]) => id + ': ' + why).join('; '), { stage: 'bundles' });
  }
}

/**
 * The net draft of 7e or 7f breaks a reservation that held at entry (DR-11, `postconditions.ts`). In a round's trial it withdraws the trial; in the
 * main line the command fails and names the reservation.
 */
export class PostconditionRefusal extends PlacementRefusal {
  /** `caught`: the value a check threw, when a finding is built from one (`postconditionViolations`); the refusal then carries it as its cause. */
  constructor(readonly rule: 'bundles' | 'bands', readonly findings: readonly { kind: string; subject: string; detail: string }[], caught?: { value: unknown }) {
    super('postcondition', `Postcondition of ${rule} failed: ${findings.map(item => `${item.kind} ${item.subject}: ${item.detail}`).join('; ')}`, { stage: rule, ...(caught === undefined ? {} : { cause: caught.value }) });
  }
}
