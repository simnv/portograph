# ADR-0026: Ranks have two poles

Status: accepted for implementation (owner ruling, 2026-11-15). Amends decision 1 of ADR-0019.
Tickets: `.scratch/dense-16x9/`.

## Decision

No member stands between an anchor and the tier that the anchor links to.

A group has two poles when a routed path inside the group joins an upward anchor with a downward-only
anchor (a member that links to the tier below and not to the tier above). The path may run through any
routed link, a link with both ports fixed to left and right included: poles joined only through such
a peer link are one pole at zero distance, the upward pole wins, and the downward anchor stands on rank
0 with it like a member that links both ways (its leaf chain stands beside it). Such a group has a pole
distance, and the rule below applies to it. A group with no such path keeps the ranks of ADR-0019
exactly: the depth from the upward anchors, and the old placement of members that no anchor reaches.

In a group with two poles the members with a routed link to the tier above (the
upward anchors) take the first rank. The members that link only to the tier below (the downward
anchors) take the last rank, `L`. Every other member counts its rank from the nearer pole. With
`du` its routed distance from the nearest upward anchor and `dd` its distance from the nearest
downward anchor, `du < dd` gives rank `du` (below the upper pole) and `dd < du` gives rank
`L - dd` (above the lower pole). On a tie it takes the upper of the two results, `min(du, L - dd)`:
a tie goes to the upper pole. No rank lies outside `0..L`, so a chain longer than the distance
between the poles stands on one rank, joined by peer links. A member that is not an anchor may
stand on a pole's rank, beside the anchors. A leaf of a member that links both upward and downward
stands beside that member, on its rank.

Within a group with two poles, each routed component that holds an anchor is ranked from its own pole,
`L` is the smallest span that holds every component (the pole distance, the largest depth of a component
with one kind of anchor, at least 1), the anchors are pinned on their ranks after the other members are
placed, and a child span never moves a pole or pushes a member past `L`.

Reading of the tie clause: given by the coordinator on 2026-11-15, for the owner to check.

### Why the scope stops at the pole distance

A first build ranked every group with anchors on both sides, also when no routed path joins the poles
(each component from its own pole). The measure on the corpus (500 sheets) was against it: the approved
golden m1-sip-edge, whose Datacenter holds access routers that link up, and border routers that link
only down, with no routed link between them, went from 931x960 to 810x1112 px, from 0 to 20 bends, and
lost one link (G3, G6 and G9 failed); 26 more sheets changed, two of them failed to lay out. The rule
removes the transit of the links of a downward anchor over the rows of its own group; a group without a
path between the poles can still have transit rows (a both-way gateway with a leaf is one), and keeps
them as before: the measure decided the scope, not a proof that those rows are harmless. The scope is the statement of the rule: a test (`test/layout/ranks-scope.test.ts`) compares every
corpus group without such a path with the code of main.

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
