# Layout as an optimization problem: research note

Session of 2026-10-25, main `33c62c16`. Sheet: Enterprise NTP (106 nodes; 153 routed and 159
overlay links).

Legend: **U** = decision the user took, in the brief or in the session of 2026-10-25. **A** = amended after the baseline evidence,
with the user's acceptance.

---

## 1. Question

Can layout be posed as an optimization problem? Does an optimizer beat the rule pipeline?

The optimizer replaces stages 4 and 5 and searches on a **surrogate**. A **realizer** sets x.

| # | Decision | Fact |
|---|---|---|
| D1 | Author-fixed | **U:** group membership, group tier, flank and canton declarations, link family, explicit `route:`. |
| D2 | Optimizer-free | **U:** node order in a sub-tier and in a group, port side and port order on each node, route per link (orthogonal, straight, bundle, merge, group-link, stub), aggregation (bundles, group-links). |
| D3 | Realizer | **U:** sets x by alignment and packing (Brandes-Köpf style). It never adds a crossing that the optimizer did not count. Rows, regions and routing then run as today. Layered, no forces (ADR-0001). |
| D4 | Objective | **A:** lexicographic. Level 1: solid x solid crossings, integer, strict. Level 2: one weighted sum of faint crossings, faint body passes, bends and compactness. |
| D5 | Salience | **U:** a crossing costs w_e x w_f. Solid routed w = 1. Faint overlay w = about 0.3. The values have no source in the literature. They are to be fitted on the user's picks (D11); no fit was done. |
| D6 | Faint body pass | **A:** a faint link passes over a body only as the last resort (D13). One pass costs w_link x w_body, with w_body = 0.3, so 0.09. That is the price of one faint x faint crossing. A routed link over a body stays forbidden (G2). Collinear faint overlaps stay forbidden (ticket 23). |
| D7 | Compactness | **A:** node-area share of the bounding box. Area in px² rates our render and the reference as equal, so it does not measure compactness. |
| D8 | Aspect | **U:** 3:4 to 4:3, a hard constraint. The legend is not in the box. When no candidate fits, a diagnostic names the cause. |
| D9 | Stub | **U:** allowed at a high penalty, about five solid crossings. |
| D10 | Solvers | **U:** CP-SAT in Python finds the **ceiling**. A deterministic, count-budgeted local search in TypeScript (sifting plus tabu, barycenter seeds) is the production candidate. Budgets are counts, never wall-clock. |
| D11 | Calibration | **U:** Bradley-Terry with a ridge prior, fitted on about 30 pairwise picks by the user. |
| D12 | Complete blocks | **U (2026-10-25):** a complete block (K2,n between rank cells) is drawn as plain routed links with its X, and only that. Bus bar, outer detour, mirrored hubs and the other mockups are refused (section 4). |
| D13 | Overlay over a body | **U (2026-10-25):** an overlay passes over a body only as the last resort (section 5; ticket 28). |
| D14 | MPLS fan | **U (2026-10-25):** the MPLS fan links are straight lines, not orthogonal (section 5; ticket 29). |
| D15 | Sweep | **U (2026-10-25):** a sweep of the gap floor, the column slack and the frame padding is approved (section 5). |
| D16 | Bends before canvas | **U (2026-10-25):** shown today's render beside the 24 px gap floor render (canvas -8 % x -10 %, routed bends 22 to 76), the user chose today's. A smaller gap ships only with bends held. |
| D17 | Straight hub fan | **U (2026-10-25):** the straight hub fan is automatic: one hub with links to three or more framed groups draws straight chords across frame edges, with no YAML field. `route: straight` stays as the explicit form. The Q108 frame-edge refusal is waived only for a strict crossing of a frame edge, never for a near miss, in one predicate. The implementer amends the chord entry of CONTEXT.md. Extends D14. Ticket 29; decisions log Q119. |
| D18 | Parent spreads its ports | **U (2026-10-25):** reverses "parents are authoritative" (pipeline.md 7c). A parent below the anchor tier spreads its ports once over its children, with one stored decision for parent growth and sibling displacement before child alignment. Reopens the row-growth question of parked ticket 14. Ticket 32; decisions log Q120. |
| D19 | Overlay U, no face riding | **U (2026-10-25):** reverses the 2026-09-16 ruling "level counts as leaving". An overlay never rides along a face or a foreign pill. It takes a U with the overlay port clearance. Only the segment that leaves its own pill is exempt. Ticket 34; decisions log Q121. |
| D20 | Straight across one tier gap | **U (2026-10-25):** reopens Section 14.1 of routed-chords.md (2026-10-11). A link across one document tier gap is straight when its chord crosses no body, pill, lane or title. The refusal reads geometry, not the band's tier. Ticket 35, part 1; decisions log Q122. |

---

## 2. Baseline

Today's stored layout against the drawthe.net reference, measured by one script (`measure.py`).
Weights: 1.0 solid, 0.3 faint.

| metric | portograph today | drawthe.net |
|---|---|---|
| crossings routed x routed (in a body) | **50** (0) | 42 (9) |
| crossings routed x overlay (in a body) | 56 (0) | 1,057 (915) |
| crossings overlay x overlay (in a body) | 315 (0) | 1,401 (1,106) |
| crossing cost outside bodies (count) | 82.06 (421) | 83.81 (470) |
| body passes, routed / overlay | 0 / 0 | 15 / 431 |
| collinear overlaps, pairs | 18 | 1,447 |
| node bounding box (px) | 1938 x 2274 | 2096 x 2096 |
| aspect w/h | 0.852 | 1.000 |
| node-area share of the box | 0.083 | 0.168 |
| bends, routed / overlay | 22 / 328 | 0 / 0 |

What the table implies:

1. **Salience crossings tie** (82 against 84 outside bodies). A strict level for all crossings lets
   one faint crossing buy any area. The reference makes the opposite trade.
2. **Solid crossings still rank first.** The reference shows 33 solid ones (42 less 9 under icons).
   We show 50. Hence D4, level 1.
3. **The reference is twice as compact** (node-area share 2.0x ours).
4. **The reference has 0 bends.** We have 350; 282 are on mesh-bus members.

---

## 3. Ceiling result

**Surrogate.** The surrogate keys each link end by (canton, frame, cell, node, face, port). Two
links in one region cross when their keys invert. It agrees with `measure.py` on all 50 routed
crossings (38.17 weighted), with 0 disagreeing pairs.

**CP-SAT.** OR-Tools 9.15, fixed seed, one worker. The output repeats.

| stage | free variables | routed crossings | bound | salience | time |
|---|---|---|---|---|---|
| today | | 50 | | 38.17 | |
| A1 | node order in cells, port order on faces | 43 | 43 | 33.90 | 0.8 s |
| A2 | A1 + frame and canton order | **42** | 42 | 33.81 | 8.5 s |
| A3 | A2 + lateral sides (ADR-0022 candidates) | 42 | 19 (CP-SAT), 42 (counting) | 33.81 | 412 s |

**Counting argument.** A complete bipartite K(m,n) between two rows keeps C(m,2) x C(n,2) crossings
under every order and every side choice. NTP holds a disjoint set of such blocks: K2,2 hubs, two K2,4
from `crt` to `srt`/`rrt`, and the MPLS fan. Their forced crossings sum to 42. So 42 is the proven
optimum for order and sides. Of the 42, 33 are solid. That equals the 33 visible solid crossings of
the reference.

**The 8 recoverable crossings.** Order and sides remove 8 of 50 (16 %). Salience drops 11 %.

- Gap 11/12, Location 4: 4 solid crossings. The child frame `loc4ntp` moves left of the cells of
  `loc4`. This is the only solid gain.
- Gap 7/8, MPLS fan: 4 routed crossings between dashed MPLS links (0.09 each). `crt001` stands before `crt002` in loc4, loc6 and loc7.

Two rules recover all 8 (section 6).

**Realizer gap.** We injected the A2 order through a scratch hook in `buildSkeletonGraph`. Two defects
showed:

- **Refused order pairs.** The realized A2 has 46 routed crossings, not 42. Four order pairs differ
  from A2: two group pairs and two node pairs. The pipeline has no input that pins port order. A1
  without the bypass gives 51: ELK keeps the old order in seven two-node rows.
- **Label-room crash.** Legal group orders crash stage 7: "A labelled link is shorter than the run its
  label reserved" (`link-191` needs 43.02 px and holds 38.87 px). The 46 comes from a build that
  skips this check (ticket 27).

Order fidelity today: 59 of 66 node pairs (89 %); group pairs 36 of 78; canton order ignored.

---

## 4. Representation result

The test isolates the NTP block: one K2,4 (`crt` to `srt`/`rrt`) and four K2,2, 24 links, drawn
with today's techniques.

| variant | crossings | bends | links visible one by one |
|---|---|---|---|
| v0 today (ranked) | 10 | 0 | yes |
| v1 bundle | 15 (2 touches) | 36 | partly |
| v4 group-link | 15 (2 touches) | 30 | partly |
| v8 outer side | 15 | 20 | yes |

The bound is 10: K2,4 forces 6 and each K2,2 forces 1. Today's render meets it with 0 bends.

**Conclusion.** No current link kind draws a complete block without crossings.

A hand drawer gets 0 with three things that the engine lacks (verdict of the K2,n test): (a) a routed
bus bar between the rows with one drop per node; (b) one link of each X drawn round the outside
through a reserved perimeter lane (v8 keeps it in the tier gap); (c) a group-link drawn as one line
with a count (v4 draws the members). The mockups below add mirrored hubs (mock C).

**Mockups.** We drew the Location 4 block (one K2,4, four K2,2) and a chain of two K2,2 pairs. Box =
nodes and links, engine units.

| style | crossings | bends | box w x h | PNG (in `mock/`) |
|---|---|---|---|---|
| D today (diagonals) | 10 | 0 | 369.5 x 344 | `D-today.png` |
| A bus bars, hops | 7 hops | 28 | 369.5 x 344 | `A-bus-bars.png` |
| B outer detour | 0 | 28 | 403.5 x 388 | `B-outer-detour.png` |
| C mirrored hubs | 0 | 26 | 349 x 443 | `C-mirrored-hubs.png` |
| P1 the X | 2 (71 deg) | 0 | 152 x 237 | `P1-x.png` |
| P2 bus | 2 (90 deg) | 8 | 152 x 237 | `P2-bus.png` |
| P2h bus with hops | 2 (90 deg) | 8 | 152 x 237 | `P2h-bus-hops.png` |
| P3 lateral, both in gap | 2 (90 deg) | 8 | 192 x 237 | `P3-lateral.png` |
| P3b lateral, one outer | 0 | 11 | 192 x 275 | `P3b-lateral-outer.png` |

With real uplinks, downlinks and faint overlays: C has 0 solid and 4 faint crossings
(`C-in-context.png`). P3b under two hubs has 1 solid (the hub X) and 4 faint, with 12 bends, box
328 x 390 (`P3b-under-hub.png`).

**User judgment of 2026-10-25 (U).**

1. Block. Shown D, A, B and C, the user said D and C are acceptable by situation, B sometimes, and A
   is unreadable.
2. Pairs. P1 and maybe P3b. The tiny buses (P2, P2h) and the lateral-in-gap version (P3) were
   unintelligible.
3. In context. Shown C and P3b with their real uplinks and downlinks, the user saw two defects. The
   uplink of the mirrored hub passes the block and reads as a second uplink of the other hub. The
   outer link climbs over both hubs. Final answer: **only D is ok.**

**Rule.** A complete block (K2,n between rank cells) is drawn as plain routed links with its X. It
gets no bus, no trunk, no hop mark and no planar detour. The 42 forced crossings stay.

---

## 5. Compactness

**Over bodies.** The variant `overlayOverBodies` changes overlay paths only. Node boxes, regions,
lanes, frames and canvas stay the same, so no gap shrinks. HEAD re-render of the sheet:

| metric | current | over bodies |
|---|---|---|
| solid x solid crossings | 50 | 50 |
| faint crossings (routed x overlay + overlay x overlay) | 82 + 204 | 49 + 205 |
| overlay bends | 306 | 282 |
| collinear overlaps, pairs (stored layouts) | 18 | 0 |
| body passes (overlay) | 0 | 13 |
| node-area share | 0.0799 | 0.0799 |
| canvas | 2153 x 2460 | 2153 x 2460 |

Overlay bends fall. The price is 13 body passes (PNGs in `compact/png/`).

The collinear-overlap row is the compact agent's count on the stored layouts (`examples/review/ntp/`), not on HEAD. On the HEAD re-render the same counter finds 0 pairs in both columns. The two HEAD controls differ by build. The compact re-render (`compact/render/current.yaml`) gives 82 + 204 faint crossings and 306 overlay bends. The sweep worktree, built at `33c62c16` on `inject/ntp.yaml`, gives 56 / 281, 310 bends and 11 collinear pairs. Both builds are counted by `measure.py` through the patched converter `from_portograph.py`, which accepts a layout without `meshBuses` or `class`. The cause of the difference is not isolated. The two YAML files differ in canton labels.

**Whitespace accounting** (stored layout; content box 2038 x 2378; nodes 7.8 % of it):

- Height: tier rows 1337 px (56 %), tier gaps 999 px (42 %), legend 42 px.
- Gaps: 16 gaps between 17 tiers; 13 are exactly 60 px. The five largest:

| gap | h (px) | reserved |
|---|---|---|
| tier 7/8 | 78.8 | 5 routed tracks (need about 69), 2 risers |
| tier 11/12 | 74.0 | mesh-bus band 34, 1 riser, 0 tracks |
| tier 3/4 | 66.5 | mesh-bus band 26.5, 1 riser, 0 tracks |
| tier 6/7 | 60 | 3 tracks, 2 risers |
| tier 5/6 | 60 | 0 tracks, 2 risers |

- Width, widest tier (12): column gaps 906 of 1918 px (47 %).
- Group padding: 46 % of group area (316k of 694k px², 55 groups). Top-level frames: 87 % not node.

**Estimate.** Row pitch 11.5 px; gap floor (routed tracks + 1) x pitch, at least 23 px. Only gaps 7/8 (69) and 6/7 (46) need more than 23 px. The gaps fall from 999 to 437 px. Height falls from 2274 to
1712 px. Node-area share rises from 0.083 to about 0.11, against 0.168 in the reference. A 40 px
floor for titles and frame edges gives about 0.097.

**Decisions of 2026-10-25 (U).**

- An overlay may pass over a body only when no other way exists (D13). It is a last resort, not a free
  choice. This amends D6. The cost threshold that picks the last resort is an open question (ticket 28).
- The MPLS fan links should be straight lines, not orthogonal (D14). See the sweep below.
- A sweep of the gap floor, the column slack and the frame padding is approved (D15).
- Bends outrank canvas: the 24 px gap render lost to today's render by eye (D16).

### Sweep (2026-10-25)

**Constants:**

| name | file:line | value |
|---|---|---|
| tier gap floor `SKELETON_SPACING.tierGap` | `src/layout/skeleton-graph.ts:8` | 60 (hard floor 21.5) |
| `nodeClearance`; skeleton padding | `src/layout/skeleton-graph.ts:8` | 20; 12 |
| `COLUMN_SLACK` | `src/layout/columns.ts:27` | 20 |
| `GROUP_PADDING` | `src/layout/regions.ts:12` | 20 |
| `laneWidth` | `src/layout/lanes.ts:75` | max(34, pill + 10, 20 + strokes) |
| `RING_PITCH`; `EDGE_MARGIN` | `src/layout/course-rows.ts:16`; `:18` | 11.5; 10.75 |
| bundle `MEMBER_GAP` | `src/layout/bundle-geometry.ts:15` | 16 |
| `LATERAL_PITCH` | `src/layout/side-measure.ts:27` | 12 |
| `GROUP_EDGE_LINK_CLEARANCE` | `src/theme/geometry.ts:67` | 10 |

**MPLS straight.**

- `route: straight` on all 14 MPLS links is accepted, but 11 links stay orthogonal. They are refused
  by `ROUTED_CHORD_REFUSED`: 9 edge, 1 leg, 1 body. The result equals the control.
- `route: overlay` breaks the sheet: 245 routed crossings, 6 removed links, canvas 8686 x 1891.
- A schema value does not give diagonal lines. The chord refusal rule must admit them.

**Sweep.** Label hits, removed links and body passes are 0 in every row. RxR = routed x routed. Faint = RxO / OxO.
Bends = routed / overlay.

| run | RxR | faint | bends | canvas | share | gates | notes |
|---|---|---|---|---|---|---|---|
| control (60, 20, 20) | 50 | 56/281 | 22/310 | 2153x2460 | 0.0799 | 9/9 | Q 0.8117 |
| gap 40 | 50 | 47/291 | 66/316 | 2096x2307 | 0.0833 | 9/9 | PLACEMENT_NON_CONVERGENCE |
| gap 30 | 50 | 52/267 | 70/312 | 2020x2282 | 0.0863 | 9/9 | same |
| gap 24 | 50 | 52/288 | 76/310 | 1983x2222 | 0.0912 | 9/9 | same, Q 0.7945 |
| slack 10 | 50 | 56/281 | 22/310 | 2151x2460 | 0.0797 | 9/9 | no effect |
| slack 0 | 49 | 56/291 | 28/310 | 2134x2479 | 0.0794 | 9/9 | wider |
| padding 10 | 50 | 65/274 | 22/320 | 1988x2318 | 0.0871 | 8/9, G6 | exit 1 |
| padding 15 | - | - | - | - | - | - | PIPELINE_FAILED: link-155 label run 3.8 of 43 px |
| gap 24 + slack 0 | 49 | 53/290 | 80/310 | 1994x2245 | 0.0897 | 9/9 | |
| gap 30 + slack 0 | 50 | 63/271 | 72/312 | 2018x2282 | 0.0870 | 8/9, G6 | exit 1 |

**Reading.**

- The tier gap floor is the one lever. From 60 to 24, the canvas shrinks 8 % x 10 % and the share
  rises from 0.080 to 0.091. Crossings, labels and gates hold.
- The cost: routed bends rise from 22 to 76, and every gap value gives PLACEMENT_NON_CONVERGENCE.
- Column slack does nothing. Group padding is blocked by G6 (10) and by a label run (15).

Tickets 29 (hub fan links straight on request) and 30 (tier gap height from reservations, bends
held) follow from this sweep.

---

## 6. Conclusion

**Crossings on this corpus are structural, and we accept them.** The proven optimum for order and
sides is 42 against 50. The 42 come from complete blocks. The user chose plain links with an X for
these blocks (section 4).

**An optimizer stage that replaces stages 4 and 5 is not justified.** Order is worth 8 crossings
(16 %). Two rules recover them:

1. Child frames and cells follow the order of their feeds (ticket 25, 4 solid crossings).
2. Port order and cell order in a fan follow the order of the far ends (ticket 26, 4 routed
   crossings between dashed links).

Ticket 27 is the stage-7 crash on a legal group order, found on the way. Fix it first.

**Compactness lives in the tier-gap height.** Column slack does nothing, and frame padding is blocked
by G6 and a label run (section 5). Compactness needs per-gap reservation heights, not a lower
constant, because the constant buys area with bends.

**Salience.** Two findings support weighting by salience: a larger crossing angle helps (Huang,
Eades, Hong 2014), and a higher edge opacity on the crossing edges slows readers (Misue, Wang 2026).
Both are verified. Rules on weight, dash or hop marks are design choices.

**Keep as a measuring stick** for future tickets: the lexicographic objective of D4. Level 1 is
solid x solid crossings, strict. Level 2 is the weighted sum of faint crossings, faint body passes,
bends and compactness, with node-area share as the compactness term.

**Keep as a tool**: the CP-SAT surrogate and ceiling scripts. They answer "is this crossing
avoidable?".

---

## 7. Literature

(A, B) = both research reports cite the item. (A) = one report only; not cross-checked.

1. *2-Layer Straightline Crossing Minimization.* Jünger, Mutzel. 1997, JGAA.
   https://doi.org/10.7155/jgaa.00001. Pair-order Booleans; exact limits. (A, B)
2. *Optimal k-Level Planarization and Crossing Minimization.* Gange, Stuckey, Marriott. GD 2010.
   https://doi.org/10.1007/978-3-642-18469-7_22. Crossings plus removed edges, like our stub. (A)
3. *Using Sifting for k-Layer Straightline Crossing Minimization.* Matuszewski, Schönfeld, Molitor.
   GD 1999. https://doi.org/10.1007/3-540-46648-7_22. The move of the local search. (A, B)
4. *Global k-Level Crossing Reduction.* Bachmaier, Brandenburg, Brunner, Hübner. 2011, JGAA.
   https://doi.org/10.7155/jgaa.00242. Sift a frame as one block. (A)
5. *Drawing Layered Graphs with Port Constraints.* Schulze, Spönemann, von Hanxleden. 2014, JVLC.
   https://doi.org/10.1016/j.jvlc.2013.11.005. Crossing count with ports. (A, B)
6. *Layered Drawing of Undirected Graphs with Generalized Port Constraints.* Walter, Zink,
   Baumeister, Wolff. GD 2020. https://arxiv.org/abs/2008.10583. The nearest problem to ours. (A)
7. *Crossing Minimization in Weighted Bipartite Graphs.* Çakıroğlu, Erten, Karataş, Sözdinler. 2009,
   J. Discrete Algorithms. https://doi.org/10.1016/j.jda.2008.08.003. The w_e x w_f cost of D5. (A)
8. *Fast and Simple Horizontal Coordinate Assignment.* Brandes, Köpf. GD 2001.
   https://doi.org/10.1007/3-540-45848-4_3. Erratum: https://arxiv.org/abs/2008.01252. The realizer.
   (A, B)
9. *Orthogonal Hypergraph Drawing for Improved Visibility.* Eschbach, Günther, Becker. 2006, JGAA.
   https://doi.org/10.7155/jgaa.00122. Track assignment for a bus bar. (A)
10. *Improving Layered Graph Layouts with Edge Bundling.* Pupyrev, Nachmanson, Kaufmann. GD 2010.
    https://doi.org/10.1007/978-3-642-18469-7_30. Member order in a bundle. (A, B)
11. *Which Aesthetic Has the Greatest Effect on Human Understanding?* Purchase. GD 1997.
    https://doi.org/10.1007/3-540-63938-1_67. Crossings first, in that experiment. (A, B)
12. *Rank Analysis of Incomplete Block Designs.* Bradley, Terry. 1952, Biometrika.
    https://doi.org/10.1093/biomet/39.3-4.324. The pick model of D11. Also Mchedlidze, Pak, Klammler,
    2019, JGAA, https://doi.org/10.7155/jgaa.00501. (A, B)

Verified items (source: `/tmp/arch/optimizer-research/angle-literature.md`):

13. *Larger crossing angles make graphs easier to read.* Huang, Eades, Hong. 2014, JVLC 25(4).
    https://doi.org/10.1016/j.jvlc.2014.03.001. Two studies (22 and 37 subjects). The smallest
    crossing angle on a path predicts performance best. The "70 degrees" figure is unverified.
14. *Empirical evaluation of aesthetics-based graph layout.* Purchase, Carrington, Allder. 2002,
    Empirical Software Engineering 7. https://doi.org/10.1023/A:1016344215610. The domain decides
    which aesthetics matter. The 1997 ranking may not carry over.
15. *Cognitive measurements of graph aesthetics.* Ware, Purchase, Colpoys, McGill. 2002, Information
    Visualization 1(2). https://doi.org/10.1057/palgrave.ivs.9500013. After path length, poor
    continuity and crossings cost most.
16. *Impact of Edge Opacity on Readability in Node-Link Diagrams.* Misue, Wang. 2026, IEEE TVCG 32(10).
    https://doi.org/10.1109/TVCG.2026.3716603. 32 participants. Higher opacity on crossing edges
    slowed readers; on focus edges it sped them. Opacity only.

No study supports the 0.3 salience, the product law or the stub price. No
controlled study covers line weight, dash or hop marks.

---

## 8. Artifacts

All paths are under `/tmp/arch/optimizer-research/`. They are not in the repo.

- Brief and research: `brief.md`, `claude-research.md`, `codex-research.md`, `merged.md`,
  `angle-literature.md`.
- Baseline: `baseline/`. Ceiling: `proto/`. Injection: `inject/`. K2,n variants: `k2n/`. Previews:
  `baseline/previews/`, `inject/png/`.
- Mockups: `mock/`. Compactness: `compact/`. Sweep: `sweep/` (`REPORT.md`, `png/`, run data).
