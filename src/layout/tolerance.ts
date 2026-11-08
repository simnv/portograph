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
 * Owner files: this one and `geometry/planar.ts`. A raw `1e-N` literal anywhere else in `src/layout`, `src/route`, `src/pipeline`,
 * `src/geometry` and `src/render` fails the lint (`test/lint/tolerance-literals.test.ts`), except as the direct initializer of a named
 * exception that the lint lists: an order key (`SAME_KEY`, `SAME_FEED_KEY`, `AUTHOR_ORDER_KEY_STEP`), a parametric guard (`NEAR_END`),
 * a room grain (`LABEL_PADDING_GRAIN`, `LABEL_WINDOW_GRAIN`) and the renderer's own owners (`render/drawio.ts`: `EPS`, `PHASE_GRAIN`; a
 * renderer must not import a placement rule). A new comparison reads a name here, or names its own quantity and adds it to the lint.
 */

// ---- distances, px ----------------------------------------------------------------------------------------------------------------

/** Reservation arithmetic, px. Every caller states its edge (`<`, `<=`, `>`, or a margin). The router's `TOLERANCE` is this constant. */
export const PLACEMENT_EPS = 1e-6;

/**
 * No move, px: a move guard treats a displacement `|dx| <= NO_MOVE_EPS` as no move and holds it without reading its evidence. One name for
 * every kind of `holdsMove` and for `holdsNodeMove` (audit P-06-F7), so a move of 1e-8 has one verdict for all six kinds. It is the
 * reservation tolerance: a shift below it is arithmetic residue, not a move.
 */
export const NO_MOVE_EPS = PLACEMENT_EPS;

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
