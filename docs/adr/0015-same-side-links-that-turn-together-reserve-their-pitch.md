# ADR-0015: Same-side links that turn the same way reserve their pitch and their corridor

Date: 2026-09-14 · Status: **proposed** (drafted for the maintainer from tickets 21 and 31) · Decisions: tickets 21, 31 (cases A, B, C)

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

## Decision (proposed)

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
