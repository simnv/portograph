# ADR-0018: A node side allocates the rows and tracks of every fan on it

Date: 2026-09-14 · Status: proposed (drafted from tickets 37, 40, 42, 43 and 44) · Decisions: pending

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
keeps the load-bearing rule. It answers tickets 42 and 44 and probably 37. It cannot answer ticket
43, where the two rows are port anchors and only placement can separate them, and it makes the room
a side needs depend on the order the fans are built, which is the property that made these defects
hard to see.

**(c) Leave the geometry and widen the gates' exemptions.** Rejected. The overlaps are real ink;
CONTEXT.md's invariants are what the renders are for.

## Consequences

The golden almost certainly moves: the target diagram has fans on sides that also carry other ports,
and per-side rows will not land where per-port rows did. That needs the maintainer's approval as a
re-baseline, so the work cannot start until this ADR is accepted.

Tickets 37, 42, 43 and 44 are all `needs-info` on this decision. Ticket 40's own defect is closed;
its reproducers are the evidence above.
