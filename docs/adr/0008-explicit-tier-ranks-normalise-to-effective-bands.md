# ADR-0008: Explicit tier ranks normalise to effective bands

Status: accepted

Amended by ADR-0019 (2026-09-29): a group with more than one rank expands into cells on consecutive sub-tiers, so one effective band per group becomes one sub-tier band per cell.

Amended by the group lift (2026-11-08, ticket 08, D-Q5): see "Amendment: group lift" below.

An explicit `tier:` is the author's ordering rank and always wins over class inference, but it is
not required to remain the emitted band index. Normalisation orders inferred top groups, explicit
ranks, inferred middle groups and inferred bottom groups, then compacts those bands from zero;
equal explicit ranks continue to share a band. This preserves author intent while allowing an
inferred top group to precede an explicit rank 0 without sparse or negative layout bands. The
validated input may retain the authored rank for diagnostics, while normalised JSON records only
the effective `tier`.

## Amendment: group lift (2026-11-08, decision review D-Q5, ticket 08)

A float component (`CONTEXT.md`) may stand in bands above the bands its document tier gives. The
document tier stays the author's tier: `group.tier` and `documentTier` in the document are never
rewritten, and title, legend and tier inference read them. Only the band (`LayoutGroup.tier`) of a
member group moves, by whole bands, and the units below a hanging component may move down
(`GroupLift.push`). So band order is no longer tier order for a lifted unit: G8 keeps its check for
the groups that did not lift, and a lifted unit gets the record checks instead (`validateGroupLifts`:
whole units, a float component, each member in its recorded band, a fed node never above its
feeder, a side entry level with it, the push the record gives).

The decision is placement input, stored as `groupLifts` (absent = nothing to decide: no float component in the
first slice, as `groupArrangements`; `[]` = decided, none) and applied at stage 1 (`applyLifts`) of every placement run of the command; nothing is
found during routing. The command runs once with no lift and once per trial; a trial is kept on
its published result. The bound is `LIFT_TRIALS` = 2 trials per command (R4), with
`GROUP_LIFT_CAPPED` for a component past it (the value of the lift PoCs, choice L6; each trial
is one more whole command run under its own placement cap, so a command has at most 1 + `LIFT_TRIALS`
lift runs). With `layout.maxWidth` the lift is decided once, by the first run, and every width-budget
stagger trial applies that record (`fixedLifts`) and decides none. A deadline (the command's, or a
per-attempt timer of ELK or the router) ends the command; it never declines a trial (R4). The area tolerance is `LIFT_AREA_TOLERANCE` = 5 %: a lift set may cost
up to 5 % area over the smallest kept set when its canvas is narrower or nearer square
(`|ln W/H|`, ADR-0024), and it must stay below the no-lift run. 5 % is the smallest tested value
that keeps the user's key-sheet ruling (+4.07 % on
`a-chain-of-tiers-packs-over-its-feeds-final-x`); no corpus sheet separates 5 % from 10 %.
