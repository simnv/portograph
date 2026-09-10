# Pipeline

Revision 2 (2026-09-10), after the codex design review (`docs/research/codex-design-review.md`).
The first revision generalised the prototype's passes on paper; this one fixes the ordering
errors that review found: semantic decisions were made after geometry was claimed, sides were
finalised after fixed paths existed, and bar spans were computed before the ports they depend on
had moved.

```
0 parse → 1 resolve → 2 sides₁ → 3 size → 4 skeleton → 5 sides₂ → 6 rows
→ 7 regions (lanes → flanks → centre → bars → bundles → bands) → 8 route → 9 link labels
→ 10 validate → 11 emit
```

Every stage reads and writes the **layout model** (`LayoutModel`, serialisable as the layout JSON
that `render` and `score` consume). No stage touches the DOM.

Three principles, each learned the hard way:

1. **Decide meaning before geometry.** Which technique a link gets (override, aggregation,
   overlay, bundle membership) is decided in stage 1 from the document alone. Only *geometry-
   dependent* choices (straight eligibility, stub) wait for a trial route.
2. **Reserve space before using it.** Lanes, bands, bar spans and bundle rows are allocated while
   placing, never discovered while routing.
3. **Freeze before pinning.** No fixed path is created until every node's sides, size and row
   position are final (stage 5/6). Anything a later stage moves must be re-validated; the
   invalidation rules are listed per stage.

---

## Stage 0 — parse

YAML → validated document (`schema.md`). Diagnostics are staged: **parse-time** (references,
structure, identifiers), **model-time** (after normalisation: tier inference, families,
port allocation), **placement-time** (capacity, facing ports — see stage 7b) and **final-geometry**
(gates). A diagnostic is never emitted before its inputs exist.

## Stage 1 — resolve techniques (semantic)

For every link, in this fixed order, from the document only:

1. **Author `route:`** — taken as given (validated: `merge` needs ≥ 2 members; `group-link`
   needs group endpoints).
2. **Aggregation** — a set of links forms a group-link only if: both endpoint groups have ≥ 2
   nodes, the links are the **complete** bipartite set between them, all share one class and
   family, and none carries an override. Membership (every member link, its ports, class) is
   retained in the model and rendered as a tooltip/legend entry, never discarded.
3. **Family** — from class via the profile: `routed` or `overlay`.
4. **Bundle membership** — ≥ 2 routed links between the same node pair (ports may differ).
5. **Stub** — deferred: needs a trial route (stage 8 marks candidates; stage 9 applies).

**M1 behaviour:** `stub` and `group-link` are parsed and recorded but not applied; a warning
says so and the links are drawn routed. This is explicit, not silent.

## Stage 2 — sides, phase one

| Peer is in… | Side |
|---|---|
| a lower tier, or a `bar` group below | `bottom` |
| a higher tier | `top` |
| a flank on the left / right of this node's tier | `left` / `right` |
| this flank's `of` group, with this flank aligned left / right | `right` / `left` |
| the same tier | **undecided** until stage 5 |

Author `side:` on a port always wins. A port with **several peers in different directions** takes
the side of the majority by link count, ties broken toward `bottom` then `right`; the other links
leave through that side and route. An **unused port** takes the side with the fewest ports
(ties: `bottom`) and renders last on it.

## Stage 3 — size

Per node, per side: `pitch(side) = max(12, widest pill on that side + 4)`, where pill width is
measured text (font-metrics table) + 2×3 padding, rotated 90° for left/right. Then
`height = max(minH, contentH, n_left|right × pitch + 2·pad)`, `width = max(minW, contentW,
n_top|bottom × pitch + 2·pad)`, `contentW/H` from the measured label, description and icon.
Author `size:` is a floor. Undecided ports count on their most likely side. Bars are sized in 7d.

## Stage 4 — skeleton (ELK)

One `elkjs` `layered` run. Options set explicitly (all verified to exist, 2026-09-10):

| Option | Value | Why |
|---|---|---|
| `elk.algorithm` | `layered` | |
| `elk.direction` | `DOWN` | |
| `elk.hierarchyHandling` | `INCLUDE_CHILDREN` | groups as compound nodes, one run |
| `elk.partitioning.activate` | `true` | tiers — must be activated, not just assigned |
| `elk.partitioning.partition` | `= tier` on each group | |
| `elk.portConstraints` | `FIXED_SIDE` | phase-one sides |
| `elk.nodeSize.constraints` | `MINIMUM_SIZE` + `PORTS` | stage-3 size is a floor ELK may grow |
| `elk.nodeSize.minimum` | stage-3 size | |
| `elk.layered.crossingMinimization.semiInteractive` | `true` | **the** mechanism that preserves in-layer order — used to pin a flank's primary peer to the outer end via `elk.position` x on the row's nodes (`considerModelOrder` is only a soft preference and does not pin) |
| `elk.json.shapeCoords` / `edgeCoords` | `ROOT` | absolute coordinates; no compound-relative conversion in our code |
| `elk.randomSeed` | `1` | default; kept explicit |

**Lateral links (flank↔tier) are withheld** from the ELK graph. Flank groups are placed after ELK
by rule: beside their `of:` tier, on their `align` side, top-aligned with the tier band.

**Time and failure:** ELK runs in a worker with a deadline (`layoutBudgetMs`, default 10 s at
≤ 300 nodes, 20 s above). On exception **or deadline**, terminate the worker and run the
fallback: one ELK run per tier band without partitioning, bands stacked in tier order with the
standard gap. The prototype recorded a 33 s *failing* run at 1,000 nodes — waiting for the
exception is not acceptable. After either path, **validate**: every group inside its tier band,
no group overlap; violation → fallback (if not already) → hard failure.

Output: absolute group boxes, node positions, in-row order.

## Stage 5 — sides, phase two; resize; repack

Immediately after the skeleton, before anything is pinned. Undecided ports take `left`/`right`
from the in-row order. Nodes are **re-sized** (stage 3 formula) if a side gained ports. Each row is
then **repacked horizontally** in ELK's order with the standard node gap, and group boxes
recomputed. Every side's port order is finalised by far-end x (for top/bottom) or y (left/right);
author `order:` wins.

From here on sides, sizes and port counts are **frozen**. Later stages move nodes and ports but
never change what a node is.

## Stage 6 — rows

Per tier: all `row`-shape nodes share one top y. Repack horizontally again if the flattening
created overlap (nodes ELK stacked at one x). For each same-tier pair with facing east/west
ports: level the facing ports (move the ports on the node with fewer on that side) and, if
nothing lies between, **pin** the link as a straight horizontal.

**Invalidation:** row alignment runs before any fixed path exists, so nothing needs re-checking.

## Stage 7 — regions

A **region** is the space between adjacent tiers, or between a flank and its tier. Sub-stages
run in this order because each reserves space the next respects. Each sub-stage lists what it
may move and what it must therefore re-validate.

### 7a — lanes (owned)

For every link whose path must transit a tier it does not terminate in: reserve a **lane** —
a vertical corridor of width `laneW = pillW + gap` — in the margin of the intermediate group on
the side nearer the source x. Lanes have an **owner** (the link) and a **segment** (the vertical
run); the owner's route through the lane is fixed here; the lane is an obstacle to every *other*
link. Capacity: the margin between the intermediate group and its neighbour in that tier (or a
flank) holds ⌊margin / laneW⌋ lanes; overflow widens the tier gap and the canvas (canvas is never
fixed). A link transiting several tiers reserves a lane at each. Lanes are allocated on the
source node's outermost slots of the departing side so the run is an in-span vertical. *Moves:*
group boxes, canvas. *Re-validate:* nothing yet pinned except row links — recheck them.

### 7b — flank align

For each flank: primary peer = the tier node with the most links to it; the peer must be a node
of the flank's `of:` tier and sits at the tier's outer end (stage 4). Consider only **distinct
port pairs** (a shared peer port counts once); compute the translation that levels the first
pair; a pair is *compatible* if the same translation levels it within 0.5 px — this holds when
both sides use the same pitch, so before comparing, **respace both facing sides to the larger of
their two pitches** (stage 3 formula re-run for those two sides only; sizes may grow; nothing is
pinned yet on those nodes). Shift the flank vertically by the translation; pin every compatible
pair as a straight horizontal; route the rest. Links from the flank to other nodes route normally.
*Placement-time diagnostic:* flank has more distinct links to the peer than the peer has facing
ports → warning, extra links route. *Moves:* the flank, two nodes' sizes. *Re-validate:* row
links on the peer.

### 7c — child under parents

Anchor tier = the tier with the most nodes (ties: lowest tier index). Below the anchor, each
group is centred under its feeds; above it, each group is centred over its children (mirror).
For a child group G fed from tier T−1: the **feed set** is the parents' bottom ports whose peer
is in G. **Parents are authoritative:** parent port x is fixed by stage 5/7a; G is centred
horizontally under the barycentre of the feed set within the space between the lanes (7a) and
neighbouring groups; then each child port x := its parent port x. A child port's x is feasible
only if the child node can be widened to contain it without overlapping a sibling; if not, the
link keeps one bend and is reported. A parent port feeding **two** children cannot be vertical to
both: the first (by child x) is vertical, the rest fan through a shared stem (7e semantics).
Iterate child-widening → sibling push → re-centre at most 8 times, ε = 0.5 px; on non-convergence
keep the last state and report. *Moves:* child groups, child widths. *Re-validate:* lanes (7a
positions are fixed; if a child now overlaps a lane, push the child, not the lane).

### 7d — bars

For each `bar` group, after 7c so all source ports are final: each node is a horizontal bar;
stack order = declaration order, top to bottom. Bar port x := source port x, ordered by x; where
two sources are closer than `pitch`, the later drop fans horizontally to the next free slot
(a 2-bend jog) and is reported. Bar span = [min port x − 30, max port x + 30], floor = label + 60;
spans of stacked bars are merged to their union transitively when any pair overlaps by > 50 % of
the narrower; a bar with no ports spans the group's label only. A drop to a lower bar crosses the
upper bar (`barCross`); a link entering a bar from **below** is the mirror case and also counted.
Drops are **pinned**. *Moves:* nothing outside the bar group (the group box shrinks to the bars).

### 7e — bundles

For each bundle (stage 1): reserve `n × memberGap` rows in the tier gap on the exit side of the
lower node (`memberGap` = 16 px; distinct from `laneW`), widening the gap. Route one centreline
with the **bundle envelope** (`n × memberGap` wide) as its width — so offsets cannot hit
obstacles — then offset members. Member order at each end is the port order; the number of
unavoidable crossings inside the channel equals the **inversion count** of the permutation
between the two ends. Engine-ordered ports are reordered to make it zero; author-`order:`ed ports
keep their inversions, each drawn as one explicit crossing and reported. Members are **pinned**.
A **shared stem** (several links leaving one port) is a `JunctionRef` in libavoid terms: one stem
of ≥ 15 px then a fan; the stem is exempt from the overlap gate.

### 7f — group label bands

For every group: band height = label height + 8, inside the top padding; label at the band's
left edge; if its bbox intersects any pinned segment or lane, slide right to the first free gap
wide enough; if none, **widen the group** by the label width and push its row neighbours (which
re-triggers 7c for groups whose parents moved — bounded by the same 8-pass limit). The label
bbox becomes an obstacle. Centre is never a fallback.

## Stage 8 — route (remainder)

libavoid-js (`Router(OrthogonalRouting)`). Registered as obstacles: node rectangles; every
**pinned path** as thin rectangles with **18 px trimmed at each end** so a remaining link that
shares an endpoint can reach it; lanes not owned by the link; label bands; bundle envelopes.
Ports are `ShapeConnectionPin`s, one class id per port, **`setExclusive(false)` for ports with
> 1 link**, direction = the side. Terminal escape: libavoid-js exposes no fixed routes or
checkpoints (verified: `connector.idl` has `Checkpoint` but no `setRoutingCheckpoints`); the
≥ 15 px stem is enforced by placing the pin on the boundary and validating the first segment
in stage 10. `overlay` links: straight segments between port centres on their own layer, not
routed. Stub candidates: after routing, a link whose route crosses > 2 tiers or is > 3× the
direct distance is marked; M1 only warns (stage 1).

## Stage 9 — link labels

Placed after routing on the longest segment of the computed path, then checked against every
label, node and segment; on collision, try the next-longest segment, then offset to the other
side of the segment, then shorten with an ellipsis to the segment length − 8; a label that still
collides is dropped to a tooltip and reported (`labelsOmitted`). Overlay-layer labels are
suppressed when overlay density (overlay links per node) exceeds the profile's threshold
(default 3).

## Stage 10 — validate

All gates in `quality.md` on final geometry including labels. Any failed gate fails `render`
(non-zero exit) unless `--allow-gate-failures`; `score` always reports. The gate-enforcement
table by size is in `quality.md` and is authoritative.

## Stage 11 — emit

Layout JSON (always) → SVG. `class` attributes from YAML; an inline `<style>` from the profile
theme plus the document `css:`. **CSS may not change geometry**: font-family, font-size,
stroke-width and transforms are set by the theme and locked (`!important` in the emitted style);
`css:` may set colour, fill, dash, opacity. The overlay `<g>` sits beneath the routed layer with
node interiors, group labels, port pills and link labels masked out; overlay endpoints keep a
2 px mark.

---

## Scale — authoritative table

| Nodes (N) | ELK | Deadline | Gates | Notes |
|---|---|---|---|---|
| ≤ 30 | partitioning | 10 s | all enforced | the "beautiful" regime |
| 31–300 | partitioning | 10 s | all enforced | warning: above readable size |
| 301–1,000 | partitioning, fallback on failure/deadline | 20 s | G3 (labels) downgraded to warning; others enforced | warning: fallback may apply |
| > 1,000 | refused without `--force` | 30 s | as above | |

Budgets that bound work, checked at parse: links ≤ 10 × N, ports ≤ 20 per node, node degree
≤ 64; beyond them, a warning and best-effort. Geometry algorithms use interval sweeps and a
uniform grid index; anything O(S²) over segments is a defect, not a design choice.

Measured so far: `elk.layout()` alone, 100 nodes / 300 links ≈ 250 ms; 1,000 / 3,000 ≈ 2 s
without partitioning. The **full pipeline** at 1,000 nodes has not been measured — ticket 17.

## What the prototype proved and what it did not

Proved on the M1 golden (`prototype/regions.mjs`, `tall5`): stages 3, 6, 7a–7f produce
0 crossings, 0 overlaps, 4 bends with every link claimed; libavoid idle. **Not yet exercised:**
stage 8 with real remainder demand (NTP golden), bundles with author-fixed ports, 3+ stacked
bars, fallback at scale under a deadline, aggregation, stubs, overlay masking, label repair.
Each is a ticket or an explicit M2 item.
