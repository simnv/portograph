# ADR-0012: Linked groups share a grid

Status: accepted (maintainer, 2026-09-12; the 30 % cap confirmed by the maintainer the same day)

Amended by ADR-0019 (2026-09-29): the grid is shared by frames, not by rank cells.

Two groups joined by a routed link share the extent across that link's direction: groups joined
by vertical (top/bottom) ports take one x-extent and width, groups joined by horizontal
(left/right) ports take one y-extent and height. The shared extent is the union of the two boxes,
and it applies only while neither box is smaller than that union by more than
`GROUP_GRID_MAX_GROWTH` (30 %) of it. Boxes only grow, nodes never move, and a union that would
overlap a third group or cross a reserved lane window is skipped. Chains (upper → bars → lower)
converge because every pass only grows extents onto existing box edges; the pass cap is groups × linked
pairs + 2, and exhausting it diagnoses `GROUP_GRID_NON_CONVERGENCE` instead of failing publication.

Why: the maintainer's fixture review showed stacks of linked groups whose boxes were a few pixels
apart in width and offset by a few more, which reads as noise. A shared grid reads as structure.
The cap keeps a small group from being inflated to a much larger partner: the maintainer first
asked for "about 10 %", the motivating fixtures need 21 % and 26 %, and the maintainer then
confirmed 30 %. The constant lives in one place.

Consequences: the rule runs in stage 7f before labels are planned, so titles centre in the shared
box; `fitRegionGroup` retains granted extents on both axes; publication and restore re-run the pass
on a copy and reject a model it would still change, unless that replay itself exhausts the cap. The golden's providers, Datacenter and
Backbone share one x-extent, and both TBR flanks share the Datacenter's y-extent.

## Amendment (2026-09-30, ticket 136): the grid gives way to the pack

The grid widens a box in place, and the derived frame widens with it. A beside row (`packBesideRows`) stood packed against the narrower frame. On a hinted run the pack moved the row and the grid put the moved box back onto the extent of its partner, so the two rules stepped against each other and no round bound could end it. The published layout must be at the fixed point of the pack, so the grid gives way: it refuses a widening that changes which groups the pack would move (judged row by row, on a copy), and the pair keeps its own extents. `GROUP_GRID_YIELDS_TO_PACK` (info) names the pair. A row that stood open before the grid is packed once after it, and the pair of rules ends by a round bound of 2; a grid that still widens after that leaves the grid aligned and raises `GROUP_GRID_NON_CONVERGENCE`, which the next call that settles withdraws. Publication and restore read the same refusal, because they re-run the grid function itself. See Q110 in `docs/design/decisions-log.md`.
