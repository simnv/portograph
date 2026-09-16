# ADR-0015: Same-side links that turn the same way reserve their pitch and their corridor

Date: 2026-09-14 · Status: accepted (maintainer, 2026-09-14; drafted from tickets 21 and 31) · Decisions: tickets 21, 31 (cases A, B, C)

## Problem

Three reproducers on `main` share one shape: two routed links leave one node side (or one row) and
turn the same way, and nothing in placement reserved the room between them.

- Ticket 31 case B and ticket 35's residue: two links wrapping the same node run their vertical
  legs 0.6–4 px apart. libavoid nudges parallel routes by its default 4 px, not the 10 px G6 needs.
- Ticket 31 case A: an upper flank port's link turns down at its 15 px checkpoint, right across the
  lower port's stem. Routed in an earlier batch, that path is an uncrossable obstacle for the lower
  port's link, and libavoid returns a truncated route.
- Ticket 21: giving the flank's secondary port the slot G5 demands makes its link pass *over* the
  primary node, where only the group's title band lives; nothing reserved a corridor.

Each is the pipeline's load-bearing rule broken: a route, size or spacing discovered during routing
that placement could have reserved.

## Decision

1. **Nested stems by turn depth.** For ports on one side of a node whose links turn the same way,
   stage 7c/7e orders the checkpoints outward by how far each link travels along the side after its
   turn: the link that turns farthest away leaves the node last (deepest checkpoint), one pitch
   (`16 px + stroke`) beyond the next. Stage 8 receives these checkpoints instead of the flat 15 px.
   This is the same tree a shared port already gets (ticket 20), applied to distinct ports on one side.
2. **Wrapping links own a pitch.** Two remainders that wrap the same node in one batch are given
   libavoid's nudging distance equal to the G6 clearance plus the widest stroke, so a same-batch
   parallel pair lands at the reserved pitch, never at 4 px.
3. **A crossing-only conflict is not a wall.** A path from an earlier batch stays an obstacle for
   overlap and clearance, but a later link may cross it: the batch planner puts links whose stems
   must cross into one batch, so libavoid resolves the crossing with a penalty rather than a dead end.
4. **A corridor for a flank link past its primary.** When G5 orders a flank port above the primary
   pair and its link goes to a peer beyond the primary, stage 7b reserves a lane-like corridor in the
   group's padding on the edge opposite the title (ADR-0011 already keeps the title away from links;
   the title moves to the other edge if needed), of one pitch, before anything is pinned.

## Consequences

Rule 1 changes stem checkpoint lengths for any node with two or more same-side links turning
alike; the golden has such ports on the TBR flanks and will re-baseline. Rule 3 changes batching,
which today follows obstacle ownership only. Rule 4 extends ADR-0011 and ADR-0013. Ticket 21's
block-by-far-end patch (`.superpowers/sdd/spec/ticket-21-wip/`) and ticket 31's worker retry
(`ticket-31-wip/`) ship with this ADR.

## Alternatives considered

- Treat far ends within one pitch as a tie in G5 (ticket 21 question a): avoids rule 4 for the
  fixture but leaves the gate ambiguous; rejected unless the maintainer prefers it.
- Route every remainder in one libavoid batch: loses the ownership exclusions that let a link
  pass its own lane and group box; rejected.

## Amendments requested (2026-09-14, from ticket 38's measured attempt)

Rule 1 was implemented against the row-gap legs, measured, and reverted. Three things it says, or
does not say, need the maintainer's word before the next attempt.

1. **Rule 1 needs a second sentence: where the ordering does not bind, the leg that travels farther
   turns *first*.** "The link that turns farthest away leaves the node last" is forced only when a
   leg reaches over another port's row — then it must leave outside that port, or it crosses its
   approach run. Where no leg reaches over another's row the rule is vacuous, and applying it as a
   total order fails: on `bundle-sides.test.ts`'s mixed pair it puts the wrapping link's approach
   run at y = 71 beside the jogging link's arrival run at y = 71.5, and G6 fails on the 0.5 px
   between them. The reverse order passes every gate.

2. **Rule 1 reserves per gap, so it must allocate per gap.** `rowGap` counts a jogging link once
   across both of its ports. A depth chosen per port on each side can therefore ask for two pitches
   where one was reserved. The unit is the leg in the gap: slot *i* at
   `right(a) + stemReach(a) + i * pitch`, the port on `a` taking `slot - right(a)` and the port on
   `b` taking `left(b) - slot`, so both ends of a jogging link name one x.

3. **The consequence paragraph is wrong about the golden.** "The golden has such ports on the TBR
   flanks and will re-baseline" did not happen: with rule 1 applied to every row-gap leg the golden
   was byte-identical. The TBR flank ports are flank groups, not row neighbours, and nothing
   reserves room for a nested stem there. Either the paragraph goes, or rule 1 owes those ports a
   reservation of their own — which is a change to stage 7b, not to stage 8.

A fourth point is not the ADR's but must be settled with it: this repo's two routing paths disagree
on libavoid's checkpoint direction flags. `runtime/avoid-worker.mjs:48` treats bit 1 as travel with
decreasing y; passing bit 1 to libavoid as a checkpoint `departure` sent every leg the other way,
measured twice. A pinned turn cannot be trusted until that is resolved.

**Fourth amendment (2026-09-14, from the second attempt).** Rule 1 says stage 7c/7e "orders the
checkpoints". A checkpoint cannot carry the rule: `checkpointsHonoured` checks only that each one
was visited, and libavoid ignores the direction mask on any gap with more than two legs — measured,
with the drawn legs at 187.375/144/173.5 against slots of 113/144/261.75. Since placement has by
then moved the depth as well, the diagram ends up worse than if the rule had not run: Q 0.3941 to
0.3148, crossings 3 to 7. Rule 1 must reserve each leg's run in `link.fixedSegments`, which stage 8
routes *through*, rather than name a checkpoint it routes *towards*.

**Fifth amendment (2026-09-14, from ticket 21; maintainer 2026-09-14).** Rule 4 stands, marked
**unverified**: no input in M1 reaches it.

Its reproducer was `flank-two-peers`, and the measurement there names a different obstacle. The
flank port G5 orders above the bundle pair is not blocked passing *over* the primary — its route
past the primary is clear, and the tier group's title band is well clear of it. It is blocked
leaving its own node: stage 7e moved the flank by the difference of the box tops and put the port
inside the envelope it was about to reserve. Measuring that move between the paired anchors fixes
the fixture with the golden unchanged, and no corridor in the group's padding is involved.

So rule 4 has no live reproducer and nothing implements it. It is kept because the shape it
describes — a flank port ordered above its primary pair, whose link must pass the primary — is
reachable in principle even though no M1 input reaches it, and because withdrawing a rule is harder
to reverse than leaving one unverified. Treat it the way ADR-0001 treats finding 42: recorded, not
resolved, and not a dependency of any ticket. Anything that claims rule 4 must first produce the
input that needs it.

## Sixth amendment (2026-09-15, from the stress test; stress ticket 04)

**Rule 1 also allocates a tier gap.** The row gap between two row neighbours was the first unit the
rule reserved. The **tier gap** — the open band between two adjacent tier bands — is the second. It
is the one the Enterprise NTP stress test names. Three fixes on 2026-09-15 (stress tickets 01 and
02) each handed the router one more reservation it was being judged against. The item behind all
three is this: nothing allocated the runs that cross a tier gap. The first ownership batch to reach
the gap therefore took whatever room it liked, and the next link found its own corridor closed.

The unit is the run, not the link. A tier gap is bounded by the lane extents that face it. Every
planned routed gap that straddles it, and has a lane terminal on one of its boundaries, is
allocated:

- a **column** where the run's two ends share one x — the straight segment across the gap;
- a **row** where they do not — a horizontal line in the gap, with a vertical segment at each end;
- a **tail** where the far end is a port beyond the gap — the run reaches the gap's far boundary on
  that port's x; the port's own approach beyond it stays routed, and the allocation is made only
  where that approach is clear.

Rows pack from the low boundary, one pitch (`16 px + widest routed stroke`) apart, each at the first
row clear of frozen placement geometry. The order is forced wherever two runs stand on one x: the
one leaving the low boundary turns first, or their vertical segments share length. A run the gap leaves out
still owes its own head-on approach of one router stem, and the rows keep clear of it. A gap where
no run needs a row allocates nothing. (Amended by the eleventh amendment: the decline of a run
whose approach is covered is per run, and every approach the gap owes is answered before the
seating, not after it.)

**Two allocated runs of one gap may cross, and the crossing is reserved.** Neither run is routed, so
neither needs an exemption from the other's obstacle. A run *along* a gap is a wall along it and
never across it. The links that must cross the gap without an allocation of their own are therefore
given the **row**. That is rule 3 applied to the obstacle set instead of to the batches. The run's
vertical segments still obstruct those links, and a route can pass them by.

The run's owner is not given the row either. Its route meets the run at the two terminals, so the
end rectangles keep the owner and the ones between do not. Otherwise its own other gaps could run
back along geometry the stitcher inserts verbatim.

An allocated run also keeps the gate's clearance from two things the router would otherwise have to
discover. The first is every reserved run of its own link that runs the same way and never meets it.
The second is the outward stem of every routed attachment in the diagram. It also stays out of the
link-free margin every group edge keeps (ADR-0013), whichever link the group belongs to.

**What this supersedes.** The lane-approach cover measured in stress ticket 02 (12 repaired, 4
broken over 322 diagrams) is not reinstated: it was a rectangle standing in for a reservation, and
this is the reservation. The pending-stem rectangles of stress ticket 02 stay for the attachments no
gap allocation reaches. The adapter's re-solve without direction masks stays: it is a property of
this libavoid build, not of the reservation model.

**What it does not do.** It does not grow a tier gap. A gap that cannot seat a row leaves that run
exactly as it is today. The Enterprise NTP diagram needs about 40 runs in one 38.5 px tier gap, so
it still fails; growing the band gap to the room its runs need is placement work above 7a and is
the next ticket.

The golden is unchanged: its four transit links descend on the x of their own lanes, so no run in
either of its tier gaps needs a row.

**Consequence measured, for the maintainer.** A reserved row crosses whatever descends through its
tier gap, where an unreserved route could detour around. On
`goldens/synthetic/own-lane-is-an-obstacle.yaml` that trade is: crossings 0 → 3, bends 12 → 6,
continuity 0.33 → 1, G6 two violations → every gate passing, and Q 0.6046 → 0.5122. Every row that
gap can seat meets the same two descents, so the score cannot be recovered without giving up the
reservation. Recorded under decision Q32 as a metric regression a note waives.

**What the sixth amendment does not settle.** Seven adversarial review rounds over about 20,000
generated variants (stress ticket 04) left seven items open, and five of them are one question in
five forms: **a reservation is a wall, and nothing in this pipeline separates crossing a wall from
travelling along it.** Rule 3 names that rule for the batch planner. The obstacle set has no
per-connector form of it, because the binding has no per-connector shape-ignore API (`pipeline.md`
§ 8), so the allocation gives a crossing by removing a whole rectangle for a whole batch. Where that
is too much, a route runs along a reservation; where it is too little, a route has no way through.
The other two items are the limit of reserving room without routing: a run the allocation displaces
can displace a second, and the second can seal a third link's approach.

## Seventh amendment (2026-09-15, from the stress test; stress ticket 05)

**A tier gap grows to the rows it must seat.** The sixth amendment allocates every run that crosses
a tier gap, and says of the gap's height only that "it does not grow a tier gap". That is the item
the Enterprise NTP sheet then named: one 38.5 px gap seating two rows where sixteen needed one, and
about 280 px of row at the pitch. A gap cannot allocate room it does not have.

The gap's height is therefore a reservation like every other room in this ADR. The room a gap asks
for is **what its seating lands in**: the last row the allocation seats, measured from the low
boundary, plus the **headroom** the high boundary keeps — one router stem and the gate's clearance,
which is what an approach standing on that boundary asks for. It is not `rows × pitch`: that is the
packing of rows half a pitch inside each boundary with nothing in the way, and a gap with a lane
never gets it, because every lane's reserved run stands on a boundary and reaches the gate's
clearance into the gap. Measured on `goldens/synthetic/a-tier-gap-grows-to-its-rows.yaml`,
`rows × pitch` gave 70 px and seated two of the four rows the gap owed; the room the seating lands
in is 90.5 px and seats four.

The seating a gap gets in its own room is the seating its own room allows, so the rule measures on a
**probe** — a copy of the model with the band below each short gap moved down past anything its
seating can ask for. The answer is then independent of the room the gap has now, which is what keeps
the reservation monotone: a second pass over the reserved geometry measures the same need and grows
nothing. Room is reserved only where the probe shows it buys the gap a seat.

A gap the allocation **refuses** for a reason room cannot answer keeps its band gap. Two of the
refusals are read from frozen placement — the rows have no clean order, and a port's own approach
beyond a boundary is blocked — and a taller gap gives the same answer, so growing it would move
every band below it for no route at all.

A gap short of its room grows by the shortfall, and every band below it moves down by the running
total. The margin the facing lane extents take (`10 + pathStroke / 2` on each side that has a lane)
is not part of the room. Nothing moves horizontally, nothing moves up, so lane x, the groups' order
and every earlier reservation stand; the lane extents follow their bands.

**The rule runs in 7f, and that is a measured choice, not the obvious one.** The count separates a
**column** — both ends on one x, no row needed — from a **row**, so it cannot be taken before 7a
fixes lane x. It cannot be taken at 7a either: 7c aligns a child under its lane, 7d spans a bar
across its ports, and 7e orders a bundle's ports, and each of those turns a row into a column. The
M1 golden's one populated tier gap owes four rows after 7a and none after 7d; a rule that grew the
gap at 7a moved every band below it and the approved golden changed (Q 0.8986107 → 0.8978139,
measured). 7f is the last placement rule, so its count is the one stage 8 receives, and it runs
before any group label is placed because the growth moves whole bands and a label placed first
would stay behind.

**What it does not settle.** 7f itself does two things afterwards that the rule cannot see: it may
move a group horizontally to fit a label band, which changes the count, and the group labels it
places become obstacles in the tier gaps, which can make a gap refuse after it grew for its rows.
Measured on the Enterprise NTP sheet, that second one costs one gap of twelve the allocation it
grew for. Nothing re-reserves after 7f.

Measured on the Enterprise NTP sheet with the rule in place: ten of its twelve gaps owe rows. Six
hold the room their seating asks for and seat **every** row they owe. Three refuse for the sixth
amendment's own reason — an approach beyond a boundary the gap cannot leave clear — and the tenth
seats none although it refuses nothing, because no row can stand clear of frozen geometry anywhere
in it. Neither is a question of room; both are stress ticket 06.

## Eighth amendment (2026-09-15, from tickets 37 and 45): a fan branch's descent is not a gap run

The sixth amendment allocates every run that crosses a **tier gap** beside a lane. Ticket 37's
tier-below reproducer crosses a tier gap and is not allocated, and it should not be. Both reasons
are properties of the allocation, not gaps in it:

- **Its near end is not a lane terminal on a gap boundary.** The run leaves a fan junction inside a
  tier band, 15 px out of its port. `gapUsers` admits a participant only where a lane terminal
  stands on a boundary, because only a corridor opens into a gap; a port anchor can sit on a
  boundary as well, and a run from there is that link's own stem.
- **The run is already reserved.** 7e writes the whole descent into `sharedRuns`, so by the time
  the allocation reads frozen placement there is no planned routed gap left to seat. The defect was
  never that the coordinate was unallocated; it was that the fan chose it without measuring it.

A fan branch's descent is therefore the fan's to reserve, and it is reserved where the fan is built
(ADR-0018 rule 3, amended 2026-09-15). Checked before a second mechanism was written: allocating it
here as a column on the target port's x would need the allocation to accept a shared-run terminal
inside a band, and would then have to re-cut geometry 7e had already fixed.

## Ninth amendment (2026-09-16, from the stress test; stress ticket 06): a refused position moves the search on, and the height is measured with the labels in front of it

Two items the seventh amendment left, both measured on the Enterprise NTP sheet.

**A row refused for a reason that names no distance takes the next position the pitch allows.** The
sixth amendment says rows pack from the low boundary, one pitch apart, "each at the first row clear
of frozen placement geometry". The implementation honoured that for an obstacle **rectangle** only:
a rectangle names how far to advance, so the search went past its bottom. The three other refusals —
the row runs along a group edge (ADR-0013), the row meets a corridor the link owns, the row meets a
reserved run of the link's own — were answered after the search had settled, and a failure there
left the run out. A gap with one row to seat and four positions the pitch allowed therefore tried
one position, was refused for running along a group edge, and allocated **nothing**.

A group edge names only "not here". So does a corridor, and so does an own run. The search advances
by one pitch on each of them and gives up only at the gap's limit. That is the sixth amendment's own
packing rule, read as it is written, and the rule itself does not change.

**A group edge costs at most two pitches.** The pitch is `16 + s` and the margin an edge keeps is
`10 + s/2` (ADR-0013), so `margin < pitch < 2 × margin` for every stroke. A row refused under a
group's bottom edge is already inside the margin, so one pitch clears it. A row refused above a
group's top edge stands at some depth `d` below that edge; one pitch clears it whenever
`d > 6 + s/2`, and two clear it always, because `2 × pitch > 2 × margin`. The fixture's comment says
"one pitch on" because that is what that gap needed; the bound is two. Measured on
`goldens/synthetic/a-row-steps-past-a-group-edge.yaml`: the gap is y 121.00 … 190.25, the first
position is 129.75 and lies 8.75 px under a group edge that keeps 10.75 px, and the row is seated at
147.25, one pitch on. The nine-node reproducer publishes. On the Enterprise NTP sheet the gap that
seated none of its four rows now seats six runs of six.

**A tier gap is measured with the group labels of its own diagram in front of it.** The seventh
amendment made the height rule 7f's first act, "before any group label is placed, because the growth
moves whole bands and a label placed first would stay behind". The reason is sound and the ordering
was not: a group label is an obstacle in the tier gap beside it, so a gap measured before the labels
grows for rows the labels then refuse. Measured, that cost the Enterprise NTP sheet 715 px of canvas
for a gap that seats nothing.

7f therefore places its group labels, measures, and places them again. The last step answers the
seventh amendment's objection exactly: no label stays behind, because the step strips every group
label and plans it again in the geometry the growth produced. It runs only where the measurement
moved a band, and it **plans only** — the measurement was taken against the first step's
reservation, so a repeat of the reservation would move geometry the measurement has already been
taken against. The measurement itself moves each group's label band and placed label with the
group, so no label is left standing in the gap the move opens.

The probe does **not** read the geometry the move finally produces. `measured` rebuilds the region
geometry with no budget of its own, which allocates a fresh centring budget and re-runs the centring
for eight passes; the rebuild after the real move does the same. Measured on the Enterprise NTP
sheet, the probe moves one group's x by +46.26 px and widens another by the same, and the real
rebuild then repeats it — so the probe reads an x the model reaches one step later. The rule is
stated for a vertical reservation and that is what it measures; the horizontal creep is a candidate
mechanism for a probe that seats fewer rows than the gap it opened, and it is recorded with the rest
of that item in stress ticket 07.

**What this leaves open, measured and filed as stress ticket 06's residue.** The Enterprise NTP
sheet still does not publish. With the labels in front of it, three of its twelve gaps refuse, all
three on one clause and for one reason: the port's own approach beyond a boundary is blocked, and
the rectangle that blocks it is a **group label** in all three cases (gaps 5/6, 6/7 and 8/9 by tier
index). The sixth amendment's answer to that is wholesale — "a gap that cannot leave every one of
its approaches clear allocates nothing" — so a gap of 48 rows allocates none because one approach is
covered. Measured by leaving only the covered run out, which the allocation can already do (it owes
that run its head-on approach and keeps the rows clear of it): 5/6 seats 47 of 48 and 8/9 seats 33
of 34. That is a change to this amendment's own decline rule and it is not taken here. (Taken by
the eleventh amendment.)

## Tenth amendment (2026-09-16, from the stress test; stress ticket 07): a gap with one possible route is a reservation

Every amendment above gives the router one more reservation and then judges its answer against it.
This one takes a piece away from it instead.

A planned gap whose two ends stand on one axis-aligned line, whose two ends may both travel along
that line, and every checkpoint of which stands on that line — between the ends, in the order asked,
with masks the line allows — has exactly **one** route. Where the run between the two ends is also
clear of everything placement froze, stage 8 reserves it and asks for nothing. The predicate is
`straightCorridorClear`, which the rows rule uses to pin a straight row path and which 7f already
uses to reserve a collinear feed's corridor against its own group labels.

**The reason is this ADR's own subject read the other way round.** A reservation is a wall, and the
obstacle set has no per-connector form of that wall (sixth amendment). Where two links must cross
and their ownership sets differ, they cannot share a batch, the first one routed becomes a wall, and
the second has no way through. Rule 3 answers that for the batch planner where it can. It cannot
answer it here: the crossing link's route is the wall, and it is a route, not a reservation, so
there is nothing to hand the later link. What there is instead is the knowledge that the later
link's own run was never the router's to choose.

Measured on `goldens/synthetic/a-straight-gap-needs-no-router.yaml`: the gap asked for
(132.50, 270.00) → (132.50, 370.00) with checkpoints at (132.50, 285.00) and (132.50, 355.00), and
libavoid answered (138.50, 246.50) → (132.50, 393.50) — the two node centres, a diagonal, and
neither reserved endpoint. The worker's own warning names the cause: `skipping checkpoint for
connector 13 at (132.5, 285)`. The rectangle that holds that point is the cover of the horizontal
run an earlier ownership batch had already routed at the depth every stem turns at. Claimed instead,
the gap is one segment between its two reserved endpoints and the other link crosses it.

**What the claim keeps.** The claimed run is a reserved run: covered for every batch from the first
with the clearance a reserved run carries, trimmed 18 px at an end that is its own port anchor, and
stitched in exactly. Nothing about `checkpointsHonoured` or the endpoint contract is relaxed; a gap
the claim declines is routed and judged exactly as before.

**What the claim owns, and what it is measured against.** A piece owns only the pins it really
attaches to. A whole link's corridor leaves one of its ports and arrives at the other, so both are
its own; a piece that begins or ends at a reserved terminal has no attachment there, and the node
behind that end can stand between the two ends of the piece. It is measured against the covers
`routeObstacles` puts in front of the router — every reserved run in the model, and every run this
pass reserves before it — at the widest routed stroke, the width those covers carry. The corridor
predicate alone is not enough: it reads a foreign link's `path` and `fixedSegments` only, so a
junction tree's shared run is invisible to it, and a perpendicular crossing of one is neither a G4
overlap nor a G6 clearance. Both counter-examples are fixtures:
`a-claimed-run-owns-only-its-pins` and `a-claimed-run-clears-a-shared-run`.

**What it costs.** The router is left only the gaps that must turn. On the approved golden that is
every gap: both remainders are such runs, the snapshot is byte-identical and Q is unchanged, so what
stage 8 recorded as libavoid answering for the golden was libavoid returning the geometry placement
had already fixed. Across the suite no geometry changed and one diagram improved:
`detoured-stem-checkpoint` loses the `segment-group-edge` violation its detour used to draw, because
the batch it shared is one connector smaller.

**What it does not settle.** A claimed run is a wall to every other link, and a link that must cross
it has only the 18 px terminal trim to pass through. That trim is why the reproducer's crossing
survives, and it is not a rule. Where a claimed run dead-ends a crossing link, the answer is the
sixth amendment's: give the cover its crossers, as the tier-gap allocation does. No input reaches
that yet, so nothing implements it.

**What the claim changes for the links it leaves behind.** Two links of one ownership batch used to
cross each other softly, libavoid resolving the crossing with a penalty. A claimed run leaves the
batch and becomes an obstacle, so its former batchmates are re-solved against a wall. Measured: on
`detoured-stem-checkpoint` that is the whole of the change, and it improves the diagram. The wall is
passable where it matters — its terminal trim leaves the 18 px at each own port anchor open, and
that edge is a free visibility line — so the effect is a geometry change of unbounded sign, not a
dead end. A claimed run also enters its own link's exclusions, so a partially claimed link becomes a
singleton batch.


## Eleventh amendment (2026-09-16, from the stress test; stress ticket 09): the gap leaves out the covered run, not its whole allocation

The sixth amendment says a gap that cannot leave every one of its approaches clear allocates
nothing, and the ninth recorded what that costs. Measured on the Enterprise NTP sheet at stage 8,
three of its twelve gaps declined, each on one run and each to an **ownerless group label**:

| gap (tiers) | y | room | runs | rows owed | seated | the run declined | the rectangle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5/6 | 3461.00 … 3606.50 | 145.50 | 48 | 48 | 0 | `link-292#0`, approach (878.25, 3606.50) → (878.25, 3644.25) | `label:group:loc7`, 77.51 × 31.50 at (807.75, 3612.50) |
| 6/7 | 3737.00 … 3882.50 | 145.50 | 52 | 52 | 0 | `link-7#4`, approach (1508.74, 3882.50) → (1508.74, 3936.50) | `label:group:loc5`, 77.51 × 31.50 at (1435.84, 3888.50) |
| 8/9 | 5099.50 … 7322.00 | 2222.50 | 34 | 16 | 0 | `link-265#0`, approach (4689.72, 7322.00) → (4689.72, 7359.75) | `label:group:loc5ntp`, 62.85 × 31.50 at (4664.30, 7328.00) |

Each rectangle is a group label of 14 px grown by `GROUP_LABEL_LINK_CLEARANCE + routedStroke / 2` =
8.75 px, and each carries **no owner at all**: a group label is nobody's to cross. One of them cost
gap 5/6 all 48 of its rows, every run in it went to stage 8, batch 0 took the room, and the sheet
failed with `Router skipped a required checkpoint on link-5#9`.

**A covered run is left out alone.** It keeps the route it has today, exactly as a run the seating
cannot place does; it becomes a **crosser** of the rows the gap did seat; and the gap owes it its
head-on approach, which every seated row keeps clear of. That is the sixth amendment's own sentence
about a run the gap leaves out, applied to this refusal instead of to the whole gap. The gap
allocates nothing only where the covered runs are the whole of its seating, and `refused` — the flag
that tells the height rule (seventh amendment) not to grow a gap — now means *every* run's approach
is blocked, not *some* run's.

**And every approach is answered before the seating, not after it.** The sixth amendment answers
the near-side approach for the runs the gap leaves out. It left two holes. The approach beyond the
**far** boundary was answered only for the runs the gap declined outright, so a seated run could
take it; and a run's own approach was measured once against frozen placement, before the gap's own
runs existed, with a second sweep afterwards that could only pay for a conflict by giving up a seat.
The arithmetic makes it systematic: a row stands half a pitch inside a boundary and its cover
reaches `margin` back across it, so it always overhangs the boundary by `margin − pitch / 2` = 3 px
at the default stroke, and any run standing on that boundary under the row loses its approach.

Both approaches — the near-side stem and the far-side reach — are therefore rectangles the row
search reads like any other, so a position that covers one is refused and the search takes the next
the pitch allows. Measured on the Enterprise NTP sheet, the gap that owes 52 rows goes from 43 seats
to 51; 5/6 seats 47 of 48, 8/9 seats 15 of 16, and all twelve gaps allocate where three used to
refuse.

**And the search is monotone in its obstacles.** The two rectangles above stand on a gap's
boundaries, which is exactly where the first position the pitch allows is, so they are the case that
exposed the sixth amendment's search: a rectangle names how far to advance and every other refusal
names one pitch, so a rectangle over a position something *else* also refuses handed the search a
position the pitch walk had stepped over — and a gap given one more obstacle seated its row
**earlier**. That breaks the seventh amendment's own contract, because the room the height rule
reserves is the room the seating lands in: measured on `a-claim-lies-on-a-cover-edge`, the first row
seated 14.75 px early, both rows then fitted the ungrown 49.25 px, the gap never grew, and it held
49.25 px where its own seating asked for 55.50. The search therefore takes the later of the two
answers where both refuse the position — the rectangle's distance and one pitch — and a refusal can
only ever move a row down.

**A gap that seats no row still reserves its columns.** The sixth amendment gave up the whole
allocation when the seating placed nothing, columns included. A column is a run whose two ends share
one x: placement fixed it end to end and no row search decides it, so leaving it to a batch reserves
nothing and buys nothing. It is now kept whatever the rows do. The gap's `seated` count is unchanged
by it — only a row is a seat — so the height rule still reads the same demand.

**And a run that lies on a reservation's cover edge is clear of it.** The two rules above put a run
there by construction: the search seats a row past a reserved approach, which lands it exactly one
cover margin from the boundary the approach stands on. A cover is its run grown by
`10 + (the two strokes) / 2`, so a centreline on that edge keeps the 10 px of visible clearance G6
asks for and owes nothing more. The tenth amendment's claim scanned those covers with `segmentRect`,
which counts a zero-area touch as a hit, so the approach was handed to libavoid instead of claimed,
and libavoid answered with a route that stops at the checkpoint and never reaches the port. The scan
now asks for an overlap of area, at a bound of two `EPS`: `segmentRect` grows the rectangle it is
given by `EPS` on every side, so a cover shrunk by one `EPS` would scan unchanged. The bound is
therefore *a centreline `EPS` (1e-7 px) or more inside the cover is refused, one within `EPS` of its
edge is admitted* — and nothing it admits can fail the gate it stands for, because a centreline less
than `EPS` inside a cover leaves more than `10 − EPS` of clearance and G6 fails at `< 10 − EPS`.

The reproducers are two generated corpus inputs, `transit-t6-p3-f1-s3` and `transit-t6-p3-f2-s3`:
each publishes with the rule and throws `Routed gap on … does not meet its reserved endpoints`
without it. `goldens/synthetic/a-claim-lies-on-a-cover-edge.yaml` is the first of them shrunk by
three links, and fails the same way. Of the 360 inputs of `corpus`, 15 hold a claim that touches a
cover edge; those two are the ones the touch decides. The rule is **not** made redundant by the
monotone search above: it was re-measured after it.

**What it does not settle.** The Enterprise NTP sheet still does not publish. Its next failure is
not an allocation: a link whose two ports face each other **inside** one tier band has no way left
across it — a node body on the line, an earlier batch's route above, ten reserved stems below, a
lane across, and a full tier gap at each of the band's two exits — and the router truncates its
route (stress ticket 12). That is the sixth amendment's open item, a reservation is a wall and
nothing separates crossing one from travelling along it, with four walls round one link and no rule
that says which of them gives way.

And it makes one open item the normal case rather than the exception. A run the gap leaves out is a
**crosser** of every row it seated, and the exemption a crosser holds is of the whole horizontal
cover — the rule that lets a run *cross* a row also lets it *travel along* one. Before this
amendment a left-out run was rare; it is now what every covered approach produces. Rows pack at
17.5 px with ±11.5 px covers, so a packed gap has no clear band by arithmetic: measured on the
Enterprise NTP sheet, gaps 5/6, 6/7 and 9/10 each leave the left-out run a 15.00 px strip at the
top, which is the headroom the high boundary owes the approaches standing on it. Both places the
traverse can go are room reserved for something else, and libavoid chooses between them. Stress
ticket 15; it is stress ticket 12 seen from the other side.

A second item this amendment does not touch: two allocated runs of **one** gap may stand 2 px apart.
The row order forbids only an exact shared x, and the clearance scan measures a candidate against
frozen placement, the reserved approaches and the owed stems — never against the other runs of its
own gap. On `a-gap-leaves-out-the-covered-run` that is 52.50 px of shared length at 2.00 px of
centreline distance, and the diagram fails G6 `parallel-clearance`. It is present on `main` at
0288048 and is not a regression, but it is worse than a discovery: a spacing **reserved** during
placement that the gate refuses, which a taller gap cannot repair. Stress ticket 16.
