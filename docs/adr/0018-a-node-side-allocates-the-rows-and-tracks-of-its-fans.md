# ADR-0018: A node side allocates the rows and tracks of every fan on it

Date: 2026-09-14 · Status: accepted (maintainer, 2026-09-14; option (a), after option (b) was built and measured) · Decisions: tickets 37, 42, 44

## Problem

A fan chooses its geometry from its own port and nothing else. `edgeAwareRows` puts its rows at
`MIN_STEM` out of that port and one pitch apart, moved only off a group edge (ADR-0013). The pitch
pass in `crossBundleFans`, and the evenly spaced `outputs` in `bundleFans`, put its tracks at the
members' far coordinates, spaced only against each other. Neither measures the result against the
rest of the node side: the other ports on it, the other fans on it, or the nodes and boxes the
corridor crosses. Four defects follow, each measured on a published render.

**The rows of two fans on one side are the same lines** (ticket 44). Both are `MIN_STEM` out of
their own port, and the rows run parallel to the side, so the peel runs are collinear. On ticket
44's fixture `bundleFans` peels link-1 out of `a.p` at x = 109.5 and `crossBundleFans` peels link-4
out of `a.r` at the same x = 109.5, sharing 35 px. G4.

**A track crosses a sibling port's row** (ticket 42). A port's own link leaves along its own
coordinate; the pitch pass does not know that row exists. On ticket 42's fixture link-2's track is
pushed to 89, which is 7.5 px from link-1's run out of `a.p` at 81.5. G6. Worse, on ticket 40's
second reproducer the tree at `b.u` gives link-1 the track 67, *past* `b.t`'s row of 94.5: the
bundle's endpoint order is inverted by a fan, the producer counts three inversions where placement
reserved for two, and layout throws `BUNDLE_CROSSOVER_CAPACITY`.

**A track crosses a node** (ticket 37). Joining a pinned row or flank path to its port's tree — the
whole of ticket 37 — makes the remainder a fan leaf. The leaf's track is then one pitch off the
pinned path's, and on the smallest fixture that is y = 89, exactly node `b`'s bottom edge, so the
leaf runs along it: G2 `through-node` and G6 `segment-node-clearance` replace the G4 the ticket set
out to fix. The corridor a fan needs is not reserved against the nodes beside it.

**Two port anchors are closer than the links leaving them** (ticket 43). Nodes of different heights
are top-aligned, so `a.p` at y = 81.5 and `c.p` at y = 71.5 are 10 px apart and the links leaving
them cannot clear each other however they are routed. This one is placement's, not the fan's, but it
is the same missing measurement: what a port's links need is decided without them.

All four break the pipeline's load-bearing rule in the same way. A fan's rows, its tracks and the
corridor they occupy are all discovered at 7d/7e from geometry that stages 3 to 6 fixed without
knowing a fan would be there.

## Decision (proposed): option (a)

**A node side is the unit that allocates fan geometry, and it allocates it at sizing.**

1. *Rows are per side, not per port.* A side's rows are one sequence, `MIN_STEM + k * pitch` from
   the side, moved off group edges as now. Every fan on the side draws from that one sequence, and
   no two fans take the same row. The deepest row the side uses is what `fanDepth` reserves.
2. *Tracks are per side, not per fan.* The side's tracks are the union of its ports' own coordinates
   and the slots the fans need between them. A fan's member takes the free slot nearest its far
   coordinate; it never takes a slot that is a port's own row, and it never passes one, so a fan
   cannot reorder a bundle.
3. *The side's budget is reserved at sizing.* A port carrying `k` routed links needs `k` tracks of
   tangential room and contributes `k` rows to the side. Stage 3 grows `sidePitch` and the node box
   to hold them, exactly as `bundleFans` already grows the pitch for an inverted bundle; stage 5
   keeps the corridor beside the side clear of foreign nodes to the side's deepest row.

Then ticket 37 is what its own text says — the row and flank producers call `treeCohorts` and
`splitUnderJunctions` — because the tree the pinned path joins has somewhere to put its members.

## Options considered

**(b) Move each row and track outward until clear, the way `clearOfGroupEdges` moves a row off a
group edge.** Cheapest, local to `edgeAwareRows` and the pitch pass, and still placement-time, so it
keeps the load-bearing rule. **Built and measured on 2026-09-14, at the maintainer's request, then
reverted.** It costs the approved golden nothing and does not work.

Both halves were written: rows offset by the rows the fans before them on the side have taken,
ordered by their own coordinate so the result does not depend on producer order; and tracks stepped
over every sibling port row on the side, exactly as the pitch pass already steps over a fixed
member's track. Each half alone, and both together, leave `goldens/m1-sip-edge.svg` **byte-identical**
with `Q = 0.8986107135065587`.

On the fixtures the tickets are about, it turns scored gate failures into hard pipeline failures:

| fixture | on `main` | rows only | tracks only | both |
| --- | --- | --- | --- | --- |
| ticket 44 | publishes, G4 + G6, Q 0.2726 | `BUNDLE_CROSSING_MISMATCH` | `BUNDLE_BEND_CONTACT` | `BUNDLE_BEND_CONTACT` |
| tickets 42/43 | publishes, G6, Q 0.4637 | unchanged, Q 0.4637 | envelope rejection | envelope rejection |
| ticket 40's second | `BUNDLE_CROSSOVER_CAPACITY` | — | envelope rejection | envelope rejection |

Two existing tests fail as well (ticket 41's tree fixture and the e2e gate-failure case).

The reason is the one the option's own paragraph gives, and it is fatal rather than untidy: moving a
row or a track outward consumes room `fanDepth` never reserved. The bundle machinery then measures
its inversions, its crossings and its envelope against geometry placement did not plan, and rejects
the result outright. Option (b) cannot be separated from the reservation, and the reservation is
option (a).

Ticket 43 was already outside (b)'s reach: its two rows are port anchors, and only placement can
separate them.

**(c) Leave the geometry and widen the gates' exemptions.** Rejected. The overlaps are real ink;
CONTEXT.md's invariants are what the renders are for.

## Consequences

The golden almost certainly moves: the target diagram has fans on sides that also carry other ports,
and per-side rows will not land where per-port rows did. That needs the maintainer's approval as a
re-baseline, so the work cannot start until this ADR is accepted.

Tickets 37, 42 and 44 are unblocked by this decision. Ticket 40's own defect is closed; its
reproducers are the evidence above.

**Ticket 43 is not decided here, and listing it above as a motivating defect overstated what this
ADR does.** Its two rows are node port anchors in different nodes, fixed by stage 5's per-node
centring (`node-geometry.ts:39`) and merely exposed by stage 6's top-alignment (`rows.ts:30-42`).
None of option (a)'s three clauses compares one node's anchor with another's; a side's own budget
cannot separate them. It needs a decision of its own and blocks nothing here.

## Amendment (2026-09-15, from tickets 37 and 45): rule 3's second clause is a reservation, not a move

Rules 1 and 2 shipped with tickets 44 and 42. Rule 3 reads "stage 5 keeps the corridor beside the
side clear of foreign nodes to the side's deepest row". Measured against ticket 37's tier-below
reproducer, that sentence names the wrong stage and the wrong remedy: the corridor there is the
whole height of a tier gap, and no placement move can clear it. What the reproducer needs is what
the fan does *inside* the corridor. Rule 3's second clause therefore reads:

**A fan reserves the run each branch takes, at a coordinate that keeps the gate's clearance from
every node standing in the corridor that run crosses.** Three parts, all in 7e:

1. *Where a branch turns.* A far port that faces the side stands at its own coordinate along it. A
   far port whose normal runs *along* the side stands on its own node's edge, so a branch that
   turned there would run along that node by construction. Such a branch turns at that port's
   **outward checkpoint** instead, which is where the port's own approach begins.
2. *What a track is measured against.* Rule 2 spaces a track against the other port rows on the
   side. It is now also spaced against the nodes beside the side: every node whose routing obstacle
   stands in the band the branch's run crosses is a wall, and the track steps to the side of it its
   own far end is on. The reach is `routeObstacles`' own, so the room the fan reserves is the room
   the gates measure.
3. *Where a branch stops.* A branch reaches the tree's common end, except one whose far port's
   normal runs along the side: that branch stops where the far port's normal stands, never short of
   its own peel row. Ending it at the common end beyond that leaves stage 8 to retrace the reserved
   run to come back, which `validateRoutedPaths` rejects outright.

Stage 8 is then left with the port's own approach and nothing else. The approved golden is
byte-identical.

**Scope.** This is `crossBundleFans`, the plain-fan producer, as rule 2 is. `bundleFans`' own
`outputs` map is untouched: a bundle's members reach a channel their bundle placed, not a far port's
checkpoint, and no reproducer reaches it. A branch whose far port stands *behind* its own peel row
keeps the sub-pitch jog to that port; that piece is the port's own approach, which stage 8 owns.

**The first clause is still open.** "Stage 3 grows `sidePitch` and the node box" is not implemented,
and `mutation.ts` still lets only the `flanks` rule change `sidePitch`. Nothing above needs it: a
track moves along the side, not out of it, so it consumes no room `fanDepth` reserved. A fan that
cannot find a clear track on its own side will need it.
