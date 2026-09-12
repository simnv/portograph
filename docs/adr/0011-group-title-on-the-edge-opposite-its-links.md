# ADR-0011: Group title on the horizontal edge opposite its links

Status: accepted (maintainer, 2026-09-12)

A group's title band takes the horizontal edge with fewer incident routed link ports. A group fed
from above carries its title at the bottom; a group that feeds downward keeps it on top; ties,
including groups linked only through left/right ports (flanks), keep the top. The title stays
horizontal: for sideways-linked groups both horizontal edges are already clear, so a rotated title
on the outer edge buys nothing and costs a second label geometry.

Why: stage 7f used to place every title in the top padding. When links entered a group from above,
the title sat on the routes and 7f had to widen the group or move the label aside, and any miss
became a stage-8 detour around the title. Choosing the edge from frozen port topology removes the
conflict before it exists, in the spirit of the pipeline's load-bearing rule.

Consequences: `LabelBand.side` is part of the placement projection; band bounds, clearance,
group insets, initial space reservation and restore validation all read the side. Bottom bands grow
the group downward without moving its nodes. Placement, publication and restore compute the side
from the same topology, so it needs no separate persistence check.
