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
