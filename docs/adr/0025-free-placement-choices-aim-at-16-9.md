# ADR-0025: Free placement choices aim at 16:9

Status: accepted for implementation (owner ruling, 2026-11-15). Tickets: `.scratch/dense-16x9/`.

## Decision

Every sheet has an **aspect aim** of 16:9. Where a placement rule has a free choice between
arrangements, it takes the one whose canvas is nearer the aim, measured as
`|ln((W/H) / (16/9))|`. The rules that today choose toward square (stagger, lift, grid) take the
aim. The tier gap of a family of straight links, past the 600 px cap of the 34-degree rule,
takes the height that brings the sheet nearest the aim, and no member is flatter than 15 degrees.

The aim is a soft default and never a gate. A document can override it.

## Considered options

- An authored option with the default unchanged. Refused: a sheet that nobody tuned came out at
  4.5:1, and the default output is what a reader sees first.
- The width budget alone (`layout.maxWidth`, ADR-0024). Refused: it is a bound, not a shape, and
  it had no effect on the sheet that started this decision.

## Consequences

Most goldens and many corpus sheets move. Each rule that takes the aim merges alone, with
`gate:compare` showing no sheet worse on bends, crossings or gates unless it is listed with a
reason, and with a contact sheet of the 12 most changed sheets for the owner.

## Amendment (2026-11-16): the lift takes the aim in its judge

The lift reads the aim in `judgeLift`, where it chooses (the tolerated rise must be narrower or nearer the aim). Its **trial filter**, the shape
test that admits a rise with no estimated area gain to a trial, keeps the square test of ADR-0024, unchanged. Reason, by measure on the corpus:
the estimate is too coarse to tell the rises the judge keeps from the ones it declines. A filter by the aim admitted a trial on 219 sheets and
kept five more lifts for +6.8 % corpus time (+42 % on the 101 sheets whose drawing did not change); a filter that bound the estimate's area to
the judge tolerance kept none of them and lost a lift that main keeps, which was visibly worse. A later ticket may revisit the filter.

## Amendment (2026-11-16): the gap of a flat block

The tier gap of a complete solid block past the cap (dense-16x9 ticket 04, slice 3) is chosen on the complete placement, not on the extent of
an earlier stage (the defect class of ticket 22: a choice made on a stale extent overshot to 1.6:1 on the sheet behind the ticket).
- The first run places every flat gap at its floor: the gap that holds the flattest member at 15 degrees, with every under-cap demand of the gap.
- Its 7f trial gives the placed extent W x H (`placedExtent`, the extent the stagger gate reads; no routing pass). The sheet wants H* = W / aim.
- The flat gaps share max(0, H* - H) equally, each clamped to [its floor, its 34 degree demand]; a gap that reaches its demand passes its share on.
- One more placement stands at the chosen gaps. It is kept only when its 7f trial stands nearer the aim than the floor placement (the width can
  move); else the floor stands. A sheet already taller than the aim keeps the floor, the densest result. The chosen placement is kept only when it stands nearer the aim than the floor placement; its width can move, so this bounds the result by the comparison, not by the aim itself.
- Bound: one placement more per command for all flat blocks together, and two 7f trials. Its placements stand outside the placement cap, as the
  stagger gate trials do (`env.gateRuns`).

A box entry is no part of the floor: a member whose box entry the chosen gap does not hold falls back alone, and the block stays.

## Amendment (2026-11-17): the room of a flat block is not judged by the aim

Before the gap choice, placement gives the flat members their room (dense-16x9 ticket 04, slice 3, step 2): the side padding of a box that a
member would leave through a corner, and the row gap beside an end node whose neighbour reaches past the face, both at the member's angle at
the block's floor.
- The placement with that room stands whatever its aspect. The room buys straight members, and the aim does not trade them away. On the sheet
  behind the ticket the canvas did not change at 16:9 (3543 x 1998 px) and grew 6 px in height at 21:10: the far row had room under the width
  the provider rows set.
- The gap choice above then runs on the placement with the room.
- Bound: at most `BLOCK_PAD_ROUNDS` (3) placements more per command, outside the placement cap; a refused placement keeps the one before it.
