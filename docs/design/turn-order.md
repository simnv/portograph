# Port order from the planned first turn (design, proposed)

Status: accepted (architecture ticket 24; user decisions 2026-10-11). Evidence: hand solves 01 and 09, principle P2
of `ref/hand-solves/ANALYSIS.md`. This document states the rule and the round that offers it. The ticket has the
measurements and the phases.

The user's decisions: stage 5 and a 7a pass (Section 4); **an offer, not a fixed rule**, judged by `unified` and paid
with one re-run of `MAX_RERUNS` (Section 10); G5 judges by the same rule (Section 7); the row bypass is in
(Section 6).

## 1. Problem

Stage 5 gives each face a provisional engine order by far-end position (x on `top`/`bottom`, y on `left`/`right`).
The far end tells where a link goes. It does not tell which way the link turns first. Two links of one node that
leave one face can then cross each other next to the node:

- Case 01. R4 has two ports on its left face. The ring link R3–R4 is straight. The closing link R4–R1 turns up and
  runs above R3 and R2. Both far ends stand at the same y, so the far-end key is a tie, and the tie gives the closing
  link the lower slot. Its vertical crosses the straight link. 1 crossing.
- Case 09 (main 0664e05). Mgmt 1 has two ports on its bottom face, each with a column-gap course (ticket 15). Both
  links go down, turn right, rise in a gap and enter their targets from the left. The link to Core 1 rises in the
  nearer gap. The far-end key puts it on the left slot, so its horizontal run crosses the stem of the link to
  Dist 1. 1 crossing.

The fix in both cases is a slot swap. No node moves, no side changes, and no turn is added.

## 2. Terms

- **Planned first turn** of a link end: the direction the planned route takes at its first turn after it leaves
  the port, read from a reservation that exists before routing. It is `low` (toward the low end of the face: up on a
  lateral face, left on a horizontal face), `high`, or `none` (the planned part is straight, or no plan states a
  turn).
- **Shape** of a turning end: `return` when the second turn of the planned route goes back toward the node's side
  of the face line (a U: a skirt into a lateral face, an overlay bracket, a U part of the tier gap); `onward`
  when it does not (an L, a Z, a stepped tier-gap part, a run to a lane that continues away).
- **Reach**: the coordinate, along the face, of the second turn of the planned route. Where the second turn is
  not placed yet, the reach is the coordinate of the far-end face that the second run serves.
- **Depth** of a turn: its distance from the face. Rows, lanes and rings set the depth after stage 5.

## 3. The rule

On one face, the engine-ordered ports take this order, from the low end to the high end:

1. Ports whose links turn `low`, shape `return`, by reach descending (the shortest run at the low end).
2. Ports whose links turn `low`, shape `onward`, by reach ascending.
3. Ports with no planned turn, by far-end position (today's key, with today's ties).
4. Ports whose links turn `high`, shape `onward`, by reach ascending.
5. Ports whose links turn `high`, shape `return`, by reach descending (the shortest run at the high end).

Equal keys keep today's order (far-end mean, then the current tie order). The sort is total and deterministic.

Why this order. For two links that turn the same way, the link with the shallower turn must take the slot on the
turn side; otherwise its run along the face crosses the other link's stem. The planners that set the depth after
stage 5 already nest by reach: a U part or bracket that reaches farther stands deeper (the tier-gap plan, ticket
153; the perimeter rings, P4), and of two onward links the one that reaches farther turns shallower. A `return` link
is shallower than an `onward` link of the same turn; otherwise one crossing is certain. The five groups above are
those depth orders read back as slot orders. The slot order is fixed first, and the depth planners follow it.
This was measured on case 09: with the slots swapped, the tier-gap plan gave the inner link the upper row with no
other change.

What stays as today:
- A face with no planned turn keeps the far-end order byte for byte (group 3 only).
- Onward links in the far-end direction (a stepped part toward its far end, an L into a lateral face) have reach
  order equal to far-end order. The rule changes the order only for `return` shapes, for a first turn away from
  the far end, and for far-end ties.
- An author `order:` wins. The author-ordered subsequence keeps its slots, and the engine ports fill the rest.
- A bus port stays last on its side.
- A shared port is one slot. Its key is the key of its links when they all agree, else group 3 with the mean far end.
- Bundle members (7e), bar members (7b) and the compatible primary bundle block of a flank keep their own rules.
  The rule never moves such a port, and their rules keep their invariant-4 permission.

The ticket-15 bracket order (`slotOrder` in `sidesTwo`) is groups 1 and 5 for overlay brackets: the bracket that
reaches farther takes the upper slot at the upper end. The rule replaces `slotOrder` with one comparator for routed
and overlay ports on one scale. An unplanned port next to brackets keeps the place ticket 15 gives it (before the
brackets when its far end stands before their nearest reach, else after them).

## 4. Where the turn is read

The pipeline's load-bearing rule: nothing may be discovered in routing that placement could reserve. Thus the rule
reads only reservations, never the router.

| Source | Known at | First turn and shape | Reach at stage 5 |
| --- | --- | --- | --- |
| Course (ticket 15): `skirt`, `transit`, `u-turn`, `shared-port`, `overlay`, perimeter | stage 5 (an input of the run) | from the faces and the side of the lane or margin | the far-end face the lane serves; the margin side for a perimeter run |
| Side lane (lane hint, ADR-0022) | stage 5 | toward the band edge that faces the far end; `onward` | the band edge |
| Stepped tier-gap part | stage 5, from skeleton x | toward the far end; `onward` | the far end (group 3 order is unchanged) |
| Row bypass (Section 6) | stage 5 | toward the bypass edge; `onward` | the bypass row |
| Transit lane of 7a, without a course | 7a | toward the lane x | read in 7a |

In a placement run that carries the turn order (the trial of Section 10, and every run after a kept trial), stage 5
sets the order from the first four sources. Stage 7a re-reads the same key once the lanes stand. It may reorder only
ports whose class or reach a lane changed, before 7c centring. Thus centring, bars, bundles and bands read the final
order, and nothing after 7a must repair it. A reorder keeps the count of ports on each face, so no node size
changes. A run that does not carry the turn order orders every face as today.

## 5. Invariant 4

Proposed text for `CONTEXT.md`, invariant 4, second sentence:

> Engine-selected order may still change where bar and bundle rules require it, including compatible primary-bundle
> order during flank alignment, **and in stage 7a where a lane fixes the planned first turn of a link (the turn
> order of `docs/design/turn-order.md`)**.

The mutation check (`src/layout/mutation.ts`): `lanes` keeps `reorder: false` for every port but one kind. A
lanes transaction may change engine order on a face only to the order the turn-order comparator gives on the
model after the transaction, and only for unauthored, non-bundle, non-bar ports. Any other reorder throws, as
today.

## 6. The row bypass (case 01)

A routed peer link between two nodes of one row whose straight run is blocked by a node of the row between them
has no plan today. Stage 8 finds a way round. This is a discovery. The bypass becomes a planned course:

- The edge: the row edge that fewer legs cross within the span of the two ends. This is the count the mesh bus
  edge uses (`busSide`, term 1, Q105). The title edge wins a tie.
- The reservation: one node-gap stem beside each end (the gap between the end and its neighbour toward the other
  end grows to the G6 clearance on each side of the stem plus the stroke, where it is narrower). One padding row on
  the chosen edge of the group, within the span (the group padding grows by one pitch where the row does not fit).
- The faces stay lateral. The first turn of each end is toward the bypass edge, shape `onward`.
- The bypass is a course candidate. The course round offers and judges it as it does every course (ticket 15), so
  it is an offer too. Once kept, it is a planned turn, and the turn round of Section 10 reads it. Case 01 thus needs
  two re-runs: the course round, then the turn round.

## 7. G5

G5 `port-order` reads the same comparator on the published paths, on the faces that the turn order placed. The
layout records those faces (`freeze.turnOrder`: node and side). On such a face, a pair of ports in group 3, or a pair
of onward ports of one class, is judged by the far-end ranges as today, and any other pair by the turn order. Every
other face is judged by the far-end ranges alone, so a baseline that no trial changed is judged as today. One
predicate serves the gate and placement (`decide.ts`, `chord-clear.ts` and the far-end question of `flanks.ts`);
placement reads the planned turns, and the gate reads the published turns. `docs/design/quality.md`, G5: "port order
on a side matches the turn order (far-end order where no link turns)".

## 8. Diagnostics

- `TURN_ORDER_TAKEN` (info): a kept trial changed the order of a face. One per face; it names the node, the side,
  the links, and the bent, turns and crossings before and after.
- `TURN_ROUND_SKIPPED` (info): the baseline has an offer, and no re-run is left for it.
- A refused trial has no note, as for the other rounds; the trace names the reason.
- `PORT_TURN_MISSED` (warning): a published path whose first turn differs from the planned one at a port that
  the turn order placed. A non-zero count is a defect of a planner, not of the rule.

## 9. Not in this rule

- Two faces. A link on the left face and a link on the bottom face of one node can still cross (NTP has one such
  pair). This is P1 (the side follows the route), not P2.
- A link with no reservation keeps group 3. The rule never guesses a turn.

## 10. The turn round (user decision, 2026-10-11)

The turn order is an offer. The round measures it on the kept result, places once more with it, and keeps the trial
only when the published result is better by `unified`.

**The offer.** On the kept 7f model and its routed result, the comparator of Section 3 reads the planned turns of
every face. The offer is the set of faces whose turn order differs from the order they have. An empty set is no
offer.

**Where the round sits.** The rounds run in this order: fan rounds, span round (ticket 22), course round (ticket 15;
before or after the side rounds, as today), side rounds, the deferred course round, **the turn round**, the overlay
round. Reasons:
- The turn order reads plans that the span, course and side rounds keep (a course is a planned turn; a span changes
  which routes bend). It must read their kept result, so it runs after them.
- The overlay round runs last on the kept routed result (ticket 15, phase 7). Its brackets already take groups 1 and
  5 of the comparator in every run, so it needs no turn trial of its own. A kept turn order is an input of every
  later run, the overlay trial included.

**Budget.** The round takes one re-run from the shared `MAX_RERUNS` and places under the hard cap of ticket 22
(`PlacementBudgetExceeded` refuses the trial). A run that stage 7a refuses before any work gives its re-run back.
The starvation rule of ticket 22 is extended both ways:
- The span, course and side rounds count the turn round as a later round with an offer when the turn offer is not
  empty on the baseline they read. Each leaves it one re-run, as each leaves one to the rounds after it today.
- The turn round leaves one re-run to the overlay round when the overlay round has an offer on the turn round's
  baseline (`measureOverlayCourses` not empty). With one re-run left and both offers present, the turn round runs
  only when its promise beats the overlay promise by `beats` (the pattern of the course and side rounds).
- When no re-run is left, the round is skipped with `TURN_ROUND_SKIPPED`.

A turn offer that exists only after a kept course (case 09: the courses make the faces) is not visible on the
baseline, so no earlier round reserves for it. It takes a re-run that the earlier rounds left.

**The judge.** The trial is kept only when all of these hold:
- No removed link. No new gate finding (findings compared as sets). No minimum separation broken or deepened.
- Every kept course publishes at most the turns it promised.
- The canvas does not grow (the turn order adds no size; a growth is a sign of a planner fault, and refuses).
- The whole reading is better by `unified`: fewer bent links over both layers; on a tie, fewer turns; on a tie,
  fewer crossings.

A pure crossing gain is the usual case: the turn order moves no bend by design. It is kept only when bent links and
turns do not rise. This is the `unified` order itself, read lexicographically: a trial that removes crossings and
adds one turn anywhere is refused. A trial equal on all three ranks is refused (no change without a gain).

**Byte identity.**
- No offer: no trial, no re-run spent, no reservation by the earlier rounds. The layout is byte for byte the layout
  main makes.
- A refused or skipped trial: the baseline stands, byte for byte as main makes it, with no note.
- One exception, stated and measured: on a sheet whose baseline has a turn offer, an earlier round now leaves one
  re-run for the turn round. If that round would have used the re-run (a side retry), its result can differ. The
  corpus measure lists each such sheet.
- `testTurnOrder: false` skips the round (tests and the before/after measure).
