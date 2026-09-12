# ADR-0012: Linked groups share a grid

Status: accepted (maintainer, 2026-09-12; the 30 % cap confirmed by the maintainer the same day)

Two groups joined by a routed link share the extent across that link's direction: groups joined
by vertical (top/bottom) ports take one x-extent and width, groups joined by horizontal
(left/right) ports take one y-extent and height. The shared extent is the union of the two boxes,
and it applies only while neither box is smaller than that union by more than
`GROUP_GRID_MAX_GROWTH` (30 %) of it. Boxes only grow, nodes never move, and a union that would
overlap a third group or cross a reserved lane window is skipped. Chains (upper → bars → lower)
converge because every pass only merges extents; the pass is bounded at eight.

Why: the maintainer's fixture review showed stacks of linked groups whose boxes were a few pixels
apart in width and offset by a few more, which reads as noise. A shared grid reads as structure.
The cap keeps a small group from being inflated to a much larger partner: the maintainer first
asked for "about 10 %", the motivating fixtures need 21 % and 26 %, and the maintainer then
confirmed 30 %. The constant lives in one place.

Consequences: the rule runs in stage 7f before labels are planned, so titles centre in the shared
box; `fitRegionGroup` retains granted extents on both axes; publication and restore re-run the pass
on a copy and reject a model it would still change. The golden's providers, Datacenter and
Backbone share one x-extent, and both TBR flanks share the Datacenter's y-extent.
