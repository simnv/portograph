# ADR-0013: Group boxes are geometry links respect

Status: accepted (maintainer, 2026-09-12)

A group box is not only a container. Two rules follow:

1. **No link through a foreign group.** A routed link never enters a group it does not attach
   inside, own a lane in the margin of, or cross a declared bar of. Stage 8 treats every other
   group box, grown by the edge margin, as an obstacle; the bundle channel router does the same;
   G2 fails a segment inside a foreign group (`through-group`).
2. **No link along a group edge.** From on or outside a box, no routed segment runs parallel to a
   group edge closer than the edge margin `GROUP_EDGE_LINK_CLEARANCE` (10 px) beyond half its own
   stroke — the same stroke-aware reading every G6 clearance uses. G6 fails one that
   does (`segment-group-edge`). Inside its own box a link turns in the group's padding; crossings
   at ports are perpendicular and stay free. Producers whose rows could land on an edge — shared-stem
   fans, cross-bundle fans, merge join/leave rows, the channel's innermost turn, bar bypass tracks —
   move the row one margin beyond the edge, and stage 7e reserves that room in its tier-gap capacity.

Why: the maintainer's fixture review found a link cutting through the `lower` group of
both-margins-full to get around two lanes, and a bundle member running exactly on the
`tier-group` boundary of shared-peer-port. Both read as the diagram not knowing where its own
boxes are. Stage 8 sees only nodes, labels and lanes as obstacles; producers computed rows from
port depth without looking at the group box.

Placement may not reserve what routing is then forbidden to use: `straightCorridorClear`, which pins
row and flank paths and reserves aligned feed corridors, treats foreign group boxes the same way.

Consequences: a foreign link that must pass a lane-filled margin goes around the neighbouring
group through the tier gutter, even when that is longer. The golden is unchanged: its links
already stay clear of foreign groups and edges.
