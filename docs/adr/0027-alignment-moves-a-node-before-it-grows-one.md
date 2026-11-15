# ADR-0027: Alignment moves a node before it grows one

Status: accepted for implementation (owner ruling, 2026-11-15). Tickets: `.scratch/dense-16x9/`.

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

## Addendum: a feed left out for good, or for now (2026-11-15)

Two clauses change the amendment above (design note `design-02-seat-2`):

1. Clause 1, narrowed: a feed that its seat left out stops pulling only when it can never join the
   kept window: the cap declined its target, or the order and pitch of its face against a kept port
   exclude its x. A feed that a bound left out (a sibling, the row window, an overlay wall) still
   pulls.
5. A seat is judged where its step ends. A step that grows a body and leaves every aligned port of
   its group off its feed is declined whole, and records no seat. This was ticket 71's rule for a
   given-back body. With it in every step, the given-back record (`givenBack`) named no node on any
   corpus sheet, and nothing read it. The record, its second run of the passes and its check are
   removed.

Two rules hold the lane reseat of 7f, the one move after the last centring:

- A corridor does not follow its child across a group that it stands beside (the `laneSide`
  post-condition of 7f).
- The reseat is judged by the publication's record comparison (`alignment-targets-differ`), because
  no centring follows it to write a decline into the record.

Measured and open:

- The owner's tier-gap sheet gets main's geometry (516 x 484, 8 bends, 5 crossings), but the
  centring spends its budget there; main settles.
- private-datacenter-spine-leaf returns to main's 10 bends and a spent budget (the branch had 0).
- a-kept-vertical-leaves-a-straight-overlay-straight fails G6. The chord step of 7f moves group `c`
  9.9 px, ticket 75's guard keeps `f2` from following, and the router draws link-2 12 px from the
  diagonal of link-5. The chord judge reads G6 only on links that have a path in 7f; link-2 is routed
  in stage 8 (dense-16x9 ticket 14). A guard on kept ports in the chord step removed the G6 but cost a
  straight link on 5 sheets, and was dropped.
- The acceptance set (`test/layout/seat-acceptance.test.ts`) holds the tests of ticket 71 with their
  old pins. Five of them fail with both clauses, and each is marked expected-fail with its clause.
