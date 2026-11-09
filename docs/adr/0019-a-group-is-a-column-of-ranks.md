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
   links inside one group. It takes the breadth-first depth from the anchors over the routed
   links inside the group, and a member's rank is its depth. A link between two members of equal
   depth is a peer link; a link from depth k to depth k+1 is a down link. An anchor is a member with
   a routed link to the tier above (else to the tier below; `anchoredFrom`). A group with no anchor
   has one rank. A link with both ports fixed to `left` and `right` is also a peer link. (Amended by
   ranked-groups ticket 27: a first version read a class rank per node class, `classRankOf` and
   `MIDDLE_CLASS_ROWS`, and a location of one class collapsed to one rank. The class table is no
   longer read.)
2. **A rank cell is a sub-tier.** In stage 1, `expandRankedGroups` (`src/layout/rank-cells.ts`)
   replaces a group `G` that has `k > 1` ranks with `k` cells `G#0..G#k-1`. Each cell is a `row`
   group on its own sub-tier and carries `frame: G`. The document records `frames`. Sub-tiers are
   dense integers, so ELK partitioning and every reader of `group.tier` stay unchanged. A rank inside
   a child span becomes cell `child#r` (`frame: child`), not `G#r`. The parent has no cell at that
   rank, unless the child is a leaf child. A leaf child (it feeds no deeper member and holds no anchor)
   pushes nothing and keeps its depth ranks (ticket 28, which replaced ticket 19's "after the last rank
   of the rest"): the parent members of those ranks keep their rank and stand in the parent's own cells
   `G#r` of the same sub-tiers, in a column beside the child frame. Only a child that feeds a deeper
   member, or holds an anchor, pushes the parent members out of its span.
   An expanded document is never expanded again.
3. **A frame is derived after placement.** `rebuildFrames` builds the drawn box of a group from
   its cells, as `rebuildBands` builds tier bands. The frame owns the label band, the title, the
   ADR-0013 obstacle and the drawio group. The renderer draws frames and never cells.
4. **One level of child groups.** A group may have a `parent:`. A child has no tier, no shape and
   no flank. It is a span of whole ranks inside its parent. Parse rejects the other cases
   (`CHILD_TIER`, `CHILD_SHAPE`, `CHILD_FLANK`, `NESTED_CHILD`, `PARENT_SHAPE`, `PARENT_FLANK`,
   `UNKNOWN_REFERENCE`).
5. **Overlay links weight order and place the free.** A frame with no routed link to another tier
   takes the mean x of its overlay partners. The order of frames in a tier and of nodes in a cell
   weights routed and overlay partners equally. A re-order stays only if the routed crossing count
   does not rise. See Consequences. **Veto kept (D19, decision review V2, third round, 2026-11-07):** a re-order that adds a routed crossing to straighten overlay links stays refused. Placement cannot see the routed bends that decide the gain: the draft predictor of the second round saw no gain (V2b: precision 16 % for a link not aligned), and the stricter predictor of the third round had precision 45 % and recall 17 % (V2c; 384 predicted-straight links end bent). A placement-time bend predictor was built and measured as ticket 09 (`bend-predictor.ts`): precision 24.5 %, recall 32.1 %, against targets of 80 % and 60 %; a trial round with the veto removed kept one sheet of six. The veto stays and the predictor is not merged.
6. **`ranked` is the default shape.** A ranked group with one rank is a `row` in every respect.
   `row` forces one rank. `grid` and `bar` stay explicit.

## Consequences

- "One group = one tier band" (ADR-0006, ADR-0008) now reads "one cell = one sub-tier band". The
  tier contract is unchanged. Bands are sub-tier bands, and G1 and G8 read cells.
- ADR-0013: the foreign-group obstacle is the frame, not the cell. A link that ends in a cell of `G`
  is not foreign to `G` and may cross the cells above it. The frame grows to hold its lane.
  A link that is foreign to `G` never enters the frame. It gets one lane x outside the frame for
  all the sub-tiers it crosses.
  A lane that a frame holds is reserved before a foreign lane, and it stays on its frame's side of
  a foreign frame (tickets 23 and 26).
- ADR-0012: frames share the grid. Cells do not.
- New gate G9: a frame contains its cells and child frames, frames of one tier do not overlap, and
  no foreign node body lies inside a frame. `frameGate` (`src/score/gates.ts`) checks it.
- Rank cells carry no padding. The rank gap is 60 px, the band gap between the bodies of adjacent
  ranks of one group. The frame edge is the outermost body plus 20 px per side, plus the label
  band on the title side. The first and last cell hold the 20 px margin. A parent frame keeps 20 px
  around a child frame. It takes that margin from the tier gap, and 40 of the 60 px remain.
- Sibling frames of one tier are disjoint columns (tickets 09, 11, 12). A column is the frame box
  plus `COLUMN_SLACK` (20 px) on each side. `packFrameColumns` packs the columns anchor tier
  first, then outward. Each column axis lands on the mean x of its routed feeds. Each frame moves
  as a whole, with one dx for all its cells. `separateFrameColumns` restores the gap after the
  `rows` rule has set the real widths. Centring spends the slack. It never leaves less than a
  band gap between two frame boxes.
- Overlay placement (ticket 05). `placeOverlayFree` puts a group with no routed link at the mean x
  of its overlay partners. Partners in the same tier are excluded. `centre` runs the pass again
  after each centre pass.
- Overlay order (tickets 06 and 06b). Overlay links weight the order of the groups and nodes of a
  tier (`orderByOverlay`) and of the frames of a document tier (`orderFramesByOverlay`). Each tier
  accepts a re-order only if three conditions hold. The routed crossings do not rise. The straight
  overlay links do not fall. The routed links inside one sub-tier with a body between their ends
  do not rise. A refused re-order keeps ELK's order and warns `OVERLAY_ORDER_REFUSED`.
- Limits. `FRAME_TITLE_UNHOSTED` warns only when a child spans every rank of its parent. A member
  with a routed link to the tier above is an anchor and always has rank 0. A flank of a multi-rank
  group stands beside the first cell of the group.
- Two deviations, accepted at ticket 02. The document default shape is renamed from `row` to
  `ranked`, and the layout JSON of a golden reads `ranked`. Its geometry is unchanged.
- An input with no intra-group routed link and no overlay link has the same geometry as on `main`
  after ticket 02. Its layout JSON differs only in the shape name `ranked`.

## Alternatives rejected

- **Recursive layout: lay out each group inside its parent, then lay out the parents.** Links that
  cross a group boundary need bridge ports. Two layouts must then agree on the position of each
  bridge port. Every stage that reads a link would learn a second coordinate system.
- **Column-major sheet: a location is a column, and the sheet is a row of columns.** It reverses
  the tier contract. Tiers stop being rows of the sheet, and every tier rule would need a
  transposed twin.
