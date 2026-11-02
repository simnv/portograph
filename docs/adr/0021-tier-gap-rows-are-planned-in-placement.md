# ADR-0021: Tier-gap rows are planned in placement

Status: accepted (maintainer, 2026-09-29). Spec: `docs/design/tier-gap-rows.md`.
Supersedes the tier-gap allocation and the tier-gap height rule of ADR-0015 (the sixth, seventh,
ninth and eleventh amendments) and the router-side grants that served them (tickets 21, 22, 30 and
37 for a tier gap). Keeps the rest of ADR-0015: nested stems, the wrapping pitch, the crossing
grant for a completed route, the claim of a gap with one possible route (tenth amendment), the
reservation of a node side (twelfth).

## Context

ADR-0015 reserved the runs that cross a tier gap one rule at a time. Each ticket added a guard or a
band (ticket 25 stem tips, 31 tip bands, 39 the held rows of interleaved pairs, 42 the growth
measure, 43 padding tips, 44 chords, 45 covers). Every guard left a part of the gap to the router.
The router then found a row, a leg or a grant that placement could have reserved: a held row that
forced a row order on its neighbours, a probe whose answer moved with how far it had opened the gap
(103.5 px asked, 128.5 px owed, 146 px needed on ticket 42's fixture), a cover that walled a
neighbour's leg (tickets 45, 46). That is the pipeline's one rule broken, in one place.

## Decision

1. **Every part of a tier gap is planned in placement.** A **part** is the path of one routed link
   inside one tier gap. The plan (`src/layout/gap-plan.ts`) gives each part its legs, its row (a Z
   part two rows and a **middle drop**) or its one vertical (a **drop**), and orders them by four
   rules: O1 same-way parts, O2 a shared vertical, O3 no row shared, O4 and O5 tips and obstacles.
   The row pitch is `P = k`, the run clearance (`nudgingDistance`, 11.5 px).
2. **The height is a formula.** `H` is the largest of the floor, the row of each part plus its need,
   the drops and the residual terms (spec Section 3). It is read on the geometry 7f publishes:
   `growTierGaps` takes it to a fixed point on trial copies (at most six rounds; from the third
   round a gap never gives back an earlier ask) and grows the gap by `H` less the room it has. There
   is no probe. (Amended: the fixed point is gone; one solve reads `H` once. See the amendment of
   architecture-2 ticket 57 at the end.)
3. **Stage 8 consumes the plan.** `allocateGapRuns` returns every planned part tip to tip as
   reserved geometry; the stem from a port anchor to its tip is claimed straight. A gap whose parts
   are all planned asks the router for nothing.
4. **A residual part is named, never silent.** A part the plan declines (`spans-two-gaps`,
   `lateral-port`, `u-turn`, `faces-away`, `off-boundary`, `crosses-lane`, `crosses-shared-run`,
   `leg-blocked`, `row-cycle`) is routed by libavoid among the reserved parts.
   `TIER_GAP_PART_RESIDUAL` (`TIER_GAP_ROW_CYCLE` for a cycle) names it with the reason. It is
   granted the crossing of every planned row of its gap, and the cover of each planned vertical that
   stands within `k` of its span, that vertical's cover alone. Two verticals of two nodes within `k`
   are both planned and named `crowded`; gate G6 reports them, which `quality.md` item 11 prefers to
   a removed link. A gap the plan does not fit after 7f is named `TIER_GAP_PART_UNFIT` and left to
   the router.
5. **What the router lost.** The residual seating of `allocateGap` (the holds of ticket 39, the row
   order, the tip bands of ticket 31, the approaches a gap owes), the room measure `tierGapRoom`,
   the chord grant of a completed cover (ticket 37: a cover is granted only where a leg or an L of
   the link crosses its interior), the split of a batch by covers and stems (`crossingParts`,
   `crossedStems`, ticket 22) and the stems passable to a batchmate. Ticket 52 measured each on the
   150 synthetic goldens, the 72 sweep sheets, the M1 golden and the NTP sheet: none had any use
   at stage 8, and deleting them changed no path on any input.

## Consequences

- A tier gap grows to the rows of its parts, at the pitch `k` and not `16 px + stroke`; the numbers
  of the old fixtures changed (spec Section 5).
- A link in a gap the plan does not fit is routed by libavoid alone and can be removed with its own
  `ROUTE_GAP_REJECTED` or `ROUTE_CHECKPOINT_SKIPPED` warning. Under a mocked growth
  (`unfit-gap.test.ts`) 1 link is removed on `a-claim-lies-on-a-cover-edge` and 7 on
  `a-band-holds-the-group-that-set-its-edge`, where the old seating removed none. No input of the
  corpus reaches this state; the price is accepted as decision Q101. A residual whose route detours
  beyond its tip-to-tip span is not granted the cover of a planned leg it crosses out there (spec
  Section 2.2); that leg is a wall to it.
- A chord is invisible to the plan (spec Section 1 item 5, S6): one chord within `k` of a planned
  drop on the NTP sheet, links 232 and 235, is a published G6 finding.

## Alternatives considered

- Keep the old allocation for the residual parts. Rejected on the measurement: it seated nothing
  for them, and it was 810 lines of `gap-runs.ts` (1058 became 245) that the plan's nine reasons no longer reach.
- Amend ADR-0015 in place. Rejected: six of its amendments describe the allocation and the height
  rule as one story, and a rewrite would lose the measured history. ADR-0015 carries a pointer.

Amendment (2026-10-05, architecture ticket 15, phase 4): a course may leave its tier band through a perimeter lane or a padding row. A padding row is a run inside the padding of the end group, between the node faces and the title band; its depth grows `groupPadding`, and on the title edge `groupInsets`. A natural end of a course leaves only its mouth to the tier-gap plan and the router. `u-turn` and `lateral-port` stay residual only for a link with no course. The course round keeps a trial only on the routed result: no gate worse, then fewer bent links, fewer turns and fewer crossings.

Amendment (2026-10-05, architecture ticket 15, phase 4, review): (Q2) the width of a perimeter lane and of a padding row is required width, not optional growth, so a canvas that a course widens may exceed the 5 % growth limit, and a turn row may stand in the padding of its group. A course trial is judged on what it publishes, not on its promise: it is refused when a course link publishes more turns than the course promised, and when the routed trial has a gate finding or a hard entry of the x constraint catalogue (`src/layout/constraints/`) that the baseline does not have. The findings are compared as sets, so a trial that trades one finding for another is refused. The side judge does not read the catalogue: `three-canton-groups-close-up-to-a-band-gap` keeps a side trial today that leaves two root frames under the band gap, and a check there would change that sheet (a ticket of its own).

Amendment (2026-10-05, architecture ticket 15, phase 5): the plan has a **U part**: a part whose two ends stand on one boundary of the gap, a port's tip and the mouth of a column-gap lane (`PlanInput.u`). It has one row and two legs, no lower leg, and asks `keep` above the band below. A U part nested in another stands above it, and a U part stands above a stepped part whose upper or lower end stands between its legs (`uEdges`, added only where they close no cycle); the other edges (O1, O2, the Z split) do not read it. `u-turn` is residual only for a link with no gap course. A **gap course** (`runs` with `gap`, no `perimeter`) is offered to a skirt, a link whose two ends stand in one band with a unit between them, only when its baseline route is removed or has a gate finding that names it: a skirt whose route holds keeps it. The lateral end keeps the face the rule gives (`hold`); the other end leaves by its bottom face (`u`), and stage 5 sets that face. Stage 7a reserves the column-gap lane (`gap-lane:<link>:0`) at the centre of the free column beside the lateral end's unit, and its x is fixed (ADR-0010); the extent is replayed from the lateral port's y. A column that is too narrow, or a side run that crosses a body, refuses the course: nothing moves for it, and a column that has to open is not built. The lane is kept on its side of every unit of its band by the guard that holds every lane (`laneSidesHold`). Only the U part below the band is built; a U part above it (a top face) would cross the group title and needs a plan hung from the high boundary.

## Amendment (architecture-2 ticket 57, 2026-11-03)

**A tier gap is as high as its reservations need, and placement computes that height once.** This amends decision 2. The fixed point of
`growTierGaps` is gone, with its cap of six rounds, its trial copies, its hand-back in the 7f rounds and the counters `gapRounds` and
`invalidations.gapRegrown`. The original text above stays as the record of the earlier decision.

1. **The stem depths are decided once and recorded.** The fixed point existed because `sidePlan` nested a stem only when `legClear` found
   the nested leg clear of the tier across the gap, so the plan read after a growth could differ from the plan read before it. `legClear`
   now reads the nodes, group boxes and lanes of the stem's own sub-tier only. A growth of the gap cannot change a stem. The depths are
   recorded on the model (`stemDepths`: the node, the side and the reach of each port with a leg there). `[]` means decided, and no side
   nests. An absent record means a model from before the end of 7f or an older layout, and the readers derive the plan. `stemDepth`,
   `routerEntryPoints`, `stemCheckpoint`, stage 8 and the validator read the record. The validator and a restore refuse a record that
   differs from what the published geometry calls for (R5).
2. **One solve (`solveTierGaps`, `gap-room.ts`).** It runs once per 7f attempt, after the last move in x (`nestOverlayPorts`) and before
   `placeGroupTitles`. It records the stem depths, reads every plan once, reads the label term, and grows each gap by
   `max(0, H - room, label deficit)`. The bands below move by the running total, and a y-only rebuild follows with no centring. A rebuild
   that moves an x throws. The 7f rounds (`settleRound`) and the chord trials grow no gap. A label shortfall across a tier gap in the
   rounds is recorded and not moved; the validator and the room check count it as a fault. The lane reseat judge (`chooseReseat`) reads no
   short gap, because the solve runs after the reseat. `TIER_GAP_GROWN` names what set each gap: a part of the plan, or "the label of
   link-N". Stage 8 `unfitGaps` stays as a safety net (R6) and must not fire.
3. **The label term.** The room of a link label across a gap is read on a copy at the growth the gap takes anyway
   (`reserveLinkLabelRoom` with `gapRoom`), at most `LABEL_SOLVE_READS` (4) times. A room that still rises is given up
   (`labelRoomUnsettled`, `LINK_LABEL_ROOM_UNSETTLED`).
4. **The floor.** `floor = max(tierGapMin, gapBandDemand) - (low - bottom(above))`. `tierGapMin` is the larger of the tier-gap spacing and
   the node clearance plus the widest stroke; it is split from `bandGap`, which keeps the horizontal uses. `gapBandDemand` is the height
   of the bands that stand in the gap: a canton title band on the gap's edge (20 + title height + band extra + 20) and an across-frames
   mesh bus band (20 + band + 20). Two facing bus bands add (20 + upper + lower + 20). A canton band and a bus band on one edge add. Stage 4
   opens each gap to `tierGapMin`. Stage 6 (`reseatBands`) seats it at `max(gap, gapBandDemand)`. The start of 7f reserves the band height
   on the y axis only (`topUpBandClearance`).
5. **Known cost, accepted.** With no centring replay after the growth, three corpus sheets gain bends (`avd-cv-pathfinder-wan` 8 to 12,
   `a-corridor-moves-after-the-grid-settles` 174 to 176,
   `a-face-aligns-one-port-and-leaves-a-chord-port-in-place` 10 to 12), and `a-band-holds-the-group-that-set-its-edge` loses one held chord (link-28). A
   follow-up ticket for the centring is planned.
