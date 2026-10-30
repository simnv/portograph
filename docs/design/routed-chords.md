# Routed chords between frames (design)

Ticket 98, Q108. Status: design. Tickets 99 to 104.

## 1. Problem

The maintainer said twice that orthogonal links must be rare: *"orthogonal links are not needed
here. they are needed only sometimes"* and *"still too many orthogonal links"*.

Today a routed link can be one straight segment in two cases only:

- a **frame chord**: both ends in one frame (the same frame, or a parent and its direct child;
  ticket 34, Q93; tickets 88, 89, 91);
- a **level path**: a facing pair on one sub-tier, shorter than twice the larger node dimension
  (`expectedLevelPath`).

A routed link between two frames, or between a frame and a free group, always routes orthogonally.

Measured on the private sheet (a build of ticket 86): 14 routed `dashed` links join the location
routers to two provider nodes on one middle row, and the providers to the core routers of the lower
locations. 12 of them draw a stepped part (leg, row, leg) with a long horizontal run. The other 2
are drops. Each of the 12 fails first at the candidate test (`frameLinkCandidate`: two frames). Each
joins two **adjacent sub-tiers** across one document tier gap (upper end on the last sub-tier of
its tier, lower end on the first of the next), so no tier band stands between its ends. The next
refusal is a title strip for at least 10 of the 12: the provider row keeps its title on its top
edge, and two lower location frames keep theirs on the top edge too. `titleStrips` holds the whole
strip, so a chord that enters its own end through the title band is refused.

These counts come from a build of ticket 86, not from current main. Since then main has the mesh
bus (tickets 82 to 84, 92: across-frames bus bands in the sub-tier gaps, canton boxes that grow by
a band and titles that move out by it), the gap-row node constraint (ticket 90: rows seated off the
lowest body edge) and the leg bound (tickets 91, 95). So gap heights, chord angles, port pitches
and title positions on the sheet can differ, and the count of title refusals can change. Ticket
103 measures the 12 links again on main.

## 2. Decision in one paragraph

A routed link whose ends stand in two different frames or free groups, on two consecutive document
tiers, with the upper port on `bottom` and the lower port on `top`, is a **cross-frame chord**
candidate. It takes one straight segment from face to face when the segment is clear, with the
same rules as a frame chord, plus three: it leaves each end frame through the edge its port faces;
it stays out of every foreign frame and canton box; and where it crosses its own end's title band,
the title must fit beside the crossing. The decision joins the existing fixed point
(`rebuildRowPaths`) and freezes at the start of 7f with the frame chords. A held chord is not a
part of the tier-gap plan; the plan keeps its own verticals off the chord. Placement does not move
groups for these chords in the first version.

## 3. Candidate (topology)

A link is a cross-frame candidate when all of these are true:

1. It passes the family filters of `frameLinkCandidate`: routed, not a bundle member, not a stub,
   `route` absent or `straight`, two different nodes, no flank and no bar end.
2. Its two ends stand in two frames that are not one frame for the frame rule (`sameFrame` is
   false). A free group is its own frame here (`frameOfGroup`).
3. The two end groups are on two consecutive **document** tiers. Both are tier groups or canton
   members; a canton adds no tier.
4. After the side freeze (ADR-0009), the port on the upper end is on `bottom` or on a lateral side that
   a side hint gave it (`sideHint`), and the port on the lower end is on `top` or on a lateral side
   that a side hint gave it (`docs/design/side-faces.md`, Section 9; ticket 117). The two faces must not
   be perpendicular (Section 15.1): a `bottom` end and a lateral end make no chord. A lateral side that
   is not a hint (an author `side:`) does not make a candidate.

Items 1 to 3 are known at stage 1. Item 4 is known after stage 6. The document tier of item 3 is the authored tier: stage 1 keeps it beside the
sub-tier as `documentTier` on every group of an expanded document, because `tier` is a sub-tier from then on (ticket 99). `rebuildRowPaths` runs after
stage 6 only, so the candidate is fixed before the first chord is read.

A group-link member is a candidate, as inside one frame (Q96), because it draws as its own link.

Why consecutive document tiers and facing ports: the ends then usually stand on adjacent
sub-tiers (the anchor rule puts an end that links down on its group's last rank, and an end that
links up on rank 0), and the chord crosses one tier gap. Where a group has fewer ranks than its
tier, a sub-tier band can stand between the ends; the band guard of Section 4 then refuses the
chord (`transit`), because such a link needs a lane, and a lane is reserved in 7a before the chord
is final (Section 9).

## 4. What the chord must clear

`standaloneChord` keeps every check it has today. It reads these for a frame chord and a
cross-frame chord alike:

- no sub-tier band strictly between the end sub-tiers (`transit`);
- the corridor of `straightCorridorClear`: 10 px from every foreign body, no contact with a foreign
  pill, no foreign lane box, no foreign group box, label, bundle zone or obstacle, 10 px from every
  fixed run that is not a held chord;
- the title strips (Section 6 changes this for a cross-frame chord's own end).

A cross-frame chord adds:

- **Foreign frames and cantons.** Every box of `groupBoxes` (free groups, frames, canton frames)
  whose `groupConsumers` do not hold the link is a wall, grown by the group edge link-margin
  (10 px plus half the stroke), as G2 `through-group` reads it. Today the corridor reads cell
  boxes only; a frame chord never leaves its frame, so the frame box was not needed. `model.frames`
  is equal to the cells after every transaction, so the check reads it directly.
- **The facing edge.** At each end, the chord leaves every box of `groupBoxes` that holds that
  end and not the other end (the end frame or free group, its parent frame, its canton frame)
  through the edge its port faces (the bottom or top edge; for a lateral port the side edge, `side-faces.md` Section 9): the point where the chord meets that edge's y lies
  on the edge, at least the group edge link-margin from each corner. A chord that would leave
  through a side edge is refused. So the chord never runs in the column slack between sibling
  frames, which centring spends and where lanes stand.

The fixed-point checks of `expectedFramePath` apply unchanged:

- 10 px from every held chord it does not strictly cross (`chordsApart`);
- 10 px from the whole vertical leg of every link that stays orthogonal (`orthogonalLeg`,
  ticket 91). In the chord's own gap, that leg runs from the port face to the far boundary of the
  gap, or to the far port's stem tip.
- 10 px from the **mouth leg** of every lane that ends on a boundary of the chord's gap (new for
  both kinds): at the lane's x, from the lane box's end through the whole gap, because the row the
  mouth leg meets is not known before 7f. `orthogonalLeg` reads port legs only, and the lane box
  (a wall with no clearance) ends 10 px plus half the stroke past the band, so today nothing keeps
  a chord from a mouth leg further into the gap.

So a held chord never crosses an orthogonal leg or a mouth leg of its gap.

**Angle.** There is no angle limit (**maintainer, 2026-09-30:** any clear chord draws straight,
however shallow), except for a member of a triggered direct family (Section 15.2: 30 degrees). A frame chord and an overlay chord take any angle, and the facing-edge rule already keeps a shallow chord inside the tier gap. The shallowest chord on the
private sheet is about 68 degrees from the vertical (391 px across, 161 px down).

## 5. The frame edge

A frame edge is not an obstacle to its own consumer (ADR-0013). The chord crosses its end frame's
padding and edge once. G6 `segment-group-edge` reads axis-aligned segments only, so a diagonal
never "runs along" an edge. The facing-edge rule (Section 4) is the only edge rule.

## 6. The own title band

A frame chord refuses every title strip. A cross-frame chord changes one case: the title band of
its **own end** on the edge the chord leaves through (the end frame's, the parent frame's, the
canton frame's). There the chord crosses the band as a leg does (ticket 62, Q103; the mesh bus
stub does the same, Q106):

- **Band.** For a frame or a free group, the strip `titleStrips` computes (the title edge of its
  first or last cell, as tall as the title). A canton has no cell, so `titleStrips` holds no strip
  for it today; its band is the one its sub-tier holds (canton-groups ticket 3). Until ticket 100
  lands, ticket 99 refuses a chord that meets an own canton's band (`title`), as for any strip.
  `model.labelBands` is not read: 7f produces it after the freeze.
- **Crossing rectangle.** The part of the chord between the band's top and bottom y, as its
  bounding box grown by half the stroke, with the title's link-free margin (8 px).
- **Decision.** The chord is refused (`title`) unless the band still holds the title: after the
  legs of `legRects`, the crossing rectangles of the held chords and this crossing are taken out of
  the band's x-range, one free interval is at least the measured title width plus the 8 px inset on
  each side. No growth is assumed.
- **Split.** The fit with this crossing alone (no legs, no other chord) is part of
  `standaloneChord`, so the batch pass offers only a chord that can hold alone. The fit with the
  legs and the held chords' crossings is part of `expectedFramePath`. A new chord checks every
  crossing in the band, its own included, so it cannot take a held chord's title room, and the
  held set only grows. Candidates are read in link order, so the result is deterministic.
- **7f (label bands).** `produceGroupLabelBands` runs after `freezeChords`. `planLabels` reads each
  held chord's crossing rectangle as a **hard** obstacle (`forbiddenRects`), computed from the
  frozen chord as it stands. Today `linkRects` reads a fixed path's segment as its bounding box;
  for a cross-frame chord that box covers the whole run from port to port, over the title band on
  the chord's full x-span, so the fit test above and the planner would disagree. Ticket 100 replaces
  that box, for a cross-frame chord, by its crossing rectangles (a frame chord keeps today's box).
  Where the title has no room, the planner widens the group (`growthPlan`), as for a title that
  does not fit. Where it cannot widen, `ROUTED_CHORD_TITLE` (warning) names the link and the group,
  and G3 judges.

*As built (ticket 100).* The crossing rectangle is wider in x on a slanted chord: the half stroke and the 8 px margin are taken along the normal of the
chord, so the x growth is (half stroke + 8) / cos of the angle to the vertical (a vertical chord gives 8 px). Measured: a title 8 px from the bounding box stood
7.8 px from a 52 degree chord, and G3 failed. The margin is in the rectangle; the planner adds no clearance to it. A held chord's child port owes it no place under
its feed, so `centreViolations` excuses it (a cross-frame chord only; ADR-0010 amendment, ticket 130).

A foreign title band stands inside its foreign frame box, so the foreign-frame wall covers it.

## 7. When the decision is made and frozen

No new stage. The candidate list of `rebuildRowPaths` takes the cross-frame candidates beside the
frame candidates. The add-only pass, the batch pass (ticket 89) and their loop are unchanged: a
held chord removes the link's stems and legs, the held set only grows, and the loop ends when a
pass adds none. `freezeChords` holds every chord that is straight at the start of 7f. From there a
held chord keeps its chord, and a refused candidate stays orthogonal (ticket 34).

The fan rule (ticket 89) reads the cross-frame candidates too: `measureFans` offers a face its
spread pitch (up to 60 px) when two chords at that face stand closer than the chord clearance. A
provider node that takes chords from three locations on one top face needs this.

*As built (ticket 102).* Nothing beyond ticket 99: `measureFans` reads `routedChordCandidate`, `fanRoundHolds` drops a fan re-run when the number of held chords of both kinds falls (`FAN_ROUND_DROPPED`, info, names the lost and gained chords), unless the kept placement has a chord pair under the 10 px clearance that the re-run clears and no frame chord is lost. A face is measured with `FAN_SLACK` (4 px) of drift room, so three
cross-frame chords that hold at the 12 px base pitch can still put a 16 px floor on their face; the fixture `a-provider-face-spreads-for-three-routed-chords` shows that. A face whose neighbouring chords
need more than 60 px is declined (`FAN_SPREAD_DECLINED`); the unit test forges the shallow geometry, and no layout input reaches it.

After the freeze, `chordsHold` and `blockedChords` also read foreign frame and canton boxes and
the facing-edge rule for a cross-frame chord. `chordsHold` moves nodes only today, so it derives
the frames of the proposed cells (`deriveFrames`) before it reads them. A 7f move that puts a
foreign frame on a held chord, or makes it leave by a side edge, is refused
(`STRAIGHT_LINK_HELD`); a move 7f cannot refuse keeps the chord and names it
(`STRAIGHT_LINK_BLOCKED`), as today.

*As built (ticket 99); coordinator's decision, 2026-09-30.* After the freeze only a foreign frame or canton box refuses a move; the facing edge is a
rule of the decision and is not held. Trace: holding it left `a-member-title-widens-a-beside-row` with G6. There 7f widens a member's title,
pushes the column of the next member, the chord of that member turns shallow and would leave its frame by a side edge, the move is refused, the
title stays unfit (`GROUP_LABEL_GAP_INFEASIBLE`) and the orthogonal fallbacks of the neighbours run along a frame edge. Released, the title widens and
no gate is gained. A held chord may therefore leave its frame through a side edge after 7f; it is named, not refused: at the end of 7f
`STRAIGHT_LINK_EDGE` (warning, placement) names each frozen cross-frame chord that leaves by a side edge or inside the 10 px corner margin
(reason `edge`), and the gates judge it.

## 8. How the other rules treat a held chord

Every consumer of `isFrameStraight` reads the wider predicate (renamed `isRoutedChord`):
`routerEntryPoints` and `legRects` (no stem, no leg), `route/obstacles.ts` (no router obstacle),
`route/validate.ts` and G7 (ends on the faces), G5 (no stem, one declared diagonal), the score
(continuity 1, Q94).

**Bundles (7e).** A bundle's zones and member paths are derived after the rows rule decides. The draft clears them before it decides
(`rebuildRegionGeometry`) and the validator's re-derivation clears them on its clone, so the rows rule never sees a bundle, for either kind of
chord. A chord that crosses a bundle is judged by G6 afterwards, as on main.

**Fan branches.** A shared-port fan tree reserves its branch run at placement, and nothing checks it against group boxes. A branch that a gate
would fail, a run through a foreign group box (G2) or along a box edge inside the edge margin (G6), is released to the router
(`FAN_BRANCH_THROUGH_GROUP`, warning); a branch that only meets a group at a right angle stays. A chord that removed the stem which hemmed a branch
exposed the case (`a-claimed-run-clears-a-shared-run`). The release is a fallback: ticket 113 keeps the planner's branches clear of foreign groups.

**Lanes (7a).** A lane is reserved before a chord is final, and a lane box is a wall to a chord.
Lanes read a chord that is held at 7a: `corridorFree` keeps a lane's descent off every fixed path,
and `validateLanes` refuses a fixed path across a foreign lane. So a chord held at 7a can turn a
lane aside and still be refused later; this is today's rule for frame chords, and ticket 99
counts it in the corpus differential (lane x changes). A cross-frame chord transits no sub-tier,
so it owns no lane.

**Tier-gap plan (ADR-0021).** A held chord is not a part (`tierGapPlan` already skips
`frozenChords`). In its gap:

- a **row** of a planned part either crosses the chord strictly or stays at least 10 px from it:
  a row ends on legs, mouth legs or a middle drop, and Section 4 and the next item keep each of
  them 10 px from the chord. G6 measures a declared diagonal against every segment by distance
  and excuses only a strict crossing (`parallelClearance`), so a strict crossing is legal. The
  crossing metric counts it: one crossing more in the score;
- a **Z middle drop** keeps `k` from the chord. `solve` picks the middle drop's x before the rows
  are seated, so the rows' y is not known then: `middleDrops` takes the chord's x-range over the
  whole gap (its x at `low` and at the lower band's top), grown by `k`, out of the free intervals,
  as it takes out the other legs and drops. A Z part left with no interval is rejected, as
  today;
- a **jog** of a drop stands on a leg x, so Section 4 covers it;
- the chord adds no term to `H`.

A 7f move in x (the canton close-up, column moves), or a gap that grows in y and so turns the
chord, can bring a leg nearer the chord after the decision. The plan names each planned vertical within `k` of a held chord that does not cross it
strictly (`TIER_GAP_CHORD_CROWDED`, info), and G6 judges, as for two verticals within `k`
(`crowded`).

*As built (ticket 101).* `PlanFrame.chords` holds the chord's x at the gap's low y and at its high y; `chordGapNotes` (`gap-plan.ts`) names both notes from the plans of the last round of `growTierGaps`,
once each. "Within `k`" is the centre-to-centre distance, 11.5 px (`k` holds the stroke). An unfit gap (`growth > 0` after the rounds) leaves all its parts to the
router, so every part over a chord's span there is `TIER_GAP_CHORD_EXPOSED`.

**Mesh bus and riser (tickets 82 to 84, 92; 94, 96, 97).** A bus bar, a stub, a riser and a
riser lane are overlay geometry: `straightCorridorClear` and the router leave out overlay lanes,
so a chord may cross them, and `riserCrossings` and `busVerticalCounts` count it. An across-frames
bus band in the chord's gap is no wall to a chord (it is an O5 band to the plan only). Inside the
band the chord is a label blocker: `bandChordSpans` reads every diagonal routed segment, so it
reads a cross-frame chord with no change. Where the chords leave no interval that holds the bus
label, the label is omitted (`link-labels.ts`). The bus side is read at stage 5, before any chord
is final, and a chord's port counts there as a routed port on that side, as today.

**Residual parts.** libavoid routes a residual part without the chord, because a diagonal is no
rectangle obstacle. The plan names each residual or unfit part whose span in the gap overlaps a
held chord's x-span (`TIER_GAP_CHORD_EXPOSED`, info). G6 judges. No input of the corpus is known
to reach this; ticket 103 measures it.

## 9. What this design does not do

- **No chord through a sub-tier band.** A link between non-adjacent sub-tiers keeps its lane and
  the orthogonal route, as today. A reserved slot through the band would need the chord decided
  before 7a and never withdrawn after it, while every move after 7a can block it. None of the 12
  links needs it (each joins adjacent sub-tiers).
- **No placement move for a routed chord in the first version.** Ticket 77 and ticket 80 move a
  node or a frame off an overlay chord. The refusals on the private sheet are the candidate rule
  and the title strips, not bodies. Ticket 104 extends the step only if ticket 103 reports links
  refused by a body or a frame.
- **No same-tier chord between frames.** A level pair between two frames keeps the level path rule.

## 10. Diagnostics

| Code | Severity | When |
|---|---|---|
| `ROUTED_CHORD_REFUSED` | info | At the freeze, once per cross-frame candidate that is not held, with the first failed check: `transit`, `faces` (a port does not leave outward), `edge` (leaves through a side edge), `frame` (a foreign frame or canton box), `title`, `body`, `pill`, `lane`, `corridor` (another gate clearance), `chord` (a held chord), `leg` (an orthogonal leg). |
| `ROUTED_CHORD_TITLE` | warning | 7f (label bands): a title could not stand clear of a held chord's crossing. |
| `TIER_GAP_CHORD_CROWDED` | info | 7f: a planned vertical within `k` of a held chord, not crossing it. |
| `TIER_GAP_CHORD_EXPOSED` | info | 7f: a residual or unfit part whose span overlaps a held chord. |

`STRAIGHT_LINK_HELD` and `STRAIGHT_LINK_BLOCKED` keep their meaning and cover both chord kinds.

## 11. Metric risks

- **Crossings.** A chord crosses planned rows of its gap strictly, where the orthogonal route
  crossed other things. The count can rise. It is not a criterion (**maintainer, 2026-09-30:** a
  clear chord draws straight even when it adds crossings); it is measured and reported. The M1
  golden tests assert 0 crossings (`golden-crossings`, `test/pipeline/golden-snapshot.test.ts`,
  `test/route/golden.test.ts`). If a chord there crosses a row, the assertion changes to the
  measured count, with a comment that cites Q108 and this decision.
- **G6.** Two new sources, both named: a 7f x-move after the freeze (`TIER_GAP_CHORD_CROWDED`,
  and `chordClearances` for chord pairs, ticket 89), and a residual part routed without the chord
  (`TIER_GAP_CHORD_EXPOSED`). Acceptance: no new G6 finding on the corpus.
- **G3.** A title that cannot stand clear of a crossing (`ROUTED_CHORD_TITLE`).
- **Bus labels.** A chord across an across-frames bus band can leave no room for the bus label,
  which is then omitted. Counted in the corpus differential and on the private sheet.
- **Canvas.** The fan spread can raise a face's port pitch from 12 px to at most 60 px. A gap that loses parts can
  shrink, which makes its chords shallower but breaks no rule.
- **Q.** Continuity and bends improve. Alignment and flow can fall on diagonals. Reported.
- **Golden.** The M1 golden has dashed routed links between groups; it can change. Each change is
  rendered and reviewed, not accepted blind.

## 12. Tickets

| # | Title | Blocked by |
|---|---|---|
| 99 | A routed link between frames takes the chord when it is clear | — |
| 100 | A cross-frame chord crosses its own title band beside the title | 99 |
| 101 | The tier-gap plan keeps its verticals off a held chord | 99 |
| 102 | A face that takes cross-frame chords spreads its ports | 99 |
| 103 | WAN links between location tiers draw straight (ticket 98 acceptance) | 100, 101, 102 |
| 104 | Placement steps a body or frame off a cross-frame chord (conditional) | 103 |

## 13. Maintainer's decisions (2026-09-30)

1. **Angle.** No angle limit: any clear chord draws straight, however shallow (Section 4).
2. **Crossings.** Straight anyway: a clear chord draws straight even when it adds crossings
   (Section 11). The M1 golden's `golden-crossings` assertion takes the measured count, with a
   comment that cites this decision.

## 14. Spanning chords (architecture ticket 22)

Status: decided by the user 2026-10-11 (all six recommendations of ticket 22); it amends Q108 when phase 4 merges. Evidence and measures:
`.scratch/architecture/issues/22-a-chord-spans-several-tier-gaps.md`. Hand solve: case 04, principle P6 and
contradiction 7 of `ref/hand-solves/ANALYSIS.md`.

### 14.1 Rule

A **spanning chord** is a cross-frame chord whose ends stand on document tiers `t` and `t + N`, `N` of 2 or more.
No cap on `N`. It is one straight segment from face to face, as every routed chord.

A link is a spanning-chord candidate when Section 3 items 1, 2 and 4 hold, and its end groups are on document
tiers that are not consecutive. Item 3 changes: "consecutive" becomes "different".

A **transited band** is a sub-tier band strictly between the end sub-tiers. Section 4 refuses every such band
(`transit`). For a spanning chord a transited band is no refusal by itself. The band must leave the chord's
**corridor** clear: the part of the segment between the band's top and bottom y, grown by the gate clearances.

Not in this version (user, 2026-10-11): the same test does not replace the `transit` refusal of a cross-frame chord on
consecutive document tiers, where a rank band of an end's own tier stands between the ends (Section 3, last
paragraph). A follow-up may measure it.

### 14.2 The walls

The walls are the walls of Section 4. Nothing is new, and nothing is relaxed:
- every box of `groupBoxes` that holds neither end (frame, canton frame, free group, rank cell, flank, bar), grown
  by the group-edge link margin (10 px plus half the stroke);
- every foreign node body (10 px) and pill (contact);
- every label and title strip, with the 8 px link-free margin (a title in a transited band stands inside its
  foreign frame box, so the frame wall covers it);
- every lane box of another link (no clearance), every bundle zone and obstacle;
- every held chord (10 px, unless the two cross strictly), every orthogonal leg and mouth leg (10 px).

Overlay geometry is no wall, as in Section 8: a bus bar, a stub, a riser, a trunk and an overlay lane.

A lane is a wall. So a candidate that is straight today through its own transit lane (a vertical drop) is offered
too: its lane box would refuse the chords that cross it, and the chord draws the same vertical with no lane.

### 14.3 Reservation

The load-bearing rule: 7a must not reserve a lane for a spanning chord, and 7a must reserve its corridor. Stage 7a
cannot know the chord from geometry that it has not made. So the chord is decided on a placed baseline and
enacted by a placement re-run, as a side hint (ADR-0022) and a course (ticket 15) are.

- **Span hint.** `LayoutLink.spanHint: true`, an input of the re-run. It freezes with the topology
  (`freeze.topology`); restore checks that the link is a candidate.
- **Stage 5.** A hinted end port takes no lane pitch. The fan rule (ticket 89, Section 7) spreads a face that
  takes several chords.
- **7a.** No transit lane for a hinted link. One **span corridor** per transited band: `Lane.kind: 'span'`, owner
  the link, layer `routed`, id `span:<link>:<sub-tier>`. Its box is the bounding box of the corridor in that band.
  Its x is derived from the two end anchors at each `rebuildLaneExtents`, as a perimeter lane's x is derived
  (ADR-0010 amendment of ticket 15: the id, owner and band are immutable, the x is not). 7a translates every unit
  of the band out of the box (`marginTranslations`, as for a lane), and the other lanes keep out of it
  (`corridorFree`). The span corridor is no router obstacle: the chord is a fixed path.
- **7c to 7f.** A guard `spanCorridorsHold` joins `optionalMoveHolds` and the centring walls. It refuses a move that
  puts a wall of Section 14.2 into a corridor: a unit or a lane of a transited band that moves in, or an end port
  that moves the corridor onto a wall. The constraint catalogue names it as a hard kind `span-corridor`, support
  `unsupported` (three positions, as `chord-side`).
- **Freeze.** `freezeChords` holds the chord. A move that 7f cannot refuse (gap growth that turns the chord, a title
  that widens, a grid that widens) keeps the chord and names it (`SPAN_CHORD_BLOCKED`). The span round refuses a
  trial that carries one, so a published sheet has none.

Why a derived corridor with a guard, and not a fixed column: the chord's x in a band depends on both end x, so no
one-variable bound holds it. A fixed column would reserve the whole sweep that the ends could take, and it still
needs a two-end bound to keep the chord inside it.

### 14.4 The span round

A pipeline round on the pattern of the course round (ticket 15, phase 4).
1. **Offer.** On the kept baseline (after the fan rounds), `measureSpans` reads each candidate that owns a transit
   lane. It removes the transit lanes of all candidates on a copy, then tests the chord of each with
   `chordVerdict`, the `transit` check replaced by the corridor test of 14.1. Link order; a chord held earlier in
   the pass is a wall to the next one (10 px, unless they cross strictly). The offer is every candidate that passes.
   The offer is empty when no candidate is bent today, because no chord can then lower the bent count.
2. **Trial.** One placement re-run with the span hints, then 7f and the route.
3. **Judge** (`judgeSpanTrial`): no removed link; every hinted link publishes its chord (the promise); no new gate
   finding and no new hard x-constraint entry (compared as sets); canvas growth within the 5 % share; then the
   `unified` order over both layers (fewer bent links, then fewer turns, then fewer crossings). The trial is kept
   only when it is strictly better. A trial that one chord spoils is refused whole.
4. **Order and budget.** The span round runs before the course round, the side round and the overlay course round,
   because a chord changes which routes are poor. It shares `MAX_RERUNS` and takes a re-run only when it offers
   something. A refused round leaves the sheet byte-identical (trace only).

A spanning chord adds crossings where it replaces a lane. That is P6, and Q108 decision 2 ("straight anyway"). The
judge reads crossings last.

### 14.5 Other rules

- **Tier-gap plan.** A spanning chord crosses `N` tier gaps. `PlanFrame.chords` holds it in each gap it crosses (its
  x at the gap's low and high y). A row crosses it strictly or keeps 10 px; a Z middle drop keeps `k`;
  `TIER_GAP_CHORD_CROWDED` and `TIER_GAP_CHORD_EXPOSED` are named per gap. A gap loses the lane mouths of the
  hinted links, so it can shrink.
- **Labels.** A link label lies on the chord (ticket 16). If the midpoint falls in a transited band, 7a widens that
  band's corridor by the label's half extent normal to the line plus the 2 px halo, so the label room is reserved
  with the corridor. Section 6 (own title band) is unchanged.
- **Overlay rule.** Unchanged. An overlay chord already spans tiers (`overlayChordAdmitted` does not read the
  consecutive-tier clause). A routed spanning chord is no wall to an overlay line.
- **Fans.** `measureFans` reads `routedChordCandidate`; a hinted link is one.
- **Score, validate, gates.** `isRoutedChord` reads the hinted kind, so continuity, G5 (one declared diagonal), G7
  and `route/validate` treat a spanning chord as every routed chord. G6 reads an axis-aligned chord (a vertical
  drop) against frame edges; the corridor margin already keeps 10 px.
- **draw.io.** A straight edge with no `edgeStyle`, as a cross-frame chord.

### 14.6 Diagnostics

| Code | Severity | When |
|---|---|---|
| `SPAN_CHORD_TAKEN` | info | Placement, the kept run: one per spanning chord, with the gaps it spans and its transited bands. |
| `SPAN_CHORD_BLOCKED` | warning | 7f: a move that 7f cannot refuse puts a wall into a held span corridor. The span round refuses the trial. |

The offer, the refused trial and its reason are in the trace only. `ROUTED_CHORD_REFUSED` does not change: a link
with no hint is no spanning-chord candidate at the freeze.

## 15. Perpendicular faces and direct families (architecture-2 ticket 22)

Status: decided by the user 2026-10-23 and 2026-10-24 (ticket 22, "User decisions after slice 1" and the
two rounds after it). Slice 1 as built.

### 15.1 A long, flat chord never joins perpendicular faces

When the two end faces of a routed link stand at 90 degrees (a `top` or `bottom` face and a lateral side), the
chord between the anchors is at least the straight-link length limit (twice the larger dimension of the two
bodies, `straightLengthLimit`, the limit of `expectedLevelPath`), and it leaves the `top` or `bottom` face at
`PERPENDICULAR_FLAT_ANGLE` (80 degrees) or more from the face's normal, the link is orthogonal. The user:
*"90 degrees turn work only in some cases. in a crowded example it indeed goes to regress"* (2026-10-24). A
shorter or steeper perpendicular chord, opposite faces and two faces on one side keep the other chord rules.
The angle is measured: the provider chord of
`a-location-router-leaves-a-lateral-side-toward-a-far-provider` stands at 81.3 degrees (its L costs one bend
and is wanted); every long perpendicular chord at 75.8 degrees or less stood on a sheet where its L cost bends
(two to six), and on `a-foreign-unit-with-routed-links-to-two-canton-groups` a G9. A crossing test (the L only
when the chord crosses more than one link) changes nothing on the corpus and keeps the provider a chord.

Before the freeze the rule is derived from the geometry; from the freeze on, the held chords are the decision
(`model.frozenChords`, R1), and the rule refuses nothing. A record of the refused links (`perpendicularRefusals`) was
tried and deleted at review: a scan of every golden found it empty, because a link the rule refuses takes a side-lane
hint before the freeze and is no chord candidate there. One predicate
(`flatPerpendicularChord`, `frame-paths.ts`) is the first check of
`chordVerdict`, so every chord decision reads it: the fixed point, the freeze, the fan, span and side
measures. A side hint that would give a cross-frame chord a long, flat one to a lateral end no longer makes a chord. Between
two lateral faces there is no angle floor (a slight tilt is fine). Overlay chords do not read the predicate.

### 15.2 Direct families

- **Units and families.** A **facing pair** is the set of slice-1 routed links between two `row` groups on
  adjacent occupied sub-tier bands: no bundle, no label, no authored route but `straight`, a chord candidate,
  ports on no other routed link, the upper port on `bottom` and the lower on `top`. The pair splits into one
  **direct family** per node of its source side, the side with fewer nodes (the upper side on a tie): a
  node↔row or node↔node family. An interleaved row↔row case is one family per source node.
- **Trigger.** On a copy with the pair's chords suppressed, the tier-gap plan seats every member, and the strict
  crossings of their planned paths (stem, part, stem) are counted, once per point and pair. A family is
  triggered when more than one counted crossing involves its members, or when more than one endpoint
  inversion involves them (`triggers`). A member the plan leaves residual makes the count `unresolved`.
- **No angle floor, no growth.** The 30 degree floor and the gap growth of the first rounds are gone (user,
  2026-10-24: the flat fans of `a-shared-end-reads-its-port-order` on main are "closest to ideal"). Measured
  with the floor: v7 fans stayed orthogonal, a-shared-end went from 10 to 22 bends and six canvases grew.
- **Verdict.** At the start of 7f, before the freeze, each triggered family in id order takes the largest set of
  members that hold together (`DIRECT_SEARCH_BUDGET` sets at most): `chordVerdict`; no two members of the fan
  touching or nearer than the chord clearance; and `fixedPointRefusal` with the members left out as orthogonal
  legs. Fans of two source nodes may cross each other straight: a member may cross the leg of another fan's
  fallback, taken as crossing when its x-span holds the leg's x, and keeps the clearance from it otherwise.
  Ties: the shorter chords, then the port keys. A family decided first read the later families' members as
  legs; once all stand, a member refused for a leg or a chord takes its chord where it now holds and every
  held chord still holds beside it, in family and peer order until nothing changes.
- **Crowding.** The centring of 7f can still move x after the freeze and bring a direct member within the chord
  clearance of a planned leg or another held chord (`crowdedDirectMembers`). The attempt then runs again from
  its start with those members refused (`crowds`), at most `DIRECT_RETRIES` (2) times; a member still crowded
  after that is a `DIRECT_FAMILY_CROWDED` warning, and G6 judges it.
- **Record.** `model.directFamilies`, triggered families only: absent before 7f means not planned, absent after
  the freeze means no family triggered (so a sheet with none keeps its bytes). Each family keeps its units,
  gap, peer order, the count, its witnesses, the inversions, the port plan
  and each member's mode (`direct`, or `orthogonal` with a reason; `unplanned` is never published). A direct member is a held chord
  (`frozenChords`); a refused member is orthogonal, and no later replay offers it the chord. Outside triggered
  families the chord rules are unchanged.
- **Validator.** `validateGroupLabelBands` reads the record (`directFamiliesFault`, R5): the trigger agrees with
  its counts, every member joins the family's units and is in one family, a
  direct member is frozen and a refused one is not, and no two direct members of one fan cross.

What it changes on the corpus without the floor (2026-10-24): `a-port-facing-away-from-a-tier-gap-is-left-to-the-router`
14 to 6 bends, where the fixed point alone refuses five chords for each other's legs; nothing else on the corpus. On the
v7 sweep sheets the crowding retry trades the G6 of `link-5~link-6` for 2 bends.

Not in slice 1: bundles, shared ports, grid rows, labelled chords.

## 16. Fan families (architecture-2 ticket 40)

Status: decided by the user 2026-10-30 (rulings Q124 to Q126). Slice 1 as built.

- **Trigger (stage 1).** `detectFanFamilies` (`src/resolve/fan-family.ts`). A candidate is a routed link of a faint
  class (a class with a dash pattern: `dashed`, `dotted`), not in a bundle, a group-link or a mesh bus, with no
  route or `route: straight`, no shared port, no flank or bar end, and its ends on adjacent document tiers in two
  different units (a unit is the outermost frame, canton or free group of an end). A cohort is one tier group of
  hubs and one class. It is a family when it has `FAN_MIN_HUBS` (2) hubs or more, `FAN_MIN_UNITS` (3) units or more,
  and every hub links to every unit. A link two families claim declines both (`FAN_FAMILY_DECLINED`). Solid links
  form no family. Recorded as `model.fanFamilies` and `link.fanFamily`; absent on a sheet with no family, so no fan
  code runs there (R4). A direct-family member is never a fan member: the fan takes the link first.
- **Admission (before the freeze, once per placed model).** In `rebuildRowPaths` every member starts orthogonal, the
  settle loop runs for the other links, then `admitFanFamilies` searches each family. Each member must pass
  `chordVerdict` alone; the search then takes the largest set whose chords keep `chordsApart` pairwise and pass
  `fixedPointRefusal` together. Ties: larger set, shorter total length, port keys (R3). The walk includes a member
  before it excludes it, and stops a branch where a chord or a leg refuses a chosen member even with every undecided
  member drawn as a chord (a fallback only adds legs). A title can refuse more as more chords cross it, so it stops no
  branch; the end of the walk tests the set with every refusal. It tests at most `FAN_SEARCH_BUDGET` (512) configurations per family and states
  `FAN_SEARCH_TRUNCATED` when it stops (R4). The settle loop then runs again around the chosen chords.
- **What a member may cross.** Foreign frame, group and canton boxes (no corridor wall) and the own far end's title
  strip (the title moves beside the chord: `planLabels` reads the held chord's crossing as an obstacle and the
  frame grows if it must). Any other crossed title strip keeps the fit-beside test. A body refuses the member
  (`body`): it falls back alone, orthogonal and dashed. The admission lets a member cross the leg of a sibling that
  falls back (the crossing is faint); that leg's stem is final only at the end of 7f, so there a member that passes a
  sibling's stem (no strict crossing beyond the stem with the clearance, `siblingStemCrowded`) is crowded.
- **Reservation.** The tier-gap plan reads the straight members of a gap (`PlanFrame.slants`): a row moves down
  until its legs and run cross a chord strictly or keep the clearance (`clearOfSlants`), and the gap grows for it.
  The crowding retry of 7f refuses a member that a moved part comes within the clearance of
  (`crowdedFanMembers`), that passes a sibling's stem, or that a group title placed in 7f still meets
  (`titleCrowdedFanMembers`: the title planner found no room beside it). The reason is `crowds`; after
  `DIRECT_RETRIES` the rest is named in `FAN_MEMBER_CROWDED`. `refuseFanMembers` re-checks the held chords near the
  new legs.
- **Record.** `model.fanAdmissions`, set at the freeze, one entry per member in family order: `straight` with
  `crosses` (the foreign boxes its chord crosses, sorted), or `orthogonal` with a reason. After the freeze a
  member that crosses a box missing from `crosses` falls back (`frame`).
- **Validator.** `validateGroupLabelBands` reads the record (`fanAdmissionsFault`, R5): order, a straight member is
  frozen and names only foreign boxes, an orthogonal one is not frozen and names a reason.
- **Score.** G2 `through-group` excuses a straight member's one segment in the boxes its record names, and no other
  box. G6 stays geometric. A crossing of two members of one family is faint: Q weighs it 0.09 (CONTEXT.md,
  *salience*), `metrics.crossings.faint` counts it, and the corpus TSV writes it in `Xf`, outside `X`.
  `gate-compare` prints `Xf` and never judges it, and refuses a pair of TSV files where one lacks the column.
