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

Stage 8 is then left with the port's own approach, and with whatever lies beyond the fan's own
depth. The two limits are named below.

A branch stops where its far port's own approach *begins*, not at that port: a port that faces the
side is approached along the side's normal, so its approach begins one router stem short of it. An
approach that begins behind the branch's peel row cannot be reached by travelling outward at all;
such a branch hands over on its peel row while its own track still travels towards the far port, and
keeps the tree's common end otherwise, so that it hands over pointing outward with room to turn
rather than on the corner of its own descent.

**Scope.** This is `crossBundleFans`, the plain-fan producer, as rule 2 is. `bundleFans`' own
`outputs` map is untouched: a bundle's members reach a channel their bundle placed, not a far port's
checkpoint, and no reproducer reaches it. A branch whose far port stands *behind* its own peel row
keeps the sub-pitch jog to that port; that piece is the port's own approach, which stage 8 owns.

**A track never steps past a sibling row.** Rule 2 says a track stays on the side of a sibling row
its own far end is on, because stepping past one reorders the members against their endpoints. Where
a wall leaves no slot on that side, the fan keeps the track rule 2 gave it and the gates report the
node the branch meets. A gate failure is recoverable; a reordered bundle throws.

**What is still left to stage 8.** A branch whose far port stands *beyond* the tree's common end
stops at that end, and the run from there to the port is stage 8's. It cannot be reserved here: the
depth beyond `fanEnd` is room `fanDepth` never reserved, which is exactly the failure option (b) was
measured into and rejected for. Turning at the far port's outward checkpoint keeps that unreserved
piece clear of the far node, which is what the defect above was about; reserving it outright is a
reservation of depth, and it belongs with rule 3's first clause.

**The first clause is still open.** "Stage 3 grows `sidePitch` and the node box" is not implemented,
and `mutation.ts` still lets only the `flanks` rule change `sidePitch`. Nothing above needs it: a
track moves along the side, not out of it, so it consumes no room `fanDepth` reserved. A fan that
cannot find a clear track on its own side will need it, and so will a branch whose far port stands
beyond the tree's end.

## Amendment (2026-09-15, from ticket 37): a row gap holds two fans, not one fan and a stem

A pinned row path whose two ports both carry a fan is the straight-through leaf of *both* trees, and
each end splits the one path from its own side. `rowGap` reserved the deeper side's `fanEnd` plus the
far side's **stem**, which is the room for one continuation, so the second split re-owned the stems
the first had written and the first tree then claimed a run its own member no longer drew (G4, and a
result that depended on the authored direction). The gap now also reserves `fanEnd + fanEnd` wherever
a link joins a fan port on one side to a fan port on the other. Where that room is absent — a flank
path, a gap another rule fixed — `joinFanTrees` joins the deeper tree only, and the other reports the
member with `FAN_MEMBER_UNRESERVED`, which is the behaviour before ticket 37.

Two fans that face each other across a gap still take one row, because ADR-0018 allocates per node
side and two facing sides are two sides. That is ticket 46, and it is the same family as ticket 44
one gap over.

## Limits of rule 3 as built (2026-09-15, from the in-house review of tickets 37 and 45)

1. **A track is tested, a run is not.** `blockedTracks` measures the coordinate a branch turns at
   against the nodes and the reserved attachment stems in the corridor. It does not measure the
   descent from the port to that coordinate, nor the outward run to where the branch stops.
   `legClear` (`sides-two.ts`) is the check that measures a whole leg and is not used here.
2. **A side port never aims at its own lane.** `laneX` reads a lane only for a top or bottom port, so
   a branch out of a left or right side that transits a tier descends on its fan's row instead of on
   the lane reserved for it, and stage 8 climbs back. Measured: a descent at x = 181 beside a lane at
   x = 166, with the router climbing 215 px; the same on `main`, so it is not this work's, but the
   sentence above would otherwise claim more than the rule does.
3. **A gate failure is recoverable and a throw is not, so a branch the router cannot work with is
   released rather than reserved.** Two cases are built, both of them fail-closed and both of them
   guesses that the measurement in (1) would settle properly:

   - A branch whose far port stands in the corridor and whose own run would end deeper than that
     port's approach begins keeps the tree's shared stem and nothing else (`FAN_BRANCH_UNRESERVED`).
     A far port *behind* the fan is left alone: the fan's own node lies across any line back, so the
     run is not retraced, and releasing it costs ticket 41's fixture a gate.
   - A fan reserves its branches one cohort at a time, so a run one cohort lays can close the
     checkpoint another link's port has to be approached from — the runs need not meet, it is enough
     that they leave the router less room than it nudges by. A post-pass releases the branch that
     hems and every branch of the link it hems (`FAN_BRANCH_HEMMED`). Ports on the hemming fan's own
     node side are exempt, because a fan's own siblings stand a pitch away by construction and
     treating them as hemmed undoes the tracks rules 1 and 2 reserve.

     **Only an end that reserved nothing can be hemmed** (stress ticket 10). An end whose own fan
     reserved a run is approached at that run's terminal and not at the port, so the port's
     checkpoint always stands inside a reservation the link itself owns and closing it costs the
     link nothing. Measuring the port at every end released branches whose approaches were never
     shut, and the release is not free: it pins the gap's end in the middle of the tier gap and the
     route the router finds for one released link can wall in the point another has to reach.
     Measured on five corpus inputs, libavoid then dropped that end without a word and answered with
     a diagonal, which stage 8 refuses. The rule is that a release must leave the router a gap it can
     answer orthogonally; where nothing is closed there is nothing to release.

     A reserved terminal **can** be shut in turn, and this rule does not claim otherwise: of 1 099
     corpus inputs, 35 hold a reserved terminal inside a foreign reserved run's margin and 27 of the
     35 fail the pipeline — `wide-t3-p3-f2-s1` answers the gap (448, 313) → (461.667, 434.5) with the
     diagonal ticket 10 is about, its terminal closed by runs at y = 427.75 and y = 445.25 against an
     11.5 px margin. What is measured is that a release does not open it: built and swept over those
     35, releasing on a closed terminal as well repaired none and broke 8 (`wide-t4-p2-f2-s2/s3`,
     `wide-t4-p4-f2-s3`, `wide-t5-p2-f2-s2`, `wide-t6-p2-f2-s2/s3`, `wide-t6-p4-f2-s3`,
     `wide-t8-p2-f2-s2`). A closed reserved terminal needs a rule that places the terminal, not one
     that drops it; stress ticket 11 owns it.

     A link the router never approaches cannot be hemmed at its port either: a rule-fixed path and a
     bundle member both carry a complete path when stage 8 plans, so `planRoute` passes over them and
     asks for no checkpoint at their ports. The exclusion is read from `path.fixed` and `bundle`,
     never from the presence of a `path`, which after stage 8 every link carries.
