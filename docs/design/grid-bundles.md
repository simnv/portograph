# A bundle in a grid turns to follow the stack (design)

Status: implemented, 2026-10-11 (architecture ticket 23; hand solve 10, principle P10). Deviations are listed in the ticket's `## Comments`.

## 1. Problem

`CONTEXT.md` `grid` and `bundle`: a group that holds both ends of a bundle declines every shape that stacks its
nodes, takes `row` to every rule, and reports `GROUP_SHAPE_DECLINED` (`src/resolve/index.ts`
`declineStackedShapes`, `src/layout/grid.ts` `groupShape` and `enclosedBundle`; pipeline.md stage 4, grid item 3).
The reason in pipeline.md is measured, and it has two parts:

1. With the two ends in one row, the bundle is lateral (`right`/`left`). Its member pitch grows the two bodies in
   y in 7e, after the rows were stacked. In the gridded golden `EAC-02` grew to 322.75 px and covered the node under
   it in its own column (`BUNDLE_CHANNEL_BLOCKED`).
2. With the two ends in different rows, nothing ordered the two faces. The channel read `have -368.25`: two faces
   out of order.

Both faults have one cause: **nobody decided the bundle's direction before the rows were stacked.** The bundle
takes a lateral side because its peer is on the same tier (stage 2 table), and the packer does not know that the
two ends must stand one over the other.

Hand solve 10 (`ref/hand-solves/10-bundle-in-a-grid.*`, page `solve`) keeps the author's grid. S3 stands under S2
and the bundle turns from `right`/`left` to `bottom`/`top`: two short vertical members in the row gap.

## 2. Rule

**A grid that holds both ends of a bundle keeps the grid when it can stand each such bundle vertically: its two
ends in one column, in adjacent rows, the upper end's members on `bottom` and the lower end's on `top`.** It
declines the grid, as today, only when no stack can do that, and the diagnostic says why.

This is not "groups reshaped after bundle bodies" (the ANALYSIS fit). The direction of the bundle is read from the
document and the stage-2 sides, before any geometry. The stack is then packed with the bundle's direction known.
So the packer never has to undo a body that grew after the rows were stacked.

### 2.1 Chains

In a grid group G, take the graph whose edges are G's **enclosed bundles** (both ends in G; `enclosedBundle` read
for every bundle, not the first). Two bundles between one pair are one edge. Each connected part must be a simple
path: a **chain** of nodes `n1 … nk`, each joined to the next by one or more bundles. A chain stands in one
column, in k consecutive rows, `n1` on top. A chain of two is case 10.

### 2.2 Orientation (which end is on top)

Read at stage 2, from the sides the stage-2 table gives to the links that leave G (`side ?? sizingSide`, the
same reading `exitRanks` uses):

1. An authored `side:` on a member port fixes it: `bottom` on the upper end, `top` on the lower end.
2. Else the exits decide: the chain's end that exits **upward** goes on top, and the end that exits **downward**
   goes at the bottom.
3. Else the chain reads in the authored direction of its first bundle's first member: its `from` end on top.

### 2.3 When the grid declines

`GROUP_SHAPE_DECLINED` (warning) stays, and names the bundle and one reason:

| Reason | When |
| --- | --- |
| `authored-side` | A member port has an authored `left` or `right` side, or both ends of one bundle have authored `top` (or both `bottom`). |
| `branch` | A node holds enclosed bundles to three different partners or more. |
| `cycle` | The enclosed bundles of G form a ring. |
| `exits` | An interior node of a chain exits upward or downward, or the chain's top exits downward, or its bottom exits upward (rule 2 cannot orient it). |
| `rows` | No column count that the grid rules allow gives rows enough for the chain: Q75 forces one row (all nodes exit one way, or a node exits both ways), or a chain whose ends exit both ways needs exactly k rows and another chain needs a different k. |

The first reason in this order is reported. A declined grid is a `row` to every rule, as today.

### 2.4 What each stage does

| Stage | Change |
| --- | --- |
| 1 | `stackChains(model, groupId)` returns the chains or a decline reason. It is the one predicate: `groupShape` and the diagnostic both read it (the "cannot disagree" property of `declineStackedShapes` stays). |
| 2 | The member ports of each chain take `bottom` (upper end) and `top` (lower end), fixed like an authored side. Stage 5 does not overturn them. This is the pattern of the bus join's facing edges (Q107), so ADR-0009 needs no change. |
| 3 | The ports size the top and bottom faces (width), not the lateral faces (height). Each node of a chain takes the widest chain node's width as a floor, so the two port blocks have one x and the bundle is straight. |
| 4 (grid pack) | The chain is one **unit** that is k rows tall. `exitRanks` gives the unit the top node's upward exit and the bottom node's downward exit. The Q75 bound counts the unit once. `gridColumns` drops each count whose rows are fewer than the longest chain. `gridRows` seats the unit in one column and k consecutive rows. A chain whose top exits upward starts in the first row; a chain whose bottom exits downward ends in the last row. The other cells of the chain's column take only nodes that exit neither up nor down. |
| 4 (row gap) | The gap under each chain link is `max(bandGap, need)`, where `need` is the channel that 7e's bundle planner reads for that bundle (two stems, plus member-pitch turn rows where the two port blocks differ in x). One function computes `need`, and both the packer and 7e call it. |
| 7e | The bundle is a facing, aligned bundle across the row gap, which is the geometry the planner already plans across a tier gap. 7e must not grow the gap. If it would, that is a fault (`GRID_BUNDLE_CHANNEL_SHORT`, error), because the packer reserved the channel. |
| rounds | No change. The rule needs no placed geometry, so it is no offer and costs no re-run. The side round already skips grid ports. Courses and span chords see a grid as before. |

### 2.5 What does not change

- A grid with no enclosed bundle: every byte.
- A bundle between a flank and one grid node (the hole that stress ticket 32 records): still not seen.
- `likeSidePairs` (two authored `top` ports kept out of one column) and the both-ways floor (Q75): as today. A chain
  does not use a like-side pair, because its ends face each other.

## 3. Expected result on case 10

Before (main 95a08df): the farm is one row of six. 4 routed links, 0 bent, 0 turns, 0 crossings. All gates pass.
Canvas 473 × 344, Q 0.8939. `GROUP_SHAPE_DECLINED` (warning).

The hand solve (page `solve`, read from the XML): 2 columns × 3 rows (S1 S2 / S4 S3 / S5 S6), the bundle on
`bottom`/`top` across a 16.5 px row gap. S4 stands under S1, so Core–S4 drops through the tier gap and down the
21.5 px column gap between S1 and S2 (8.5 px from S1) and turns onto S4's top face: 1 bent of 4, 4 turns,
0 crossings. The Farm frame grows from 447.5 × 117 to 447.5 × 334.5; its width did not shrink, which the ANALYSIS
calls unfinished. The content then reaches y 550, so the canvas would be about 473 × 562.

The rule: S1 and S4 both exit upward, so Q75 puts them in two columns of the first row, and the chain S2/S3 takes a
third column (closest to square: 3 columns × 2 rows, S1 S4 S2 / S5 S6 S3). Every link is straight: 0 bent,
0 turns, 0 crossings. This is better than the solve by the unified order (0 bent against 1), and it keeps P9 (move
nodes little). The solve's detour of Core–S4 is not part of P10.

## 4. Fixtures and tests

See architecture ticket 23, *Acceptance*.
