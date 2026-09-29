# Tier-gap row plan (design)

Status: implemented, 2026-09-29 (Section 5 tickets 1 to 4 are done: tickets 48, 50, 51 and 52; ADR-0021). Replaces the tier-gap
allocation of tickets 25, 31, 39, 42 and 43 with one rule that orders every part of a tier gap in
placement (7f).

## Problem

The allocation in `src/layout/gap-runs.ts` grew by accretion. Each ticket added one guard or one
band. Every one of them leaves a part of the gap to the router. The router then discovers a row or
a vertical that placement could have reserved. The evidence:

- `holdsOf` holds only the earlier part of an interleaved pair (`gap-runs.ts:295-312`). Its
  partner, and every unheld neighbour, gets its row from libavoid. Ticket 43 measured that a held
  row forces a row order on the neighbours. An unheld neighbour's leg then crosses the held row.
- `heldRuns` reserves the horizontal only (`gap-runs.ts:346-351`). The legs stay the router's, and a
  peer's cover walls them (ticket 45; `retraces itself`, ticket 46).
- `tierGapRoom` measures the room on a probe (`gap-room.ts:65-79`). The answer moves with how far
  the probe opened the gap (ticket 42: 103.5 px asked, 128.5 px "owed", 146 px really needed,
  because link-212's crossing row was discovered, not reserved).
- The nested-tip headroom is x-blind (`gap-runs.ts:1004-1006`). A foreign chord refuses rows by its
  bounding box (`firstBlock`, `gap-runs.ts:682-696`; ticket 44). A vertical part "interleaves" with
  every diagonal that spans it (ticket 43).

The pipeline's one rule is: never let a route, size or spacing be discovered during routing that
could have been reserved during placement. This spec applies it to the whole tier gap.

## Vocabulary (to be added to `CONTEXT.md`)

`column` is taken by the frame column and the grid corridor, and `piece` by `RoutePiece`. The words
below are new and are used consistently here.

| Term | Definition |
|---|---|
| **part** | The path of one routed link inside one tier gap, from one **end** to the other. |
| **tip** | An end that is a port's stem tip: the anchor moved by the `stemPlan` depth along the side's normal (`gap-runs.ts:270`). |
| **mouth** | An end that is a lane's approach point: the lane's x, one router stem (15 px) inside the gap boundary (`gap-runs.ts:265-266`). |
| **drop** | A part whose two ends stand less than one run clearance apart in x. It takes one vertical run, with a jog where the ends differ. |
| **stepped part** | Any other part. It takes an upper **leg**, a **run** on its **row**, and a lower leg, each on its own end's x. |
| **Z part** | A stepped part with two rows and a **middle drop** between them, used only where one row is impossible. |
| **row plan** | The rows, legs and drops of every part of one tier gap, computed in 7f. |
| **residual part** | A part the plan declines. The plan names why; the router lays it as today. |

Numbers: run clearance `k = nudgingDistance = 10 + stroke = 11.5 px` (`bands.ts:182-183`); row pitch
`P` (open question 1); group-edge margin `e = 10 + stroke / 2 = 10.75 px` (`gap-runs.ts:494`);
router stem `m = 15 px` (`bands.ts:35`).

## Section 1 — The parts of a gap

1. **Which links.** Every drawn routed link with a planned gap whose two stops stand on opposite
   sides of the tier gap (`gapUsers`, `gap-runs.ts:204-207`). The stops are the port anchors and the
   ends of the lane runs (`stopsOf`, `gap-runs.ts:127-141`).
2. **Three kinds.** Tip to tip (a link between the two tiers). Tip to mouth (a link that leaves a
   port and enters a lane, or the reverse). Mouth to mouth (a link that transits both tiers). The
   kind changes only the end's own terms in Section 3.
3. **A tip stands where `stemPlan` puts it**, nested or flat. A flat tip in the group padding is a
   tip of the gap. `pieceOf` already builds it (`gap-runs.ts:256-283`); the guard that skipped it
   (`gap-runs.ts:308`) goes.
4. **Drops.** A part with `|x_lower − x_upper| < k` is a drop (ticket 42 rule 2, `gap-runs.ts:303`,
   kept). Its vertical stands on the end x that keeps `k` from every foreign leg: the upper end's x by
   default, the lower end's x where that is the one that clears (ticket 50, review). Where the ends
   differ, the jog stands one clearance above the lower tip row, or `e` off an O5 band anchored below over its x if that is higher (upper stand: `bandTop - max(depth + k, band)`), or one clearance below
   the upper tip row (lower stand); either way the tip is entered along its normal. Both are reserved.
   The vertical below the jog of an upper stand, and the stub beside the jog of a lower stand, is a
   lower leg (an upper leg) for the within-`k` rule of Section 2.2.
5. **Absent, one line each.** An overlay link is not routed. A stub is not drawn. A straight chord
   (ticket 34) reserves nothing and blocks nothing; this closes ticket 44. Chords are therefore
   invisible to the plan, and a jog may land under one. (S6, decided in ticket 51: the G6 finding is accepted. A chord as an O5 band for
   drops and jogs needs the jog to move, and the jog stands in three terms of the plan (`jogOf`, `lbOf` and the need of every run over the
   drop), so it is not a local change. Measured on the 53 chord-bearing inputs of the goldens and the sweep, and on the NTP sheet (102 chords): one
   chord and one planned drop within `k` of each other, NTP links 235 and 232.) A bundle member, a bar
   drop and an end that consumes a shared run keep their own rules; their geometry is an obstacle
   to the plan, and they have no part.
6. **Residual by shape.** These stay routed, as today, and are named `TIER_GAP_PART_RESIDUAL` with a reason (a cycle among
   the rows is `TIER_GAP_ROW_CYCLE`): a part that spans two gaps without a lane (`spans-two-gaps`); a lateral-port link that crosses
   the gap (`lateral-port`); a same-boundary U-turn (`u-turn`: a link with no lane whose two ports face this gap from one band; no gap
   stands between its stops, so it is read from the ports, ticket 51); a port facing away from the gap (`faces-away`; both stops of a
   pair that fail the up-down test, which ticket 48 labelled `u-turn`); a span that crosses a through-lane's reserved run (`crosses-lane`). A gap that holds one of these is not router-free (Section 4).

## Section 2 — The order

The plan gives each stepped part one row `y` (a Z part two). Each part's legs stand on its ends'
x. Given the rows, every crossing is fixed by arithmetic. The order is the whole decision.

### 2.1 What a crossing is

For two stepped parts A (row `yA`) and B (row `yB`) with `yA < yB` (A above), the crossings are
exactly these: A's run crosses B's upper leg where B's upper x lies strictly inside A's x-span; B's
run crosses A's lower leg where A's lower x lies strictly inside B's x-span. Nothing else can meet.
Two runs are parallel, two legs are parallel, and above a tip stands only its stem. A lower leg or a drop
reaches every row below its start after growth, because `need_i` ≥ the depth of every lower end the
run crosses.

From that arithmetic:

- Two parts whose ends **interleave** (`(xAu − xBu)(xAl − xBl) < 0`) cross exactly once, whichever
  is above. The crossing lies on the upper part's run and on the lower part's leg. Both reserve it.
- Two parts that run the **same way**, do not interleave, and overlap in x cross twice in one order
  and never in the other (O1 below). Same-way parts whose spans do not overlap never cross.
- Two parts that run **opposite ways** and overlap in x always interleave. Opposite-way parts that
  do not interleave have disjoint spans and never cross.
- A run that spans a **drop** crosses it once, wherever the row is. The point lies on the run and
  on the drop; both are reserved.
- **A Z part** (rows `ya < yb`, middle drop at `xm`): a foreign run at `y` crosses its upper leg
  where `xu` is inside the span and `y < ya`; its middle drop where `xm` is inside and
  `ya < y < yb`; its lower leg where `xl` is inside and `y > yb`. Each of its two runs crosses a
  foreign leg as an ordinary run does. A half is not a stepped part: its "lower leg" is the middle
  drop, which stops at the other row, so the cross-twice claim above does not hold for a half.

Chords are not parts; a chord that crosses a run is a crossing the score counts and the router
never sees.

### 2.2 Constraints

- **O1, same way.** For every pair of stepped parts that run the same way, do not interleave, and
  overlap in x: of two rightward parts the one further right at the upper end is above (ties at the
  upper end are decided at the lower end); of two leftward parts the one further left. A Z half
  obeys O1 against every part its whole Z does not interleave. A part the whole Z **interleaves**
  is not left free where no O1 or O2 path already orders it between the halves (a part forced
  between them keeps its reserved crossings). Ordered between the halves it crosses the Z three
  times where its upper x is inside the first half's span and its lower x inside the second's (the
  first run over its upper leg, its run over the middle drop, the second run over its lower leg).
  It is ordered above the first half where that keeps the graph acyclic, else below the second
  half, else the parts are residual with `TIER_GAP_ROW_CYCLE`. Above or below both halves, the pair
  crosses once.
- **O2, shared vertical.** Where the upper end of part A and the lower end of part B stand within
  `k` of one another in x (a port over a lane mouth, a lane under a lane, two ports of two nodes on
  one x, or 5.9 or 10 px apart), their legs are parallel closer than the gate allows. A is above B:
  the leg from the low boundary turns first (today's only forced order, `rowOrder`,
  `gap-runs.ts:407-410`). The two halves of a Z part carry the whole's O2 edges: the upper edge on
  the first half, the lower edge on the second, and the first half is above the second. (S4) O2 also
  applies between a drop's vertical and a stepped part's leg: the stepped part's leg within `k` of the
  drop's lower x runs at least `k + jogDepth` above the band below (`jogDepth = max(depth + k, the O5 band anchored below)`, `depth` of the drop's lower end), so its row stays `k` above the jog.
- **O3, no row shared.** Two parts share one row only where their x-spans, each grown by `k`, are
  disjoint. Every other pair takes rows at least `P` apart. A described part (one with a link
  label) keeps `label height + 2 × 4 + stroke` below its row before the next row, or its label is
  suppressed (open question 1).
- **O4, tips and drops.** A run keeps `k` from every foreign tip whose leg it crosses: at least `k`
  below an upper tip row, at least `k` above a lower tip row. It keeps `k` from a spanned drop's
  lower tip row and its jog. A part's own turn may stand on its own tip row: its stem is claimed
  (Section 4), so no pocket is needed. A **residual** part keeps ticket 25's `2k` between its two
  tip rows and ticket 31's `2k` band round its tips, because it is routed.
- **O5, obstacles and anchoring.** A run keeps `e` from a horizontal group edge it would run along
  (`alongGroupEdge`, `gap-runs.ts:493-508`), the label clearance from a group label, and `k` from a
  lane box, a bundle envelope, a bar band, a shared run and a fixed obstacle. These are y bands
  over an x-range, not bounding boxes: a chord forbids nothing. **Every obstacle is anchored to one
  band.** One anchored to the band above (its group edges and labels, the lane boxes that overhang
  from it, its nested tips) is a lower bound: the row passes below it. One anchored to the band
  below (its group top edges, its lane overhangs, its nested tips, a mouth at `high`) is a need:
  the row stays above it by the clearance, and the distance is measured from `bandTop`
  (Section 3). Lane boxes overhang from both bands (`tierGaps`, `gap-runs.ts:109-116`), so each is
  anchored to its own band.
  A canton frame reaches into the gap (its margin and its title band stand outside every member box), so a canton that
  ends at the upper band is anchored to that band, one that starts at the lower band to that one, with the group-edge margin.
- **O6, cycles.** O1 and O2 together can form a cycle. One shape: two aligned node pairs joined by
  an X (tickets 41 and 43), where each part's upper leg stands on the other's lower x. Another:
  A 0 → 100, B 100 → 200, C 200 → 0, a pure O2 three-cycle. Rule: while the graph of O1 ∪ O2 has a
  cycle, the latest unsplit part on it in model order becomes a **Z part**: upper leg, first row, a
  middle drop, second row, lower leg. The middle drop stands at the centre of the widest interval
  between the part's ends that is `k` clear of every other leg and drop **and leaves O1 ∪ O2 ∪ the
  Z's own edges acyclic**; the part is residual only where no clear interval does. A half's edges
  follow from its own span by 2.1 (its own upper and lower x), not from the whole's: copying the
  whole's O1 edges onto both halves orders a half against a part it does not cross. Each round splits one more part, so there are at most `n`
  rounds. Where a cycle remains among halves only (no shape has shown one), its parts are residual,
  named `TIER_GAP_ROW_CYCLE`.
- **Residual by constraint.** A part that cannot obey O2 to O5 is residual: two upper ends of two
  nodes within `k`; a leg through a fixed obstacle (a group or canton title is nudged along its edge off the legs of the ports under it at
  placement, ticket 62, so a title is such an obstacle only where no position on the edge clears every leg and no lane-feasible widening of its group frees one: ticket 66 makes such a leg a hard obstacle, like a straight feed's, wherever `growthPlan` allows it, so the title stands past the legs and the group widens by the title plus the clearances beside the port, and the leg stays a residual `leg-blocked` only where the lanes forbid the widening (`GROUP_LABEL_LEG_ALLOWANCE_EXHAUSTED` names a title whose widening ran out of its extra pass, pipeline.md 7f). The nudge is all or none per tier gap: the bottom edges of tier t and the top edges of tier t + 1 keep their places together if any one of them cannot clear its legs, because nudging some would plan some drops of the gap and leave the others to the router, which lays them across the planned rows); a port over a lane mouth on the same boundary.
  Where two lower legs, or two upper legs, of two nodes stand within `k` (a drop's vertical counts as an upper and a lower leg), the later part is
  **planned all the same**, with the clash named in the plan (`crowded`) and reported by G6: a published
  finding, which `quality.md` item 11 prefers to a removed link and to a route round the sheet. A
  jogged drop first tries the other end's x for its vertical (Section 1 item 4). A residual part whose span
  crosses a planned leg has no route across it (`plan.ts:212` grants rows only, so an ungranted
  leg would guarantee a removal): it is planned with a G6 finding (legs within `k`), or it is granted
  the cover of every planned vertical it crosses (S5).

### 2.3 The ordering rule

The constraints O1, O2 and the Z split form a directed acyclic graph on the parts. The plan takes
the parts in a **topological order** and packs each one on the highest row it may take:

```
y(part) = max( lb(part),                                        # Section 3
               y(earlier) + P  for every earlier part within k in x, or ordered above it )
```

Among the ready parts, the one with the largest **static need** goes first, then the smaller
lower bound, then model order. The static need reads only the geometry, never the order:

```
need*(part) = max( own lower term  (Section 3),
                   k + depth(j)   for every partner j that interleaves the part
                                  with j's lower x strictly inside its span,
                   k + depth(d)   for every drop d inside its span, 2k where d has a jog )
```

Taking the most demanding part first is earliest-deadline-first. It is a **heuristic**: it keeps
the gap short on the shapes below, optimality is not claimed, and `H` (Section 3) can depend on
the tie-breaks. `H` itself is computed afterwards from the crossings the packed order really has,
not from `need*`.

Rows are packed from the low boundary. Every term anchored to the band below enters `H` as a need,
never a row (O5). So the rows are valid before and after the growth, and a second measure is
identical. This is what the probe existed for, and why it goes.

### 2.4 Proofs on four shapes

Geometry read from the placed models after 7f on main (b3ed02e); stems flat at 15 px unless marked
nested. Rows at `P = k = 11.5`; growth measured against the 60 px band gap. Crossings checked by
the arithmetic of 2.1: every forced pair crosses once, no other pair crosses, and every crossing
lies on reserved geometry.

**Ticket 36 shape** (`two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row.yaml`, gap
248..308, the band gap before today's 39.5 px growth). Parts: link-4 104.6 → 194 (upper tip nested at 280.5); link-5 116.6 → 265.5; link-6
176.1 → 57; link-7 188.1 → 128.5 (nested 280.5); link-8 265.5 → 206; link-9 a drop at 277.5.
Edges: O1 link-5 above link-4, link-6 above link-7; O2 link-8 above link-5 (both on x 265.5) and
**link-7 above link-4** (link-7's upper leg at 188.1, link-4's lower leg at 194: 5.9 px apart).
Static needs: link-4 and link-5 26.5 (an interleaving partner's lower x inside the span), the rest
15.

| part | row | why |
|---|---|---|
| link-8 | 263.0 | its own tip row; no foreign tip in 206..265.5 |
| link-5 | 292.0 | need 26.5 first; crosses link-7's nested leg: 280.5 + k |
| link-6 | 303.5 | link-4 is not ready (link-7 first); overlaps link-5 |
| link-7 | 315.0 | below link-6 (O1) |
| link-4 | 326.5 | below link-5 (O1) and link-7 (O2), overlaps link-6 |

Five forced crossings (4×6, 4×7, 5×6, 5×7, 5×8), each on one run and one leg. Actual need: link-4
and link-5 cross a lower leg, `k + m = 26.5`. `H = 326.5 − 248 + 26.5 = 105`; growth 45 (today
39.5, with link-4 above link-5 and two crossings the plan does not have). Without the O2 edge
7 > 4 the order 8, 5, 4, 6, 7 gives 93.5 px, and leaves link-7's upper leg 5.9 px beside link-4's
lower leg over 23 px of y, which G6 refuses.

**Ticket 41 shape** (`an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips.yaml`, gap
248..308). link-3 57 → 128.5, link-4 128.5 → 57: O2 both ways, so link-4 is a Z part with its middle
drop at 92.75. Rows: link-4a 263 (its tip row), link-3 274.5, link-4b 286. One crossing, on link-3's
row and link-4's middle drop. largest term `286 + 15 − 248 = 53` under the 60 px floor: `H = 60`, no growth. Today the gap does not grow
either, and the router discovers both the row and the vertical.

**Ticket 43 shape** (`a-plain-tip-in-the-group-padding-holds-its-row.yaml`, gap 121..181, tips in
the padding at 116 and 186). link-1 57 → 138.5, link-2 128.5 → 67; the legs stand 10 px apart at
each end, so O2 holds both ways and link-2 is a Z part (middle drop 97.75). Rows: link-2a 131.75
(`121 + e`), link-1 143.25, link-2b 154.75. One crossing. largest term `154.75 + e − 121 = 44.5` under the 60 px floor: `H = 60`, no growth.
Today link-1 rides the tip row 116 and link-2 rides it collinear (G4, G6).

**v5-4-0** (synthetic sweep sheet; two gaps). Upper gap 121..181: link-1 −63.1 → −40.5; link-2
140 → 31; link-3 4.9 → 102.5 (nested 133.5); link-4 a drop at 174; link-5 38.9 → 245.5; link-11
−29.1 → mouth 307.5; link-12 a drop at 519 to its mouth. Edges: O1 link-5 above link-3; O2 link-11
above link-1 (legs 11.4 px apart), link-5 above link-2 (7.9 px apart). Static need: link-11 25.75
(its mouth), the rest `e`. Rows: link-11 145 (crosses link-3's nested leg), link-1 and link-5 156.5
(shared: spans 79 px apart), link-2 168, link-3 179.5. Seven forced crossings (five interleaved
pairs, two on link-4's drop), none discovered. `H = 69.25`, growth 9.25. Today: no growth, link-2 on
the tip row 116 with link-5 collinear (G4); with ticket 37, link-5 removed.
Lower gap 278..350.5 (lane boxes overhang from the band above to 288.75 at x 307.5 and 519):
link-7 31 → 515; link-8 102.5 → 586.5 (lower tip nested 338); link-9 174 → 319.5; link-10
245.5 → 729.5 (nested 320.5); link-11 a drop from its mouth; link-12 mouth 519 → 1003. Edges: O1
link-8 and link-10 above link-7, link-10 above link-8 and link-9, link-12 above link-8 and link-10;
O2 link-12 above link-7 (519 and 515). Static need: link-10 30, link-8 12.5, the rest `e`. Rows:
link-12 303.75 (its mouth), link-10 315.25, link-8 326.75, link-7 338.25, link-9 349.75. Six forced
crossings (7×9, 8×9, four on link-11's drop). `H = 71.75` from the clipped low 288.75 (82.5 measures from 278), growth 10. Today: no growth; four links
routed by libavoid through the padding.

**O2 three-cycle with an interleaving fourth part** (synthetic, gap 248..308, flat tips at 263
and 293): A 0 → 100, B 100 → 200, C 200 → 0, D 188 → 12. O2: B above A, C above B, A above C, a
cycle; C is the latest and becomes a Z part, middle drop at 56 (the first of two widest clear
intervals). D has no O1 or O2 edge and interleaves C, so O1 orders it above C's first half. Rows:
D 274.5 (crosses B's upper leg), C1 286, B 297.5, A 309, C2 320.5. Five crossings, all forced:
D×B on D's run, C×B on C's first run, A×D and A×C (over the middle drop) on A's run, C×D on C's
second run. `H = 320.5 − 248 + 26.5 = 99`. Ordered between the halves instead, D would cross C
three times.

At `P = 17.5` (today's pitch) the first four plans grow 63, 5, 0, 27.25 and 34 px.

## Section 3 — The gap height as a formula

For each stepped part `i` with row `y_i` (packed from `low`, Section 2.3). `depth` of a lower end
is `bandTop − its row`: 15 for a flat tip on the boundary, 32.5 or 50 for a nested one, negative for
a tip in the padding, `overhang + m` for a mouth.

```
lb_i   = max( own upper tip row  (or low + e where that tip is in the padding),
              own mouth row,
              tip row + k        for every foreign upper tip strictly inside the span,
              O5 bands anchored to the band above, over the span, stepped past their bottom )
need_i = max( depth(own lower end),
              e                  where the span crosses a group's top edge,
              k + depth(j)       for every lower leg the run really crosses (parts above it),
              k + depth(d)       for every drop d inside the span (k + jogDepth(d) where d has an
                                 upper-stand jog: jogDepth = max(depth(d) + k, the O5 band below
                                 over the jog); the run keeps k from the jog, O4),
              O5 bands anchored to the band below, over the span, plus their clearance )
drop d:  lb_d = own upper tip row;  need_d = depth(own lower end) + (k where it has a jog)
residual r between the two tiers:  need_r = depth(upper tip, from low) + 2k + depth(lower tip)
H      = max( floor, max_i ( y_i − low + need_i ), max_d ( lb_d − low + need_d ), need_r )
growth = max( 0, H − (bandTop − low) )
```

`floor = bandGap − (low − bottom(band above))`, not `bandGap`: a lane overhang takes its part of the band gap. The largest
term without the floor is `demand`; the `TIER_GAP_GROWN` diagnostic will report it.

The drop term is ticket 25's `stemShortfall` (`gap-runs.ts:954-972`) for a planned drop: a drop
whose nested tips would overlap in a 60 px gap grows the gap to hold them, without the `2k` pocket
a routed link needs. The residual term keeps that `2k` where the link is routed. Ticket 31's
`reach` headroom (`gap-runs.ts:1004-1006`) is `k + depth(j)` of the parts that really cross that
leg, x-scoped (ticket 42 proposal 3). Neither is a separate pass.

No probe. **H is computed on the geometry 7f publishes** (S1): a stem nests only where the gap has the
room, so `H` depends on the growth. `growTierGaps` iterates to a fixed point of `geometry(growth)`:
each round reads the plan on a trial copy grown by the round before it (the trial is replayed
only where the published model is replayed) and replaces the growth by `H − room`, the height that plan asks less the room the gap had
before any growth (ticket 51; adding each round's ask counted a stem that nested only in a larger gap twice). The rounds are capped (6). A gap that does not settle within the cap is left to the router and named
`TIER_GAP_PART_UNFIT` with the ask. Then the last step: move the bands by the sum, replay, warn
(`gap-room.ts:84-97`). The 7f order stays: labels, plan and growth, labels again, corridor move. A
corridor move after the plan changes an x; the plan is recomputed at consumption on frozen
placement, as `allocateGapRuns` is today, and a part that then does not fit is residual with
`TIER_GAP_PART_UNFIT`, never a silent discovery.

## Section 4 — What the router still does

- **Nothing inside a gap whose parts are all planned.** `allocateGapRuns` returns every planned
  part tip to tip: legs, run, middle drop, or the one vertical of a drop. `planRoute` reserves the
  covers for every batch from the first (`plan.ts:188-214`), and stage 8 stitches the runs. The stem
  from a port anchor to its tip is then a gap with one possible route, and stage 8 claims it
  (`pipeline.md:1195-1201`). A link with no connector joins no batch (`plan.ts:340-346`), so its
  checkpoints are never asked for. The claim rests on a 0.5 px margin: `corridorFree`
  (`plan.ts:501-525`) reads foreign leg covers at a half-width of 11.5 px, and ports of one side
  stand 12 px apart (`pipeline.md:1101-1109`). A gap that holds a residual part (Section 1 item 6,
  Section 2.2) is not router-free: the residual is routed among the reserved parts.
- **Residual parts**, lateral ports, shared-run ends, bundle members, flank regions and bar drops
  are routed as today. The crossers of a planned run (`gap-runs.ts:1041-1048`, `plan.ts:212`) are
  the residual links of the gap, and the one granted leg cover of Section 2.2.
- **Two links on one port** share the leg from the tip to the higher of their rows. The shared leg
  is an **output of the plan**: the plan record marks it, stage 8 exempts the overlap through that
  record, and nothing is written to `link.sharedRuns` (`gap-runs.ts` writes no model geometry by
  contract, `gap-runs.ts:22-24`; item 5 of Section 1 stays true).
- **Unnecessary once every part of a gap is planned (deleted by ticket 52, on the use counts of
  its ticket file):** the chord grant of `gapNeeds` (ticket 37), `crossingParts`, `crossedStems`
  and the stems passable to a batchmate (tickets 22 and 30), `holdsOf`, `heldRuns`,
  `allocateWithHolds`, `rowOrder`, `allocateGap` with its `owed`, `reaches`, `covered` and
  `declined` sets, the tip bands of `blockers()`, `tierGapRoom`, the probe of `growTierGaps`
  (`stemShortfall` went with ticket 50). None had a use at stage 8 on the corpus, and deleting them
  changed no path. **Kept, for residual parts:** the completed-cover grant by a leg or an L (ticket
  21; 7 corpus inputs), the claimed-straight-piece grant (ticket 14; 2 inputs), the crossers of
  the planned rows and the grant of a planned vertical's cover (scoped to the vertical, ticket 52).
  Ticket 37 is closed by deletion: no cover was granted by the chord alone.
- **Diagnostics that remain:** `TIER_GAP_GROWN` (now with the part that set `H`),
  `ROUTE_CHECKPOINT_SKIPPED` and `ROUTE_GAP_REJECTED` for residual links, ticket 46's removal of a
  retracing route. **New:** `TIER_GAP_PART_RESIDUAL` with its reason, `TIER_GAP_PART_UNFIT`,
  `TIER_GAP_ROW_CYCLE`.

## Section 5 — Migration

**Subsumed.** Ticket 25 (stem tips apart): the drop and residual terms of Section 3. Ticket 31 (tip
bands, column bands): O4. Tickets 39 and 41 (the earlier part holds the mid row): every part holds
a row; the mid row is not special. Ticket 42 rule 2 (near-vertical part is a drop): Section 1 item
4; rule 1 (owed measure, parked): the formula. Ticket 43 (padding tips, `isAbove`, companions): O1
and Section 1 item 3. Ticket 44 (chord bounding box): Section 1 item 5. Ticket 45 (cover walls a
leg): O2 and O3; legs are reserved. Ticket 37: not needed for planned parts; kept for residual ones
until ticket 4 deletes it. Ticket 46 stays, a safety net for residual routes.

**Fixtures that must keep their outcome** (all through the real router: `removedLinks` empty and
every gate passing): `two-interleaved-links-of-one-tier-gap-cross-on-a-reserved-row`,
`an-earlier-link-with-no-run-crosses-on-the-row-between-its-tips`,
`an-unseated-lane-end-piece-holds-the-row-between-its-tips`, `a-near-vertical-piece-holds-no-row`,
`a-nested-tip-row-holds-no-allocated-row`, `a-seated-column-leaves-a-tip-its-pockets`,
`a-seated-column-leaves-a-corridor-open`, `a-straight-gap-needs-no-router`,
`a-tier-gap-grows-to-its-rows`, `a-row-steps-past-a-group-edge`, `detoured-stem-checkpoint`, the M1
golden and the golden snapshot. `a-band-holds-the-group-that-set-its-edge` grows today by ticket
25's `stems` term, which the formula replaces by the drop and residual terms: measure it before
claiming it keeps its outcome. **Tests whose numbers change by design:**
`test/pipeline/gap-runs.test.ts` (the 5.50 and 23.00 px messages, `required = last seat +
headroom`), `interleaved-gap-links.test.ts` (the mid-row assertions), `nested-tip-row.test.ts`
(23 px becomes `k` for planned parts), `near-vertical-piece.test.ts` (77.25 px),
`tier-gaps-compact.test.ts`, `test/route/stem-chord.test.ts` (request count),
`test/route/golden.test.ts`, `detoured-stem.test.ts` (`plan.batches`), and every growth number
(39.5 → 45 on the ticket 36 fixture at `P = 11.5`).

**Tickets** (dependency order; each with a fixture-sized acceptance test):

1. **The plan as a pure module** (done, ticket 48). `src/layout/gap-plan.ts`: parts (Section 1), constraints, Z
   split and order (Section 2), formula (Section 3); no caller. Acceptance: a unit test that builds
   the four shapes of 2.4 from their placed models and asserts the rows, the middle drops, one
   crossing per forced pair and none else, and `H`. New synthetic fixture
   `a-tier-gap-plan-orders-every-part.yaml` (the v5-4-0 shape, tier and class only).
2. **7f grows by the formula and stage 8 consumes the plan, together** (done, ticket 50). `growTierGaps` reads `H`;
   the probe, `tierGapRoom`'s seating measure, `stemShortfall` and the `reach` headroom go.
   `allocateGapRuns` returns the plan's parts; `planRoute` reserves them; the old holds are off the
   path. The two ship together: the plan alone disagrees with the old growth (105 px asked against
   the probe's 99.5 for different rows on the ticket 36 fixture), and a part that does not fit
   would be residual inside a gap full of reserved legs. Gate: the sweep's removal count does not
   rise. Acceptance: the ticket 41 and 43 fixtures route whole with `plan.batches` empty; the
   ticket 36 fixture grows 45 px and routes whole; a second `bands` pass grows nothing.
3. **Residual parts and diagnostics** (done, ticket 51). `TIER_GAP_PART_RESIDUAL`, `TIER_GAP_PART_UNFIT`,
   `TIER_GAP_ROW_CYCLE`, the granted leg cover, the shared leg in the plan record, ticket 46's
   removal. Acceptance: a synthetic with two nodes whose facing ports stand 9 px apart across a
   gap completes, names the residual part, publishes it with one G6 and removes nothing; a
   two-links-one-port fixture passes G4.
4. **Deletion, sweep, docs** (done, ticket 52). Delete the code Section 4 lists; `pipeline.md` § 7a and § 7f and
   ADR-0015 rewritten to this spec; `CONTEXT.md` vocabulary. Acceptance: the 72-sheet sweep gains
   no removal on any sheet (the coordinator runs it); the NTP sheet as below.

**Expected effect.** NTP sheet (today: removed 0, Q 0.735, G4 6, G6 18, canvas 3196 × 2554.75, the
tier 9 to tier 10 gap grown 94.75 px). Estimate, not measured (private input): the gap holds five
or six rows per location at `P = 11.5`, packed from the plain tip row 1327 and the nested rows
1344.5 and 1362; `H` lands at 40 to 60 px of growth, between ticket 42's owed 68.5 (which lost three
violations to a discovered row) and today's 94.75, with link-209 and link-245 seated (ticket 44)
and link-212's crossing row reserved. Removed 0; G4 drops (the collinear pairs 211/209 and 212/213
of the tip rows get rows of their own); G6 at or under 18; Q at or above today. Canvas height falls
by 35 to 55 px. 72-sheet sweep (today 31 removals, 0 throws): the removals are checkpoint pockets
inside tier gaps; with every tier-gap part reserved the expectation is under 10, all from residual
parts named by the diagnostic, and 0 throws.

## Section 6 — Open questions for the maintainer

1. **Row pitch `P`.** `k = 11.5` is the router's own nudging distance and the G6 number; `17.5` is
   the bundle pitch the allocation inherited (`gap-runs.ts:738`). Recommendation: `P = k`, and a
   described part takes `label height + 8 + stroke` (18.5 px at 9 px type) before the next row,
   or its label is suppressed as an overlay label is. The ticket 36 shape then grows 45 px instead
   of 63, v5-4-0 19 instead of 61.
   **Decision (2026-09-29):** The row pitch is `P = k = 11.5`, and a described part takes `label height + 8 + stroke` before the next row.
2. **Rows in the padding.** The router lays rows between a padding tip and the group edge today
   (v5-4-0's lower gap). The plan does not (`lb ≥ low + e`). Recommendation: not in the first
   version; measure the sweep's growth, then decide.
   **Decision (2026-09-29):** The first version lays no rows in the group padding.
3. **Legs of two nodes within `k`.** The plan makes the later part residual and grants it the
   earlier leg's cover (ticket 45's shape). The real fix is a placement rule on port x.
   Recommendation: residual with a diagnostic now; a placement ticket later.
   **Decision (2026-09-29):** Legs of two nodes within `k` stay residual with a diagnostic, and a placement rule on port x comes later.
4. **The shared leg at a port.** Exempt it through the plan record (recommended: the plan writes no
   model geometry) or through a declared shared run on the link.
   **Decision (2026-09-29):** The plan record exempts the shared leg at a port.
5. **When to delete the router-side grants** (tickets 21, 22, 30, 37). Recommendation: with ticket
   4, once the sweep shows no residual tier-gap part; keep them until then, gated by the count.
   **Decision (2026-09-29):** The router-side grants (tickets 21, 22, 30, 37) are deleted with the last ticket, once the sweep shows no residual tier-gap part.
