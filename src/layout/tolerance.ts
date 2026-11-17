/**
 * The named tolerances of placement and routing (decision review 2026-11, D-Q6; audit P-08, section 3).
 *
 * `PLACEMENT_EPS` is a distance tolerance of 0.000001 drawing pixels. It absorbs residue when placement measures and spends reserved room:
 * a gap measured, spent and measured again, a width grown to a measured label, a deficit inserted at a split (stress tickets 13 and 19).
 * Planar coincidence uses `geometry/planar.ts` (`EPS`, 1e-7) and has a different contract: whether published geometry contains, overlaps
 * or touches. Strict no-deeper guards, products, order keys, solver stops and renderer comparisons keep their stated units and named
 * owners, below. Each name states its quantity, its unit and its edge; two names with one number are two decisions, kept apart so that
 * a change of one cannot move the other.
 *
 * Owner files: this one and `geometry/planar.ts`. A raw tolerance literal (a number above 0 and at most 0.01 in any spelling,
 * `Number.EPSILON`, a power with a negative exponent) anywhere else in `src` fails the lint (`test/lint/tolerance-literals.test.ts`),
 * except as the direct initializer of a top-level named exception that the lint lists: an order key (`SAME_KEY`, `SAME_FEED_KEY`,
 * `AUTHOR_ORDER_KEY_STEP`), a parametric guard (`NEAR_END`), a room grain (`LABEL_PADDING_GRAIN`, `LABEL_WINDOW_GRAIN`), the constraint
 * residual (`RESIDUAL_TOLERANCE`) and the renderer's own owners (`render/drawio.ts`: `EPS`, `PHASE_GRAIN`; a renderer must not import a
 * placement rule). A new comparison reads a name here, or names its own quantity and adds it to the lint.
 */
import { EPS } from '../geometry/planar.js';

// ---- distances, px ----------------------------------------------------------------------------------------------------------------

/** Reservation arithmetic, px. Every caller states its edge (`<`, `<=`, `>`, or a margin). The router's `TOLERANCE` is this constant. */
export const PLACEMENT_EPS = 1e-6;

/**
 * The margin a chord corridor step adds to its shortfall, px (`chordSteps`, dense-16x9 ticket 03, slice C). The corridors of one row move each
 * other's hubs, so the seat-and-measure loop closes a shortfall geometrically; the margin ends that tail inside `CHORD_SEAT_PASSES` seats. Edge:
 * a gap whose shortfall is above `PLACEMENT_EPS` grows by the step plus this margin.
 */
export const CHORD_CORRIDOR_SLACK = 1;

/**
 * The geometric tolerance of a solid-block reservation, in px (dense-16x9 ticket 31, review 1 ruling): how far a member may stand short of its
 * angle (read in px of height), its floor, or its box clearance and still hold it. The publication validator, the judge of a move
 * (`blockMoveRefusal`) and the judge of a step (`chordsHold`) read this one constant (R1); `EPS` stays a float compare. Why 0.01 px: the
 * block is reserved at exactly its demand, and the 7c passes that run after the freeze are an iterative solve, whose residue moves one end of
 * a member by 0.001 to 0.004 px. On the ticket 31 synthetic that left the chord 1.5e-4 to 2.4e-3 px of height short of 34 degrees, so a
 * drawn constraint cannot be held tighter than that. 0.01 px is about 4 times the largest dip measured, and invisible in the drawing.
 */
export const BLOCK_TOLERANCE = 0.01;

/**
 * The solid-block constraints that back a gate threshold, and the gate each one backs: the one place that says which (dense-16x9 ticket 04,
 * slice 3, step 2, review 2; coordinator ruling). A judge's tolerance must never reach under a gate threshold. So such a constraint is reserved
 * with `BLOCK_TOLERANCE` as margin (`blockReserve`: reserved = the gate threshold + BLOCK_TOLERANCE), and the validator and the judges of a move
 * and of a step accept it down to the gate threshold exactly, with the gate's own float compare (`blockAllowance`: `EPS`). The tolerance spends
 * only the reserved margin. Every other block constraint backs no gate and keeps `BLOCK_TOLERANCE` as its allowance, with no reserve:
 * - the 34 degree angle and the 15 degree floor;
 * - the own-box crossing margin (`edge`): a gate excuses a segment inside its own box, and a member does not run along its own box's edge on
 *   one axis.
 * The two that back a gate:
 * - `room`: a row neighbour's body from a straight flat member (`blockRowGaps`): G6 `segment-node-clearance`.
 * - `frame`: a foreign group box from a solid-block member: G6 `segment-group-edge`, met where the chord runs along a box edge on one axis.
 */
export const GATE_BACKED_BLOCK_CONSTRAINTS = { room: 'G6 segment-node-clearance', frame: 'G6 segment-group-edge' } as const;
export type BlockConstraint = keyof typeof GATE_BACKED_BLOCK_CONSTRAINTS | 'angle' | 'floor' | 'edge';
const gateBacked = (constraint: BlockConstraint): boolean => Object.hasOwn(GATE_BACKED_BLOCK_CONSTRAINTS, constraint);
/** How far a block constraint may stand short of its threshold and still hold, px: `EPS` where it backs a gate, else `BLOCK_TOLERANCE`. */
export function blockAllowance(constraint: BlockConstraint): number { return gateBacked(constraint) ? EPS : BLOCK_TOLERANCE; }
/** The margin a reservation (or an admission) of a block constraint adds over its threshold, px: `BLOCK_TOLERANCE` where it backs a gate, else 0. */
export function blockReserve(constraint: BlockConstraint): number { return gateBacked(constraint) ? BLOCK_TOLERANCE : 0; }

/**
 * No move, px: a move guard treats a displacement `|dx| <= NO_MOVE_EPS` as no move and holds it without reading its evidence. One name for
 * every kind of `holdsMove` and for `holdsNodeMove` (audit P-06-F7), so a shift has one verdict, move or no move, for all six kinds. Strict
 * (ADR-0010: lane guards stay strict): at the reservation tolerance a shift of 9e-7 toward a riser took a port 5e-7 outside the keep-out
 * line into it unjudged (DR-12 review), and producers pass raw shifts of that size.
 */
export const NO_MOVE_EPS = 1e-9;

/**
 * Riser keep-out depth, px: a routed port stands in the keep-out when its depth is `> RISER_DEPTH_EPS`, and a move keeps it no deeper when the
 * new depth is `<= before + RISER_DEPTH_EPS`. Strict on purpose (ADR-0010: lane guards stay strict).
 */
export const RISER_DEPTH_EPS = 1e-9;

/** Join rows off group edges, px (`clearOfGroupEdges`): a row stands inside `lo + e < x < hi - e`, and nearer than `margin - e` to an edge it blocks. */
export const BUNDLE_EDGE_EPS = 1e-9;

/** Crossed vertical cover of a tier-gap run, px (`plannedRuns`): a run is granted the cover strictly inside `lo - keep + e < x < hi + keep - e`. */
export const COVER_BOUNDARY_EPS = 1e-9;

/** Legend row fit, px: an item wraps to a new row when the row would exceed the limit by more than this. */
export const LEGEND_FIT_EPS = 1e-9;

/** A reserved run's axis in the router plan, px: a vertical difference `< e` is level; `> e` and `< -e` say down and up. */
export const ROUTE_AXIS_EPS = 1e-9;

/** The bundle channel's visibility grid, px: an obstacle grows by this beyond its clearance, and a grid line stands this far off its edge. */
export const CHANNEL_GRID_STEP = 1e-3;

// ---- products, px squared ---------------------------------------------------------------------------------------------------------

/**
 * The sign tolerance of a product of two differences, in px squared: a pair of coordinates is "inverted" when
 * `(a1 - b1) * (a2 - b2) < -SIGN_EPS`, so a tie or a rounding residue is no inversion. Same number as `PLACEMENT_EPS` and not the same
 * unit: it is no distance.
 */
export const SIGN_EPS = 1e-6;

/**
 * The lane feed-order product, px squared (`feedOrderHolds`): corridors and children swap when `(cx - x) * (child - peerChild) < -e`. Stricter
 * than `SIGN_EPS` on purpose; D-Q6 keeps it as its own owner.
 */
export const LANE_ORDER_SIGN_EPS = 1e-9;

/** Coalescing two segments of one path, px squared (`coalesce`): they merge when `|cross| <= e` and `dot > e` (collinear, same way). */
export const COALESCE_PRODUCT_EPS = 1e-9;

// ---- dimensionless ----------------------------------------------------------------------------------------------------------------

/** An aspect score improvement, the absolute natural log of width over height: a candidate wins only when it is better by more than this. */
export const ASPECT_EPS = 1e-9;

// ---- solver stops, px -------------------------------------------------------------------------------------------------------------

/** The inner row solve of a bundle merge stops when a row shift is smaller than this. A stop, not a claim that smaller geometry is equal. */
export const BUNDLE_ROW_SETTLE_EPS = 1e-9;

/** The column pool solve of `pullTier` stops when no iterate moves by this much. Its feasibility checks read `PLACEMENT_EPS`. */
export const COLUMN_SETTLE_EPS = 1e-9;
