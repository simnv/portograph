# Ranked groups — design

Status: approved in conversation 2026-09-29, spec for implementation. Supersedes the `grid`
shape as the default; `grid` stays as an explicit shape. Owner: maintainer.

## Problem

On the Enterprise NTP sheet 100 of 153 overlay links are drawn orthogonal, every one because a
node body stands on its straight segment. The overlay rule (`CONTEXT.md`, *overlay*) is correct
and unchanged. Placement is the cause, for two structural reasons:

1. **A group is one row of bodies.** The reference (`docs/design/golden-4-enterprise-ntp.png`)
   draws a location as a column of short rows — wan, NTP server, switch, switch pair, router pair —
   so its physical links are short and vertical. `row` draws sixteen devices as a 2 000 px bar and
   `grid` packs them as a block whose physical links become buses.
2. **Overlay links have no say in position.** After the skeleton, every stage that decides x, order
   or spacing filters `link.layer !== 'routed'`. A group with no routed links (every client group)
   is left-packed at x ≈ 12–800 while its partners stand at x ≈ 3 000–4 400.

Decisions taken (maintainer, 2026-09-29): ranks are derived from the physical links, not
declared; overlay links weight the order of groups in a tier and place groups that routed links
leave free; a child group (Zone 16) is a span of whole ranks, one level deep; the grid work of
tickets 34–36/38 is parked on `wip/grid-tickets`.

## Vocabulary (to be added to `CONTEXT.md`)

| Term | Definition |
|---|---|
| **rank** | An integer ordering of a group's members from the top of the group, derived from the routed links inside the group. Rank 0 holds the members that link to the tier above. |
| **rank cell** | The layout group that holds the members of one rank of one document group. A cell is a `row` group to every stage; it has its own sub-tier, no label, no padding of its own and no frame. |
| **sub-tier** | One entry of the dense tier list the layout runs on. Document tier `t` expands to `R(t)` sub-tiers, where `R(t)` is the largest rank count among the groups of tier `t`. Sub-tiers are integers; every stage that reads `group.tier` reads a sub-tier. |
| **frame** | The drawn box of a document group: the union of its cells plus group padding and its label band, derived after placement the way tier bands are. The frame is the ADR-0013 obstacle and the ADR-0011 title owner. A **child frame** is the frame of a child group, drawn inside its parent's frame. |
| **ranked** | The default group shape. A ranked group with one rank is a `row` in every respect. |

Invariant 2 becomes: *A node has exactly one group. A group may have one parent group; a child
group has no tier of its own and is a span of whole ranks inside its parent.*

## Section 1 — Rank derivation (`src/layout/ranks.ts`, pure)

Input: one document group, its members, the routed links between them, and the routed links
from members to other tiers. The node class decides nothing here (ticket 27): a location whose
members are all one class, as a converter emits them, has the same ranks as one whose classes
differ.

1. **Anchors.** A member with a routed link to the tier above is an anchor at rank 0. If none
   exists, the members with a routed link to the tier below are anchors at the last rank and the
   layering runs upward. If neither exists, the group has **one rank**: ranks exist to make the
   links toward the anchors short and vertical, and a group with no anchor has nothing to be above,
   so its internal routed links are peer links (decided 2026-09-29 on ticket 02: without this rule
   any two members joined by a link became a column).
2. **Depth and peer links.** The **depth** of a member is its breadth-first distance from the anchor
   set over the routed links inside the group, read as undirected. A routed link between two members
   of equal depth is a **peer link**: it never lengthens a path, and its two ends share a rank. A
   link from depth k to depth k+1 is a **down link** from the shallower member. A link whose two
   ports the author fixed to `left`/`right` is also a peer link: the two ends, and every member
   joined to them by such links, count as one node for the depth. The class rank table no longer
   decides peer-ness, and nothing reads it (ticket 27).
3. **Layering.** Longest-path layering over the down links. Every down link rises by exactly one
   depth and peer components sit at one depth, so a member's rank is its depth. A link can skip a
   rank only through step 5 (a child span push) or step 6.
4. **Cycles.** A ring needs no rule: depth is defined by hops, so a link closing a ring joins two
   members of equal depth (a peer link) or of depths one apart (a down link).
   *Twin lift, dropped (ticket 27).* An idea kept for the record: lift a member that shares its
   neighbours with a shallower twin up to the twin's rank. No rule of this kind separates the
   reference `wrt004` from `wrt001` and `wrt002` (K4 twins around `wrt003`), or `b` from `c` in a
   triangle under one anchor, so it is not part of the derivation.
5. **Child group.** A child's members take rank `max(own, first rank of the child)` and the child's
   span is `[min, max]` of them. A parent member whose rank falls inside the span, and who is not a
   child member, is pushed to the rank after the span. A child span is therefore whole ranks.
   A child whose members have no routed link to a deeper member outside the child (a leaf child)
   and hold no anchor pushes nothing (ticket 28): it keeps its depth ranks, and the parent members
   whose rank falls in its span keep their rank too. They stand in the parent's own cell of that
   rank, beside the child, so one sub-tier can hold both `G#r` and `child#r`. A child span is whole
   ranks in y only. Only a child that feeds deeper members, or holds an anchor, pushes the parent
   members out of its span. An overlay-only leaf child still goes after the last rank of the rest
   (step 6). A group anchored from below has no leaf rule. (Ticket 19 put every leaf child after
   the last rank of the rest of the group; ticket 28 replaced that rule with the depth ranks.)
6. **Overlay-only and unreached members.** A member no anchor reaches over the routed links (it has
   no routed link inside the group, or only routed links to members no anchor reaches) takes the
   rank of its nearest overlay partner in the group that has one, else the last rank. In a group anchored
   only from below the last rank is the anchors' own rank, so an unreached member stands beside them.
7. **Output.** `rank` per member, `rankCount` per group, `span` per child group. No geometry.

Alignment across a tier: a group anchored from above puts rank 0 at the tier's first sub-tier; a
group anchored only from below puts its last rank at the tier's last sub-tier. Sibling locations
therefore align their ranks by index, as the reference draws them.

Fixtures (`goldens/synthetic/`): a plain chain; a peer pair under one uplink; a cycle
`sw–sw–rt–rt`; a child span with a parent member pushed below it; an overlay-only member; the
six-body collapse (16 members of one class, six ranks), the triangle and the twin quad
(`a-peer-link-*`, ticket 27).

## Section 2 — Rank cells and frames

**Expansion (stage 1, resolve).** After ranks are derived, every document group `G` in tier `t`
with ranks `0..k-1` is replaced in the layout document by cells `G#0..G#k-1`. Cell `G#r` is a
`row` group at sub-tier `offset(t) + r` (or bottom-aligned, see above) and carries
`frame: G`. Sub-tiers are re-densified to `0..n` so ELK partitions and every `group.tier` reader
stay integers. `tierBands` are sub-tier bands. Nothing in stages 2–8 learns a new concept: lanes,
tier-gap allocation, same-tier links (`rt001 ↔ rt002` is a same-sub-tier link), label rules and
corridors run on cells unchanged.

**Frames (new, `src/layout/frames.ts`).** `rebuildFrames` derives, like `rebuildBands`, one frame
per document group: the union of its cells' boxes, grown by group padding (20 px) on every side,
plus the label band on the title edge. A child frame is the union of its span's cells plus padding;
the parent frame grows to hold the child frame plus padding. The layout JSON gains `frames`; the
renderer draws frames and never cells.

**Beside (ticket 28).** A leaf child shares sub-tiers with parent cells. In x the child frame is a
column inside the parent frame, and the parent's cells of the child's ranks are a disjoint column
next to it, `COLUMN_SLACK` (20 px) apart. The child goes on the side its overlay partners favour
(the mean x of the partners outside the frame, against the mean x of those parent cells); a tie
puts it on the right, in declaration order. `packFrameColumns` reads the stands of all frames
before it moves a cell. `separateFrameColumns`, `columnShifts` and `holdColumnAxes` move the child
frame and the parent cells as two columns of one parent, and centring keeps each cell inside its own
column (`besideWalls`). A parent link that passes the child's ranks to reach a parent cell beside
the child is foreign to the child and stays outside the child frame.

**What cells are exempt from:** the label band (`bandFor` returns none for a cell; the frame owns
one), ADR-0011 title placement, ADR-0012 linked-group grid (frames share the grid, cells do not),
group padding, and the ADR-0013 obstacle. **What frames own:** the label band, whose room is
reserved in the frame's first cell only (`reserveInitialSpace` shifts rank 0 alone); the title,
placed by ADR-0011 from the frame's incident links; the foreign-group obstacle and the G2 / G6
group-edge rules; the drawio export group.

**Gates.** G1 (`group inside its tier band`) and G8 read cells. New G9: every frame contains its
cells and its child frames, frames of one tier do not overlap, and no foreign node body lies inside
a frame. `validateSkeletonBands` and `mutation.ts` keep their checks on cells.

**Transit through a frame.** A link that ends in cell `G#3` and arrives from above crosses
sub-tiers of `G#0..G#2`. It is not foreign to `G`, so ADR-0013 permits the passage; the lane is
reserved beside the crossed cells as today, and the frame grows to hold it. A link foreign to `G`
never enters the frame. A lane that a frame holds is reserved before a foreign lane, and it stays on
its own frame's side of a foreign frame (tickets 23 and 26). A fixed-point rule (reserve, grow, place
the foreign lane, repeat) was replaced: it does not converge, because lane x is immutable and frame
growth only grows.

**Shapes.** `ranked` is the default. `row` forces one rank. `grid` and `bar` are unchanged and
explicit. A ranked group with one rank is indistinguishable from a `row` group, so every input
without intra-group routed links renders as before.

## Section 3 — Overlay links in placement

1. **Barycentre for the free.** After the skeleton and before `centre.ts` runs its steps, a frame
   whose cells have no routed link to another tier is placed at the mean x of its overlay
   partners' centres, then de-overlapped against its tier siblings with the band gap, keeping the
   order the barycentre gives. A single node with no routed links inside a cell is ordered in its
   cell by the same key. Routed geometry never moves because of this rule.
   A free frame whose box lies wholly outside the x-span of its settled overlay partners in other
   tiers first takes the nearest edge of that span (the into-span pre-step, ticket 22). The move stays
   only when the total overlay chord length of the moved groups falls; else the tier goes back.
2. **Order in a tier.** The order of frames in a tier, and of nodes in a cell, is the barycentre of
   partner positions in the adjacent sub-tiers and of overlay partners anywhere, routed and overlay
   weighted equally; one downward sweep then one upward sweep from the anchor tier; ties keep the
   ELK order. The re-order is accepted per tier only when the routed crossing count of that tier's
   regions does not rise.
3. **ELK keeps the overlay edges.** ELK still reads the overlay links between tiers, because they
   place x for straightness. A filter that hid them from ELK was tried and rejected (ticket 18): ten
   overlay tests regress. Ticket 18 re-seats the bands after `flattenRows` instead, so the height
   ELK gave a band no longer shows as gap between bands.
4. **Alignment stops at a chord.** Alignment growth of a body stops short of an overlay chord
   (`ALIGNMENT_STOPPED_AT_OVERLAY`, ticket 29). The bound of 12 stays.
5. **A link inside one frame is a chord.** A routed link with both ends in one frame, and a
   group-link member likewise, takes one straight segment where it clears every body (tickets 34
   and 38). `docs/design/pipeline.md` Stage 6 has the rule.
6. **Sides.** No change. A same-sub-tier overlay pair takes `left`/`right` and rides the row; a
   cross-sub-tier pair takes `top`/`bottom`.

## Section 4 — Converter and inputs

`scripts/conversion/drawthe_net.py` already applies innermost-box-wins (ticket 33). It stops
emitting `shape: grid`, emits `parent:` on a box that lies inside another box, and emits no rank
information. Explicit `tier:` stays on top-level groups only; a `tier:` on a child is a parse error.

## Section 5 — Measurement and gates

Metric on the NTP sheet (`/tmp/ntp-diag/ntp.yaml`, 106 nodes, 312 links): straight overlay links,
baseline **53 of 153**; removed links, baseline 0 with the ticket-22 fix; canvas area and Q
recorded beside them. Guard against a gamed count: collinear-overlap count (ticket 21).
Corpus: the geometry differential over `goldens/` and `goldens/synthetic/` against main, per input.
An input without intra-group routed links and without overlay links must be byte-identical in
layout JSON: a one-rank group's frame is today's group box. An input with overlay links is compared
per input, and a move is accepted only where the straight overlay count rises or holds, or where
the group entered the x-span of its overlay partners (a group with no routed link that stands outside
that span is first moved into it, accepted on the total length of its overlay links; ticket 22).

## Section 6 — Docs

ADR-0019 *A group is a column of ranks; a frame is derived, cells are laid out* (supersedes the
"one group = one tier band" reading of ADR-0006/0008 and amends ADR-0013). `CONTEXT.md`: the terms
above, invariant 2, the default shape, and the *grid* entry marked explicit. `docs/design/pipeline.md`:
stage 1 expansion, `rebuildFrames`, G9. ADR-0012: frames share the grid.

## Out of scope

Nesting deeper than one level. Overlay links widening gaps to open a sightline. A `rank:` override
in YAML. The `grid` faults of tickets 34–36/38 (parked).
