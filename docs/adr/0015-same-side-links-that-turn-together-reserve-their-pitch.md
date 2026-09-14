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
