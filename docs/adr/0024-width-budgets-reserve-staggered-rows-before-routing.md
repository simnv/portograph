# ADR-0024: Width budgets reserve staggered rows before routing

Status: accepted for implementation (owner request, 2026-10-31). Ticket: snack-theme 166.

## Decision

`layout.maxWidth` is a positive finite budget for the published canvas width, in pixels.
It is an operational input. Placement receives the document without that field, so a sheet
that already fits produces the exact normal output, including the echoed document.
An absent budget takes the original pipeline path and records no stagger decision.

Measure the normal published width first. Above the budget, try eligible rows in descending
published width, then group id. A row has at least three members; every member has routed links,
all through one horizontal face, towards that face, and none join members of the row.
Keep the existing feed order. Odd members stand one line away from their feeds: below for
upward links and above for downward links. One uniform centre pitch reserves same-line node
and pill clearance and the stroke-expanded obstacle beside every passing vertical.

Stage 5 records the order, face, pitch and line step in `staggerRows`. It seats feeding faces
before transit lanes fix their x. Ordinary parents reserve their width and port positions;
bar parents retain stage 7d's source-derived span. Frames and tier bands fit both lines, and
ADR-0011 keeps titles on the opposite edge. The topology freeze holds a copy of the decision.
Every publication and restore checks that copy, both lines, the pitch and current port corridors.
A later move that breaks a reservation refuses through the existing transaction boundary.

Each remaining row is tried once on a complete pipeline run. Re-sort the remaining rows after
a kept trial. All runs share the caller's command deadline. A trial is kept only when narrower,
with all G1-G9 passing, no removed links, and complete straight vertical drops from staggered
members. Refused trials produce `ROW_STAGGER_REFUSED`; a missed budget produces
`WIDTH_BUDGET_UNMET` on the narrowest valid result tried. A deadline still ends the command,
as ADR-0010 and the command-budget contract require.

## Consequences

This spends height instead of reducing content sizes or fonts. There is no router grant,
new routing technique or paint-dependent placement.
The search is greedy, widest first. It does not search combinations of individually refused rows.

## Amendment (2026-11-02, architecture-2 ticket 51): an unbudgeted sheet may stagger

The sentence "an absent budget takes the original pipeline path and records no stagger decision"
no longer holds. Without a budget, stage 5 of the first placement run picks each group's
arrangement right before the seat, on a draft, and spends no placement run. A row staggers only
when all of these hold: no authored `shape`; not a flank and not a rank cell; four or more
members; one plain routed link per member, all out through one horizontal face; its band is the
one widest band; the seated draft passes the stage-5 proof and the freeze validation; and the
sheet is at least one pitch narrower. `groupArrangements` records `stagger`, or `row` with the
reason, for every group. There is no record when no group passes the rules before a draft, or under
`layout.autoArrange: false` (default true), which keeps every row. Later placement runs of the
command keep the record and the rows. If a later stage of the first run refuses a chosen stagger,
the run is placed again with that row declined, within the re-run budget.

Two changes apply to both sources. One uniform pitch becomes a pitch per gap: a gap between the
members of two parents also holds both parents, seated over their drops, a row gap apart, and
the members of each parent are one run of the order. The seat also proves each drop, or refuses
the row by name: the far end is the horizontal face over the member; the vertical from the
parent face to the member meets no foreign body, pill or group box, and a transit clears the
occupied box of each group of a tier it crosses by half a lane; the parent port stands over
the member; and the anchor tier is the row's tier or lies beyond it, so the centre rule (7c)
moves the parents and not the row. These came from the corpus run with a 1 px budget, where
stage 5 admitted five trials that routing refused for bent drops.

With `layout.maxWidth` the search stays as above: its first run is the unbudgeted run, with
stage 5's own choice, and the search tries the remaining rows. The routed trial stays for that
path.
