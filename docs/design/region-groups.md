# Region groups — design

Status: proposal, 2026-09-29, for the maintainer's review. No code changed. Extends
`docs/design/ranked-groups.md`, whose out-of-scope line is *nesting deeper than one level*
(`ranked-groups.md:196`), and ADR-0019 decision 4 (*one level of child groups*). Owner: maintainer.

## Problem

The Enterprise NTP sheet has three continents. Each holds one or two lower locations on tier 4
(each with a zone child), and that continent's NTP client group on tier 5, SNTP client group on
tier 6 and outlet group on tier 7. The reference draws each continent as one column: the client
groups stand under their own locations. The model has no word for a continent, so placement cannot
draw one:

1. **The client groups are placed by tier.** A client group has no routed link, so `placeOverlayFree`
   puts it at the mean x of its overlay partners (ADR-0019 decision 5). A tier-5 group whose flow
   links come from the zones of two continents lands between them. On the current render two of
   the three tier-5 groups stand under a location of another continent (Section 6).
2. **A parent cannot have a parent.** `NESTED_CHILD` refuses it (`src/parse/index.ts:82`). A child
   group is a span of whole ranks inside one tier group and has no tier (`index.ts:59`). A
   continent is not a rank span: its members are tier groups on several consecutive tiers.
3. **The converter flattens depth.** `drawthe_net.py:198-210` folds a box under a child into that
   child. The source sheet has no continent boxes at all, so nothing is lost there today, but the
   converter has no way to emit them.

Decision (maintainer, 2026-09-29): nesting deeper than one level is the solution, as **region
groups**: a group whose members are tier groups on consecutive tiers, drawn as one frame around a
column of those groups.

## Vocabulary (to be added to `CONTEXT.md`)

The word *region* is taken: stage 7 calls the space between two adjacent tiers a region
(`CONTEXT.md`, *region*; `docs/design/pipeline.md:406-409`). The term below is therefore always the
two words **region group**, never the bare word, and the YAML key is `region:` (open question 1).

| Term | Definition | Not to be confused with |
|---|---|---|
| **region group** | A group whose **members** are tier groups of consecutive tiers. It has no tier, no nodes, no shape and no flank, and it is not a member of another region group. It is placed as a **region column** and drawn as a **region frame**. | *region* (the space between two tiers); *child group* (a rank span inside one tier group) |
| **member** (of a region group) | A tier group that names the region group in `region:`. A member keeps its tier, its shape and its children. A flank of a member belongs to the member's region group. | *node* (a member of a group) |
| **region column** | The one x interval a region group owns on every tier it spans: the widest packed run of its members on any of its tiers, plus 20 px slack on each side. Members of every tier stand inside it; every other unit stands outside it. Sibling region columns are disjoint, a band gap apart. | *column* (one frame's) |
| **region frame** | The drawn box of a region group, derived after placement: the union of its member frames grown by group padding, plus the label band on the ADR-0011 title edge. It is an ADR-0013 obstacle and an ADR-0011 title owner, and it spans the tier gaps between its tiers. | *frame* (one tier group's) |

The *group* row of `CONTEXT.md` becomes: *A group has a tier, is a flank, has a parent group, or is
a region group.* Invariant 2 gains: *A tier group may belong to one region group. A region group
holds tier groups of consecutive tiers and belongs to no region group.*

## Section 1 — Schema and validation (`src/parse/index.ts`)

**Declaration.** A member names its region group: `site-a: { tier: 4, region: west }`. The region
group is a group entry with `label` and optional `class` only: `west: { label: West }`. Nothing
else declares it. `region` joins the key list at `index.ts:37`.

Two forms were considered and rejected. (a) `parent:` on the tier group. Today `parent` means a
rank span without a tier (`index.ts:59-63`), and a reader would need the parent's declaration to
know which of two things a `parent` is. (b) `members:` on the region group. Membership is declared
on the member everywhere else (`group:` on a node, `of:` on a flank, `parent:` on a child), and one
place per relation is the rule.

**Validation**, after `inferTiers` (`index.ts:154-197`), because it reads effective tiers:

| Code | Rule |
|---|---|
| `REGION_KEYS` | A region group has no `tier`, `align`, `of`, `parent`, `shape`, `layout` and no node. |
| `REGION_MEMBER_KIND` | A member is a tier group: it has no `align` and no `parent`. A child group takes its parent's region group and does not name one. |
| `REGION_MEMBER_SHAPE` | A member is `ranked`, `row` or `grid`. A `bar` spans its ports across its tier and keeps the place its own stage gives it (`src/layout/columns.ts:301`); it is refused in this version. |
| `REGION_TIER_GAP` | The effective tiers of a region group's members are consecutive. A region group with a member on tier 4 and on tier 6 and none on tier 5 is an error, not a frame with a hole (a frame is an obstacle, and a tier-5 group could stand neither inside nor across it). A region group may span one tier. |
| `REGION_NESTED` | A region group is not a member of a region group. A region group's member may have child groups; the chain region group → member → child is the maximum depth (open question 3). |
| `REGION_EMPTY` | A region group with no member. |
| `UNKNOWN_REFERENCE` | `region:` names a group that does not exist. |

`NESTED_CHILD` (`index.ts:82`) is unchanged: a member has no `parent`, so its child passes. The
converter's one-level flattening (`drawthe_net.py:198-210`) is also unchanged: a region group is
never a painted box in the source.

**Converter.** `scripts/conversion/drawthe_net.py` gains `--region TOKEN[=LABEL]`, repeatable. A
top-level group whose identifier starts with `TOKEN` (case-insensitive) is a member. Identifiers,
not labels, are read: on the NTP sheet two client-group labels carry another continent's token while
their identifiers carry the right one. A top-level group with no token takes the region group that
receives more than half of the overlay-family links of the group and its children; else it stays
outside, with a warning that names the counts. A region group whose members do not occupy
consecutive tiers is dropped with a warning. On the NTP sheet this gives each lower location its
continent by 16 of 18 or 6 of 6 flow links, and leaves the three top locations outside (their sync
links reach every continent alike). Without `--region` the output is byte-identical to today's.

## Section 2 — Placement: a region group is a column across its tiers

**Units today.** `columnTiers` (`columns.ts:35-55`) builds one unit per top-level frame or one-rank
group and merges units whose sub-tier ranges touch into one document tier (`columns.ts:50-53`).
`packStep` packs one tier, anchor tier first, each unit at the mean x of its routed feeds toward
the tier packed before (`columns.ts:276-379`); `separateFrameColumns` and `holdColumnAxes` move a
frame as a whole (`columns.ts:393-397`, `433-442`); `columnWindow` walls each cell in its column
(`src/layout/centre.ts:263`). A parent frame's stand is a row of child blocks (`columns.ts:87-98`).

**Rules.**

1. **Roots.** A unit is a top-level frame or one-rank group whose group has no `region:`, or a
   member. A region group is not a unit: its sub-tier range would merge tiers 4–7 into one pack
   step at `columns.ts:50-53`. `columnTiers` therefore reads members as roots and records their
   region group.
2. **Contiguous, and ordered as one.** On every tier a region group spans, its members stand
   contiguous in the tier's run. The order of region groups along a tier is one order for all its
   tiers: ticket 06b's `orderFramesByOverlay` (`src/layout/overlay-order.ts:310-340`) reorders
   region groups as units, keyed by the mean partner x over every node of the region group, and
   accepted over every sub-tier the region group spans with the three conditions of ADR-0019. The
   members inside a region group are ordered by the same rule with the region column as their
   walls. A unit outside every region group, on a tier a region group spans, is ordered among the
   region groups by the same key.
3. **The stand of a region group.** For each spanned tier: the run of its members' extents
   (`columns.ts:295-297`) a band gap apart, packed relative to the region group's axis by
   `packStep`'s feed rule against the tier packed before, with members only. The stand's width is
   the widest run. The region column is the stand plus `COLUMN_SLACK` on each side. This is the
   parent-frame stand (`Stand`, `columns.ts:87-98`, `standOf`, `columns.ts:120-168`) with tiers in
   place of "children beside own cells".
4. **One PAV over the span.** The tier step whose tier is nearest the anchor tier among a region
   group's tiers (or is it) places the region column: the region group joins that tier's run as
   one item of its column's width, its wish the mean x of the routed feeds of all its members on
   that tier (the union of its members' feeds), by the pool-adjacent-violators fit of
   `columns.ts:343-365`. Every later tier step of the span finds the region column fixed and packs
   the members inside it. So a region column is both: a column whose feed axis is the union of its
   members' feeds on its first tier, and a wall inside which its members' columns are nested.
5. **Narrower tiers are centred.** On a tier where the members' run is narrower than the region
   column, the run is centred in it, then the feed rule (tickets 11 and 16) moves members inside
   the column. A member never leaves its region column. This is the anchor-tier centring rule of
   `centre.ts` applied to a column instead of the sheet.
6. **Disjoint.** Sibling region columns stand slack + band gap + slack apart, so region frame boxes
   stay a band gap apart at the limit, as sibling frames do (ticket 09). `separateFrameColumns`,
   `columnShifts` and `holdColumnAxes` move a region group as a whole, one dx for every cell of
   every member on every tier; inside it they move members as today. `columnWindow` intersects a
   cell's window with its region column, as `besideWalls` does for a beside cell (`centre.ts:232`).
7. **Foreign units on a spanned tier.** A unit between two region groups in a tier's run reserves
   its width plus two band gaps between the two region columns on every tier of the pair's common
   span. A unit before or after the region groups stands outside them as today.
8. **Outside every region group** nothing changes: the three top locations, the key, the satellite
   row and the MPLS row are packed as today. An input with no `region:` key is byte-identical in
   layout JSON.
9. **A tier without a member** does not exist inside a span (`REGION_TIER_GAP`). Below or above the
   span the region column ends: the region frame does not reach those tiers.

## Section 3 — Frames

`deriveFrames` (`src/layout/frames.ts:44-65`) builds a frame from its cells and its child frames
grown by group padding, and takes the smallest child tier. A region frame is the same derivation
with no own cells: the union of its member frames grown by 20 px, plus the label band. Three
changes make it hold:

- **Every member is a frame.** A one-rank member (a client group of one node) is today a plain
  group with no frame (`src/layout/rank-cells.ts:104-106`). It becomes a one-cell frame `G#0`, so
  the region frame, the columns, the lanes, G9 and the overlay order read members alike. The
  expansion guard at `rank-cells.ts:73` counts region groups as a reason to expand. The `frames`
  record gains `kind: 'region'` on a region frame and sets `parent` on each member frame to it, so
  `Frame.parent` (`src/model/layout.ts:110`) is the one containment relation for both levels.
- **Transitive readers.** `frameCells` and `frameNodes` read direct children only
  (`frames.ts:104-107`, `176-180`). They read descendants. `foreignFrame` already walks the whole
  `parent` chain (`frames.ts:136`) and `topFrame` in lanes does too (`src/layout/lanes.ts:458-461`),
  so a lane foreign to a region group takes one more margin (`outer`) without a new rule.
- **Title.** ADR-0011 chooses the edge: the horizontal edge with fewer incident link ports, ties to
  the top. A region group fed from above (the NTP continents, whose routers reach the MPLS row)
  takes the bottom edge, below its last tier, where only the canvas margin lies. When the top edge
  wins, the tier gap above the first tier grows by the band height, globally for that gap, in 7f
  (`growTierGaps`, `src/layout/gap-room.ts:49-97`), as a detour under a title reserves band room
  (ticket 04). The band is hosted outside every member frame: a member's own title stays in its
  first cell (`frames.ts:28-32`).

**Tier gaps are global.** `rebuildBands` derives one band per sub-tier as the union of every
group of that sub-tier (`src/layout/skeleton-geometry.ts:95-104`), and the tier gap between two
bands is one height for the whole sheet. A region group's members on adjacent tiers keep that gap.
The region frame spans the gaps between its tiers, and its 20 px margin above the first member
frame and below the last is taken from the tier gap there, as a parent frame's margin around a
child frame is (ticket 03, 40 of 60 px remain). A smaller gap inside a region group than outside is
not offered: it needs per-column tier gaps, and then every 7f rule and the tier-gap row plan run per
column (open question 4, recommendation: no).

**Obstacle and lanes.** A region frame is an ADR-0013 obstacle grown by the group edge link-margin.
A link foreign to a region group (neither end inside it) never enters it; its lane stands outside
the region frame at one x for every sub-tier of the span (`foreignReach`, `frames.ts:119-124`,
with the region group as `foreignRoot`). A link that ends inside the region group is not foreign
to it and may transit its member frames as today (ADR-0019, ADR-0013), and `transitLanes`
(`frames.ts:74-87`) grows the region frame to hold the lane it owns beside a member cell. A lane
the region group holds is reserved before a lane foreign to it (`lanes.ts:464-471`).

## Section 4 — Routing

1. **Lanes.** A link between two members of one region group that crosses a tier of the span (a
   router on tier 4 to an outlet on tier 7) owns a lane beside the member cells it passes, inside
   the region column and the region frame. A link that leaves the region group takes its lane
   outside the region column on the side of its far end. Lane x is immutable and a frame only grows
   (`pipeline.md:1047-1056`); both stay true, one level up.
2. **Tier-gap row plan.** `docs/design/tier-gap-rows.md` plans one gap at a time, over every part
   of that gap. A region group's members on adjacent tiers share the gap with the members of other
   region groups. Nothing changes: the plan reads parts, not groups. It changes only if gaps become
   per column, which is not recommended.
3. **Overlay links.** Unchanged. A chord from a zone of one region group to a client group of
   another (the NTP sheet has four such flow links) crosses two region frames: nothing but a node
   body or a foreign pill blocks an overlay segment (`CONTEXT.md`, *overlay*).
4. **The straight intra-frame rule.** Ticket 34 makes a routed link a chord when both ends lie in
   *one frame*: the same document group, or a parent and its direct child
   (`pipeline.md:390-392`). The rule does not extend to a region group. A region group is a column
   of frames, not a frame of nodes: a link between two of its members crosses a tier gap and is a
   part of that gap's row plan, with a reserved row, and a chord across a tier gap would reserve
   nothing there. Recommendation: no.

## Section 5 — Gates and score

- **G9** (`src/score/gates.ts:58-80`) extends by containment: a region frame contains each member
  frame (`gates.ts:67`, already the `parent` check once `parent` is set); region frames do not
  overlap each other or a group that is not a descendant (`gates.ts:70`, `75`, with "own" read
  transitively); no node outside a region group lies inside its frame (`gates.ts:80`). A member
  frame outside its region frame fails `frame-contains` with the region group named.
- **Compactness** reads node rectangles (`src/score/metrics.ts:9`, `46-47`), so the region column's
  empty room beside a one-node client group under a 16-node location does not move the metric.
  The canvas area is recorded beside Q as in `ranked-groups.md` Section 5. Expected on the NTP
  sheet: narrower, because the lower tiers pack as three columns instead of the spread of today
  (Section 6).
- **Metric of the ticket** stays the straight overlay count over 153, with removed links,
  canvas area and Q beside it.

## Section 6 — The NTP sheet

Today (`main`, layout of the private input; the sheet is described by tier and class, names are
private): tier 2 holds three top locations, 7 nodes each. Tier 4 holds four lower locations (16,
16, 8 and 8 nodes), each with a zone child of four, spread over a 3 170 px span. Tiers 5, 6 and 7
hold three one-node or three-node client groups each. `placeOverlayFree` puts every client group
at the mean x of its overlay partners. The tier-5 group of continent B receives two flow links from
a zone of continent A and two from its own, so it stands under continent A's second location, about
1 000 px left of its own. The tier-5 group of continent C likewise stands under continent B's
location. The tier-6 and tier-7 groups stand under their own locations. No frame shows which
groups belong together; the reader sees four location frames and nine small boxes.

With three region groups (A: two lower locations and three client groups; B and C: one location and
three client groups each), tiers 4–7 become three region columns. Inside A the two locations stand
side by side and the three client groups are centred under the pair. B's and C's tier-5 groups move
right under their own locations. The four cross-continent flow links become long chords across the
region frames; the 30 within a continent stay short. The three region frames read as three
continents. The three top locations, the key, the satellite row and the MPLS row stay as today.
What must move: the two tier-5 groups (about 1 000 and 700 px), and the four location columns
close up to three region columns a band gap apart.

## Proofs on shapes (fixtures under `goldens/synthetic/`)

| Fixture | Shape | Asserts |
|---|---|---|
| `a-region-group-frames-two-tiers` | one region group; one two-rank location on tier 0 over one one-node client group on tier 1, a flow link between them | the region frame contains both member frames plus 20 px; the client group's axis is the location's; the title stands on the edge ADR-0011 chooses; G9 clean; the same input without `region:` is byte-identical to today |
| `two-region-groups-are-disjoint-columns` | two region groups of two tiers each; one cross-region flow link | region frame boxes a band gap apart; members inside their region columns on both tiers; the region order follows the overlay key when the crossing count does not rise, else `OVERLAY_ORDER_REFUSED` |
| `a-narrow-tier-is-centred-in-its-region-column` | a region group whose tier-0 run is 600 px and whose tier-1 run is 120 px, fed by a routed link off the axis | the tier-1 member stands inside the region column, centred, then pulled to its feed by no more than the room the column leaves; `COLUMN_AXIS_HELD` names the wall when the feed lies beyond it |
| `a-foreign-unit-between-two-region-groups` | two region groups of two tiers; a plain group on tier 1 ordered between them | the plain group stands between the two region columns on tier 1, and the two columns keep that gap on tier 0 |
| `a-transit-inside-a-region-group` | a region group of three tiers; a link from tier 0 to tier 2 of the same region group; a foreign link from above the region group to below it | the first link's lane stands inside the region frame, which grows to hold it; the foreign lane stands outside the region frame at one x for all three tiers |
| `three-continents` | the NTP shape at fixture size: three top locations on tier 0 outside every region group, an MPLS row on tier 1, region groups A (two locations with zones), B and C (one each) on tier 2, client groups on tiers 3 and 4, cross-region flow links | three region frames a band gap apart; every client group under its own region group; the top locations unmoved against the same input without region groups; every zone inside its location inside its region group |

## Migration

| # | Ticket | Acceptance test |
|---|---|---|
| 1 | **Schema.** `region:` key; `NormalisedGroup.region`; the seven codes of Section 1; `CONTEXT.md` terms and invariant 2; converter untouched. | `test/parse`: the two-tier fixture parses with the member's `region`; one test per code; `NESTED_CHILD` still refuses a child of a child. |
| 2 | **Frames.** Every member a frame; `kind: 'region'`; `deriveFrames` for a region frame; transitive `frameCells` / `frameNodes`; G9 extension; the renderer and the drawio export draw the region frame and its title. | `a-region-group-frames-two-tiers`: containment and title assertions; G9 negative test (a member frame moved out of its region frame on a clone fails `frame-contains`); goldens byte-identical. |
| 3 | **Column.** `columnTiers` roots; the region stand; one PAV over the span; centring inside the column; `columnWindow`, `separateFrameColumns`, `holdColumnAxes` at the region level. | `two-region-groups-are-disjoint-columns` and `a-narrow-tier-is-centred-in-its-region-column`: the gap and wall assertions after the whole layout, not only after pack. |
| 4 | **Order.** `orderFramesByOverlay` with region groups as units over their whole span; foreign units between region groups. | `two-region-groups-are-disjoint-columns` (the swap and the refusal) and `a-foreign-unit-between-two-region-groups`. |
| 5 | **Lanes.** Held and foreign lanes at the region level; the chord rule not extended; the tier-gap plan unchanged. | `a-transit-inside-a-region-group`; a test that a member-to-member link across one gap keeps its planned row and takes no chord; the same gap with and without the region group has one row plan. |
| 6 | **Converter and the NTP metric.** `--region`, the majority rule, the warnings; measure the sheet. | A converter test on a synthetic drawthe.net document with two continents; `three-continents` renders with three region frames; the NTP numbers (straight of 153, removed, canvas, Q) recorded in the ticket's comments, and the corpus differential byte-identical for every input without `region:`. |

Ticket 1 blocks 2; 2 blocks 3 and 5; 3 blocks 4 and 6. Each ticket is one review step.

## Open questions

1. **Declaration form and the word.** `region:` on the member and a bare group entry for the region
   group; the two-word term *region group* in prose, because *region* is the stage-7 gap.
   Recommendation: adopt both. The alternatives (`parent:` reuse, `members:`) are in Section 1.
2. **Do the three top locations get a region group?** They sync to every continent alike and have
   no client group. A one-tier region group is legal (Section 1) but adds a frame that says
   nothing. Recommendation: no; the converter's majority rule leaves them outside, and an author
   may add one.
3. **Depth.** Region group → member → child is three levels of frame. Recommendation: fix the
   depth there. A region group is a column of units and a member is a unit, so a region group of
   region groups is the same rule applied again, but no sheet in the corpus needs it, and every
   transitive reader of ticket 2 is written for a chain of any length already.
4. **Per-column tier gaps.** A region group could hold its tiers closer than the global gap.
   Recommendation: no. Bands are global (`skeleton-geometry.ts:95-104`), the row plan is per gap,
   and G1 and G8 read bands; a per-column gap makes each of them per column.
5. **The region title on the top edge.** Grow the gap above (Section 3) or host the title only on
   the bottom edge. Recommendation: let ADR-0011 choose and grow the gap when the top wins; on the
   NTP sheet the bottom wins and nothing grows.
