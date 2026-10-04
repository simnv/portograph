import type { Owner } from '../../model/layout.js';

/** The id an owner names; a `barCross` owner names a pair and has none. */
export const ownerId = (owner: Owner): string | undefined => 'id' in owner ? owner.id : undefined;

/**
 * The x constraint catalogue (architecture ticket 05). Nothing here moves a box: the catalogue is data, and `evaluate.ts` reads a
 * published layout against it. No production stage imports this module.
 *
 * A relation is `position(b) - position(a) >= bound` for a hard entry, and `position(b) - position(a) = bound` as a target for a soft one.
 * A position is the x of an owner plus an offset that does not change when the owner moves (a group is rigid: its bodies and ports keep
 * their offsets). Two owners per relation: this is why a chord-side relation (three positions) is `unsupported`.
 */
export type TermAt = 'group' | 'frame-left' | 'frame-right' | 'fixed';
export interface Term { at: TermAt; owner: string; offset: number }

export type ConstraintKind =
  | 'separation-root-frames' | 'separation-flank' | 'separation-root-frame-group' | 'separation-root-groups'
  | 'separation-frame-frames' | 'separation-cell-child-frame' | 'separation-frame-cells'
  | 'containment-cell' | 'containment-child-frame' | 'containment-held-lane'
  | 'lane-clearance' | 'anchor-tier-fixed'
  | 'port-feed-alignment' | 'chord-alignment' | 'chord-side';

/** Why the entry exists. Never "the published boxes stand so". */
export type Anchor = 'author-intent' | 'documented-clearance' | 'declared-reservation' | 'conditional-choice';

/**
 * `known`: the rule is stated in an ADR, a Q number or a named constant, and the published layout owes it; a violation is an
 * invariant violation. `translation`: this catalogue's reading of a rule is not yet confirmed; a violation is a translation error
 * until a contract is named.
 */
export type Contract = 'known' | 'translation';
/** `difference`: two owners, solvable as a difference constraint. `fixed-endpoints`: valid only with both endpoints held. `unsupported`: not expressible. */
export type Support = 'difference' | 'fixed-endpoints' | 'unsupported';

export interface Constraint {
  /** Kind plus sorted owners (and `/n` for a second entry of the same pair): stable across runs. */
  id: string;
  kind: ConstraintKind;
  strength: 'hard' | 'soft';
  /** `kind:id` keys (`group:east#1`, `frame:east`, `lane:..`, `link:..`): a frame and a cell that share an id stay two owners. */
  owners: string[];
  /** ADR, Q number, ticket or constant name. */
  source: string;
  /** The named constant or input the bound comes from (`bandGap`, `FRAME_TO_FRAME_GAP`, `reference layout`, `lane bounds`, ...). */
  basis: string;
  /**
   * `evidence`: a violation says something about the layout. `hull`: valid for a solve, but the pipeline builds the checked box from the
   * same terms (frames.ts `deriveFrames`), so it holds by construction and a pass proves nothing.
   */
  role: 'evidence' | 'hull';
  anchor: Anchor;
  /** The discrete choice the entry holds fixed (a published order, a lane side), when it holds one. */
  branch?: string | undefined;
  contract: Contract;
  support: Support;
  a?: Term;
  b?: Term;
  bound: number;
  note?: string | undefined;
}

export type FindingClass = 'invariant-violation' | 'translation-error' | 'legacy-exception' | 'unsupported';

export interface Residual {
  constraint: Constraint;
  /** Hard: `b - a - bound`, negative when violated. Soft: `b - a - bound`, signed distance from the target. Absent when unsupported or unevaluated. */
  residual?: number;
  violated: boolean;
  /** Set for a violated hard entry, and for every unsupported entry. */
  class?: FindingClass;
  /** Why a legacy exception is one, or why an entry is unsupported. */
  reason?: string | undefined;
}
