# ADR-0026: Ranks have two poles

Status: accepted for implementation (owner ruling, 2026-11-15). Amends decision 1 of ADR-0019.
Tickets: `.scratch/dense-16x9/`.

## Decision

No member stands between an anchor and the tier that the anchor links to.

A group can have anchors on both sides. The members with a routed link to the tier above (the
upward anchors) take the first rank. The members that link only to the tier below (the downward
anchors) take the last rank. Every other member stands between them, on the rank nearer its
pole; a tie goes to the upper pole. A leaf of a member that links both upward and downward
stands beside that member, on its rank.

ADR-0019 took the breadth-first depth from the upward anchors alone. A leaf of a downward
anchor then got a rank below it. Every link from that anchor to the tier below crossed the
leaf's row, lost its routed chord to the `transit` refusal and took a lane and two rows. On a
transport sheet with two cores this cost 28 links their straight path and made 304 of 346
crossings.

## Considered options

- One side wins: count ranks from the side that buries fewer link ends. Refused: some groups
  keep a row in the way.
- Search over rank arrangements for the fewest crossed rows. Refused: slower, and the result is
  hard to predict from the document.

## Consequences

A group with anchors on both sides and leaves under its lower anchors loses one rank. The
`transit` refusal stays; this rule removes its cause.
