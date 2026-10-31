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
new routing technique, paint-dependent placement, or change to an unbudgeted sheet.
The search is greedy, widest first. It does not search combinations of individually refused rows.
