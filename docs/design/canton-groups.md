# Canton groups — design

Status: proposal, 2026-09-29, revised after one review round. No code changed. Extends
`docs/design/ranked-groups.md`, whose out-of-scope line is *nesting deeper than one level*
(`ranked-groups.md:196`), and ADR-0019 decision 4 (*one level of child groups*). Owner: maintainer.

## Section 0 — The word

The maintainer's word for the new group was *region*. That word is taken: the `Region` type,
`model.regions` in the layout JSON, `src/layout/regions.ts`, invariant 7 and stage 7 all use it for
the space between two tiers (`CONTEXT.md`, *region*; `docs/design/pipeline.md:406-409`). This spec
uses **canton** (Latin and French; кантон one-to-one; a territorial unit that holds several
communes; unused in the repo). The maintainer may rename it. Only this section and the key name
change then.

## Problem

The Enterprise NTP sheet has three continents. Each holds one or two lower locations on tier 4
(each with a zone child), and that continent's NTP client group on tier 5, SNTP client group on
tier 6 and outlet group on tier 7. The reference draws each continent as one column. The client
groups stand under their own locations. The model has no word for a continent, so placement cannot
draw one:

1. **The client groups are placed by tier.** A client group has no routed link. `placeOverlayFree`
   puts it at the mean x of its overlay partners (ADR-0019 decision 5). A tier-5 group whose flow
   links come from the zones of two continents lands between them. On the current render two of
   the three tier-5 groups stand under a location of another continent (Section 6).
2. **A parent cannot have a parent.** `NESTED_CHILD` refuses it (`src/parse/index.ts:82`). A child
   group is a span of whole ranks inside one tier group and has no tier (`index.ts:59`). A
   continent is not a rank span. Its members are tier groups on several consecutive tiers.
3. **The converter flattens depth.** `drawthe_net.py:198-210` folds a box under a child into that
   child. The source sheet has no continent boxes, so the converter has no way to emit them.

Decision (maintainer, 2026-09-29): nesting deeper than one level is the solution, as **cantons**: a
group whose members are tier groups on consecutive tiers, drawn as one frame around one column.

## Vocabulary (to be added to `CONTEXT.md`)

| Term | Definition | Not to be confused with |
|---|---|---|
| **canton** | A group whose **members** are tier groups of consecutive tiers. It has no tier, no nodes, no shape and no flank, and it is not a member of another canton. It is one top-level frame unit to placement (a **canton column**) and is drawn as a **canton frame**. | *region* (the space between two tiers); *child group* (a rank span inside one tier group) |
| **member** (of a canton) | A tier group that names the canton in `canton:`. A member keeps its tier and its children. A member is a frame, of one cell when it has one rank. | *node* (a member of a group) |
| **canton column** | The canton frame's box plus 20 px slack on each side, derived off the member boxes as they stand, as every column is. Members stand inside it; every other unit stands outside it. Sibling canton columns are disjoint, a band gap apart. | *column* (one tier group's frame) |
| **canton frame** | The drawn box of a canton, derived after placement: the union of its member frames grown by group padding, plus the label band on the ADR-0011 title edge. It is an ADR-0013 obstacle and an ADR-0011 title owner. It spans the tier gaps between its tiers. | *frame* (one tier group's) |

The *group* row of `CONTEXT.md` becomes: *A group has a tier, is a flank, has a parent group, or is
a canton.* The *frame* row gains: *a member frame is drawn inside its canton frame*. The *column*
row gains: *a canton is one column across its tiers*. Invariant 2 gains: *A tier group may belong
to one canton. A canton holds tier groups of consecutive tiers and belongs to no canton.*

## Section 1 — Schema and validation (`src/parse/index.ts`)

**Declaration.** A member names its canton: `site-a: { tier: 4, canton: west }`. The canton is a
group entry with `label` and optional `class` only: `west: { label: West }`. Nothing else declares
it. `canton` joins the key list at `index.ts:37`.

Two forms were considered and rejected. (a) `parent:` on the tier group. Today `parent` means a
rank span without a tier (`index.ts:59-63`). A reader would need the parent's declaration to know
which of two things a `parent` is. (b) `members:` on the canton. Membership is declared on the
member everywhere else (`group:` on a node, `of:` on a flank, `parent:` on a child).

**Validation**, after `inferTiers` (`index.ts:154-197`), because it reads effective tiers:

| Code | Rule |
|---|---|
| `CANTON_KEYS` | A canton has no `tier`, `align`, `of`, `parent`, `shape`, `layout` and no node. |
| `CANTON_MEMBER_KIND` | A member is a tier group: it has no `align` and no `parent`. A child group takes its parent's canton and does not name one. |
| `CANTON_MEMBER_SHAPE` | A member is `ranked` or `row`. `expandRankedGroups` copies a `bar` or `grid` group without cells (`src/layout/rank-cells.ts:34`, `55-58`), so "a member is a frame" has no meaning for them, and ticket 06b's `free` predicate walls a unit with a grid cell (`src/layout/overlay-order.ts:315-316`). Both are refused in this version. |
| `CANTON_MEMBER_FLANK` | No flank names a member in `of`. A flank's nodes are in no member cell, so G9 `frame-foreign-node` would fail inside the canton frame. Refused in this version. |
| `CANTON_TIER_GAP` | The effective tiers of a canton's members are consecutive. A canton with members on tiers 4 and 6 and none on tier 5 is an error, not a frame with a hole. A canton may span one tier. |
| `CANTON_NESTED` | A canton is not a member of a canton. A member may have child groups. The chain canton → member → child is the maximum depth (open question 3). |
| `CANTON_EMPTY` | A canton with no member. |
| `UNKNOWN_REFERENCE` | `canton:` names a group that does not exist. |

`NESTED_CHILD` (`index.ts:82`) is unchanged: a member has no `parent`, so its child passes. The
converter's one-level flattening (`drawthe_net.py:198-210`) is also unchanged: a canton is never a
painted box in the source.

**Converter.** `scripts/conversion/drawthe_net.py` gains `--canton TOKEN[=LABEL]`, repeatable.
The rule is one pass:

1. A top-level group whose identifier starts with `TOKEN` (case-insensitive) is a member of that
   canton. Where two tokens match one identifier (`we` and `west`), the longest token wins.
   Identifiers, not labels, are read: on the NTP sheet two client-group labels carry another
   continent's token while their identifiers carry the right one. A tokenised `bar` or `grid`
   group is left outside with a warning, because parse would refuse it (`CANTON_MEMBER_SHAPE`).
2. Every other top-level group counts the overlay-family links of itself and its children to the
   groups step 1 tokenised, and to those only. The denominator is that count. More than half to
   one canton makes the group a member of it. Zero links, or no majority, leaves the group outside
   with a warning that names the counts. Groups assigned in this step are never read by it.
3. A canton whose members do not occupy consecutive tiers is dropped with a warning.

On the NTP sheet the tokens are the three continents' client groups. Each lower location joins its
continent by 16 of 18 or 6 of 6 flow links. The three top locations have zero links to tokenised
groups (their sync links reach the lower locations, which no token names), so they stay outside.
Without `--canton` the output is byte-identical to today's.

## Section 2 — Placement: a canton is one top-level frame unit

**Today.** Every reader of "top-level" is `frames[id].parent === undefined`: `columnTiers`
(`src/layout/columns.ts:40`), `frameColumns` (`:831`), `overlayFreeGroups` (`:479-482`),
`frameGate`, `frameHost`, `topFrame` (`src/layout/lanes.ts:458-461`), and `frameDepth`
(`src/layout/centre.ts:250`). `columnTiers` merges units whose sub-tier ranges touch into one
pack step (`columns.ts:50-53`). `standOf` lays a parent frame's children out as blocks: children on
distinct sub-tiers are `apart` and centred on the axis, children that share a sub-tier are a
`beside` row (`columns.ts:133-148`). `packStep.centre()` moves every cell of the unit to its
axis plus its offset (`columns.ts:283-289`). `columnShifts` and `pullTier` move a top-level unit as
a whole (`columns.ts:668`, `:520`).

**Decision.** The `frames` record sets `parent` on every member frame to its canton, and the canton
frame has `kind: 'canton'` and no own cell. Nothing in `columnTiers` changes: the canton is the
top-level unit, its range spans its tiers, and its tiers form one merged pack step. The rules
below are consequences of that, and each names its machinery.

1. **One unit, one step.** The canton's sub-tier range does not touch the tiers outside it (on the
   NTP sheet the MPLS row's sub-tier is one below the first canton sub-tier), so the merged step
   holds the cantons and the units outside every canton on those tiers, and nothing else.
2. **Stand.** `standOf(canton)`: members on distinct sub-tiers are `apart` blocks centred on the
   canton axis; two members that share sub-tiers (the two lower locations of continent A) are a
   `beside` row. Each block carries `GROUP_PADDING` on both sides (`columns.ts:126-128`), so two
   beside member frames stand 2 × `GROUP_PADDING` = 40 px apart (`packBesideRows`,
   `columns.ts:716-717`). They stand in **declaration order**: `ownX` is undefined for a frame with
   no own cell (`columns.ts:143`) and `place()` then returns `right` for every block
   (`columns.ts:146`). The stand's width is the widest block or row. The canton's extent is that
   width plus the slack on each side (`extent`, `columns.ts:295`).
3. **Axis.** `feedReader` maps every cell of the unit to it (`columns.ts:250-273`), so the canton's
   wish is the mean of the routed feeds of all its members toward the tier packed before, less
   the members' offsets (`wanted`, `columns.ts:305-314`). That is the union of its members' feeds.
   The pool-adjacent-violators fit (`columns.ts:343-365`) places the cantons and the foreign units
   of the step a band gap apart. When the merged step holds the anchor sub-tier, `authority` is
   undefined, every wish is undefined and the run keeps ELK's centre (`columns.ts:329-349`).
4. **Narrower tiers are centred.** `packStep.centre()` puts an `apart` block on the axis. A one-node
   client group under a 16-node location stands centred under it at pack time.
5. **Cost.** Members are not feed-moved per tier at pack time. A tier-5 member whose routed feed
   from tier 4 is off the canton axis is not pulled toward it by the pack. This is ticket 28's rule
   for children: the inner columns are held by the stands at pack time and by `besideWalls` in
   centring (`columns.ts:772`, `centre.ts:232`). The member-level pulls are Section 2b.
6. **Whole moves.** `columnShifts` and `pullTier` move the canton as a whole, one dx for every cell
   of every member on every tier, and keep sibling cantons a band gap apart.
7. **Foreign units on a spanned tier.** A unit outside every canton in the merged step is placed
   before or after the run of cantons. Its overlay key decides the side. No machinery does this
   today: `orderFramesByOverlay` leaves every non-frame unit where it stands
   (`overlay-order.ts:338`), so a one-rank group ELK put between two cantons stays there. Ticket 5
   adds the rule, and fixture 4 starts from that ELK-between case. A foreign unit between two
   cantons was considered and rejected: a 120 px group on one tier would cost 180 px of empty room
   between the two canton columns on every other tier of the span.
8. **Outside every canton** nothing changes: the three top locations, the key, the satellite row
   and the MPLS row are packed as today. An input with no `canton:` key is byte-identical.
9. **Order.** Ticket 06b's `orderFramesByOverlay` (`overlay-order.ts:310-340`) reorders the
   cantons of the merged step as units. The key is the mean partner x over every node of the
   canton. Acceptance runs over every sub-tier of the step with the three conditions of ADR-0019.
   `orderFramesByOverlay` reorders top-level units only (`overlay-order.ts:321-323`), so it
   does not order members. Ticket 5 adds an **inner overlay order**, per canton and per tier, with
   the same key and acceptance and the canton column as the walls. Until then members stand in
   declaration order (rule 2).

### 2b — Member-level walls (what the pack does not hold)

After the pack, rows widen cells (`fitGroupBox`; ticket 28 measured 40 → 74 → 255 px on a beside
gap), sides-two moves a cell about 8 px, alignment up to 12 px (ticket 29), ADR-0012 widens a
paired cell, and `transitLanes` adds 34 px per held lane. The column is derived off the boxes as
they stand (`frameColumns`, `columns.ts:826-849`), never fixed. So:

1. **The canton column is derived**: the canton frame box plus `min(COLUMN_SLACK, free)` on each
   side, as `frameColumns` derives every column. A widened member widens it. `columnShifts` then
   moves the sibling canton as a whole. At rows time `separateFrameColumns` keeps cantons a band
   gap plus 2 × `COLUMN_SLACK` = 100 px apart (`columns.ts:393-397`, `684-687`); only 7f brings
   them to a band gap (`holdColumnsAfterPush`, `bands.ts:623`, slack 0).
2. **An inner pass holds the member wall.** `pullTier` has no member level: its units are the
   `columnTiers` units, one range per top-level unit (`columns.ts:520-529`), and a member is never
   in `standing`. The member wall is therefore a **new inner pass**: per canton and per tier, the
   members as units, the derived canton column as the walls of the plan, the same `feedRange` and
   `overlayRange`. It runs after `pullTier` and before centring, wherever `holdColumnAxes` runs. A
   member that cannot reach its feed because of the wall warns `COLUMN_AXIS_HELD` and names the
   canton. Fixture 3's "after the whole layout" assertion depends on this pass.
   *No oscillation.* `columnShifts` moves right only, and only while boxes stand closer than gap
   plus two slacks; `pullTier` projects with the same offsets; centring's slack falls to 0 as the
   boxes approach a band gap (`columns.ts:839-846`). The drift is at most one slack per
   `repackOverlaps`, which runs twice (ticket 16's bound).
3. **A one-cell member keeps the barycentre.** `overlayFreeGroups` excludes every frame cell
   (`columns.ts:479-482`), so a one-node client group, now a one-cell frame, would lose ticket 05's
   placement. `overlayFreeGroups` admits a one-cell member frame with no routed link. `placeOverlayFree`
   moves it as a frame and clamps the target to the canton column. The same wall bounds
   `overlayRange` in `pullTier`.
4. **Held lanes.** A held lane grows the canton frame as it grows a frame (ticket 04). A later
   foreign lane reads the grown frame (ticket 14). A canton moved after lanes may not cross a lane
   (ticket 23). `separateFrameColumns` restores the band gap after the growth.
5. **Idempotence.** A second layout of the layout JSON moves nothing: the derived column is a
   function of the boxes, and every pull is a projection onto the same ranges.

## Section 3 — Frames

`deriveFrames` (`src/layout/frames.ts:44-65`) builds a frame from its cells and its child frames
grown by group padding, and takes the smallest child tier. A canton frame is the same derivation
with no own cell: the union of its member frames grown by 20 px, plus the label band.

- **Every member is a frame.** A one-rank member is today a plain group with no frame
  (`rank-cells.ts:104-106`), and a `row` member is copied without cells too (`rank-cells.ts:34`).
  Both become a one-cell frame `G#0`, so the canton frame, the columns, the lanes, G9 and the
  overlay order read members alike. The expansion guard at `rank-cells.ts:73`
  counts cantons as a reason to expand. `Frame.parent` (`src/model/layout.ts:110`) is the one
  containment relation for both levels.
- **Transitive readers.** `frameCells` and `frameNodes` read direct children only
  (`frames.ts:104-107`, `176-180`). They read descendants. `foreignFrame` already walks the whole
  `parent` chain (`frames.ts:136`), and `topFrame` does too (`lanes.ts:458-461`), so a lane foreign
  to a canton takes one more margin (`outer`) without a new rule. `frameDepth` (`centre.ts:250`)
  gives a leaf child beside its parent's cells inside a canton an inset of 40 px.
- **Title host.** `frameHost` returns `undefined` for a frame with no own cell on the edge
  (`src/layout/bands.ts:103-109`), and the title is not drawn (`FRAME_TITLE_UNHOSTED`,
  `bands.ts:992`). Ticket 03 fix A recorded the alternative, a band outside the child frame, as not
  built. A cell-hosted canton band cannot be that alternative: `titles()` keys `hosted` by host
  cell (`bands.ts:127-133`), so a canton band on a member's first cell collides with that member's
  own band on the same edge, and a cell-hosted band grows the cell box (`bands.ts:682`), so
  `cellReach` and `deriveFrames(member)` would put it inside the member frame.
  **Decision: the canton band is held by the sub-tier.** It takes the `topShift` room only
  (`bands.ts:670-672`, one shift for the whole sub-tier): its y lies above the moved tier band on
  the top edge, or below the last tier band on the bottom edge; `deriveFrames(canton)` adds the
  band to the canton box; `cellReach` is untouched; no cell hosts it and `frameHost` is not asked.
  *Timing.* `produceGroupLabelBands` (`bands.ts:995`) calls `reserveInitialSpace` (`bands.ts:645`)
  at the start of `bands`, before `growTierGaps` and the replay (`src/layout/mutation.ts:720-725`).
  The bottom-edge push is the shift loop inside `reserveInitialSpace` (`bands.ts:689-695`), which
  moves every lower tier band down by the grown height; it is not `pushFollowingGroups`
  (`bands.ts:599-611`, the horizontal widening plan). A canton fed from above (the NTP continents,
  whose routers reach the MPLS row) takes the bottom edge. With a tier below it, the gap must hold
  20 + 20 + about 23 px, more than the 60 px band gap, so the shift happens; on the NTP sheet only
  the canvas grows.

**Tier gaps are global.** `rebuildBands` derives one band per sub-tier as the union of every
group of that sub-tier (`src/layout/skeleton-geometry.ts:95-104`). The gap between two bands is
one height for the whole sheet. A canton's members on adjacent tiers keep that gap. The canton
frame spans the gaps between its tiers. Its 20 px margin above the first member frame and below
the last is taken from the tier gap there, as a parent frame's margin is (ticket 03, 40 of 60 px
remain). A smaller gap inside a canton is not offered. It needs per-column tier gaps, and then
every 7f rule and the tier-gap row plan run per column (open question 4).

**Obstacle and lanes.** A canton frame is an ADR-0013 obstacle grown by the group edge
link-margin. A link foreign to a canton never enters it. Its lane stands outside the canton frame
at one x for every sub-tier of the span (`foreignReach`, `frames.ts:119-124`, with the canton as
`foreignRoot`). A link that ends inside the canton is not foreign to it. It may transit the member
frames as today. `transitLanes` (`frames.ts:74-87`) grows the canton frame to hold the lane it
owns beside a member cell. A lane the canton holds is reserved before a lane foreign to it
(`lanes.ts:464-471`).

## Section 4 — Routing

1. **Lanes.** A link between two members of one canton that crosses a tier of the span (a router
   on tier 4 to an outlet on tier 7) owns a lane beside the member cells it passes, inside the
   canton column and the canton frame. A link that leaves the canton takes its lane outside the
   canton column on the side of its far end. Lane x is immutable and a frame only grows
   (`pipeline.md:1047-1056`); both stay true one level up.
2. **Tier-gap row plan.** `docs/design/tier-gap-rows.md` plans one gap at a time over every part
   of that gap. A canton's members on adjacent tiers share the gap with the members of other
   cantons. Nothing changes: the plan reads parts, not groups.
3. **Overlay links.** Unchanged. Nothing but a node body or a foreign pill blocks an overlay
   segment (`CONTEXT.md`, *overlay*). On the NTP sheet 40 overlay links cross a continent boundary
   inside tiers 4–7: the 36 links of the sync mesh between the zones and locations of different
   continents, and 4 flow links. No rule breaks, but 36 chords will show between the canton frames.
4. **The straight intra-frame rule.** Ticket 34 makes a routed link a chord when both ends lie in
   one frame: the same document group, or a parent and its direct child (`pipeline.md:390-392`).
   The rule does not extend to a canton. A canton is a column of frames, not a frame of nodes. A
   link between two of its members crosses a tier gap and is a part of that gap's row plan. A chord
   across a tier gap would reserve nothing there. Recommendation: no.

## Section 5 — Gates and score

- **G9** (`src/score/gates.ts:58-80`) extends by containment. A canton frame contains each member
  frame (`gates.ts:67`, the `parent` check). The overlap skip at `gates.ts:72` reads a direct
  parent-child pair only; it reads the chain. Frames do not overlap a group that is not a
  descendant (`gates.ts:75`, "own" read transitively). No node outside a canton lies inside its
  frame (`gates.ts:80`). A member frame outside its canton frame fails `frame-contains` with the
  canton named.
- **Compactness** reads node rectangles (`src/score/metrics.ts:9`, `46-47`). The canton column's
  empty room beside a one-node client group under a 16-node location does not move it. The
  canvas area is recorded beside Q as in `ranked-groups.md` Section 5.
- **Metric of the ticket** stays the straight overlay count over 153, with removed links, canvas
  area and Q beside it.

## Section 6 — The NTP sheet

Today (`main`, layout of the private input; the sheet is described by tier and class): tier 2 holds
three top locations, 7 nodes each. Tier 4 holds four lower locations (16, 16, 8 and 8 nodes),
each with a zone child of four, spread over a 3 170 px span. Tiers 5, 6 and 7 hold three client
groups each, of one or three nodes. `placeOverlayFree` puts every client group at the mean x of
its overlay partners. The tier-5 group of continent B receives two flow links from a zone of
continent A and two from its own, so it stands under continent A's second location, about 1 000 px
left of its own. The tier-5 group of continent C likewise stands under continent B's location. The
tier-6 and tier-7 groups stand under their own locations. No frame shows which groups belong
together. The reader sees four location frames and nine small boxes.

With three cantons (A: two lower locations and three client groups; B and C: one location and three
client groups each), tiers 4–7 become three canton columns. Inside A the two locations stand side
by side as a `beside` row, and the three client groups are centred under the pair. B's and C's
tier-5 groups move right under their own locations. The 36 sync chords and the 4 cross-continent
flow chords cross the canton frames; the 30 flow links within a continent stay short. The three
canton frames read as three continents, each with its title on the bottom edge. The three top
locations, the key, the satellite row and the MPLS row stay as today. What must move: the two
tier-5 groups (about 1 000 and 700 px), and the four location columns close up to three canton
columns a band gap apart.

## Proofs on shapes (fixtures under `goldens/synthetic/`)

The anchor tier stands outside the span in fixtures 2, 3 and 7, as a wide tier above the cantons,
so rule 3's feed union is exercised. Fixture 11 puts it inside.

| # | Fixture | Shape | Asserts |
|---|---|---|---|
| 1 | `a-canton-frames-two-tiers` | one canton; a two-rank location on tier 0 over a one-node client group on tier 1, one flow link | the canton frame contains both member frames plus 20 px; the client group's axis is the location's; G9 clean; the same input without `canton:` is byte-identical to today |
| 2 | `two-cantons-are-disjoint-columns` | a wide anchor tier above two cantons of two tiers each; one cross-canton flow link | canton frame boxes a band gap apart; members inside their canton columns on both tiers; each canton's axis on the mean of its members' feeds; the order follows the overlay key, else `OVERLAY_ORDER_REFUSED` |
| 3 | `a-narrow-tier-is-centred-in-its-canton-column` | anchor tier above; a canton whose tier-1 run is 600 px and tier-2 run 120 px, the tier-2 member fed off the axis | the tier-2 member centred at pack; after the whole layout still inside the canton column; pulled to its feed by no more than the room the column leaves; `COLUMN_AXIS_HELD` names the canton |
| 4 | `a-foreign-unit-beside-the-run-of-cantons` | two cantons of two tiers; a plain group on tier 1 that ELK places between them | the plain group stands before or after the run on the side its key favours; no empty room between the cantons |
| 5 | `a-transit-inside-a-canton` | a canton of three tiers; a link from tier 0 to tier 2 of the canton; a foreign link from above the canton to below it | the first lane inside the canton frame, which grows to hold it; the foreign lane outside at one x for all three tiers; the neighbour gap a band gap after `separateFrameColumns` |
| 6 | `a-member-widened-after-pack` | a canton whose tier-1 member has a 13-node row that `fitGroupBox` widens, beside a sibling canton | the canton column follows the widened member; the sibling canton moved as a whole; no member outside its column; G9 clean |
| 7 | `a-tier-below-a-canton` | anchor tier above; a canton fed from above with a plain tier below it | the title on the bottom edge; the tier below pushed by the band; the gap holds 20 + 20 + band |
| 8 | `a-leaf-child-beside-its-parent-inside-a-canton` | canton → location → leaf zone beside the parent cells | the zone inside its location inside its canton; inset 40 px; the beside gap `COLUMN_SLACK` after the whole layout |
| 9 | `a-canton-layout-is-idempotent` | fixtures 2, 3 and 6 laid out twice | the second layout JSON equals the first |
| 10 | `three-continents` | three top locations on tier 0 outside every canton, an MPLS row on tier 1, cantons A (two locations with zones), B and C on tier 2, client groups on tiers 3 and 4, cross-canton flow links | three canton frames a band gap apart; every client group under its own canton; the top locations unmoved against the same input without cantons |
| 11 | `an-anchor-tier-inside-a-canton-span` | a canton of three tiers whose middle tier is the anchor tier | the run keeps ELK's centre; members centred; G9 clean |

## Migration

| # | Ticket | Acceptance test |
|---|---|---|
| 1 | **Schema.** `canton:`; `NormalisedGroup.canton`; the eight codes of Section 1; `CONTEXT.md` terms and invariant 2. | `test/parse`: fixture 1 parses with the member's `canton`; one test per code; `NESTED_CHILD` still refuses a child of a child. |
| 2 | **Frames and the unit.** Every member a frame; `kind: 'canton'`; `parent` on member frames; `deriveFrames` for a canton frame; transitive `frameCells` / `frameNodes`; G9 with the transitive skip; `columnTiers` untouched, the canton as the unit; the renderer and the drawio export draw the canton frame. | Fixtures 1, 2 and 11; G9 negative test (a member frame moved out on a clone fails `frame-contains`); goldens byte-identical. |
| 3 | **Title band.** The canton band held by the sub-tier: the `topShift` room in `reserveInitialSpace`, the bottom edge by its shift loop, `deriveFrames(canton)` adding the band, `cellReach` untouched, no host cell; no `FRAME_TITLE_UNHOSTED` for a canton. | Fixture 7; fixture 1 with the title forced to the top edge; a member's own top band and the canton's top band on one sub-tier do not collide. |
| 4 | **Member-level walls** (Section 2b). Derived canton column; the new inner pass after `pullTier` and before centring; `overlayFreeGroups` for one-cell members; held-lane parity; idempotence. | Fixtures 3, 5, 6, 8 and 9, asserted after the whole layout. |
| 5 | **Order and foreign units.** `orderFramesByOverlay` with cantons as units; the inner overlay order per canton per tier; foreign units moved before or after the run; the chord rule not extended; the tier-gap plan unchanged. | Fixtures 2 (the swap and the refusal) and 4 (from the ELK-between start); a member-to-member link across one gap keeps its planned row and takes no chord; the same gap with and without the canton has one row plan. |
| 6 | **Converter and the NTP metric.** `--canton`, the one-pass rule, the warnings; measure the sheet. | A converter test on a synthetic drawthe.net document with two continents; fixture 10 renders with three canton frames; the NTP numbers (straight of 153, removed, canvas, Q) in the ticket's comments; the corpus differential byte-identical for every input without `canton:`. |

Ticket 1 blocks 2; 2 blocks 3, 4 and 5; 4 blocks 6. Each ticket is one review step.

## Docs

ADR-0020 *A canton is a column of tier groups; its frame is derived* amends ADR-0019 decision 4
(one level of child groups; a member may hold one level, and a canton holds members) and
ADR-0013 (the canton frame is an obstacle). `ranked-groups.md:196` loses *nesting deeper than one
level* from its out-of-scope line and points here. `CONTEXT.md`: the four terms above, the *group*,
*frame* and *column* rows, invariant 2. `docs/design/pipeline.md`: stage 1 (a member is a frame),
the Frames section (the canton frame, the title host), G9.

## Open questions

1. **The word.** *Canton*, `canton:`, `CANTON_*`, `kind: 'canton'`, `--canton`. Recommendation:
   adopt; Section 0 says what a rename touches. The declaration form (`canton:` on the member, a
   bare entry for the canton) is Section 1; the alternatives are rejected there.
   **Decision (2026-09-29):** Adopted. The word is canton; the key, the codes, the frame kind and the converter flag keep the names of this spec.
2. **Do the three top locations get a canton?** They have no client group and their sync links
   reach every continent. A one-tier canton is legal (Section 1) but adds a frame that says
   nothing. Recommendation: no; the converter leaves them outside, and an author may add one.
   **Decision (2026-09-29):** Adopted. The three top locations get no canton by default; the converter leaves them outside, and an author may add one.
3. **Depth.** Canton → member → child is three levels of frame. Recommendation: fix the depth
   there. Every transitive reader of ticket 2 is written for a chain of any length, so a canton of
   cantons is the same rule applied again, but no sheet in the corpus needs it.
   **Decision (2026-09-29):** Adopted. The depth is fixed at canton, member, child.
4. **Per-column tier gaps.** A canton could hold its tiers closer than the global gap.
   Recommendation: no. Bands are global (`skeleton-geometry.ts:95-104`), the row plan is per gap,
   and G1 and G8 read bands; a per-column gap makes each of them per column.
   **Decision (2026-09-29):** Adopted. No per-column tier gaps; bands stay global.
5. **`grid` members and member flanks.** Refused in this version (`CANTON_MEMBER_SHAPE`,
   `CANTON_MEMBER_FLANK`). Recommendation: keep them refused until a sheet needs them; a grid
   member needs a cell form, and a member flank needs a place in the canton frame.
   **Decision (2026-09-29):** Adopted. Grid members and member flanks stay refused (`CANTON_MEMBER_SHAPE`, `CANTON_MEMBER_FLANK`) until a sheet needs them.
