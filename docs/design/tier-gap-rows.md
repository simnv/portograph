# Tier-gap row plan (design)

Status: proposal, 2026-09-29. No code changed. Replaces the tier-gap allocation of tickets 25, 31,
39, 42 and 43 with one rule that orders every piece of a tier gap in placement (7f).

## Problem

The allocation in `src/layout/gap-runs.ts` grew by accretion. Each ticket added one guard or one
band. Every one of them leaves a piece of the gap to the router, and the router then discovers a row
or a column that placement could have reserved. The evidence:

- `holdsOf` holds only the earlier piece of an interleaved pair (`gap-runs.ts:295-312`). Its
  partner, and every unheld neighbour, gets its row from libavoid. Ticket 43 measured that a held
  row forces a row order on the neighbours; an unheld neighbour's leg then crosses the held row.
- `heldRuns` reserves the horizontal only (`gap-runs.ts:346-351`). The legs stay the router's, and a
  peer's cover walls them (ticket 45; `retraces itself`, ticket 46).
- `tierGapRoom` measures the room on a probe (`gap-room.ts:65-79`). The answer moves with how far
  the probe opened the gap (ticket 42: 103.5 px asked, 128.5 px "owed", 146 px really needed
  because link-212's crossing row was discovered, not reserved).
- The nested-tip headroom is x-blind (`gap-runs.ts:1004-1006`), a foreign chord refuses rows by its
  bounding box (`firstBlock`, `gap-runs.ts:682-696`; ticket 44), and a column piece "interleaves"
  with every diagonal that spans it (ticket 43).

The pipeline's one rule is: never let a route, size or spacing be discovered during routing that
could have been reserved during placement. This spec applies it to the whole tier gap.

## Vocabulary (to be added to `CONTEXT.md`)

| Term | Definition |
|---|---|
| **piece** | The part of one routed link's path inside one tier gap, from one **end** to the other. |
| **tip** | An end that is a port's stem tip: the anchor moved by the `stemPlan` depth along the side's normal (`gap-runs.ts:270`). |
| **mouth** | An end that is a lane's approach point: the lane's x, one router stem (15 px) inside the gap boundary (`gap-runs.ts:265-266`). |
| **column** | A piece whose two ends stand less than one run clearance apart in x. It takes one vertical run. |
| **row piece** | Any other piece. It takes an upper **leg**, a **run** on its **row**, and a lower leg. |
| **Z piece** | A row piece with two rows and a reserved middle column, used only where one row is impossible. |
| **row plan** | The rows, legs and columns of every piece of one tier gap, computed in 7f. |
| **residual piece** | A piece the plan declines. It names why, and the router lays it as today. |

Numbers: run clearance `k = nudgingDistance = 10 + stroke = 11.5 px` (`bands.ts:182-183`); row pitch
`P`, see open question 1; group-edge margin `e = 10 + stroke / 2 = 10.75 px` (`gap-runs.ts:494`);
router stem `m = 15 px` (`bands.ts:35`).

## Section 1 — The pieces of a gap

1. **Which links.** Every drawn routed link with a planned gap whose two stops stand on opposite
   sides of the tier gap (`gapUsers`, `gap-runs.ts:204-207`). The stops are the port anchors and the
   ends of the lane runs (`stopsOf`, `gap-runs.ts:127-141`).
2. **Three kinds.** Tip to tip (a link between the two tiers of the gap). Tip to mouth (a link that
   leaves a port and enters a lane, or the reverse). Mouth to mouth (a link that transits both
   tiers). The kind changes nothing below; only the end's own bounds differ (Section 3).
3. **A tip stands where `stemPlan` puts it**, nested or flat. A flat tip in the group padding is a
   tip of the gap: `pieceOf` already builds it (`gap-runs.ts:256-283`), and the guard that skipped it
   (`gap-runs.ts:308`) is gone.
4. **Columns.** A piece with `|x_lower − x_upper| < k` is a column (ticket 42 rule 2,
   `gap-runs.ts:303`, kept). Its run is one vertical segment at the upper end's x. Where the two ends
   differ by less than `k`, the jog stands on the lower tip row, reserved, not discovered.
5. **Absent pieces.** A straight chord (ticket 34) has no piece: it reserves nothing and blocks
   nothing (this closes ticket 44). A bundle member, a bar drop, and an end that consumes a shared
   run keep their own rules; their geometry is an obstacle to the plan, and they have no piece.
6. **Not a piece of this gap.** A port on a `left` or `right` side, and a piece that spans two gaps
   at once (`gap-runs.ts:216`), stay crossers as today.

## Section 2 — The order

The plan assigns each row piece one row `y` (a Z piece two). Each piece's legs stand on its ends'
x. Given the rows, every crossing is fixed by arithmetic, so the order is the whole decision.

### 2.1 What a crossing is

For two row pieces A (row `yA`) and B (row `yB`) with `yA < yB` (A above), the crossings are
exactly: A's run crosses B's upper leg where B's upper x lies strictly inside A's x-span; B's run
crosses A's lower leg where A's lower x lies strictly inside B's x-span. Nothing else can meet: two
runs are parallel, two legs are parallel, and above a tip stands only its stem.

From that arithmetic:

- Two pieces whose ends **interleave** (`(xAu − xBu)(xAl − xBl) < 0`) cross exactly once, whichever is
  above. The crossing lies on the upper piece's run and on the lower piece's leg. So it is reserved
  by both, and no router is asked for it.
- Two pieces that run the **same way**, do not interleave, and overlap in x cross twice in one order
  and never in the other. The one on the far side of the direction of travel must be above (ticket
  43's `isAbove`). Same-way pieces whose spans do not overlap never cross.
- Two pieces that run **opposite ways** and overlap in x always interleave. Opposite-way pieces that
  do not interleave have disjoint spans and never cross.
- A run that spans a **column** crosses it, once, wherever the row is. The point lies on the run and
  on the column; both are reserved.

So the only decisions are the order, and the rows' y. Nothing is left over for the router.

### 2.2 Constraints

- **O1, same way.** For every pair that runs the same way, does not interleave, and overlaps in x:
  the piece on the far side of the travel direction is above the other. Ties at one end are decided
  at the other.
- **O2, shared column.** Where the upper end of piece A and the lower end of piece B stand within
  `k` of one another in x (a port over a lane mouth, a lane under a lane, two ports of two nodes on
  one x, or 10 px apart), their legs are collinear. A is above B: the leg from the low boundary turns
  first (today's only forced order, `rowOrder`, `gap-runs.ts:407-410`).
- **O3, no row shared.** Two pieces share one row only where their x-spans, each grown by `k`, are
  disjoint. Every other pair takes rows at least `P` apart.
- **O4, tips.** A run keeps `k` from every tip whose leg it crosses: a crossing of a foreign upper leg
  lies at least `k` below that tip row; a crossing of a foreign lower leg at least `k` above it. A
  piece's own turn may stand on its own tip row (the router turns there today). A run keeps `2k`
  (the ticket 31 band) from a **residual** tip's column, because a residual link is routed and needs
  the pocket ticket 25 measured.
- **O5, obstacles.** A run keeps `e` from a horizontal group edge it would run along
  (`alongGroupEdge`, `gap-runs.ts:493-508`), the label clearance from a group label, and `k` from a
  lane box, a bundle envelope, a bar band, a shared run and a fixed obstacle. These are forbidden y
  bands over an x-range, not bounding boxes: a chord forbids nothing.
- **O6, cycles.** O2 can contradict itself: two aligned node pairs joined by an X (the ticket 41 and
  43 shapes) put each piece's upper leg on the other's lower column. Then the later piece in model
  order becomes a **Z piece**: upper leg, first row, a middle column, second row, lower leg. The
  middle column stands at the centre of the widest interval between the piece's ends that is `k`
  clear of every other leg and column. O2 then holds for its two halves in turn.
- **Residual.** A piece that cannot obey O2 to O5 (two upper ends of two nodes within `k`, a leg
  through a fixed obstacle, a port standing over a lane mouth on the same boundary) is residual. The
  plan names it and its reason, and the router lays it as today.

### 2.3 The ordering rule

The constraints O1, O2 and the Z split form a directed graph on the pieces. It is acyclic after O6
(O1 edges follow the x order at the upper end inside each travel direction, and O2 cycles are cut).
The plan takes the pieces in a **topological order** and packs each one on the highest row it may
take:

```
y(piece) = max( lower bound of the piece,                        # Section 3, lb
                y(earlier) + P  for every earlier piece within k in x, or ordered above it )
```

Among the ready pieces, the one with the largest **need** (Section 3) goes first, then the smaller
lower bound, then model order. The need is the room a piece asks below its row; taking the most
demanding piece first is earliest-deadline-first, which keeps the gap short. Optimality is not
claimed; the rule is deterministic and the proofs below are per shape.

Rows are packed downward from the low boundary and never read the high boundary. That is what makes
the gap height a formula (Section 3): the rows do not move when the gap grows, and a second pass
measures the same rows.

### 2.4 Proofs on four shapes

Geometry read from the placed models after 7f on main (b3ed02e); stems flat at 15 px unless marked
nested. Rows at `P = k = 11.5`; growth measured against the 60 px band gap. Crossings were checked by
arithmetic: every forced pair crosses once and no other pair crosses.

**Ticket 36 shape** (`two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row.yaml`, gap
248..308). Pieces: link-4 104.6 → 194 (upper tip nested at 280.5); link-5 116.6 → 265.5; link-6
176.1 → 57; link-7 188.1 → 128.5 (nested 280.5); link-8 265.5 → 206; link-9 a column at 277.5.
Edges: O1 link-5 above link-4, link-6 above link-7; O2 link-8 above link-5 (both on x 265.5).

| piece | row | why |
|---|---|---|
| link-8 | 263.0 | its own tip row; no foreign tip in 206..265.5 |
| link-5 | 292.0 | crosses link-7's nested leg: 280.5 + k |
| link-6 | 303.5 | overlaps link-5 |
| link-7 | 315.0 | below link-6 (O1) |
| link-4 | 326.5 | below link-5 (O1), overlaps link-7 |

Five forced crossings (4×6, 4×7, 5×6, 5×7, 5×8), each on one run and one leg. Need: link-4 and
link-5 cross a lower leg, `k + m = 26.5`. Gap = 326.5 − 248 + 26.5 = 105 px; growth 45 (today
39.5, with link-4 above link-5 and two crossings the plan does not have).

**Ticket 41 shape** (`an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips.yaml`, gap
248..308). link-3 57 → 128.5, link-4 128.5 → 57: O2 both ways, so link-4 is a Z piece with its
middle column at 92.75. Rows: link-4a 263 (its tip row), link-3 274.5, link-4b 286. One crossing, on
link-3's row and link-4's middle column. Gap = 286 + 15 − 248 = 53 px: no growth. Today the gap does
not grow either, and the router discovers both the row and the column.

**Ticket 43 shape** (`a-plain-tip-in-the-group-padding-holds-its-row.yaml`, gap 121..181, tips in
the padding at 116 and 186). link-1 57 → 138.5, link-2 128.5 → 67; the legs stand 10 px apart at
each end, so O2 holds both ways and link-2 is a Z piece (middle column 97.75). Rows: link-2a
131.75 (`121 + e`), link-1 143.25, link-2b 154.75. One crossing. Gap = 154.75 + e − 121 = 44.5 px:
no growth. Today link-1 rides the tip row 116 and link-2 rides it collinear (G4, G6).

**v5-4-0** (synthetic sweep sheet; two gaps). Upper gap 121..181, lanes clip nothing: link-1
−63.1 → −40.5; link-2 140 → 31; link-3 4.9 → 102.5 (nested 133.5); link-4 column 174; link-5
38.9 → 245.5; link-11 −29.1 → mouth 307.5; link-12 column 519 to its mouth. Edges: O1 link-5 above
link-3; O2 link-11 above link-1 (legs 11.4 px apart), link-5 above link-2 (7.9 px apart). Rows:
link-11 145 (crosses link-3's nested leg), link-1 and link-5 156.5 (shared: spans 79 px apart),
link-2 168, link-3 179.5. Seven forced crossings, none discovered. Need: link-11's mouth
`overhang + m = 25.75`, the rest `e`. Gap 69.25 px, growth 9.25. Today: no growth, link-2 on the tip
row 116 with link-5 collinear (G4); with ticket 37, link-5 removed.
Lower gap 278..350.5 (lane boxes to 288.75 at x 307.5 and 519): link-7 31 → 515; link-8 102.5 →
586.5 (lower tip nested 338); link-9 174 → 319.5; link-10 245.5 → 729.5 (nested 320.5); link-11 a
column from its mouth; link-12 mouth 519 → 1003. Edges: O1 link-8, link-10 above link-7, link-10
above link-8 and link-9, link-12 above link-8 and link-10; O2 link-12 above link-7 (519 and 515).
Rows: link-12 303.75 (its mouth), link-10 315.25, link-8 326.75, link-7 338.25, link-9 349.75. Six
forced crossings (7×9, 8×9, and four on link-11's column). Need: link-10's nested tip 30. Gap
82.5 px, growth 10. Today: no growth; four links routed by libavoid through the padding.

At `P = 17.5` (today's pitch) the same plans grow 63, 5, 0, 27.25 and 34 px.

## Section 3 — The gap height as a formula

For each row piece `i` with row `y_i` (packed from the low boundary `low`, Section 2.3):

```
lb_i   = max( own upper tip row  (or low + e where that tip is in the padding),
              own mouth row,
              tip row + k        for every foreign upper tip strictly inside the span,
              lane box + k       for every lane column the span crosses,
              forbidden bands O5 over the span, stepped past their bottom )
need_i = max( bandTop − own lower tip row   (0 for a tip in the padding; e where a group edge is spanned),
              overhang + m                  for an own lower mouth,
              k + (bandTop − tip row)       for every lower leg the run crosses (pieces above it),
              e                             where the span crosses a group's top edge )
H      = max( bandGap, max_i ( y_i − low + need_i ) )
growth = max( 0, H − (bandTop − low) )
```

`bandTop − tip row` is the depth a lower tip stands inside the gap: 15 for a flat tip on the
boundary, 32.5 or 50 for a nested one, negative for a tip in the padding. The terms are x-scoped:
a nested tip at another x sets nothing (ticket 42 proposal 3). Ticket 25's `stems` term
(`gap-runs.ts:954-972`) is the case `y_i ≥ upper tip + k` and `need_i ≥ k + depth` of one piece:
`2k` between the tip rows. Ticket 31's `reach` headroom (`gap-runs.ts:1004-1006`) is the `need` of
the pieces that cross that leg. Neither is a separate pass.

No probe. `growTierGaps` keeps only its last step: move the bands by `growth`, replay, warn
(`gap-room.ts:84-97`). The rows do not move with the growth, so a second measure is identical; the
monotonicity argument of `gap-room.ts:30-37` is no longer needed. The 7f order stays: labels, plan
and growth, labels again, corridor move. A corridor move after the plan changes an x; the plan is
recomputed at consumption on frozen placement, as `allocateGapRuns` is today, and a piece that then
does not fit is residual with a diagnostic (`TIER_GAP_PIECE_UNFIT`), never a silent discovery.

## Section 4 — What the router still does

- **Nothing inside a planned gap.** `allocateGapRuns` returns every planned piece tip to tip: legs,
  run, middle column, or the one vertical of a column. `planRoute` reserves them as today
  (`plan.ts:188-214`), and stage 8 stitches them (`pipeline.md` § 8). The stem from a port anchor to
  its tip is then a gap with one possible route, and stage 8 claims it without the router
  (`pipeline.md:1195-1201`). A link every piece of which is planned joins no ownership batch.
- **Residual pieces**, lateral ports, shared-run ends, bundle members, flank regions and bar drops
  are routed as today. For them the covers of the planned runs stay obstacles, and the crossers of a
  run (`gap-runs.ts:1041-1048`, `plan.ts:212`) are the residual links of the gap.
- **Two links on one port** share the leg from the tip to the higher of their rows. The plan
  declares it a shared run of that port (the junction of `CONTEXT.md`), so the overlap gate exempts
  it, as the pipeline already treats one port as one strip (`pipeline.md:1101-1109`).
- **Unnecessary once every piece of a gap is planned:** `gapNeeds` and the cover grants
  (`plan.ts:422-454`, tickets 21 and 37), `crossingParts` and `crossedStems` (`index.ts:56-63`,
  `plan.ts:549-563`, tickets 22 and 30), `holdsOf`, `heldRuns`, `allocateWithHolds`, `rowOrder`,
  `allocateGap` with its `owed`, `reaches`, `covered` and `declined` sets, `stemShortfall`, the tip
  bands of `blockers()` (`gap-runs.ts:647-667`), the probe of `growTierGaps`. They remain in use only
  for residual pieces, and ticket 37 is closed by deletion rather than by a metric review when the
  corpus shows no residual piece in any tier gap (Section 5, ticket 5).
- **Diagnostics that remain:** `TIER_GAP_GROWN` (now with the piece that set `H`),
  `ROUTE_CHECKPOINT_SKIPPED` and `ROUTE_GAP_REJECTED` for residual links, ticket 46's removal of a
  retracing route. **New:** `TIER_GAP_PIECE_RESIDUAL` with the reason (legs of two nodes within `k`;
  a port over a lane mouth; a leg through a fixed obstacle) and `TIER_GAP_PIECE_UNFIT` (Section 3).

## Section 5 — Migration

**Subsumed.** Ticket 25 (stem tips apart): Section 3's `lb` and `need` of one piece. Ticket 31 (tip
bands, column bands): O4. Ticket 39 and 41 (the earlier piece holds the mid row): every piece holds
a row; the mid row is not special. Ticket 42 rule 2 (near-vertical piece is a column): Section 1
item 4; rule 1 (owed measure, parked): the formula. Ticket 43 (padding tips, `isAbove`,
companions): O1 and Section 1 item 3. Ticket 44 (chord bounding box): Section 1 item 5. Ticket 45
(cover walls a leg): O2 and O3; legs are reserved, not the router's. Ticket 37: not needed for
planned pieces; kept for residual ones until ticket 5 deletes it. Ticket 46 stays (a safety net for
residual routes).

**Fixtures that keep their expectations** (all through the real router): `removedLinks` empty and
every gate passing on `two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row`,
`an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips`,
`an-unseated-lane-end-piece-holds-the-row-between-its-tips`, `a-near-vertical-piece-holds-no-row`,
`a-nested-tip-row-holds-no-allocated-row`, `a-seated-column-leaves-a-tip-its-pockets`,
`a-seated-column-leaves-a-corridor-open`, `a-band-holds-the-group-that-set-its-edge`,
`a-straight-gap-needs-no-router`, `a-tier-gap-grows-to-its-rows`, `a-row-steps-past-a-group-edge`,
`detoured-stem-checkpoint`, the M1 golden and the golden snapshot. **Expectations that change by
design:** the growth numbers (39.5 → 45 on the ticket 36 fixture at `P = 11.5`; 77.25 on the ticket
42 fixture will fall), the "mid row" assertions of `interleaved-gap-links.test.ts` (the row is the
packed one), the 23 px tip-distance assertion of `nested-tip-row.test.ts` (`k` for planned pieces),
and `plan.batches` on links that no longer need the router.

**Tickets** (dependency order; each with a fixture-sized acceptance test):

1. **The plan as a pure module.** `src/layout/gap-plan.ts`: pieces (Section 1), constraints and
   order (Section 2), formula (Section 3); no caller. Acceptance: a unit test that builds the four
   shapes of Section 2.4 from their placed models and asserts the rows, the middle columns, one
   crossing per forced pair and none else, and `H`. New synthetic fixture
   `a-tier-gap-plan-orders-every-piece.yaml` (the v5-4-0 shape, tier and class only).
2. **Stage 8 consumes the plan in the room the gap has.** `allocateGapRuns` returns the plan's
   pieces; `planRoute` reserves them; pieces that do not fit the current gap are residual. Old
   holds stay off the path. Acceptance: the ticket 41 and 43 fixtures (no growth needed) route
   with `removedLinks` empty, every gate passing, one crossing, and `plan.batches` empty.
3. **7f grows by the formula.** `growTierGaps` reads `H`; the probe, `tierGapRoom`'s seating
   measure, `stemShortfall` and the `reach` headroom go. Acceptance: the ticket 36 fixture grows
   45 px (at `P = 11.5`) and routes whole; `a-tier-gap-grows-to-its-rows` still grows; a second
   `bands` pass grows nothing.
4. **Residual pieces and diagnostics.** `TIER_GAP_PIECE_RESIDUAL`, `TIER_GAP_PIECE_UNFIT`, the
   shared leg at a port declared as a shared run, ticket 46's removal. Acceptance: a synthetic with
   two nodes whose facing ports stand 9 px apart across a gap completes, names the residual piece,
   routes it, and removes nothing; a two-links-one-port fixture passes G4.
5. **Deletion, sweep, docs.** Delete the code Section 4 lists; `pipeline.md` § 7a and § 7f and
   ADR-0015 rewritten to this spec; `CONTEXT.md` vocabulary. Acceptance: the 72-sheet sweep gains
   no removal on any sheet (coordinator runs it); the NTP sheet as below.

**Expected effect.** NTP sheet (today: removed 0, Q 0.735, G4 6, G6 18, canvas 3196 × 2554.75, the
tier 9 to tier 10 gap grown 94.75 px). Estimate, not measured (private input): the gap holds five
or six rows per location at `P = 11.5`, packed from the plain tip row 1327 and the nested rows
1344.5 and 1362; `H` lands at 40 to 60 px of growth, between ticket 42's owed 68.5 (which lost three
violations to a discovered row) and today's 94.75, with link-209 and link-245 seated (ticket 44)
and link-212's crossing row reserved. Removed 0; G4 drops (the collinear pairs 211/209 and 212/213
of the tip rows have rows of their own); G6 at or under 18; Q at or above today. Canvas height
falls by 35 to 55 px. 72-sheet sweep (today 31 removals, 0 throws): the removals are checkpoint
pockets inside tier gaps; with every tier-gap piece reserved the expectation is under 10, all from
residual pieces named by the diagnostic, and 0 throws.

## Section 6 — Open questions for the maintainer

1. **Row pitch `P`.** `k = 11.5` is the router's own nudging distance and the G6 number; `17.5` is
   the bundle pitch the allocation inherited (`gap-runs.ts:738`). Recommendation: `P = k`. The
   ticket 36 shape then grows 45 px instead of 63, v5-4-0 19 instead of 61.
2. **Rows in the padding.** The router lays rows between a padding tip and the group edge today
   (v5-4-0's lower gap). The plan does not (`lb ≥ low + e`). Recommendation: not in the first
   version; measure the sweep's growth, then decide.
3. **Legs of two nodes within `k`.** The plan makes the later piece residual (ticket 45's shape).
   The real fix is a placement rule on port x. Recommendation: residual with a diagnostic now; a
   placement ticket later.
4. **The shared leg at a port.** Declare it a shared run (junction) so G4 exempts it, or leave the
   two paths collinear as today. Recommendation: declare it; it is the pipeline's own word for it.
5. **When to delete the router-side grants** (tickets 21, 22, 30, 37). Recommendation: with ticket
   5, once the sweep shows no residual tier-gap piece; keep them until then, gated by the count.
