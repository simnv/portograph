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

The tier gap of a complete solid block past the cap (dense-16x9 ticket 04, slice 3) is chosen in stage 7e, before the freeze, from the band
extent of the settled draft: the sheet grows toward the height `width / aim`, from the floor (the gap that holds the flattest member at 15
degrees, plus every under-cap demand of the gap) up to the 34 degree demand. Several flat gaps share the extra height equally; a gap that
reaches its 34 degree demand passes its share on. A box entry is no part of the floor: a member whose box entry the chosen gap does not
hold falls back alone, and the block stays. The canvas after routing can differ from the band extent of 7e; the choice is not judged again.
