# ADR-0027: Alignment moves a node before it grows one

Status: opt-in until ticket 15 (owner ruling, 2026-11-16). The rule ships behind `layout.moveBeforeGrow: true`; the default
stays the rule before this ADR (a body grows in place up to `ALIGNMENT_MAX_GROWTH` = 12 times its own width, and the centre rule
gives back a stranded growth, architecture-2 ticket 71). It becomes the default when ticket 15 (the joint seat plan) passes the
acceptance set. Accepted for implementation 2026-11-15. Tickets: `.scratch/dense-16x9/`.

With the option off, every corpus sheet lays out as on main dc568f88 (0 layout-hash changes on the full corpus, 510 sheets). With
the option on, every sheet lays out as the branch before the opt-in (e95b4aea merged with dc568f88). Every part of the branch reads
the option. Five fixes of the branch change no corpus sheet with the option off, but each was shown only with seats, and no input
shows that main needs it (review 1 of ticket 02), so they read the option too. Each has an opt-in test that fails without it:

- the lane reseat of 7f keeps a group beside its lane on its side (`crossesBeside`; `reseat-lane-sides.test.ts`);
- `chooseReseat` and the 7f draft compare the alignment target record when they judge a reseat (`reseat-lane-sides.test.ts`);
- the close-up keeps a port under its lane (`lanePorts`; `seat-owns-body.test.ts`);
- the end trim keeps the label room of a same-tier link (`labelRoomHolds`; `opt-in-fixes.test.ts`);
- the region rebuild of the centre rule names its open alignments (the NTP sheet; `opt-in-fixes.test.ts`).

A sixth, the end-trim replay that dropped the removed links, changed nothing on the corpus or on 103 hand variants, with the option on or off, and is deleted.
The face recentring of 7c (81f108fd) also reads the option; it changes 7 corpus sheets with the option off.

## Known failures: why the rule is an opt-in (ruling 18, 2026-11-16)

On inputs off the defaults, with a bundle beside a seated body, the rule removes a link or throws where main draws the
sheet. These are not trades: a removed link or a refused layout is never the price of a width cap. They keep the rule off by
default:

- A removed link. With the 5 times cap a body cannot reach the common start of a bundle block (main grows it to 280.75 px; the
  cap stops near 250 px), so the block is bent. Its envelope covers the column of a foreign feed, and the drop of that feed to the
  same node has no way down: the router removes the link (`ROUTE_CHECKPOINT_SKIPPED` on a stem checkpoint). On the
  `feedOrder: false` case main draws 6 links and the rule draws 5. The outside dense sheet loses two links at the left-face ports
  of two sibling nodes 51 px apart in the same way (no seat, no bundle; with ticket 01 merged it loses none).
- A throw. On a hand variant with a bundle split beside a seated body, the publication refuses the layout ("Centring invariant
  violated": a port of the bundle's node stands off its feed), where main draws it.

Owners: dense-16x9 ticket 19 (placement reserves the drop, or refuses the bent block, before routing) and ticket 15 (one joint
alignment plan that decides the seats of a group together). The rule becomes the default only when ticket 15 passes the
acceptance set with neither failure.

## Decision

To put a port over its feed, alignment (stage 7c) first moves the node or its group inside the
slack of its row. A node grows only when no move makes the link vertical, and only up to a
small cap. Past the cap the node keeps the width that its ports and label need, and the link is
a diagonal routed chord.

The cap replaces `ALIGNMENT_MAX_GROWTH = 12`. Its ticket sets the number from the corpus: the
smallest cap that keeps the result of ticket 73, where the owner chose wider nodes for vertical
links (2026-11-05).

## Considered options

- Never grow. Refused: it reverts ticket 73, where a vertical link was worth more than a compact
  node.
- Keep growth as the first tool, with a lower cap. Refused: stretched nodes get shorter but stay,
  against the owner's ruling of 2026-11-03 that a node is not stretched beyond what its ports and
  label need.

## Consequences

Sheets with a narrow child under a wide parent change: the child keeps its width and stands
under its feed, or its link becomes a diagonal. The groups of such nodes shrink with them.

## Amendment: the cap taken (2026-11-15)

The cap is 5 times the width the node needs for itself (`ALIGNMENT_CAP_TIMES` in
`src/layout/size.ts`, read by `withinAlignmentCap`). A seat that grows nothing keeps the cap, so a
body that is already wide aligns inside its width. Owner ruling of 2026-11-15, on the numbers below.

The first ruling asked for a pitch cap: a body grows only while every two neighbouring ports it
stands are at most 144 px apart. The pitch cap fails the ruling's test on the ten ticket-73 sheets
(main: 102 verticals, 24 bends). `a-band-holds-the-group-that-set-its-edge` falls from 23 to 22
verticals and `a-tier-gap-plan-orders-every-part` falls from 9 to 5.

| cap | ticket-73 verticals | ticket-73 bends | ten sheets below main verticals |
| --- | --- | --- | --- |
| main (12, growth in place) | 102 | 24 | - |
| pitch, 144 px | 97 | 46 | 2 |
| 2.5 | 78 | 50 | 8 |
| 3 | 91 | 44 | 4 |
| 3.5 | 100 | 34 | 3 |
| 4 | 104 | 32 | 0 |
| 5 | 104 | 26 | 0 |
| 12 | 79 (one sheet does not publish) | - | 1 |

4 and 5 both keep every ticket-73 sheet at or above main's verticals. 4 costs more. On the corpus,
34 sheets are worse on bends at 4 and 18 at 5. On the dense 16:9 sheet, 4 gives 246 bends and adds
gate G4, and 5 gives 206 bends (main: 202). At both caps the widest grown body on that sheet is
427 px (main: 1 129 px). These numbers are from the trial runs. The report of the branch has the
final corpus table at 5.

## Amendment: the seat owns the body (2026-11-15)

Dense-16x9 ticket 02. The seat is one decision. `alignmentSeats` records it, and every later
pass, the replay and the publication check read that record:

1. While a seat stands, the main move of its group reads only the feeds of the kept ports. A feed
   that the seat left out does not pull the body.
2. A seat on transit-lane ports only holds nothing, because a lane follows its child.
3. A kept port stays owed after the chord freeze. The recorded window is tried first, and it may
   move the body as far as a move+grow may. A seat is decided again only for more owed verticals,
   then more targets.
4. The cap of a seat reads the width the record holds from before the first seat (`from`), never
   a width that an earlier pass grew. A seat that falls in its step (a recorded body that now keeps
   no port) gives the body back to that box: width `from`, at the offset `at` inside the seated box.
   A seat that stands keeps its body as it stands.

The records live until publication (`RECORD_STAGES`). A seat that no longer stands is withdrawn
at the end of the passes and at the end of each rule from `centre` to `bands`. A kept port off its
feed at publication is a layout error ("at a recorded seat").

Two guards outside 7c keep what a seat stands:

- The end trim is declined when the room that 7f reserved for a link label or an overlay track held
  before the trim and not after it.
- The close-up does not take a port off the lane of its link that it stands under (a perimeter or
  span lane does not follow the group).

Clause 4 was also tried as written in the design note: every step gives each recorded body back
its pre-seat box and seats it again. On the corpus that gave 5 errors ("Centring invariant
violated" on three-continents, three-continents-top-3-first, a-claim-lies-on-a-cover-edge and
a-title-no-position-clears-leaves-the-leg-to-the-router) and a spent budget on
private-datacenter-spine-leaf. Two tiers that stand on each other's ports moved each other again
on every pass, because the ports that a seat does not keep are laid at pitch again.

Open (ticket 09): neither the seat nor the group before its seats is bounded by the window of the
step. On the feedOrder:false
copy of a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first, snk0 moves and grows past
that window, the clamp carries it off its targets, and it keeps 247 px with no seat. To bound the
seat by the window, the producer and the publication replay must read one recorded window. The
window is read from the centring context and from the group as it stands. Read before the seats
(to bound move+grow, or to clamp the group into it before it is seated), it makes the replay
disagree with the producer: "Centring invariant violated" on three-continents and
three-continents-top-3-first.

## Addendum: a seat is judged where its step ends (2026-11-15)

The design note `design-02-seat-2` proposed two clauses. The owner chose clause 5 alone:

- Clause 5: a seat is judged where its step ends. A step that grows a body and leaves every aligned
  port of its group off its feed is declined whole, and records no seat. This was ticket 71's rule
  for a given-back body. With it in every step, the given-back record (`givenBack`) named no node on
  any corpus sheet, and nothing read it. The record, its second run of the passes and its check are
  removed.
  Amended 2026-11-18 (dense-16x9 ticket 47): for a member of a pooled row unit, such a step
  withdraws its seats alone and keeps its main move, which is the unit's shared decision. The
  exception covers only the members the unit's seat moves off their own mean (the coordinate-override
  map of `rowSeats`); a member whose own mean is the unit's seat is declined whole as any group. When
  the clamp carries every seat off its feeds, the seats are withdrawn (`ALIGNMENT_SEAT_REFUSED`), every
  recorded seat the withdrawal undoes gives its growth back and its record goes, the group goes back
  to where its main move put it, and the rest of the step runs again there. The withdrawal stands
  only when it holds at least as many owed verticals and aligned targets as the whole-step decline
  on that decline's own geometry; a tie goes to the withdrawal. The trade is accepted
  where the step's own measure ties and later decisions (the course round, the overlay order) bend
  links outside the step: on the review-2 reduction two straight links take 6 turns for a sheet
  143 px narrower, with Q and the gates equal (ruling of 2026-11-18). A
  whole-step decline undid that move on every pass and left the unit at its stage-6 x. For a group
  that is not pooled, the move and the seat are one body's decision, and the step is declined whole.
- Clause 1 is not changed: a seated body pulls only through the feeds of its kept ports. The
  narrowed clause 1 (a left-out feed stops pulling only when the cap declined its target, or the
  order and pitch of its face exclude it) was built and measured, and it is not kept. A joint
  alignment plan that decides the seats of a group together is a later ticket (dense-16x9 ticket 15).

Two rules hold the lane reseat of 7f, the one move after the last centring:

- A corridor does not follow its child across a group that it stands beside (the `laneSide`
  post-condition of 7f).
- The reseat is judged by the publication's record comparison (`alignment-targets-differ`), because
  no centring follows it to write a decline into the record.

Trades, listed and not fixed (the rows of `test/layout/seat-acceptance.test.ts` that stand as
expected-fail, each with its old value, its value now and its ticket):

- The owner's tier-gap sheet with `feedOrder: false` has 16 bends and G5 and spends the budget
  (main: 8 bends and settles). Body `isp1` grows to 397 px across the feeds of `isp0`: no rule
  decides the seats of one group together (ticket 15).
- widened-child-packs-tier with a wide label keeps `w1` at 139 px, not 272 px, and has 5 bends, not
  2; a-hub-tiers-fan-draws-straight-and-crosses-itself has 7 bends, not 6; a-shared-end-reads-its-port-order
  has 11 bends, not 8 (ticket 15).
- The `feedOrder: false` copy of a-group-shift-leaves-a-chord-clear-of-a-lane-middle-tier-first has
  12 bends, not 5 (ticket 09, the step window).
- a-kept-vertical-leaves-a-straight-overlay-straight has 12 bends, not 6: `f2` stands both owed
  verticals and the seat trades the overlay to `b-s2` for them (ticket 15).

- a-row-stretches-a-body-past-its-sibling, a-course-lane-stands-beside-the-box-before-the-grid-widens-it
  and facing-rows-link-direct-as-families have 6 bends, not 0. The seated body pulls only through its
  kept feeds; the feeds that a sibling bounds stop pulling, so the body is not stretched pass by pass
  toward them as on main. The narrowed clause 1 gives 0 bends back on these sheets, but on
  a-stranded-growth-is-given-back the same pull runs in a cycle (12 bends, not 6). A plan that
  prices the push of the sibling is ticket 15.
- sync-links-do-not-stack-a-tier and a-foreign-node-stays-out-of-a-bus-row have 2 bends, not 0. The
  cap stops the parent short of its third child: the seat stands two verticals, and the third link
  keeps a jog where a body with no growth gives three straight chords (ticket 16).

Measured: private-datacenter-spine-leaf has 0 bends and settles (main: 10 bends, spent), and
a-stranded-growth-is-given-back has main's 6 bends and settles.

## Amendment: a seat set owns a child row (dense-16x9 ticket 36, slice 1, 2026-11-17)

With the option on, a rank cell that the rows rule seats as one set (`seatSet`, docs/design/pipeline.md, stage 6) is owned by that entry, not by the
seats of this ADR: its bodies keep the widths placement gave them (no alignment growth inside the set), 7c applies the stored positions, and no
clause of this ADR chooses a seat for its members. A set that cannot stand is withdrawn whole by name, and its row falls back to the clauses
above. Rows outside the scope of the set (staggered, in a canton, in a feeding chain) keep the clauses above. The test option `testSeatSets:
false` keeps the clauses above for every row, for tests whose subject is one of them.

## Amendment: the default mode falls back to the option-off run (dense-16x9 ticket 56, owner ruling 2026-11-18)

The option has three modes, read by one reader (`moveBeforeGrowMode`, `src/layout/read/move-before-grow.ts`): written `true` is strict and throws as
before, written `false` is off, and a sheet that writes nothing takes the default (`DEFAULT_MEANS_ON`, false until ticket 45 flips it). In the
default-on mode `layout` runs the whole command with the option on and writes the effective mode into the document of the run. When that run fails
with a `PlacementRefusal` (any code of the closed set `REFUSAL_CODES`, the centring invariant included; a refusal that wraps another exception, the
`SkeletonError` of a tier attempt, only when that cause qualifies too) while the command budget has time left, it runs the complete input once more
with the option off: a fresh ledger, the ordinary pipeline with its width and lift selection and the publication fit, on what is left of the budget.
Only that run's own validated result publishes, with the warning `MOVE_BEFORE_GROW_FALLBACK`, which names the first failure by code and message
(R6), and the record `moveBeforeGrowRun` (`requested: default`, `effective: off`, the failure). A failure of that run propagates. A parse or
resolve error fails in both modes and does not run twice; a deadline (the command's, ELK's or the caller's) is no refusal and never falls back.
The record and the document's effective value are checked at every publication and at the restore (R5), so a restored layout runs the checks
of the mode it ran. A run that draws in the default-on mode records `effective: on`. This is the release guarantee of ticket 45 for a sheet
that draws with the option off; the joint placement of a pooled row unit (ticket 53) can retire it when it passes the cases of ticket 46.

## Amendment: the default mode chooses the growth on the whole sheet (dense-16x9 ticket 60, owner ruling 2026-11-19)

Ruling: "whole-sheet choice, narrow the trigger". Move before grow means that the move is tried first and the growth is the second choice; it
does not forbid the growth. A node that cannot move grows when the growth keeps its links straight and the move alone leaves them bent. The
census of the flip (ticket 60 analysis) found two placement causes in stage 7c: the cap of 5 times on a body that cannot move, and a seat bounded
by its row as stage 5 left it. A local rule (a higher cap, or a slide bounded as a growth) repairs part of the bent links and makes the sheets
the default made better worse again: a growth that keeps its own links straight can cost the sheet more. So the choice is made on the whole sheet.

In the default-on mode (`layout.moveBeforeGrow` not written, `DEFAULT_MEANS_ON` true) the command runs the option-on run as before. When that run
completed and left a seat short (`growthShort`, `src/pipeline/index.ts`), and the command budget has time left, the command lays the whole input out
once more with the option off, on what is left of the same budget. The trigger reads two existing placement notes by code, stage and owners,
never by text, and no 7c record is added for it. A note the caller passed in (the parse diagnostics) fires nothing (review 1, P4):

- a link that a `CENTRE_ALIGNMENT_INFEASIBLE` note names is still bent in the published run, by the scorer's bend reader (`pathBends`);
- the run has a `SEAT_SET_DECLINED` note of the placement. The cap also acts in the placement runs of a round's trial (the course round); when
  that trial is declined, the published run names no short seat although the cap cost the sheet its course.

One judge decides (`judgeGrowthChoice`, `src/layout/read/move-before-grow.ts`): the option-off run publishes only when it is better on the whole
sheet by the unified order (`unifiedCompare`, the comparator of the far-end round: fewer bent links over both layers, then fewer turns, then fewer
crossings), draws every link that the option-on run draws (`removedLinks`, the removed-link guard of the routed trials, by identity: review 1,
P1), and has no error-gate finding that the option-on run does not have, counted with its multiplicity (`gateFindings`: review 1, P2). A tie
keeps the on run. A trial decides nothing when the budget has no time left before it starts or once it returns, or when it throws for any
reason (review 1, P3): the on run publishes, with one note `MOVE_BEFORE_GROW_TRIAL_SKIPPED` (stage `placement`) that names the cause; `info` for
a spent budget or a qualifying refusal, `warning` for anything else, such as a worker bug (review 1, P5, R6). The restore check reads the shape of
that note only: one at most, on an option-on record. A refusal of the option-on run still falls back as the amendment of ticket 56
says, with no trial. Written `true` stays strict (one run, no trial); written `false` is off.

A kept option-off run records the choice (`moveBeforeGrowRun`: `effective: off` with `choice`, the tallies of both runs, distinct from a fallback,
which has `failure`) and one info note `MOVE_BEFORE_GROW_CHOICE` that names both tallies. The record excuses no gate. The restore check
(`moveBeforeGrowRunFault`) accepts exactly that shape: the document holds the option off, the layout is final, the recorded `off` tally is the
tally the judge's measure reads on the published model, it is better than the recorded `on` tally by the judge's comparator, and one note names
them. The `on` tally is evidence only: its run did not publish.

Measured on the census as written (647 sheets, slice 1): the trigger fires on 259 sheets, and all 33 sheets that the option-off run repairs are
among them; the narrower first arm alone fires on 143 sheets and misses 5 of the 33. The outside sheet does not fire. The cost is one more run
on the sheets that fire.

