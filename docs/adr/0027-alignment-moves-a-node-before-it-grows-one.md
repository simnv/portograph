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
