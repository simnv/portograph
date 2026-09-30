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
4. After the side freeze (ADR-0009), the port on the upper end is on `bottom` and the port on the
   lower end is on `top`.

Items 1 to 3 are known at stage 1. Item 4 is known after stage 6. `rebuildRowPaths` runs after
stage 6 only, so the candidate is fixed before the first chord is read.

A group-link member is a candidate, as inside one frame (Q96), because it draws as its own link.

Why consecutive document tiers and facing ports: the ends then usually stand on adjacent
sub-tiers (the anchor rule puts an end that links down on its group's last rank, and an end that
links up on rank 0), and the chord crosses one tier gap. Where a group has fewer ranks than its
tier, a sub-tier band can stand between the ends; the band guard of Section 4 then refuses the
chord (`transit`), because such a link needs a lane, and a lane is reserved in 7b before the chord
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
- **The facing edge.** At each end, the chord leaves the end frame (and the end's canton frame
  when the other end is outside that canton) through the horizontal edge its port faces: the
  point where the chord meets that edge's y lies on the edge, at least the group edge link-margin
  from each corner. A chord that would leave through a side edge is refused. So the chord never
  runs in the column slack between sibling frames, which centring spends and where lanes stand.

The fixed-point checks of `expectedFramePath` apply unchanged:

- 10 px from every held chord it does not strictly cross (`chordsApart`);
- 10 px from the whole vertical leg of every link that stays orthogonal (`orthogonalLeg`,
  ticket 91). In the chord's own gap, that leg runs from the port face to the far boundary of the
  gap, or to the far port's stem tip. So a held chord never crosses an orthogonal leg of its gap.

**Angle.** There is no angle limit. A frame chord and an overlay chord take any angle, and the
facing-edge rule already keeps a shallow chord inside the tier gap. The shallowest chord on the
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

- **Crossing rectangle.** The part of the chord between the band's top and bottom y, as its
  bounding box grown by half the stroke, with the title's link-free margin (8 px).
- **Decision.** The chord is refused (`title`) unless the band still holds the title: after the
  legs of `legRects`, the crossing rectangles of the held chords and this crossing are taken out of
  the band's x-range, one free interval is at least the measured title width plus the 8 px inset on
  each side. No growth is assumed.
- **7g.** `planLabels` reads each held chord's crossing rectangle as a **hard** obstacle
  (`forbiddenRects`), computed from the frozen chord as it stands. Where the title has no room, the
  planner widens the group (`growthPlan`), as for a title that does not fit. Where it cannot widen,
  `ROUTED_CHORD_TITLE` (warning) names the link and the group, and G3 judges.

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

After the freeze, `chordsHold` and `blockedChords` also read foreign frame and canton boxes for a
cross-frame chord. A 7f move that puts a foreign frame on a held chord is refused
(`STRAIGHT_LINK_HELD`); a move 7f cannot refuse keeps the chord and names it
(`STRAIGHT_LINK_BLOCKED`), as today.

## 8. How the other rules treat a held chord

Every consumer of `isFrameStraight` reads the wider predicate (renamed `isRoutedChord`):
`routerEntryPoints` and `legRects` (no stem, no leg), `route/obstacles.ts` (no router obstacle),
`route/validate.ts` and G7 (ends on the faces), G5 (no stem, one declared diagonal), the score
(continuity 1, Q94).

**Lanes (7b).** A lane is reserved before a chord is final, and a lane box is a wall to a chord.
Lanes do not read chords. A cross-frame chord transits no sub-tier, so it owns no lane.

**Tier-gap plan (ADR-0021).** A held chord is not a part (`tierGapPlan` already skips
`frozenChords`). In its gap:

- a **row** of a planned part either crosses the chord strictly or stays at least 10 px from it:
  the row ends on legs, and Section 4 keeps every leg of the gap 10 px from the chord. A strict
  crossing is legal (G6 excuses it) and adds one crossing to the score;
- a **Z middle drop** keeps `k` from the chord: the plan reads the chord's x over the two rows'
  y-range as a wall for the middle-drop interval, as it reads a lane wall;
- a **jog** of a drop stands on a leg x, so Section 4 covers it;
- the chord adds no term to `H`.

A 7f move in x (the canton close-up, column moves) can bring a leg nearer the chord after the
decision. The plan names each planned vertical within `k` of a held chord that does not cross it
strictly (`TIER_GAP_CHORD_CROWDED`, info), and G6 judges, as for two verticals within `k`
(`crowded`).

**Residual parts.** libavoid routes a residual part without the chord, because a diagonal is no
rectangle obstacle. The plan names each residual or unfit part whose span in the gap overlaps a
held chord's x-span (`TIER_GAP_CHORD_EXPOSED`, info). G6 judges. No input of the corpus is known
to reach this; ticket 103 measures it.

## 9. What this design does not do

- **No chord through a sub-tier band.** A link between non-adjacent sub-tiers keeps its lane and
  the orthogonal route, as today. A reserved slot through the band would need the chord decided
  before 7b and never withdrawn after it, while every move after 7b can block it. None of the 12
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
| `ROUTED_CHORD_TITLE` | warning | 7g: a title could not stand clear of a held chord's crossing. |
| `TIER_GAP_CHORD_CROWDED` | info | 7f: a planned vertical within `k` of a held chord, not crossing it. |
| `TIER_GAP_CHORD_EXPOSED` | info | 7f: a residual or unfit part whose span overlaps a held chord. |

`STRAIGHT_LINK_HELD` and `STRAIGHT_LINK_BLOCKED` keep their meaning and cover both chord kinds.

## 11. Metric risks

- **Crossings.** A chord crosses planned rows of its gap strictly, where the orthogonal route
  crossed other things. The count can rise. Not a criterion (as for frame chords and overlay
  chords); measured and reported.
- **G6.** Two new sources, both named: a 7f x-move after the freeze (`TIER_GAP_CHORD_CROWDED`,
  and `chordClearances` for chord pairs, ticket 89), and a residual part routed without the chord
  (`TIER_GAP_CHORD_EXPOSED`). Acceptance: no new G6 finding on the corpus.
- **G3.** A title that cannot stand clear of a crossing (`ROUTED_CHORD_TITLE`).
- **Canvas.** The fan spread can widen a face by up to 60 px per port. A gap that loses parts can
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

## 13. Open questions for the maintainer

1. **Angle.** This design sets no angle limit (Section 4). A chord on the private sheet runs about
   68 degrees from the vertical. Is a limit wanted, for example 60 degrees, past which the link
   stays orthogonal?
2. **Crossings.** A chord that crosses the rows of its gap adds crossings. Keep it straight
   whatever the count (this design), or refuse a chord that adds more crossings than its
   orthogonal route had?
