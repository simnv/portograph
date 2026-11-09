# ADR-0024: Width budgets reserve staggered rows before routing

Status: accepted for implementation (owner request, 2026-10-31). Ticket: snack-theme 166.

## Decision

`layout.maxWidth` is a positive finite budget for the published canvas width, in pixels.
It is an operational input. Placement receives the document without that field, so a sheet
that already fits produces the exact normal output, including the echoed document.
An absent width budget skips the budget-driven trials. Stage 5 may still stagger an eligible row of four or more members by the aspect rule (amendment 2026-11-02; D12, decision review 2026-11-07, which replaces the earlier claim that an absent budget records no stagger decision); authored `shape` and `autoArrange: false` keep their contracts.

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
when all of these hold: no authored `shape` (any of `ranked`, `row`, `bar`, `grid`); not a flank and not a rank cell; four or more
members; one plain routed link per member, all out through one horizontal face; its band is the
one widest band; the sheet is wider than tall; the seated draft passes the stage-5 proof and
the freeze validation; and the sheet is at least one pitch narrower and nearer square
(`|ln(W/H)|` strictly smaller, W and H the stage-5 canvas that the band extents set). The
aspect rule (user decision 2026-11-02) keeps the small rows of tall sheets one line. A stage-5
stagger refusal keeps the row and names the reason; any other error of a draft, the freeze
validation included, is a defect and ends the run. `groupArrangements` records `stagger`, or `row` with the
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
the member; a parent seated over its drops and the other links of its feeding face keeps the freeze's
own tests (clearance and place in its row, the pitch and order of every port of that face,
its band); and the anchor tier is the row's tier or lies beyond it, so the centre rule (7c)
moves the parents and not the row. These came from the corpus run with a 1 px budget, where
stage 5 admitted five trials that routing refused for bent drops.

With `layout.maxWidth` the search stays as above: its first run is the unbudgeted run, with
stage 5's own choice, and the search tries the remaining rows. The routed trial stays for that
path.

Decision (2026-11-02, architecture-2 ticket 52): `groupArrangements` also records `column`. A
flank, or a tier group with a flank beside it, whose members each have one plain routed lateral
link to one node of the facing group stands one member on each line. Stage 5 of the first
placement run decides it on final sides, before the nodes are sized again, and the facing face
takes the column's centre pitch, so every link is level and straight. It spends no placement
run, and the record exists when a group took the column or a stagger draft was tried.

## Second amendment (2026-11-08, decision review 2026-11, D-Q4, ticket 07): fan wrap, two triggers, area objective

The user ruled that a tier block must not be much wider than its sheet because one row of leaves stands on one line under one hub
(mock A: two staggered lines, straight vertical drops, the hub spans them). The first amendment changes as follows.

- Candidates. A rank cell is admitted. A row has three or more members, and every hub of the row feeds three or more of them (a **fan**;
  the runs of several hubs stand side by side, and the seat refuses interleaved runs). The other rules stay.
- Two triggers, in one place (`triggerReason`, `src/layout/stagger.ts`). A rank cell takes the **block trigger**: its one line is wider
  than the widest other group of its tier block (its top-level frame with the child frames). A plain row, which has no other block content,
  keeps the aspect rule: its band is the one widest band and the sheet is wider than tall.
- Objective: the stage-5 canvas area, strictly less, replaces "at least one pitch narrower". A plain row must also come out nearer square.
- Re-pack. After the seat, a wrapped rank cell packs its document tier again (`packTier`), so the sibling units close up.
- Feeding chain. The units on the feed side that feed the block, tier by tier, without a shared parent, are its feeding chain. The first
  seat decides it once (`StaggerRow.chain`; `[]` for no chain, absent for a plain row). Every seat moves those units as one block in x by
  one move, so that each unit on the tier next to the block stands over its own feeds. A chain whose near units need different moves, or
  whose move the boxes beside it do not leave room for, refuses the row by name. 7c grows no chain body and centres a chain node only on its
  feeds inside the chain or into the block, which keeps each near unit over its feeds. Publication and restore check each near unit on its
  own.
- Acceptance gate. A stagger that stage 5 chose stands only when the complete placement (after 7f, before routing) takes less area than
  the same placement without it, keeps every link that placement makes straight, and shortens no hard separation. The comparison run keeps
  the first run's record with every chosen stagger a row and places no stagger at all, so it cannot choose another one. It is one placement
  run per command whose placements stand outside `MAX_RERUNS` and the placement cap, so it is always available, and its state is its own: a kept stagger goes on as if
  it had not run. A declined stagger stays one line; the record names the gate, and the info diagnostic `FAN_WRAP_DECLINED` names the reason.
  A stagger refusal in the wrapped run's 7f declines it the same way.

Evidence: two proofs of concept on the fan wrap. On the key sheet
`a-chain-of-tiers-packs-over-its-feeds-final-x` the canvas goes from 2937 x 1069 to 1845 x 1126 px (area -33.8 %), with no bend and no
straight link lost.
