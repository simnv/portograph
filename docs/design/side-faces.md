# Lateral sides for links between tiers (design)

Q109. Status: design (2026-09-30). Tickets 114 to 121 under `.scratch/ranked-groups/issues/`.

## 1. Problem

The maintainer asked (2026-09-30): *"Links could connect not only to top/bottom, but to left/right
too."* Asked when, the answer was *"not only nearest face"*.

Today stage 2 gives a port whose peer is on another tier the side `top` or `bottom`. Stage 5 gives
`left` or `right` only to a port whose peers are on the same tier or on a flank. So a link between
two tiers always leaves a horizontal edge and enters a horizontal edge. When the straight line
between those two faces is blocked, the link bends at least twice.

The maintainer's example: a routed link leaves the bottom face of a load balancer, jogs right,
runs down a long vertical, turns left along a horizontal run, and then drops onto the top face of
an outlet. If it entered the outlet's right face, the horizontal run would end on that face and the
route would lose its last bend.

A lateral side has two uses:

1. **Straighten.** A link whose segment from a top or bottom face is blocked, or leaves its frame
   through a side edge, can be one straight segment from a lateral face. On the private sheet:
   - an overlay link from a server in a two-rank group to a client on the tier below goes round the
     sibling body that stands under the server;
   - 9 of 13 cross-frame chord candidates (Q108) are refused with reason `edge`. The providers
     stand in a small frame and the location routers stand far to the side, so the chord is
     shallow. Measured on a small synthetic (2026-09-30): every refused chord leaves the far
     **location** frame, not the provider frame, and it leaves through a **side edge** of that
     frame. The misses past the 10 px corner margin are 7.4, 7.6, 14.5, 24.5 and 30.3 px; on the
     private sheet they are 40 to 80 px. A shift of the port along its bottom face does not
     answer it: three of five need 28 to 99 px of shift, and the router's face is about 30 px
     wide.
2. **Cut bends.** A link that must bend takes the faces that give the fewest bends: an L (one
   bend, a bottom face to a lateral face), not a route of 3 to 5 segments.

## 2. Decision in one paragraph

A port of one link whose peer stands on another tier may take the **lateral side** that faces the
peer, when that gives the link fewer **planned bends**. The choice is made on a placed model (the
end of 7e, when every node x is known), and it is enacted by **running placement again** with the
chosen side as a **side hint**. Stage 2 of the new run applies a hint as it applies an author
`side:`, one rank below it, so stages 3 to 7 size the node, reserve the leg and the clearance, and
freeze the side at stage 5 as for any other port. ADR-0009 is unchanged: no side changes after the
freeze. The side round shares the loop that ticket 89 made for fan pitches. A round is kept only
when every hint in it gives the shape it was taken for and the bent-link count falls. The shapes
are: a straight segment (an overlay chord, or a routed frame chord or cross-frame chord), and one
bend (an overlay L, or a routed **side lane**: a lane that runs down beside the lateral end's frame
to the port's height and ends in a horizontal **side run** into the lateral face).

## 3. Terms

These go into `CONTEXT.md` with ticket 114. Existing terms keep their meaning.

| Term | Definition |
|---|---|
| **lateral side** | `left` or `right`. A **lateral port** is a port on a lateral side (the words `lateral-port` and "lateral links" already use this sense). |
| **natural side** | The side stages 2 and 5 give a port when no hint and no author `side:` applies. |
| **side hint** | An engine-chosen lateral side for one port, measured on a placed model and applied at stage 2 of the next placement run. It ranks below an author `side:` and above the stage-2 rule. It is not written in the YAML. The layout JSON records it on the port (`sideHint`, with `naturalSide`). |
| **planned bends** | The bends a link will have, read from placement claims at the end of 7e (Section 6). A lower bound for a routed link that stage 8 routes. |
| **side lane** | A lane owned by a link with a lateral port on a routed end, through that end's own sub-tier band, from the band edge to the port's y. It stands outside the end's frame, on the side the port faces. |
| **side run** | The horizontal fixed segment from a side lane's x to the lateral port's face, at the port's y. |

## 4. Which links may take a lateral side

**Both families.** Each family has one example of each use (Section 1), and each has a shape that
placement can reserve or derive:

- **overlay**: the path is derived from the two frozen ports (`overlay-paths.ts`). A lateral face
  needs no new path rule. The straight branch already allows any angle, and "leaving outward" is
  read against the port's own normal, so a lateral face leaves outward toward a peer on its side.
  The orthogonal branch already derives a single turn, which a top/bottom pair cannot use.
- **routed**: a straight segment is a routed chord (Q93, Q108), decided in the `rebuildRowPaths`
  fixed point. One bend is a side lane, reserved in 7a with the lane machinery. Nothing is left for
  stage 8 to find.

A link end is a **candidate** when all of these are true:

1. Its natural side is `top` or `bottom`: the peer stands on another sub-tier (another tier, or
   another rank of the same group).
2. The port carries exactly one link. A shared port (a fan, ADR-0016), a bundle member (ticket 35),
   a bus port and a mesh-bus link are not candidates. Their sides are owned by other rules.
3. The link is not a stub, not a group-link collapse, and its `route` is absent or `straight`.
4. The port has no author `side:`. The link has no author `route: orthogonal`.
5. The node is not in a `grid` group, a `bar` group or a flank. The grid vote already reads
   geometry (stage 5), and bars and flanks own their sides.

The lateral side offered is the one that faces the peer: `right` when the peer's centre x is
greater than the node's centre x, else `left`. The other lateral side faces away and fails
"leaving outward" for any straight segment, so it is never offered.

## 5. Shapes and the decision rule

For each candidate link, the measure reads up to four configurations: natural at both ends
(today), lateral at the upper end, lateral at the lower end, lateral at both ends. For each it
reads the shape a probe gives (Section 7):

| Shape | Bends | Overlay | Routed |
|---|---|---|---|
| straight | 0 | the straight branch | a frame chord or a cross-frame chord (`chordVerdict` clear) |
| L | 1 | the orthogonal branch's single turn | a side lane at the far port's x (source-aligned, no jog) and its side run |
| side lane after a transit lane | today's lane bends, less the mouth part | not offered | the link's own transit lane runs on through the end band (ticket 120) |
| any other | as planned | not offered | not offered |

"Lateral at both ends" is offered for the straight shape only. An L has one lateral end by
definition.

**Order of preference.**

1. Fewer planned bends. A configuration is taken only when its planned bends are strictly fewer
   than today's. Straight (0) beats L (1). L beats every stepped route (2 or more).
2. On a tie in bends: fewer lateral ports (one lateral end before two).
3. Then: no node growth before growth (Section 8).
4. Then: the lateral port at the **lower** end. This is the maintainer's example: the vertical run
   drops from the upper port, and the horizontal run ends on the lower node's face. It also keeps
   the feed direction a reader expects (from above).
5. Then: the lateral port on the end whose node comes first in document order. This is the
   deterministic last tie-break.

**Order of links.** The measure reads candidates in link order. Each accepted hint is applied to
the probe's clone before the next link is read, so later links see earlier hints (as the chord
batch pass does). The set of hints only grows inside one measure.

## 6. Planned bends

`plannedBends(model, link)` reads the placed model at the end of 7e. It reads no router.

- **Overlay:** the segment count of the derived path, less one (`overlayPath` on the current
  geometry).
- **Routed chord** (a frame chord or a cross-frame chord that the fixed point holds): 0.
- **Level path** (`expectedLevelPath` pinned): 0.
- **Side lane:** 1, plus the planned bends of the part in the gap above the lane (0 when the lane
  is source-aligned and the part is a drop).
- **Any other routed link:** per tier gap it crosses, 0 when its two ends in that gap stand on one
  x (a drop), else 2; plus 2 for a transit lane that is not source-aligned. A Z part counts 2 here
  (a lower bound); a residual part counts 2.

A link is **bent** when its planned bends are more than 0. The round uses planned bends. The
acceptance (Section 15) uses the bends the published paths have.

## 7. When the side is chosen: the side round

**Why not stage 5 alone.** Stage 5 knows only the skeleton's x. Stages 7a to 7c move groups and
nodes by far more than a pitch, so a lateral side chosen from skeleton x is often wrong at 7e.

**Why not a late change after 7c.** A side read after 7c would break ADR-0009, and every consumer
of sides between stage 5 and 7c would need a replay: the stage-5 resize and repack, row paths
(stage 6), the source-side transit pitch and lane allocation (7a), the primary bundle order (7b),
the feeds that centring reads (7c), the bus side (`busSide`), and the ADR-0011 title edge. That
list is the whole placement. Running placement again is the same work, and it has one producer.

**The round.** `measureSides(model, refused)` runs where `measureFans` runs, on the model that
`place()` returns (stages 1 to 7e). It returns side hints. The loop in `src/pipeline/index.ts`
merges the hints with the fan floors and runs `place(floors, hints)` again:

1. The loop has one cap for both kinds, `PLACEMENT_ROUNDS = 3` (today `FAN_ROUNDS = 2`).
2. A round runs only when the measure gives a new floor or a new hint.
3. A trial is kept when all of these hold:
   - every hint of the trial gives its shape: `plannedBends` of that link on the trial is the
     bends the measure promised, or fewer;
   - the bent-link count falls, or stays the same while the total planned bends fall;
   - the straight chord count does not fall (the existing fan rule).
4. A hint that does not give its shape goes into `refused` and is never offered again. When rounds
   remain, the loop runs once more with the delivered hints only. When no round remains, the trial
   is dropped and the last kept model stands.
5. A kept hint stays in every later round. So the hint set grows, the refused set grows, and the
   loop ends.

**What a hint changes in the new run.**

- **Stage 2** (`sidesOne`): a port with a hint takes the hint's side. It records `naturalSide`,
  the side the stage-2 rule gives it (for a port the stage-2 rule leaves undecided, the side
  stage 5 gives it in the measured round).
- **Stage 3** (`sizeNodes`): the node is sized with the port on the lateral side. The node takes
  its measured size as a floor (`nodeFloors`), so the natural face never shrinks between rounds
  (Section 8).
- **Stage 4** (skeleton): ELK gets each hinted port on its natural side (`skeleton-graph.ts` reads
  `naturalSide ?? side ?? sizingSide`). When the node sizes are equal, the ELK input is the same as
  in the measured round, and so is the skeleton.
- **Stage 5** (`sidesTwo`): the side is already set, so stage 5 does not change it. The engine
  order on the lateral side sorts by the peer's y, as for any lateral port. The row gap reserves
  the pill of a named lateral port (the facing-pill rule). `busSide` and the ADR-0011 title edge
  read a hinted port on its natural side, so a hint never moves a bus or a title.
- **7a to 7f**: no change for overlay hints. For routed hints, see Sections 9 and 10.

**The probe.** The measure never runs placement. It clones the 7e model, puts the port on the
lateral side, re-sizes that node in place (the top edge stays, the height grows downward when the
lateral face needs more room), re-derives its anchors from the slots, and reads the shape:
`overlayPath` for an overlay link, `chordVerdict` for a chord, and the side-lane corridor test
(Section 10) for an L. The trial then says whether the shape holds after placement moves.

## 8. Node size

Invariant 3 is unchanged: `height = max(minH, contentH, n_left|right × pitch + 2·pad)`. A lateral
pitch is `max(12, pill height + 4)`, so 14 px for a named pill and 12 px for an anonymous port.

- **Height.** A lateral face that takes hints can need more height. The growth is **reserved at
  size time**: stage 3 of the new run sizes the node with the port on the lateral side. It is not
  found on demand. A taller node makes its row and its sub-tier band taller, and everything below
  moves down. The trial measures the result, and rule 3 of the round refuses a trial where this
  loses a shape.
- **Width.** A port that leaves the top or bottom face frees one slot there. The node keeps the
  measured round's width as a floor (`nodeFloors`), so the other ports on that face keep their
  pitch, and the skeleton input stays the same. Ticket 114 states how `rebuildNodeGeometry`
  places the remaining ports over that width (their order does not change).
- **Tie-break 3** of Section 5 prefers a configuration that fits the lateral face at the node's
  current height.
- **Lateral fans.** A lateral face is not spread by the fan rule in the first version
  (`measureFans` reads top and bottom faces). When two chords from one lateral face would stand
  closer than the 10 px chord clearance at the base pitch, the probe refuses the second one
  (`pitch`).

## 9. A routed chord from a lateral side

Candidate item 4 of `routed-chords.md` (Section 3) changes: the upper port is on `bottom` or on a
lateral side, and the lower port is on `top` or on a lateral side. Items 1 to 3 do not change. A
frame chord (one frame) takes a lateral end with no other change.

**The facing-edge rule is read per port face, not per tier direction.** Q108 wrote it as "the
chord leaves each end frame through the edge its port faces", and ticket 99 built it for the two
faces it allowed: the upper end leaves by the bottom edge, the lower end by the top edge. With a
lateral port the words stay and the reading changes:

- At each end, the **exit edge** of every box that holds that end only (the end frame or free
  group, its parent frame, its canton frame) is the edge on the side the port faces: the bottom
  edge for `bottom`, the top edge for `top`, the right edge for `right`, the left edge for `left`.
- The chord meets that edge at least the group edge link-margin (10 px plus half the stroke) from
  each corner. For a side edge, that is the edge's y-range less the margin at the top and at the
  bottom.
- A chord that leaves by any other edge is refused (`edge`), as today. For a lateral port, a
  horizontal edge is now the wrong edge: a chord steep enough to reach the frame's bottom edge
  before its side edge keeps the bottom face. So the two faces split the work: a steep chord takes
  the bottom (or top) face, and a shallow chord takes the lateral face. This is the case the
  measure above found: the shallow chord already leaves the location frame by its side edge, and
  only the port's face is wrong.

**The measured case.** The location router's port takes the lateral side that faces the provider
(tie-break 4 does not apply: the upper end is the one that can straighten; the probe reads both
ends, and the configuration with a clear chord wins by rule 1). The chord leaves the router's
lateral face, crosses the frame's side padding, and leaves the location frame through the side
edge that faces the provider. The router must be the outermost body on that side at the chord's
height, or the chord meets its row neighbour (`body`). The provider end keeps its natural face
when its own exit is clear; when the provider frame is also small, the provider's port may take
its lateral side too ("lateral at both ends", Section 5).

**Beyond the exit edge.** The chord crosses the column slack beside the location frame. There,
the foreign frame and canton boxes are walls (unchanged), and lane boxes are walls (unchanged). Q108
kept a chord out of the slack because centring spends it and lanes stand in it. Both still hold:
lanes are reserved in 7a and read as walls; centring (7c) ends before the fixed point stops at 7e;
a 7f move that puts a foreign frame on the held chord is refused by `chordsHold`
(`STRAIGHT_LINK_HELD`), as for any cross-frame chord. The chord leaves the frame by a side edge, so
it crosses no title band at that end.

After the freeze, `edgeLeavers` (`STRAIGHT_LINK_EDGE`) names a frozen cross-frame chord that leaves
by an edge other than its exit edge, read per port face as above.

## 10. The side lane (routed, one bend)

A routed lateral port whose peer is on another sub-tier has no planned part today: the tier-gap
plan names it residual (`lateral-port`), and stage 8 routes it. The side lane reserves it in 7a.

**Shape.** The upper port's stem goes down from its face (the upper port is on `bottom`), crosses
the tier gap as a planned part, enters the lane's mouth, runs down the side lane through the lower
end's sub-tier band to the lateral port's y, and turns into the side run. When the lane is
source-aligned, the gap part is a drop and the link has one bend. A lower end on `top` and an upper
end on a lateral side is the mirror case: the lane runs up through the upper end's band.

**Where it stands.** Outside the end's frame (or free group, or canton), on the side its port
faces, as every lane stands (ADR-0013). The side run crosses the frame's side padding and side edge
at a right angle, so G6 (`segment-group-edge`) does not apply. Nothing may stand between the face
and the lane at the port's y: no body, no pill, no foreign lane, no foreign frame. So in the first
version the lateral node is the outermost node of its row, on that side, within its frame.

**Reservation.** 7a allocates the side lane with `allocateLanes`, as a lane for one sub-tier, with
the lateral end's band as its extent, cut at the port's y. It tries the source-aligned corridor
first (the x of the upper port), then the nearest clear exterior corridor, as for a transit lane.
The side run is a fixed segment of the lane owner (`fixedSegments`). The lane source's anchor is
then fixed in x, as for every lane (ADR-0010, 7a). The stem length (15 px) and the edge margin
(10 px plus half the stroke) fit inside the 20 px frame padding plus the lane's own clearance, so
the frame does not grow for the run. The frame grows for the lane only where the existing lane rule
says so.

**The tier-gap plan.** The part in the gap between the two ends is a normal part, from the upper
tip to the side lane's mouth (ADR-0021). A source-aligned side lane makes it a drop.
`lateral-port` stays a residual reason for a lateral port with no side lane.

**Author lateral ports.** The side lane also serves a lateral port with an author `side:` whose
peer is on another sub-tier. That port is residual today (`lateral-port`). The corpus differential
of ticket 118 lists each such link.

**Transit lanes (ticket 120).** A link that already owns a transit lane toward its lower end (the
long vertical of the maintainer's example) can run that lane on through the lower end's band to
the lateral port's y, and end in a side run. That removes the mouth part (its row and its lower
leg). This is a separate ticket, because it changes the extent of an existing lane, not a new one.

## 11. Overlay

No new path rule. `overlay-paths.ts` derives the path from the frozen ports as today:

- straight: one segment from the lateral face to the other face, when it leaves both ports outward
  and enters no node body and no foreign pill;
- L: the orthogonal branch's single turn. It is taken only when the derivation gives exactly one
  turn on the trial.

An overlay lateral port puts a pill on the lateral face. Stage 5's row gap already reserves room for
facing named pills. The overlay endpoint mark stands on the port's own outward face, as today. The
placement steps of tickets 76, 77 and 80 read the chords as they stand after the side freeze; they
count a lateral chord as any straight overlay chord.

## 12. What is reserved where

| What | Where | By |
|---|---|---|
| The side of the port | stage 2 of the new run (hint), frozen at stage 5 | ticket 114 |
| Lateral face capacity (node height) | stage 3, again at the stage-5 resize | invariant 3, ticket 114 |
| Natural face width (a floor) | stage 3 (`nodeFloors`) | ticket 114 |
| Pill room in the row gap | stage 5 (`rowGap`, facing pills) | unchanged |
| A routed chord from a lateral face | the `rebuildRowPaths` fixed point, frozen at the start of 7f | ticket 117 |
| Side lane and side run | 7a (`allocateLanes`, `fixedSegments`) | ticket 118 |
| The part in the gap above a side lane | the tier-gap plan, 7f (ADR-0021) | ticket 118 |
| An overlay path | derived from the frozen ports (stage 8 publishes it) | unchanged |

## 13. Interactions

- **G5 (port order).** The lateral side's engine order sorts by the peer's y (stage 5, unchanged).
  A hinted port whose peer is below sorts to the bottom of the face, nearest the bottom corner, so
  its link crosses no other link of that face near the face. An author `order:` still wins.
- **G6 (group-edge margin).** A side run meets the frame's side edge at a right angle. A side lane
  stands outside the frame at the lane clearance. A chord leaves by its facing edge at least the
  margin from a corner. No new run is parallel to a frame edge.
- **Fans and pitch floors (tickets 89, 102).** Fan floors and side hints share the round loop. A
  floor is kept when a hint later moves a chord off that face (floors only grow), so a face can
  keep a wider pitch than it still needs; the corpus differential reports canvas growth. Lateral
  faces are not spread (Section 8).
- **Mesh bus stubs.** A bus port is never a candidate, and `busSide` reads hinted ports on their
  natural side, so the bus keeps its edge and a joined pair keeps its facing edges (Q107).
- **Riser keep-out.** A side lane is a lane. 7a places it with the other lanes, and the riser
  keep-out reads it as a fixed-x leg of the member row in whose band it stands. Ticket 118 checks
  the order inside `allocateLanes` (`reserveRisers` against pending lanes) and adds that read if it
  is missing. A side run may cross a riser lane at a right angle (overlay geometry; counted as a
  crossing).
- **Title bands.** A lateral port leaves by the frame's side edge, so its chord or side run crosses
  no title band at that end. `busSide` and the title edge read the natural side, so no title moves.
  The other end keeps the rules of Q103 and ticket 100.
- **Chord freezing at 7f.** Unchanged. The side is frozen at stage 5; the chord is decided in the
  fixed point and frozen at the start of 7f. `chordsHold` and `blockedChords` read a lateral chord
  as any cross-frame chord.
- **Lanes.** A side lane is an obstacle to every link, its owner included, as every lane is. It is
  a wall to every chord.
- **Link labels (ADR-0014).** A label on a side run is horizontal (0 degrees). The label room of a
  described link is reserved on its longest run, as today.
- **Restore (ADR-0010).** `restoreLayoutModel` compares resolved semantics with the document. A
  hinted port has a side the document does not give. The topology baseline records each hint and
  its natural side; restore checks that the natural side is the one stages 2 and 5 give, that the
  hint is the lateral side that faces the peer, and that the port is a candidate (Section 4).
- **draw.io export.** Ports already carry any of the four sides. No change.

## 14. Determinism

- The hints are a function of the placed geometry and link order only.
- The probe and the round read no clock. The round cap is a count.
- The loop keeps the one clock read it has today: a re-run does not start after the hard command
  deadline (`FAN_SPREAD_CUT`, renamed `PLACEMENT_ROUND_CUT` and extended to side hints). That
  fallback names itself, as it does for fans. No corpus input and no private input reaches it.
- ELK is deterministic for one input. With equal node sizes, a hinted run gives ELK the same input
  as the measured run (Section 7).

## 15. Metrics and acceptance

**Must not regress** (corpus differential over all of `goldens/`, against main):

- **Gates:** no gate gained in any file. G5 and G6 finding counts do not rise.
- **Crossings:** the corpus total does not rise. A file may rise only where a new straight chord
  crosses a planned row (the Q108 rule: straight anyway); each such file is listed.
- **Q:** the corpus mean does not fall. Each file that falls by more than 0.005 is listed with its
  cause.
- **Links removed:** 0.
- **Canvas:** each file whose area changes by more than 2 % is listed.

**Acceptance:**

- **Bent links fall** on the corpus: the count of links whose published path has more than one
  segment, routed and overlay counted apart, falls, and no file gains a bent link.
- **Private sheet** (link ids only): the overlay link past the sibling body is one segment; at least
  6 of the 9 `edge` refusals draw straight; the routed and overlay bent counts fall; Q is not below
  0.8188; no gate fails; crossings are reported.
- **M1 golden:** rendered again; each changed link is named and reviewed by `agy -p` against
  `docs/design/quality.md`.

## 16. Not in the first version

- A candidate on a shared port, a bundle, a grid, a bar or a flank.
- A lateral side for a link whose natural side is already lateral (a same-tier peer).
- A side lane inside a row gap (between two nodes of one row). It needs a lane inside a frame row.
- Fan spread on a lateral face.
- A shape with two or more bends offered as an improvement (for example, a side lane that is not
  source-aligned). Only straight and L are offered, and a transit lane that loses its mouth part
  (ticket 120).

## 17. Open questions

1. **The mechanism.** The side round runs placement again (Section 7). The other way is a new
   stage after 7c that changes sides and replays every consumer, which amends ADR-0009.
   *Recommendation:* the round. It keeps ADR-0009 and has one producer. The cost is one more full
   placement for a diagram that takes a hint; the scale bench (ticket 17 inputs) measures it, and
   the command deadline still bounds it.
2. **Height growth.** A lateral face may grow its node with no cap (Section 8), or the offer can
   stop at the height the node already has. *Recommendation:* no cap, reserved at size time, and
   the corpus differential reports canvas growth. A router or a provider that takes several lateral chords on one face needs growth.
3. **Crossings for an L.** Q108 takes a clear chord even when it adds a crossing. The same rule for
   an L? *Recommendation:* yes; fewer bends win, and crossings are reported.
4. **Author lateral ports and the side lane** (Section 10). *Recommendation:* yes; it replaces a
   residual part with a planned one.

## 18. Tickets

| # | Title | Blocked by |
|---|---|---|
| 114 | A side hint puts a port on a lateral side in the next placement run | — |
| 115 | The side round straightens an overlay link from a lateral side | 114 |
| 116 | An overlay link turns once into a lateral side | 115 |
| 117 | A routed chord leaves a lateral side | 115 |
| 118 | Placement reserves a side lane into a lateral port | 114 |
| 119 | The side round offers a routed L through a side lane | 115, 118 |
| 120 | A transit lane ends in a lateral side (conditional) | 119, 121 |
| 121 | Links between tiers bend less (acceptance) | 116, 117, 119 |
