# Quality — gates, score, and what "beautiful" means

Revision 2 (2026-09-10) after the codex design review: gates now name the object pairs they
apply to and their ownership exceptions; every metric has a finite formula and an empty-set
value; thresholds are split into **assertions** (tests fail) and **advisories** (reported).

`portograph score <layout.json>` computes everything below from the layout JSON, never from
SVG. The JSON carries, per element, its geometry, its owner, and a `layer`
(`routed` | `overlay`); runtime statistics (timings) are in a separate block excluded from
snapshots.

---

## Geometry vocabulary used by the gates

- A **port anchor** is the point on the node boundary where a link attaches. A **pill** is the
  rendered port rectangle centred on the anchor, straddling the boundary. Links start at the
  anchor; G7 checks anchors, not pills.
- A **stem** is the first/last segment of a routed link, from the anchor outward, perpendicular
  to the side, ≥ 15 px.
- **Owner** relations: a node owns its labels and pills; a group owns its label and its nodes; a
  link owns its label and its stems; a bundle owns its members' parallel runs and its counted
  merge trunks, including each trunk's **multiplicity label**; a bar owns the drops that cross it
  to reach a lower bar. Owning a link does not exempt a label from that link's other segments: a
  visible link label names its one supporting segment and nothing else.

## Hard gates

A failed gate fails the diagram (subject to the size table below). Overlay-layer elements are
out of scope for G2, G4 and G6.

| # | Gate | Applies to | Exceptions (by ownership) |
|---|---|---|---|
| G1 | **No node overlap; containment** | node–node rectangles; node inside its group box; group boxes inside their tier band; no group–group overlap | — |
| G2 | **No routed segment through a foreign node or group** | routed segments × node rectangles; routed segments × group boxes the link does not attach inside (ADR-0013) | a segment's own endpoint nodes; a drop crossing a **bar** it does not terminate on (`barCross`, reported); a link owning a lane in the group's margin or crossing a declared bar of the group |
| G3 | **No label collision** | every label bbox × every other label bbox, node rectangle, pill, routed segment (area-aware); a **group title** also owns an 8 px link-free margin no routed segment may enter | a label vs its **owner** (node label inside its node; pill text inside its own pill and over its own incident stem within that pill; a link label on the clearance zone — never the body — of the **one** segment its persisted `support` reference names, and only when that reference's link is its own owner); overlay layer |
| G4 | **No collinear overlap** | pairs of routed segments on the same line sharing > 1 px | validated counted merge runs of selected bundle members (reported as `bundledLength`); exact source/target shared-run trees at one port; lane-owner runs vs their own lane |
| G5 | **Ports exit correctly** | every routed link: first/last segment perpendicular to its side, ≥ 15 px; every other segment axis-aligned unless it is a declared **straight bundle member** (`straight: true`, ADR-0017); port order on a side matches far-end order | author `order:`; overlay; stub |
| G6 | **Clearances** (stroke-aware, centre-to-centre minus half strokes) | node–node ≥ 20; routed segment–foreign node ≥ 10; parallel routed segments ≥ 10; a routed segment on or outside a group box runs no closer than 10 px beyond its half stroke parallel to its edge (ADR-0013) | incident node–segment contact at the anchor; bundle members (`memberGap` = 16 applies); `barCross` contacts; junction fans |
| G7 | **Attachment** | every link endpoint = a port anchor; every anchor on its node's boundary | — |
| G8 | **Tier contract** | every group's box within its tier's band; tier bands in order, non-overlapping | — |
| G9 | **Frame contains** | every frame contains its cells and child frames; frames of one tier do not overlap; no foreign node body lies inside a frame | — |

Why G4 exists: the prototype's crossing counter used an intersection test that returns *false for
parallel segments*; overlaps were invisible until asked for. Overlap is computed by bucketing
axis-aligned segments by line and sweeping intervals. The sweep is O(S log S + K) when reporting
K overlapping pairs; it never scans every unrelated segment pair. Dense overlaps can require
quadratic output, so the reporting cost cannot be bounded by O(S log S) alone.

## Soft score

`Q = Σ wᵢ · clamp(Mᵢ, 0, 1) / Σ wᵢ` over the eight scored metrics. Their existing raw weights
sum to 0.95; normalising by that total preserves their relative importance. Each `Mᵢ` is defined
for every diagram, including empty ones (value 1 where the metric has no subject). Symmetry is
reported separately and does not contribute to either sum.

| Metric | Formula | Empty-set value | Weight |
|---|---|---|---|
| Crossings | `1 − min(1, c / m)`; `c` = crossings outside bundles, `m` = routed links | 1 | 0.30 |
| Bends | `1 − min(1, mean bends per routed link / 3)` | 1 | 0.15 |
| Path continuity | fraction of drawn routed links whose consecutive turns alternate direction (no U-turns); a one-segment link counts as continuous | 1 | 0.10 |
| Compactness | `Σ node area / bbox area`, computed globally and per group, reported both, scored as the mean | 1 | 0.10 |
| Grid alignment | fraction of nodes whose top **or** left edge shares a coordinate (±1 px) with ≥ 2 other nodes | 1 | 0.10 |
| Flow consistency | fraction of routed *vertical* segments whose direction (source→target) is downward when the target tier is lower | 1 | 0.10 |
| Aspect ratio | `min(w, h) / max(w, h)` of the bounding box of nodes, paths and visible labels, excluding the generated legend | 1 | 0.05 |
| Segment uniformity | `max(0, 1 − std / mean)` of routed segment lengths | 1 | 0.05 |
| Symmetry | reported only: fraction of nodes with a mirror partner about the bbox's vertical axis (±4 px) | — | — |

Use raw `c/m` in assertions, never the Purchase-normalised form (it saturates near 1 for every
non-random layout).

Also reported: `overlaps`, `bundledLength`, `barCross`, `labelHits`, `labelsOmitted`, `stubs`, `removedLinks`,
`groupLinks`, `lanesUsed`, `inversions`, `fallbackUsed`, `deadlineHit`, canvas size, and (outside
the snapshot block) layout time per stage.

`counts` gives the raw counts of each link family, beside Q and outside it (Q reads only the routed
layer). For `routed` and for `overlay`: `links`, `bent` (links with a turn) and `turns`, and the
`crossings`. The routed `crossings` is the count that Q uses. The overlay `crossings` has one number
per named mode of `src/layout/read/crossings.ts`, kept apart: `pairs` (path pairs that cross) and
`points` (crossing points). The overlay family is the attached overlay links that are no mesh-bus
member, as `read()` in `src/layout/objective.ts` reads them. Mesh-bus overlay links are counted apart
in `overlay.meshBusLinks` and in no other overlay number.

`removedLinks` counts the links stage 8 removed because it could not use them
(`ROUTE_CHECKPOINT_SKIPPED`, `ROUTE_GAP_REJECTED`). The layout JSON lists them in `removedLinks`. A
removed link has no path, no label, and no place in the score or the gates. It is not a gate
failure, so the count is the only signal. Read it on every render.

## Thresholds — assertions vs advisories

| Metric | ≤ 30 nodes | ≤ 100 nodes | Kind |
|---|---|---|---|
| Gates G1–G9 | pass | pass (G3 warning-only above 300) | **assertion** |
| Crossings outside bundles, M1 golden | **= 0** | — | **assertion** (supersedes the "≤ 2" in the decisions log) |
| `c / m` | ≤ 0.05 | ≤ 0.15 | advisory |
| Mean bends | ≤ 1.0, max 3 | ≤ 1.5 | advisory |
| Continuity | ≥ 0.7 | ≥ 0.6 | advisory |
| Compactness | ≥ 0.25 | ≥ 0.2 | advisory |
| Grid alignment | ≥ 0.6 | ≥ 0.5 | advisory |
| Flow | ≥ 0.8 | ≥ 0.7 | advisory |
| Aspect | ≥ 0.5 | ≥ 0.4 | advisory (the prototype measured 0.496; the JPEG golden baseline is pending) |
| `Q` vs approved baseline | ± 0.05 | ± 0.05 | **assertion** |

## Size bands: gate enforcement and time

The whole-command deadline is 60 s (`COMMAND_DEADLINE_MS` in `src/cli.ts`); it was 30 s until Q109a
(ticket 137). The band claim below moved separately. Three generated workloads, measured 2026-09-15 on the maintainer's machine:

| Nodes | Links | Shape | Time | Measured outcome |
|---|---|---|---|---|
| 120 | 200 | tiers × fan-out | 4.0 s | publishes, 989 draw.io cells |
| 300 | 810 | tiers × fan-out | **51 s** | publishes, 3,363 draw.io cells |
| 100 | 389 | degree-64 hub, wide tier, transit | 30.0 s | takes the deadline path, no artifact |

Evidence: `.scratch/stress/spec.md` for the first two rows, ticket 17 for the third. The first two
are pipeline times measured with the deadline out of the way: the layout is produced, and the row
says what it produced. Under the 60 s default command the 51 s row fits, with 9 s to spare on that machine; under the old
30 s deadline it was a failure, and the CLI ended the run and wrote nothing. The third row was measured under the deadline and reached
it.

So node count alone does not decide the time; link count and degree decide it beside the node
count. 100 is a **policy choice, not a measured ceiling**: it is where the threshold table above
stops scoring, and the nearest measurements do not contradict it — 120 nodes at 4.0 s is inside the
deadline, and the only measurement that failed at 100 nodes is the degree-64 hub.

| Nodes | G1 G2 G4 G5 G6 G7 G8 G9 | G3 | Whole-command time |
|---|---|---|---|
| ≤ 100 | enforced | enforced | the claimed band; a dense shape can still reach the deadline |
| 101–300 | enforced | enforced | not bounded — `--force` territory |
| 301–1,000 | enforced | warning | not bounded — `--force` territory |
| > 1,000 | `--force` only | warning | not bounded |

The supported band ends at 100 nodes, where it was 300 before. `--force` itself is only required
above 1,000 nodes (`src/parse/index.ts`, ADR-0006); between 101 and 1,000 nodes nothing refuses the
command, the time is simply not a promise.

## Test design

- **Fixtures first**: ticket 00 owns the approved golden YAML, its hand-written expected model,
  and the 14 rule counter-examples. The ticket that owns a parser diagnostic, API probe, router
  remainder, gate pair or scale generator also owns that test-only input; these do not alter or
  reopen the approved golden.
- **Golden tests**: `render` reviewed once by the maintainer; thereafter the layout JSON is an
  **exact snapshot** (runtime block excluded). Determinism is not required but is free.
- **Gate tests**: every golden passes G1–G9.
- **Score tests**: before golden approval, record a candidate `Q`; after ticket 18 approves it,
  assert `Q` within ± 0.05 of that value. Crossings-outside-bundles may only go down without a
  waiver. A nonempty zero-link diagram gives value 1 only to metrics whose subject is routed
  links and must produce a finite node-aware `Q`; a truly empty geometry has `Q = 1`.
- **Rule unit tests** — the codex counter-examples as fixtures: flank facing two peers; flank
  with unequal pitch on the two sides; many links sharing one peer port; same-tier nodes stacked
  at one x; a parent port feeding two children; three stacked bars; a bar fed from both sides;
  sources 1 px apart on a bar; a bundle with author-`order:` reversed ends (inversions = 3);
  both margins occupied; a group label with no free gap; a link label that fits nowhere; a
  node with no ports and a long label; a zero-link diagram.
- **Tier and flank ties**: mixed inferred-top plus explicit tier 0; sparse explicit tiers; and a
  4–4 primary-peer tie resolved toward the flank-facing outer peer, then node id.
- **API probes** (before ticket 06/13): `partitioning.activate`, `semiInteractive` + `position`,
  `nodeSize.constraints/minimum`, `shapeCoords=ROOT`; libavoid `setExclusive(false)`,
  `JunctionRef`, pin on boundary → stem length.
- **Scale tests**: the **full pipeline** at 100 / 300 / 1,000 synthetic nodes with a hub (degree
  64), a wide tier (40 nodes), and long transit links; fallback exercised by **injected failure**
  and by deadline, not by relying on a particular ELK crash.
- **Review**: codex on every ticket's diff; agy on every golden render against the checklist.

## The checklist (the spec half of Q7)

1. Hierarchy reads top-to-bottom; providers/external at the top, backbone/core at the bottom.
2. Segments all horizontal or all vertical within a tier; mixed only to flag a special segment.
3. Ports leave perpendicular; parallel links bundled or evenly spaced.
4. Redundant pairs sit side by side.
5. Every group is labelled; labels never sit on links.
6. Colour encodes role or link property; the diagram survives removal of colour.
7. Link property encoded consistently: weight = speed, style = class.
8. No crossing that a topology rewrite could avoid — bar, stub, duplicated cloud.
9. Whitespace is even; object : gutter ≈ 60 : 40.
10. A legend exists when more than one symbol or line style is used — generated, not authored. A
    port role (a pill painted to mean something) needs one as soon as any other variant — a second
    role, a node class or a line style — is drawn beside it. It is measured in stage 9 and
    placed in reserved canvas space below the drawn diagram, lists exactly the classes and port
    roles present, and is excluded from the scored bounding box: its size follows the class set,
    not the quality of the layout.
11. No link is removed. `removedLinks` is 0, or each removed link is named in the diagnostics with its
    reason. A drawing that lacks a link the input declares is not a correct drawing.
    A part of a tier gap the plan declines is not a removal: it is named `TIER_GAP_PART_RESIDUAL` (or
    `TIER_GAP_ROW_CYCLE`) and published with its gate findings, a G6 pair at worst (ADR-0021).
12. A routed link inside one frame (including a group-link member) is one straight segment where
    its chord clears every body. It is orthogonal only where a body stands on the chord.

A **straight bundle member** is the single diagonal between the two stems of a heavily inverted
bundle (ADR-0017: more inversions than half the members, or a staircase more than half as long again
as the straight members, and only when the existing geometry holds the member gap between every pair of member segments G6 would measure, stems included). It carries `straight: true`, which G5 accepts only on a member of a bundle that owns the
segment, and only one per member — a second is a staircase of its own. G4 indexes such a segment — before the axis buckets, whatever its angle — on a uniform grid over the
cells its run crosses and their neighbours, so an overlap longer than 1 px always shares a cell, and
measures that overlap along the run. An ordinary run joins that grid too, in the cells a declared
member already holds, because a declared member can also lie on an ordinary run's line; two ordinary
runs are judged on their own axis, keyed by the EPS the collinearity predicate uses and swept in
span order against the two neighbouring keys as well, since collinearity within a tolerance is not
transitive. A run too long to walk
cell by cell is compared with the declared members directly. G5 reads `straight: true` whatever the segment's angle, so an axis-aligned segment cannot
carry the marker without an owning bundle; G6 measures its clearance to any segment it does not strictly cross, at the bundle member gap
between two members. Each pair of members still crosses exactly once per endpoint inversion, counted by the same
strict intersection test. A label on such a member takes the run's own heading (ADR-0014 rule 1) and
is offset so its stored box clears the run.

Bundle member gap means visible clearance between strokes. The regular minimum centreline pitch
is 16 px plus the maximum member stroke. Crossovers may need wider tracks. An envelope owner does
not exempt arbitrary parallel overlap: a counted merge run must have exact selected membership,
actual geometry and matching count. Shared endpoint ties contribute no strict inversions; engine
port precedence applies only between strictly separated far-peer coordinate ranges. Unequal
authored order keys remain independently enforced. Shared-run and local fan exemptions are
symmetric for source, target and mixed incidence, and require validated tree traversal.
