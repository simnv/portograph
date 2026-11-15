# ADR-0026: Ranks have two poles

Status: accepted for implementation (owner ruling, 2026-11-15). Amends decision 1 of ADR-0019.
Tickets: `.scratch/dense-16x9/`.

## Decision

No member stands between an anchor and the tier that the anchor links to.

A group can have anchors on both sides. The members with a routed link to the tier above (the
upward anchors) take the first rank. The members that link only to the tier below (the downward
anchors) take the last rank, `L`. Every other member counts its rank from the nearer pole. With
`du` its routed distance from the nearest upward anchor and `dd` its distance from the nearest
downward anchor, `du < dd` gives rank `du` (below the upper pole) and `dd < du` gives rank
`L - dd` (above the lower pole). On a tie it takes the upper of the two results, `min(du, L - dd)`:
a tie goes to the upper pole. No rank lies outside `0..L`, so a chain longer than the distance
between the poles stands on one rank, joined by peer links. A member that is not an anchor may
stand on a pole's rank, beside the anchors. A leaf of a member that links both upward and downward
stands beside that member, on its rank.

Reading of the tie clause: given by the coordinator on 2026-11-15, for the owner to check.

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
