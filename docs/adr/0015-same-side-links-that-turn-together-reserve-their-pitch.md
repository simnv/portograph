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
no run needs a row allocates nothing.

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
of 34. That is a change to this amendment's own decline rule and it is not taken here.
