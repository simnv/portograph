# ADR-0019: A group is a column of ranks; a frame is derived, cells are laid out

Status: accepted (maintainer, 2026-09-29). Spec: `docs/design/ranked-groups.md`.
Supersedes the reading "one group = one tier band" in ADR-0006 and ADR-0008. Amends ADR-0012
and ADR-0013.

## Context

The Enterprise NTP sheet has 153 overlay links. Only 53 of them are drawn straight. The other 100
are drawn orthogonal, and in each case a node body stands on the straight segment. The overlay rule
is correct. Placement is the cause, for two reasons.

1. A group is one row of bodies. The reference (`docs/design/golden-4-enterprise-ntp.png`) draws
   a location as a column of short rows. Its physical links are short and vertical. The `row`
   shape draws sixteen devices as a 2 000 px bar. The `grid` shape packs them as a block, and its
   physical links become buses.
2. Overlay links have no say in position. After the skeleton, every stage that decides x, order or
   spacing skips the links that are not routed. A group with no routed link is left-packed while
   its partners stand thousands of pixels away.

## Decision

1. **Ranks are derived, not declared.** `deriveRanks` (`src/layout/ranks.ts`) takes the routed
   links inside one group. It runs longest-path layering from the anchors over the links that are
   not peer links. An anchor is a member with a routed link to the tier above (else to the tier
   below; `anchoredFrom`). A group with no anchor has one rank. `classRankOf`
   (`src/layout/rank-input.ts`) gives a class that a row of the tier-inference table names a class
   rank. A link is a peer link when both class ranks are defined and equal. A link with both ports
   fixed to `left` and `right` is also a peer link. `MIDDLE_CLASS_ROWS` splits the profile's one middle band into router,
   switch and server, so that a router-switch uplink is not a peer link.
2. **A rank cell is a sub-tier.** In stage 1, `expandRankedGroups` (`src/layout/rank-cells.ts`)
   replaces a group `G` that has `k > 1` ranks with `k` cells `G#0..G#k-1`. Each cell is a `row`
   group on its own sub-tier and carries `frame: G`. The document records `frames`. Sub-tiers are
   dense integers, so ELK partitioning and every reader of `group.tier` stay unchanged. A rank inside
   a child span becomes cell `child#r` (`frame: child`), not `G#r`. The parent has no cell at that
   rank. An expanded document is never expanded again.
3. **A frame is derived after placement.** `rebuildFrames` builds the drawn box of a group from
   its cells, as `rebuildBands` builds tier bands. The frame owns the label band, the title, the
   ADR-0013 obstacle and the drawio group. The renderer draws frames and never cells. (Lands with ticket 03.)
4. **One level of child groups.** A group may have a `parent:`. A child has no tier, no shape and
   no flank. It is a span of whole ranks inside its parent. Parse rejects the other cases
   (`CHILD_TIER`, `CHILD_SHAPE`, `CHILD_FLANK`, `NESTED_CHILD`, `PARENT_SHAPE`, `PARENT_FLANK`,
   `UNKNOWN_REFERENCE`).
5. **Overlay links weight order and place the free.** A frame with no routed link to another tier
   takes the mean x of its overlay partners. The order of frames in a tier and of nodes in a cell
   weights routed and overlay partners equally. A re-order stays only if the routed crossing count
   does not rise. (Tickets 05 and 06.)
6. **`ranked` is the default shape.** A ranked group with one rank is a `row` in every respect.
   `row` forces one rank. `grid` and `bar` stay explicit.

## Consequences

- "One group = one tier band" (ADR-0006, ADR-0008) now reads "one cell = one sub-tier band". The
  tier contract is unchanged. Bands are sub-tier bands, and G1 and G8 read cells.
- ADR-0013: the foreign-group obstacle is the frame, not the cell. A link that ends in a cell of `G`
  is not foreign to `G` and may cross the cells above it. The frame grows to hold its lane.
  (Lands with ticket 04.)
- ADR-0012: frames share the grid. Cells do not.
- New gate G9: a frame contains its cells and child frames, frames of one tier do not overlap, and
  no foreign node body lies inside a frame. It lands with ticket 03.
- Two deviations, accepted at ticket 02. The document default shape is renamed from `row` to
  `ranked`, and the layout JSON of a golden reads `ranked`. Its geometry is unchanged. A flank of a
  multi-rank group stands beside the first cell of that group, on that cell's sub-tier.
- An input with no intra-group routed link and no overlay link has the same geometry as on `main`
  after ticket 02. Its layout JSON differs only in the shape name `ranked`.

## Alternatives rejected

- **Recursive layout: lay out each group inside its parent, then lay out the parents.** Links that
  cross a group boundary need bridge ports. Two layouts must then agree on the position of each
  bridge port. Every stage that reads a link would learn a second coordinate system.
- **Column-major sheet: a location is a column, and the sheet is a row of columns.** It reverses
  the tier contract. Tiers stop being rows of the sheet, and every tier rule would need a
  transposed twin.
