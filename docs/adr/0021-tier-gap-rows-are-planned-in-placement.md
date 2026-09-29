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
   is no probe.
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
  `ROUTE_GAP_REJECTED` or `ROUTE_CHECKPOINT_SKIPPED` warning; the old seating removed none on the two
  fixtures that reach this state through a mocked growth (`unfit-gap.test.ts`). No input of the
  corpus reaches it.
- A chord is invisible to the plan (spec Section 1 item 5, S6): one chord within `k` of a planned
  drop on the NTP sheet, links 232 and 235, is a published G6 finding.

## Alternatives considered

- Keep the old allocation for the residual parts. Rejected on the measurement: it seated nothing
  for them, and it was 810 lines of `gap-runs.ts` (1058 became 245) that the plan's nine reasons no longer reach.
- Amend ADR-0015 in place. Rejected: six of its amendments describe the allocation and the height
  rule as one story, and a rewrite would lose the measured history. ADR-0015 carries a pointer.
