# ADR-0022: A side hint is an input of placement

Status: accepted (maintainer, 2026-09-30, Q109). Spec: `docs/design/side-faces.md`. Leaves ADR-0009
unchanged.

## Context

A link between two tiers may draw fewer bends if a port stands on a lateral side (`left` or
`right`) and not on `top` or `bottom`. Only a placed model shows which link is bent, and which
lateral side faces its peer. But ADR-0009 fixes every port side at stage 5, before any geometry
that depends on it. A side chosen after stage 7c would need a replay of the stage-5 resize, the row
paths, the lane allocation, the bundle order, the centring feeds, the bus edge and the title edge.
That list is the whole of placement.

## Decision

1. **Placement runs again.** A **side hint** is the lateral side one measure asks one port to take.
   It is an input of the next placement run, like a fan floor (ticket 89). It is never written in the
   YAML and never changes the document. `place(floors, hints)` applies it at stage 2, below an
   author `side:` and above the stage-2 rule. ADR-0009 holds inside each run: sides freeze at
   stage 5 of that run.
2. **Two names for one side.** A hinted port has `side` (the hinted lateral side, which the drawing
   uses) and `naturalSide` (the side stages 2 and 5 give it without the hint). The layout JSON
   records `sideHint: true` and `naturalSide` on it, and on nothing else. A layout with no hint is
   byte-identical to one made before this ADR.
3. **Each reader has one side.** The skeleton graph, the mesh-bus edge and the ADR-0011 title edge
   read `naturalSide`. A hint then moves no title, no bus and no ELK input. Stage 3, stage 5
   (engine order, `rowGap`, content insets, `groupPadding`) and stages 7a to 7e read `side`. The
   table is in `docs/design/side-faces.md`, Section 7.
4. **Size is reserved at size time.** A lateral face that takes hints can need more height. Stage 3
   of the new run sizes the node with the port on the lateral side. The size of the measured run
   is a floor (`nodeFloors`, the size the skeleton graph was built from), so the ports left on the
   natural face keep their pitch. `rebuildNodeGeometry` is not changed: it centres the remaining
   ports of a face over the whole box at the face's pitch, in the same order, so a face that lost a
   port leaves an equal margin on both ends.
5. **Only a candidate takes a hint.** A port is a candidate when the spec's Section 4, items 1 to 6,
   hold. A hint on any other port is an error, not a silent drop.
6. **Restore checks stored invariants, not the history.** `freeze.topology` records `sideHint` and
   `naturalSide`. `freeze.nodeFloors` records the floors, and only when a run had them.
   `restoreLayoutModel` checks that the natural side is the one the document gives, that the port is
   a candidate, that the hint faces its peer, and that each floor is at least the node's content and
   at most the node's size. It does not run the round again.

## Consequences

- Every placement stage that reads a side reads the drawn one, except the three readers in
  Decision 3. A new reader of a side must choose, and say which in a comment.
- A hint can lose a shape after 7c moves a node. The round (ticket 115) measures the trial and
  drops it. The hint itself has no such check.
- A restored layout whose peer moved to the other side of a hinted node after the round is refused.
  The round keeps a trial only when the planned bends hold, so a published layout passes.
- Cost: one more placement run for each accepted round. The budget rules are in the spec, Section 7.

## Note (2026-09-30, ticket 119): the lane hint

A hint may carry one more bit: `laneHint`, for the routed L through a side lane. The round passes the keys of such hints to the placement run next to the hint map; `sidesOne` records `laneHint: true` on the port (with `sideHint`), `freeze.topology` stores it, and restore checks that it comes only with `sideHint`. `chordKind` gives no chord to a link with a `laneHint` port, so 7a reserves the lane and the fixed point never claims the link. The hint is still an input of placement and is never written in the YAML.

Amendment (2026-10-05, architecture ticket 15, phase 4): a port whose side a course sets is not a hint candidate (`hintRefusal`: "the port is owned by a course"). A course side may face away from the peer; a hint still faces its peer. The title edge, the bus edge, the ELK input and the rank input read the natural side, as for a hint. A course moves no title: its padding row stands inside the clearance edge of the label band.
