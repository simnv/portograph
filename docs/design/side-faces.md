# Lateral sides for links between tiers (design)

Q109. Status: design (2026-09-30), amended after the Opus review the same day (H1, H2, M1 to M6,
L1 to L6). Tickets 114 to 122 under `.scratch/ranked-groups/issues/`.

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
6. The link owns no transit lane (`transitTiers` is empty): its ends stand on adjacent sub-tiers.
   A transit link belongs to ticket 120 (review M6).
7. The link is **bent now**: its planned bends on the measured model are more than 0 (Section 6).
   A straight link is never probed (review M4).

An author lateral port is no hint candidate (item 4), but it may get a side lane (Section 10,
decision 4).

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

**Minimum outward angle** (review L1). A straight segment from a lateral face leaves at
`MIN_LATERAL_ANGLE = 15°` or more from the face: its horizontal component out of the face is at
least `sin 15°` of its length. A steeper segment rides the node's own edge and reads as a link to
the corner; it keeps the natural face. The probe reads this for both families.

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

> **Amended (Section 19, 2026-09-30).** Candidates are read on the baseline (the kept model after
> 7f). A trial is kept only on its routed result after 7f; a predictor may prune hints predicted
> worse only when the rest can be placed again.
> The command deadline is now 60 s (user decision); the rule "the whole command fits at 2x" below
> stands, and Section 19.5 re-derives the constants. The pseudo-code and the numbers below are the
> first version.

**Why not stage 5 alone.** Stage 5 knows only the skeleton's x. Stages 7a to 7c move groups and
nodes by far more than a pitch, so a lateral side chosen from skeleton x is often wrong at 7e.

**Why not a late change after 7c.** A side read after 7c would break ADR-0009, and every consumer
of sides between stage 5 and 7c would need a replay: the stage-5 resize and repack, row paths
(stage 6), the source-side transit pitch and lane allocation (7a), the primary bundle order (7b),
the feeds that centring reads (7c), the bus side (`busSide`), and the ADR-0011 title edge. That
list is the whole placement. Running placement again is the same work, and it has one producer.

**The round** (review H2). `measureSides(model, refused)` runs on the model that `place()` returns
(stages 1 to 7e), after the fan rounds. Fan floors keep ticket 89's loop unchanged. Side hints get
their own rounds after it. In pseudo-code:

```
model  = place(floors = {}, hints = {})
floors = {}; hints = {}; refused = {}          // refused: a set of (port, side) keys
reruns = 0                                     // every place() after the first

// 1. Fan rounds: ticket 89's loop, unchanged (cap FAN_ROUNDS = 2, code FAN_SPREAD_CUT).
for round in 0 ..< FAN_ROUNDS:
  next = floors ∪max measureFans(model).floors
  if next == floors: break
  if not gate(): cut(FAN_SPREAD_CUT); break
  trial = place(next, hints); reruns += 1
  if elkCut(trial): cut(FAN_SPREAD_CUT); break
  if straightChords(trial) < straightChords(model): break     // drop the trial, keep floors
  model = trial; floors = next

// 2. Side rounds: only when a hint is offered.
for round in 0 ..< SIDE_ROUNDS:                // SIDE_ROUNDS = 2: one offer, one retry
  offer = measureSides(model, refused)          // new hints only; never an old or refused key
  if offer is empty: break
  if reruns >= MAX_RERUNS: note(SIDE_ROUND_SKIPPED); break      // a count, not the clock
  if not gate(): cut(SIDE_ROUND_CUT); break
  trial = place(floors, hints ∪ offer); reruns += 1
  if elkCut(trial): cut(SIDE_ROUND_CUT); break
  failed = { h in hints ∪ offer : plannedBends(trial, link(h)) > promised(h) }
  if failed is empty
     and (bent(trial) < bent(model)
          or (bent(trial) == bent(model) and totalBends(trial) < totalBends(model)))
     and straightChords(trial) >= straightChords(model):
    model = trial; hints = hints ∪ offer; continue
  // the trial is dropped: model, floors and the old hints stay as they were
  if failed ∩ hints is not empty: refused = refused ∪ offer     // a new hint broke an old one
  else if failed ∩ offer is not empty: refused = refused ∪ (failed ∩ offer)
  else: refused = refused ∪ offer                               // every shape held, no gain
```

- **Fan-only diagrams.** When no hint is offered, part 2 does nothing, and the loop is ticket 89's
  loop with the same cap and the same rule. The output is byte-identical to main. There is no third
  fan round.
- **An old hint** is never withdrawn. It gave its shape on the kept model. A trial in which it
  fails is dropped, and the new hints of that trial are refused.
- **Floors** do not change in part 2. A dropped side trial leaves them as they were. A side round
  adds no fan measure: a lateral chord that would need a spread is refused by the probe (`pitch`,
  Section 8).
- **Known limit: `refused` is greedy and keyed by hint.** A hint refused in a trial with another
  hint is not offered again, even when it would give its shape alone, and a key refused for one
  geometry stays refused after the geometry changes. The retry round offers only the hints that
  were not refused; nothing searches subsets.

**Budget** (review M4). The layout must not depend on machine speed (ticket 112). The side rounds
therefore use the count-based gates of ticket 112 and add no clock read:

- There is no time gate (ticket 141, Section 19.5). A re-run starts when the counts allow it. The clock only ends the whole command at
  the hard deadline, with an error; it never picks a layout. (Ticket 137's `RERUN_GATE_MS` is deleted.)
- `MAX_RERUNS` caps fan and side re-runs together. It is a **fixed constant**, never set by the
  clock. The gate alone is not enough: it is read at the start of a re-run, and a re-run that
  passes it can still leave too little time for 7f, routing, link labels and scoring, so the
  command meets the 60 s deadline and publishes nothing.
- **The rule for the constant:** `MAX_RERUNS` is the largest count for which the private sheet's
  **whole command** (first placement, every re-run with its measures, 7f, stage 8, stage 9,
  validation and scoring) finishes before the 60 s deadline on a machine 2 times slower, with 2 s of
  margin. Known numbers on a quiet machine: the first placement takes about 2 s and 7f 6.6 s. The
  rest is not measured yet. Ticket 115 measures each stage time on the sheet on a quiet machine
  (the coordinator renders it for the implementer), multiplies the total by 2 for each candidate
  count (0 to 3), and sets the constant to the largest count that fits. When 0 fits, no side round
  runs, and the ticket says so.
- `measureFans` and `measureSides` are part of the measured total, per round.
- **Measured (ticket 115, private sheet, quiet machine, dist workers):** first placement 3958 ms; two fan re-runs 2681 and 2729 ms;
  `measureFans` 35 and 29 ms, `measureSides` 7 ms; 7f 6462 ms, route 281 ms, labels 237 ms, score 24 ms (tail about 7004 ms); whole command
  16.5 s. Gates read 25983 and 23273 ms left. Projection: 2 re-runs 16.4 s quiet, about 33 s at 2x, so main missed the 30 s deadline at
  2x (ticket 131; the deadline is 60 s since ticket 137, and at 2x the same run fits). 3 re-runs 19.1 s quiet, which fits at 1.45x but not at 1.5x. The sheet has no side candidate with the straight overlay
  shape yet, so no side round ran. `MAX_RERUNS` stays 3 (provisional) until ticket 121, when tickets 116, 117 and 119 give the sheet real
  side candidates and the constant is set from a new measurement.
- The probe has a cap: at most `PROBE_CAP = 256` probes per `measureSides` call, in link order.
  The candidates after the cap are not probed that round (`SIDE_PROBE_CAPPED`, info). The cap is a
  count.

**What a hint changes in the new run** (review M3). Each reader of a side is named here, with the
side it reads.

| Reader | Side read | Why |
|---|---|---|
| Stage 2 (`sidesOne`) | hinted | It applies the hint and records `naturalSide`: the side the stage-2 rule gives, or, for a port that rule leaves undecided, the side stage 5 gave in the measured round. |
| Stage 3 (`sizeNodes`) | hinted | The lateral face is reserved at size time. The measured size is a floor (`nodeFloors`). |
| Stage 4 (ELK, `skeleton-graph.ts`) | natural | `naturalSide ?? side ?? sizingSide`. With equal sizes the ELK input is the same as in the measured round. |
| `busSide` (`bus.ts`, `sideOf`), at stage 2 and at stage 5 | natural | A hint never moves a bus edge. |
| ADR-0011 title edge (`frameSide`) | natural | A hint never moves a title. |
| Stage 5 engine order, `rowGap`, content insets, `groupPadding` | hinted | These are the geometry of the port as drawn. |
| 7a to 7e (lanes, row paths, chords, bundles) | hinted | They reserve the drawn shape. |
| 7c feeds (the axis on the mean x of routed feeds) | hinted | **Decided:** the hinted side, because a natural-side anchor does not exist on the drawn node. `feeds()` keeps a link only when the parent port is on the facing horizontal side and the child port on the other (`bottom` over `top`), so it **drops a hinted link completely**: the centring axis loses that link's whole pull, not half a node width. The axis can move far, the node can leave the x the round measured, and more trials can fail. The round drops those trials; ticket 115 counts them. A side lane adds its own feed (Section 10, *The far port*). |

**What a named lateral port changes** (it has a pill; an anonymous port has none):

- the node's content inset on the lateral side (the larger of 10 px and the pill's inward half
  extent plus 4 px), so the content interior can narrow and `contentW` can grow;
- `groupPadding` on that side, which stage 5 reserves beyond named pills;
- `rowGap` toward the row neighbour on that side: the facing pill and the 15 px stem.

So a named lateral port can change the node width and the row x after the skeleton, and the trial
measures it. Ticket 114's byte-identical ELK test uses an anonymous port and passes the measured
size floors.

**The probe.** The measure never runs placement. It makes **one** clone of the 7e model for the
whole call and resets the touched node and links after each probe (review M4). It puts the port on
the lateral side, re-sizes that node in place (the top edge stays, the height grows downward when the
lateral face needs more room), re-derives its anchors from the slots, and reads the shape:
`overlayPath` for an overlay link, `chordVerdict` for a chord, and the side-lane corridor test
(Section 10) for an L. The trial then says whether the shape holds after placement moves.

## 8. Node size

Invariant 3 is unchanged: `height = max(minH, contentH, n_left|right × pitch + 2·pad)`. A lateral
pitch is `max(12, pill height + 4)`, so 14 px for a named pill and 12 px for an anonymous port.

- **Height.** A lateral face that takes hints can need more height. The growth is **reserved at
  size time**: stage 3 of the new run sizes the node with the port on the lateral side. It is not
  found on demand. A taller node makes its row and its sub-tier band taller, and everything below
  moves down. The trial measures the result, and the round (Section 7) drops a trial where this
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
- **Slack** (review M2). The shape is judged at 7e and drawn after 7f, which moves columns and
  grows gaps. So the probe and the fixed point read the corner margin plus `SIDE_EDGE_SLACK = 4 px`
  (as `FAN_SLACK` does for the chord clearance) for an exit through a side edge. The freeze and
  `edgeLeavers` read the margin alone.
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

**A new lane kind** (review H1). A transit lane does not fit: `laneExtent` gives a full band,
`validateLanes` expects the ids of `transitTiers(link)` and bounds equal to the band,
`reservation()` writes one full vertical run, `rebuildLaneExtents` resets every lane to its band,
and `laneSource` aligns to the end nearer the anchor tier. The side lane is its own kind:

- **Model.** `Lane.kind: 'transit' | 'side'` (absent reads `transit`, so old layouts restore). A
  side lane adds `port: PortRef` (the lateral port). Its id is `side-lane:<link id>`. `tier` is the
  lateral end's sub-tier; `side` is the port's side; `group` is the lateral end's group.
- **Extent.** Measured from the port, not the band: from the band edge that faces the far end
  (grown by the same `10 + stroke / 2` pad as `laneExtent`) to the port's anchor y. A function
  `sideLaneExtent(model, lane)` gives it.
- **Replay.** `rebuildLaneExtents` recomputes a side lane from `sideLaneExtent` with the port's
  current anchor y, so a 7d or 7f move in y (a band that grows, a node that moves down) moves the
  end of the lane with the port. It rebuilds the lane's pair of fixed segments with
  `sideReservation`, not with `reservation()`, and it reads the lane kind explicitly. The lane's x,
  owner and id never change after 7a (ADR-0010).
- **Kind checks.** Every lane function that reads or moves lanes reads `kind` explicitly:
  `reseatLanes`, `rebuildLaneExtents`, `validateLanes`, `laneSidesHold` and the riser reads. A
  function that serves one kind only says so and skips the other.
- **Alignment end.** `sideLaneSource(link)` is the far end (the port that is not lateral), not the
  end nearer the anchor tier. The lateral end is not moved under the lane: the side run joins them
  at any x.
- **The far port** (the review re-check). The part is a drop only while the far port stands on the
  lane's x. Neither 7c nor 7f holds a port by name today: 7c aligns a child under a feed, and a 7f
  column move checks only the lanes of its own tier (`laneSidesHold`). So:
  - **7c.** `feeds()` adds one feed per side lane: the far port is the child, and the lane's x is
    the x it must sit under (`transit: true`, as a transit lane's feed is). When the far end's tier
    is centred, centring brings the far port under the lane like any child. When the far end is in
    the authority tier, 7c does not move it, and 7a put the lane on its x. When centring declines
    the feed, the far port stays off the lane, the part is stepped, the planned bends rise, and the
    round drops the trial.
  - **7f.** A new guard, `sideLanesHold`, joins `optionalMoveHolds`: a move that changes the x of
    a side lane's far port while the lane stays is refused (`SIDE_LANE_HELD`, info). This covers
    column moves, the canton close-up and the chord-clear steps, in every tier, not only the lane's
    tier. A move 7f cannot refuse (a forced widening) keeps the move: the tier-gap plan then
    plans a stepped part to the mouth, and `SIDE_SHAPE_LOST` names the link (Section 11).
- **Reservation.** `sideReservation(model, link, lane)` writes two fixed segments, in path order:
  the vertical run at the lane x over the extent, then the **side run** from the lane x to the
  port's face at the port's y. Both carry `lane: <id>`. The side run is at least one stem (15 px)
  long, so it is the port's stem.
- **`validateLanes`.** The expected ids are the transit ids plus a side-lane id for each link that
  has one. A side lane is valid only on a candidate for it (a routed link with no transit lane, a
  lateral port whose peer is on another sub-tier, the node outermost on that side of its row in its
  frame). Its bounds equal `sideLaneExtent`, and `fixedSegments` equal `sideReservation`. The other
  lane checks (width, side of the group, occupied groups, overlap with lanes, fixed paths across a
  foreign lane) apply unchanged.
- **Route validation.** `route/validate` accepts a complete path that ends in the side run: the
  last segment is horizontal, ends on the lateral port's face, and equals the reserved side run.
  The existing check "the complete path holds every immutable reserved segment" covers both runs.
- **Allocation.** 7a allocates side lanes with the transit lanes in `allocateLanes`: the
  source-aligned corridor first (the far port's x), then the nearest clear exterior corridor. A
  link whose corridor is not clear gets no side lane and stays residual (`SIDE_LANE_REFUSED`, info,
  with the reason `body`, `lane`, `frame` or `corridor`).
- **Size.** The stem (15 px) and the edge margin (10 px plus half the stroke) fit inside the 20 px
  frame padding plus the lane's own clearance, so the frame does not grow for the run. The frame
  grows for the lane only where the existing lane rule says so.

Ticket 118 builds the model, the allocation, the replay and `validateLanes`. Ticket 122 builds the
tier-gap mouth, the stitch and route validation, and the riser keep-out.

**The tier-gap plan.** The part in the gap between the two ends is a normal part, from the upper
tip to the side lane's mouth (ADR-0021). A source-aligned side lane makes it a drop.
`lateral-port` stays a residual reason for a lateral port with no side lane.

**Author lateral ports.** The side lane also serves a lateral port with an author `side:` whose
peer is on another sub-tier. That port is residual today (`lateral-port`). The corpus differential
of ticket 118 lists each such link.

**Link-label room** (review M1, re-check point 5). `reserveLinkLabelRoom` measures the
face-to-face gap, and `overlayRunMid(..., 'y')` has no answer for an L whose longest run is
horizontal. It has two moves: in y, the groups of the tiers below move down by the deficit; in x,
**insert at the split**: everything at or right of the split between the two ends moves right, in
every tier, and it refuses when a reserved lane stands at or beyond the split
(`LINK_LABEL_ROOM_UNRESERVED`, and the stage-9 ladder places the label). The spec takes:

- **Side lane:** the label room is reserved on the **vertical** run (the drop and the lane), by the
  move in y. The side run is never the label's run: its own lane stands beyond its split, so
  insert at the split would always refuse.
- **Overlay L:** the room is reserved on the longest run. On a vertical run, the move in y. On a
  horizontal run, insert at the split. Where a lane stands beyond the split, the spec accepts the
  refusal: `LINK_LABEL_ROOM_UNRESERVED` (warning) names the link and the stage-9 ladder places the
  label, as it does today for any link in that case.

Tickets 116, 118 and 119 each add their case.

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

**Shape held after 7f** (review M2; amended by Section 19: a trial is kept only when each promised
shape holds on its 7f output, so the check below is a guard). An overlay path is not a claim, and 7f can move a body onto it
after the round judged it at 7e. At the end of 7f, `SIDE_SHAPE_LOST` (warning, placement) names each
hinted link whose derived path has more bends than the round promised. The acceptance (Section 15)
counts it and must find 0 on the corpus. `SIDE_SHAPE_LOST` reads every hinted shape:

- a **routed chord** is held by `freezeChords`; the check is a guard for a move 7f cannot refuse;
- a **side lane does need the check**: its reservation holds the lane and the side run, but not the
  far port's x, and a forced 7f move turns the drop into a stepped part (Section 10, *The far
  port*);
- an **overlay** path is held by nothing, so the check is its only witness.

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
| Side lane and side run | 7a (`allocateLanes`, `sideReservation`), extent replayed from the port's y | ticket 118 |
| The part in the gap above a side lane | the tier-gap plan, 7f (ADR-0021) | ticket 122 |
| Link-label room on a lateral shape | 7f (`reserveLinkLabelRoom`) | tickets 116, 118, 119 |
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
  keep-out reads it as a fixed-x leg of the member row in whose band it stands. Ticket 122 checks
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
- **Link labels (ADR-0014).** A label on a side run is horizontal (0 degrees). The label room is
  reserved on the longest run of the planned shape (Section 10, *Link-label room*).
- **Restore (ADR-0010).** `restoreLayoutModel` compares resolved semantics with the document. A
  hinted port has a side the document does not give. The topology baseline records each hint and
  its natural side; restore checks that the natural side is the one stages 2 and 5 give, that the
  port is a candidate (Section 4). Restore does **not** check that the hint faces the peer
  (coordinator, 2026-09-30, ticket 114 review): restore accepts every layout the pipeline publishes,
  and 7f can move a column after the round judged the shape. The round drops a trial where facing
  fails at 7e. At the end of 7f, `SIDE_HINT_FACES_AWAY` (warning, placement) names the link of a
  hinted port that then faces away, and `SIDE_SHAPE_LOST` covers the published shape.
  Restore checks the stored invariants, not the history (review L2): the stored `naturalSide`, the
  hint and the stored `nodeFloors` are checked against the document and the geometry; restore does
  not re-run the round.
- **draw.io export.** Ports already carry any of the four sides. No change in code; ticket 121
  checks a lateral port and a side run through the drawio CLI (review L4).

## 14. Determinism

- The hints are a function of the placed geometry and link order only.
- The probe and the round read no clock. The round cap is a count.
- The loop reads no clock (ticket 141). Fan re-runs keep `FAN_SPREAD_CUT` and side re-runs `SIDE_ROUND_CUT`, and both now name only an ELK
  fall-back in a re-run (ADR-0006), never a time gate.
- Every other bound is a count: `FAN_ROUNDS`, `SIDE_ROUNDS`, `MAX_RERUNS`, `PROBE_CAP`.
- ELK is deterministic for one input. With equal node sizes and anonymous ports, a hinted run gives
  ELK the same input as the measured run (Section 7).

## 15. Metrics and acceptance

**Must not regress** (corpus differential over all of `goldens/`, against main):

- **Gates:** no gate gained in any file. G5 and G6 finding counts do not rise.
- **Crossings:** not a criterion (Section 17, decisions 3; Q108 for chords). The corpus total and
  each file that rises are reported, with the link that adds the crossing.
- **Q:** the corpus mean does not fall. Each file that falls by more than 0.005 is listed with its
  cause.
- **Links removed:** 0.
- **Canvas:** each file whose area changes by more than 2 % is listed.

**Acceptance:**

- **Bent links fall** on the corpus: the count of links whose published path has more than one
  segment, routed and overlay counted apart, falls, and no file gains a bent link.
- **Private sheet** (link ids only): the overlay link past the sibling body is one segment; the
  number of the 9 `edge` refusals that draw straight is reported, link by link (a reported number,
  not a gate; review L6); the routed and overlay bent counts fall; Q is not below
  0.8188; no gate fails; crossings are reported.
- **`SIDE_SHAPE_LOST`:** 0 on the corpus.
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

**Open follow-ups (no ticket yet).**

- **`FAN_RERUN_MS` was too small** (ticket 112). Closed by ticket 137 (with ticket 131), then replaced by ticket 141: the deadline
  is 60 s, and no time constant decides a re-run. See Section 19.5.

## 17. Decisions (2026-09-30)

1. **The mechanism** (coordinator). The side hint is applied by running placement again
   (Section 7). A late stage after 7c that changes sides is rejected: it would amend ADR-0009 and
   replay every consumer of sides. The scale bench (ticket 17 inputs) measures the cost of the
   extra run, and the command deadline still bounds it.
2. **Height growth** (maintainer). No cap. A lateral face grows its node as far as its ports need,
   reserved at size time (Section 8). The corpus differential and the private sheet report canvas
   growth.
3. **Crossings for an L** (maintainer). Fewer bends win for a one-bend route even when crossings
   rise, as Q108 decided for chords. Crossings are not a criterion of the side round. Total corpus
   crossings are still measured and reported (Section 15). Coordinator, 2026-09-30: this holds for the
   straight shape and the L alike. The round does not drop a trial for an overlay crossing added at a
   moved port; it keeps the trial and emits the info diagnostic `SIDE_HINT_ADDS_CROSSING` (link and
   count). The false-gain case of ticket 115 (review M1) is closed by the natural-clear candidate test.
4. **Author lateral ports and the side lane** (coordinator). An author `left` or `right` port whose
   peer is on another sub-tier also gets a side lane (Section 10). It replaces a residual part with
   a planned one.

## 18. Tickets

| # | Title | Blocked by |
|---|---|---|
| 114 | A side hint puts a port on a lateral side in the next placement run | — |
| 115 | The side round straightens an overlay link from a lateral side | 114 |
| 116 | An overlay link turns once into a lateral side | 115, 133, 136 |
| 117 | A routed chord leaves a lateral side (the chord part may merge first) | 115, 133, 136 |
| 118 | Placement reserves a side lane into a lateral port | 114 |
| 119 | The side round offers a routed L through a side lane | 115, 118, 122, 133, 136 |
| 120 | A transit lane ends in a lateral side (conditional) | 119, 121 |
| 121 | Links between tiers bend less (acceptance) | 116, 117, 119 |
| 122 | A side lane joins the tier-gap plan and the route | 118 |
| 133 | The side round judges the published geometry (Section 19) | 115, 137 |
| 134 | Stage 7f holds a promised overlay L (conditional, Section 19.6) | 116, 133 |
| 135 | Stage 7f costs 6.5 s on the private sheet | — |
| 136 | A hinted placement run leaves the column packing off its fixed point (Section 19.9) | — |
| 137 | The command deadline is 60 s, and every re-run reads one gate (Section 19.5; closes 131) | — |

## 19. Amendment 1 (2026-09-30): the round judges the published geometry

This section amends Sections 6, 7, 11, 14 and 15. Where they differ, this section wins. Row Q109a of
the decisions log records it.

### 19.1 Why

Ticket 116 measured the round on the private canton sheet. The round judges a trial at 7e, and 7e
does not predict what 7f publishes:

- 7f moves every tier down, by a different amount per tier. End nodes move 66 to 237 px in y between
  7e and publication, and each tier gap grows by about 80 to 90 px. The x moves are small (−28 to
  +44 px). The diagonals get steeper and clear bodies that blocked them at 7e.
- Of about 60 overlay links, 9 publish straight but plan 2 to 4 bends at 7e. To see their natural
  straight as clear at 7e needs 8 to 32 px of slack. In a small fixture a link that needs 16 px stays
  bent, and a link that needs 32 px publishes straight. No value of `NATURAL_SLACK` separates the
  two.
- Result: 4 links gain, but the bent overlay links go from 22 to 24. A link that is straight when
  published got a hint and went 1 → 4 segments (after 7f the L's vertical crosses a body of a middle
  row). A second L lost its shape (5 → 4). Three straight neighbours went 1 → 3; two neighbours
  gained.

The cause is one error: the round compares two 7e models, but it must compare two published models.
A slack cannot fix it. A hold in 7f (Section 19.6) fixes only the L that the round promised, not the
baseline and not the neighbours.

### 19.2 The rule

1. **The baseline is published geometry.** 7f runs on the kept model (after the fan rounds) before
   the side round. Its output is the **baseline**: the model the command publishes when no trial is
   kept. This 7f is not extra work, because the command runs it in any case.
2. **Candidates are read on the baseline.** `measureSides` reads "bent now" and probes the overlay
   shapes on the baseline, so a link that publishes straight is never a candidate. `NATURAL_SLACK`,
   `naturalStraightNearlyClear` and `predictedBends` are removed. The routed shapes (a chord, ticket
   117; a side lane, ticket 119) keep their probe on the kept 7e model, because placement decides
   them in 7a to 7e and holds them in 7f (`freezeChords`, `sideLanesHold`). Their "bent now" is read
   on the baseline, as for every link. `measureSides` keeps two probe clones, one of the baseline
   (overlay) and one of the kept 7e model (routed). **Each accepted hint is applied to both clones**,
   each in its own coordinates, so every later probe of either family sees every earlier hint (the
   lateral slot stacking reads the other ports on that face).
3. **The predictor only prunes** (coordinator, after the Opus review). The trial runs placement to
   7e, as today. Only when another round and another re-run remain, the **predictor** (Section
   19.3) moves each trial node by the move that 7f gave the same node in the kept model, and the
   round refuses the hints predicted **worse** than on the baseline and places the rest again. It
   never refuses a hint that is only short of its promise (it still gains; user decision, net
   count), and it never drops a whole trial. When no round or re-run remains (the sheet), the trial
   goes to 7f with no screen: the 60 s budget already pays for that 7f, and a screen could only drop
   a real gain when the predictor is wrong.
4. **A trial is kept only on its routed result.** The trial runs 7f, then the round routes the
   baseline and the trial (stage 8) and compares the two routed models: no hinted link has more
   bends than on the baseline, no hinted port newly faces away, no link is removed by the trial's
   route that the baseline's route keeps, the bent links fall (or stay equal while the total bends
   fall) counted over all links, and the straight routed chords do not fall. Otherwise the routed
   baseline is published. **A side hint therefore never makes the published sheet worse** by that
   count, for overlay and routed links alike. A trial is a batch (Section 19.8), so a hint that
   gives fewer bends than on the baseline but more than it promised does not refuse the batch; info
   `SIDE_SHAPE_SHORT` names it.

   Routing here does not break the load-bearing rule. Both placements are complete when they are
   routed; nothing that routing finds is fed back into placement. The router only measures which of
   two finished placements publishes fewer bends.
5. **At most one trial reaches 7f per command** (`MAX_SIDE_VERIFY = 1`, a count). After that 7f
   the round stops, kept or not.

### 19.3 The predictor

`predictPublished(trial7e, kept7e, baseline)` returns a clone of `trial7e` in which:

- each node moves by `baseline − kept7e` of the same node (the x and y of the top-left corner). Its
  ports, anchors and pills move with it. The node keeps its trial size;
- groups, frames, lanes, runs and pinned paths do not move. The predictor serves the overlay paths
  and the facing test only, and those read nodes and pills alone (`overlayBlockers`,
  `hintsFacingAway`).

The move is per node, not per tier, because the x moves differ inside one tier. The predictor reads
no router and no clock. It costs one clone and one `bendTotals` (milliseconds on the sheet). It
prunes; it never judges. It has the same kind of error as 7e (7f growth depends on what the hint
changes: label room, side lanes, gap rows), which is why it may only prune a hint predicted worse,
and only when the rest can be placed again. Ticket 133 reports its agreement with the routed bends,
link by link.

### 19.4 The round, amended

```
model  = place(floors = {}, hints = {}); fan rounds as Section 7, part 1   // unchanged
kept7e = model
declined = measureFans(kept7e); atFreeze = chordClearances(kept7e)        // unchanged, read at 7e
base   = bands(kept7e)                     // the baseline: the same 7f that main runs, no abort parameter
refused = {}
for round in 0 ..< SIDE_ROUNDS:            // SIDE_ROUNDS = 2 (a count)
  offer = measureSides(base, kept7e, refused)   // overlay probes on base, routed on kept7e; each hint on both clones
  if offer is empty: break
  if reruns >= MAX_RERUNS: note(SIDE_ROUND_SKIPPED); break
  floorsOf = stage3Sizes.get(kept7e)                             // the 7e model keys the size cache, never base
  trial7e = place(floors, hints ∪ offer, floorsOf, abortAt = trialDeadline); reruns += 1
  if elkCut(trial7e): cut(SIDE_ROUND_CUT); break              // a deadline ends the command (ticket 141)
  if round + 1 < SIDE_ROUNDS and reruns < MAX_RERUNS:           // the predictor prunes only when it can place again
    worse = hinted links predicted worse than on base, or newly facing away, on predictPublished(trial7e, kept7e, base)
    if worse ∩ offer is not empty: refuse(worse ∩ offer); continue
  trial = bands(trial7e, abortAt = trialDeadline)
  routedBase = route(base); routedTrial = route(trial)
  if holds(routedTrial, routedBase, offer) and gains(routedTrial, routedBase, trial7e, kept7e):
    base = trial; kept7e = trial7e; hints = hints ∪ offer        // publish the trial
    declined, atFreeze = read again on trial7e
  else: refuse(offer)
  break                                                          // one trial reaches 7f per command
publish route(base) (reuse routedBase or routedTrial; link labels, score)
```

- `holds(r, rb, offer)`: on the routed trial `r` against the routed baseline `rb`, no hinted link has
  more bends (`worse` names those that do), no link is removed by the trial's route that the
  baseline's route keeps, and no hinted port faces away that did not already face away on the
  baseline (main's `awayBefore` exclusion, for test hints). A hinted link with fewer bends than on
  the baseline but more than promised is `short`: kept, and named by `SIDE_SHAPE_SHORT` (info).
- `gains(r, rb, trial7e, kept7e)`: by the published path of **every** link (routed and overlay), the
  bent count falls, or it is equal and the total bends fall; and `straightChords(trial7e) >=
  straightChords(kept7e)`. Collateral is counted on every link, not only near the moved nodes. The
  predictor's prune uses `plannedBends` instead (no router).
- **Main's crossing check goes.** Main keeps a trial only when `overlayCrossingsAt` at the moved
  nodes does not rise (ticket 115 review). The amended round has no crossing term: the user decided
  that fewer bends win even when crossings rise (Section 17, decision 3), so 115's straight hints
  lose that check too. `SIDE_HINT_ADDS_CROSSING` (ticket 116) stays as a report on a kept trial,
  read on the two routed models with no slack (it must not call `naturalStraightNearlyClear`,
  which goes).
- `MAX_SIDE_VERIFY` = 1 is the `break` at the end of the loop body, not a separate check.
- **The abort parameter.** `place` and `bands` take an optional `abortAt` of their own, apart from
  the command budget that 7f's chord-clear step reads. `bands` is synchronous inside
  `withLayoutMutation`, so the check throws from the edit callback between 7f passes. The baseline
  call passes none, so the baseline 7f never throws for a side reason. On a trial that reaches 7f,
  `onProgress` reports `bands` and `route` twice; the reporter labels the trial's stages.
- A kept trial names, as info `SIDE_HINT_BENDS_NEIGHBOUR`, each link without a hint whose bends
  rose: the collateral that the net count accepted.
- Hints are no longer kept across rounds, because only one trial reaches 7f. The retry (round 2)
  offers again on the same baseline, less the keys that the predictor pruned.
- `SIDE_SHAPE_LOST` (now: a hinted link with more bends than on the baseline) and
  `SIDE_HINT_FACES_AWAY` stay. On a kept trial, rule 4 has already tested them exactly, so they
  are guards and must read 0.

### 19.5 Budget: a 60 s deadline (user decision)

**Ticket 141 (2026-09-30) replaces the gates below.** The user rule: the layout never depends on machine speed. Ticket 137's `RERUN_GATE_MS`
read the time left, so on a slow machine the same input could publish another layout. Now:

- The choice between layouts reads no clock. A re-run starts by counts only: `FAN_ROUNDS` = 2, `SIDE_ROUNDS` = 2, `MAX_RERUNS` = 3 (the two fan
  re-runs and one side trial), `MAX_SIDE_VERIFY` = 1. `RERUN_GATE_MS`, `FAN_RERUN_MS`, `BANDS_MS` and `POST_PLACEMENT_RESERVE_MS` are deleted.
- The clock only ends the whole command. `step`, `route` and the `trialAbort` check between the passes of a trial's 7f throw
  `CommandDeadlineError` when the budget is spent (`remainingMs() <= 0`). A deadline in a re-run or in a trial is no longer caught and turned into
  `FAN_SPREAD_CUT` or `SIDE_ROUND_CUT`: the command ends with the error and publishes nothing. `SIDE_ROUND_CUT` and `FAN_SPREAD_CUT` now mean
  only that ELK fell back in a re-run.
- The chord-clear step of 7f lost its clock guard and its `CHORD_CLEAR_BUDGET` warning. It is already bounded by counts (`CHORD_TRIALS`,
  `SETTLED_TRIALS`, one move per mover, `CANTON_ROUNDS`). `bands` and `withLayoutMutation` take no budget any more, only `abortAt`.
- Why these counts: on the private sheet the worst path (4.0 s first placement, two fan re-runs and one side trial of 2.7 s each, three 7f of
  6.5 s at most, two routes) is about 23 s quiet and about 46 s at 2x, which leaves 14 s before 60 s. A fourth re-run adds 2.7 + 6.5 s quiet,
  or 18.4 s at 2x: 64 s, over the deadline. So 3 is the largest count that fits at 2x.
- Time-dependent places left, by design: the ELK per-attempt limit (ADR-0006: 10 s, 20 s above 300 nodes) and the router's `ROUTE_BUDGET_MS`
  are stage policies, and they can still fall back on a very slow machine (diagnosed as before). They bound one attempt, not the choice
  between two layouts. `runtime.stages` durations are reports and are outside the layout snapshot.
- Test: `test/pipeline/deadline-gates.test.ts` runs `layout()` on a fake clock at speeds 0, 1 and 2 and asserts byte-identical layout JSON,
  and that a clock past the deadline rejects with `CommandDeadlineError`.

**The text below is ticket 137's derivation, kept for the measured times; its gates and constants no longer exist.**

**Decided by the user (2026-09-30):** the command deadline goes from 30 s to 60 s
(`COMMAND_DEADLINE_MS`, ticket 137), so the side trial always fits on the sheet and the layout does
not depend on machine speed. **The rule of Section 7 is restored:** the private sheet's whole
command, on its worst path, finishes before the deadline on a machine 2 times slower, with 2 s of
margin, and no clock gate cuts at 2x or faster. The clock gates stay only as a guard against the
hard deadline.

**The sheet at 2x** (quiet times doubled: first placement 4.0 s, fan re-run 2.7 s, 7f 6.5 s, route
plus link labels plus score 0.55 s, measures about 0.1 s; a later profiling run gives 16.5 s in
process with 7f about 7.1 s, and ticket 138 speeds 7f up with no byte change; the table keeps the
measured 16.5 and 25.7 s):

| Path | Quiet | 2x | Against 60 s at 2x |
|---|---|---|---|
| No candidate (main today) | 4.0 + 2 × 2.7 + 6.5 + 0.55 = 16.5 s | 33.0 s | 27.0 s left |
| One trial to 7f, no routing in the judgment | 16.5 + 2.7 + 6.5 = 25.7 s | 51.4 s | 8.6 s left |
| One trial to 7f, both routed (worst path) | 25.7 + about 0.4 (the second route and the count) ≈ 26.2 s | about 52.5 s | about 7.5 s left, under 58 s |

The sheet has no pruned re-place: `MAX_RERUNS` leaves no re-run after the trial, so the predictor
never runs there.

**The constants.** Each is a fixed number, set from the sheet at 2x and rounded up; none is read
from the clock at run time.

| Constant | Value | Stands for | Sheet at 2x |
|---|---|---|---|
| `COMMAND_DEADLINE_MS` | 60000 (was 30000) | the hard deadline | — |
| `FAN_RERUN_MS` | 6000 (was 8000) | one placement re-run to 7e, fan or side | 5.4 s |
| `BANDS_MS` (new) | 14000 | one 7f | 13.0 s |
| `POST_PLACEMENT_RESERVE_MS` | 4000 (was 8000) | route, link labels, score, validation and the SVG after 7f | 1.1 s measured; SVG and validation to be measured by ticket 137 |
| `RERUN_GATE_MS` | `POST_PLACEMENT_RESERVE_MS + FAN_RERUN_MS + BANDS_MS` = 24000 | what must be left to start any re-run | — |

- **One gate for every re-run.** A fan re-run or a side trial starts only with `RERUN_GATE_MS` left.
  After a fan re-run, the baseline 7f and the tail must still fit; after a side trial, its 7f and
  the tail. Both are one re-run, one 7f and the tail. This replaces ticket 112's fan gate
  (`POST_PLACEMENT_RESERVE_MS + FAN_RERUN_MS`, which left out 7f; ticket 131).
- **Gate readings on the sheet at 2x:** fan gate 1 at about 8.1 s (51.9 s left), fan gate 2 at
  about 13.5 s (46.5 s left), the side gate after the baseline 7f at about 32.0 s (28.0 s left).
  Each passes; the side gate has 4.0 s spare. The side gate closes at about 2.25x, and the worst
  path (26.2 s × f + 2 s) reaches 60 s at about 2.2x, so the gates and the rule agree to within the
  guard.
- **The trial deadline stays as a guard.** `trialDeadline` is the command's remainder less
  `POST_PLACEMENT_RESERVE_MS`, passed as the `abortAt` parameter of the trial's `place` and `bands`
  (Section 19.4). At 2x on the sheet it leaves 24.0 s against 18.4 s needed. It acts only above
  about 2.2x: the trial then throws `CommandDeadlineError` at the next stage or 7f pass, the round
  cuts (`SIDE_ROUND_CUT`) and the baseline publishes, so a side trial never makes the command miss
  its deadline. The reserve (4 s) also covers the second route (about 1 s at 2x). 7f's own gate
  (the chord-clear step against `POST_PLACEMENT_RESERVE_MS`) reads the command budget, in the trial
  as in the baseline.
- **`MAX_RERUNS` stays 3, set by the gate margin.** Section 7's time rule alone would allow a fourth
  re-run (about 52.5 + 5.4 + 2 = 59.9 s at 2x, just under 60 s). The gate does not: before a fourth
  re-run it reads 22.6 s left, under `RERUN_GATE_MS` (24 s), so it would cut at 2x. The count is the
  largest with no gate cut at 2x. On a diagram with fewer fan re-runs, the second side round can
  run.
- `MAX_SIDE_VERIFY` stays 1: a second trial to 7f adds about 19 s at 2x (over 70 s).
- Every other bound is a count: `FAN_ROUNDS`, `SIDE_ROUNDS`, `MAX_RERUNS`, `MAX_SIDE_VERIFY`,
  `PROBE_CAP`.
- The ELK policy (ADR-0006: 10 s, or 20 s above 300 nodes) and the router's own `ROUTE_BUDGET_MS`
  do not change. `budget.share` still caps them by what remains.
- Lowering `POST_PLACEMENT_RESERVE_MS` from 8 s to 4 s moves the point where 7f's chord-clear step
  stops trying movers. The sheet at 2x starts its 7f with about 46 s left, far from either value;
  the goldens never come near a gate. Ticket 137 confirms with the corpus differential.

### 19.6 A hold for an overlay L in 7f: deferred

7f could hold an overlay L as a keep-out for its two runs, as `sideLanesHold` holds a side lane.
Under rule 4 a lost L no longer publishes a worse sheet; it only drops a trial. A hold would let more
trials pass, but it constrains 7f for every other link, and the L's own ends move in 7f, so the
keep-out must move with them. Ticket 134 builds it only when the measurement of ticket 133 shows a
verified trial refused because an L was lost.

### 19.7 Byte-identity

- A diagram for which **main's round made no offer and the new round makes none** publishes the
  bytes of main. The baseline is main's 7f output, and neither round adds a diagnostic.
- Every other golden can differ: where main's 7e round kept a trial, the geometry changes; where
  main refused one, its `SIDE_HINT_REFUSED` goes; where the new round offers, its notes are added.
  Ticket 133 lists each such golden by name, with the cause.

### 19.8 One trial per sheet: the batch and the shared cap

On the private sheet the side round gets **one trial at most**: `MAX_RERUNS` = 3 and the fan rounds
spend 2 (ticket 117 measured it: one trial, refused, then `SIDE_ROUND_SKIPPED`). Section 19.5 shows
that the gates at 2x also allow no more, even with the 60 s deadline. The design follows from that.

- **A trial is a batch.** It carries every hint of the offer, as today: `measureSides` accepts the
  hints in link order and applies each to both probe clones (Section 19.2, rule 2), so each probe
  sees the hints before it. One trial per link would give the sheet one link.
- **A batch is judged as a whole, by the net count** (rule 4): the bent links over all links fall,
  and no hinted link is worse than on the baseline. A hint that falls short of its promise but
  still gains does not refuse the batch. The first version asked every hint to give its promised
  shape, so one short hint refused the whole batch; with one trial, the sheet then gained nothing.
- **The predictor prunes only when it can place again.** When a re-run and a round are left and
  the prediction says some hints get worse than on the baseline, the round refuses those hints and
  places the rest again. A hint predicted short (it still gains) is never pruned. The predictor
  never drops a whole trial. On the sheet no re-run is left, so the batch goes to 7f as it is.
- **A batch that fails at 7f is refused whole.** No second 7f is allowed, so no subset is tried.
  This is the known limit of Section 7 (`refused` is greedy), now with exact data.

**Fans and sides share `MAX_RERUNS`; fans keep priority.**

- The fan loop spends a re-run only when a floor grows. A fan round that changes nothing already
  costs no re-run, so "side trials first when fans change nothing" is already the behaviour.
- Fans must run first. The fan floors move chords and nodes; a side trial judged before them would
  be judged on a model that the fans then move. And the baseline must be main's 7f output for
  byte-identity (Section 19.7).
- Per family the counts stay: `FAN_ROUNDS` = 2, `SIDE_ROUNDS` = 2, `MAX_RERUNS` = 3 in all,
  `MAX_SIDE_VERIFY` = 1. Raising `MAX_RERUNS` to 4 would make the fourth gate cut at 2x
  (Section 19.5).
- Ticket 133 reports, on the sheet, what the second fan re-run changes in the published baseline.
  When it changes no published link, a later ticket may lower `FAN_ROUNDS` for large inputs by a
  count rule, and the freed re-run lets the predictor prune on the sheet.

### 19.9 Notes from ticket 117

- **A routed chord owns its path.** A hinted lateral port whose link is a routed chord candidate gets
  no side lane (ticket 117). The chord is its reserved path. This agrees with Section 10.
- **A kept trial off the fixed point.** On `three-canton-groups-close-up-to-a-band-gap`, a kept
  side trial leaves the published layout off the fixed point of the column rules: on a copy,
  `packBesideRows` then moves two groups by +83 and +171 px; without the hint it moves nothing. This
  is a placement defect of the hinted run (probably an anchor-step pack that 7c or 7f leaves
  unfinished), not a judging error. Rule 4 judges the layout that is published, so it cannot see a
  pack that did not run. Ticket 136 diagnoses and fixes it in placement, and it blocks the round
  wiring of tickets 116, 117 and 119. Ticket 133's acceptance runs the fixed-point check on each
  kept trial of the corpus as a hard gate: a trial off the fixed point fails the ticket.

### 19.10 User decisions (2026-09-30)

1. **Raise the time limit (user).** The command deadline goes from 30 s to 60 s, so the side trial
   always fits on the sheet at 2x and the result does not depend on machine speed. The gates are
   re-derived and stay only as a guard against the hard deadline; Section 7's rule that the whole
   command fits at 2x is restored (Section 19.5). Ticket 137 makes the change and closes ticket
   131. Rejected with it: side gains only on a quiet machine; refusing side trials on large inputs;
   keeping a trial on the prediction alone (it can publish a worse sheet).
2. **Net count (user).** A trial is kept when the bent links fall across the whole sheet (or stay
   equal while the total bends fall) and no hinted link is worse than on the baseline (rule 4). Each
   neighbour without a hint whose bends rise is named in `SIDE_HINT_BENDS_NEIGHBOUR`. The stricter
   rule "no link gets worse" is rejected. This matches Section 17, decision 3, for crossings.

### 19.11 Coordinator decisions after the Opus review (2026-09-30)

The review (ticket 133, comments) found the core sound and asked for these amendments, now in the
sections above:

1. The predictor may act only when another re-run and round remain; otherwise the trial goes to 7f
   (Section 19.2, rule 3).
2. It prunes only hints predicted worse, never hints that are only short (rule 3, Section 19.8).
3. Stage 8 is inside the judgment: both models are routed and bends are counted on the routed
   paths, so routed neighbours are judged; a link the trial's route removes counts as worse (rule
   4; about 0.4 s quiet, worst path about 52.5 s at 2x, Section 19.5).
4. Main's crossing check goes, by the user's decision that fewer bends win even when crossings
   rise; `SIDE_HINT_ADDS_CROSSING` stays as a report (Section 19.4).
5. Byte-identity holds where main made no offer and the new round makes none (Section 19.7).
6. Each accepted hint is applied to both probe clones (rule 2).
7. Ticket 136 blocks the round wiring of 116, 117 and 119; the fixed-point check is a hard gate in
   133 (Section 19.9).
8. The side round reads the stage-3 size cache by `kept7e`, never by the baseline (Section 19.4).
9. Ticket 133's tests fail without the fix (a straight hint that 7f breaks; a case that needs more
   than 4 px of slack).
10. The pseudo-code has no unreachable check, keeps main's `awayBefore` exclusion, and the
    predictor moves no group or frame box.
11. The trial's `place` and `bands` take their own `abortAt`; the baseline 7f never throws for a
    side reason.
12. `MAX_RERUNS` = 3 is set by the 2x fit of the sheet, not by a gate (Section 19.5, ticket 141).
