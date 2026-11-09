# Prototype results — sixteen ELK variants, five rule iterations

Prototype code: `prototype/` (run `npm ci` there; `./run.sh <variant>`, `./run-av.sh <variant>`,
`node regions.mjs tall2 tall5 && node render.mjs tall5-av && node metrics.mjs tall5-av`).
Renders: `prototype/out/`. Target: `docs/design/target-example.jpeg` — 15 nodes, 32 links, 6
groups: providers on top, a datacenter row of four routers, TBR-001/002 flanking with eight
side-ports each, a route-reflector box centred below, two backbone rows at the bottom.

Input: the predecessor's `demo/public/diagram.yaml` converted to ELK JSON (`prototype/build.mjs`).

## Phase 1 — what ELK can and cannot do (2026-09-09)

| Variant | Ports | Tiers | Other | Crossings | Bends | Max | Aspect | Size | Shape vs target |
|---|---|---|---|---|---|---|---|---|---|
| free | FREE | — | | 3 | 60 | 4 | 1.51 | 1817×1204 | flanks stacked above tier |
| **part** | FREE | partition | | **3** | 44 | 4 | 1.01 | 1374×1360 | tiers right; flanks above; RRs staggered; EBR-02 dropped a layer |
| side | FIXED_SIDE | partition | | 21 | 126 | 7 | 0.70 | 1226×1740 | ports right, long detours |
| sideMO | FIXED_SIDE | partition | model order | 20 | 110 | 6 | 0.98 | 1563×1600 | |
| order | FIXED_ORDER | partition | model order | **76** | 116 | 6 | 0.81 | 1371×1694 | |
| lc | FIXED_SIDE | layerConstraint | model order | 22 | 116 | 5 | 1.18 | 1830×1552 | |
| lcc | FIXED_SIDE | partition | lcc | 20 | 110 | 6 | 0.98 | 1507×1544 | |
| lccFree | FREE | partition | lcc | 3 | 58 | 6 | 0.92 | 1281×1394 | |
| flat | FIXED_SIDE | partition | no compound | 27 | 84 | 5 | 1.63 | 1730×1060 | |
| flatFree | FREE | partition | no compound | 3 | **36** | 4 | 1.31 | 1167×892 | most compact; wrong shape |
| flatOrd | FIXED_ORDER | partition | no compound | 62 | 86 | 5 | 1.60 | 1730×1084 | |
| hybrid | FIXED_SIDE | partition | flat, lateral links withheld | 2 (13 edges only) | 16 | 2 | 2.44 | 1660×680 | ELK routed only 13 |
| hybridFree | FREE | " | " | 2 (13) | 16 | 4 | 3.07 | 1828×596 | |
| hybrid-mixed | FIXED_SIDE | " | libavoid on withheld only | 23 | 62 | 3 | 2.44 | 1660×680 | |
| **hybrid-av** | FIXED_SIDE | " | **libavoid on all 32** | **10** | 70 | 4 | 2.44 | 1660×680 | **right shape**: flanks beside, RR centred, backbone bottom |
| hybridFree-av | FREE | " | libavoid on all | 58 | 54 | 4 | 3.07 | 1828×596 | |

Findings: ELK's router is excellent when links follow the flow (3 crossings) and collapses when
ports are forced lateral (20–76). The target's composition is two-axis (tiers *plus* flanks); layered
layout has no "beside". Withholding lateral links and routing with libavoid gives the shape at
10 crossings — all in one dashed bundle. Nothing bundles.

**Scale** (`prototype/scale.mjs`, synthetic, ~2 ports/node): 100 nodes / 300 links ≈ 250 ms in
every mode. 1,000 / 3,000: hierarchical without partitioning 1.7 s (21k × 25k px); flat 2.0 s;
**with partitioning: NPE (hierarchical) / stack overflow after 33 s (flat).**

## Phase 2 — region rules on `hybrid-av` (2026-09-09/10)

| Iteration | Rules added | Crossings | Outside bundles | Overlaps | Bends | Max | Label hits |
|---|---|---|---|---|---|---|---|
| tall2-av | size nodes from lateral port count; spacing | 11 | 11 | 0 | 60 | 3 | — |
| tall3-av | flank align · bars · lanes around RR · bundle as channel | **0** | **0** | **0** | 16 | 2 | 2 |
| tall4-av | + row align · label band (centred) · child under parents (lanes first) | 0 | 0 | 0 | **4** | **1** | **0** |
| tall5-av | label left-by-default, slide on collision · bar span = attached ports ± 30 | 0 | 0 | 0 | 4 | 1 | 0 |

`tall` alone (sizing only): TBR↔EAC links −72 % length, −20 % bends; crossings unchanged because
they lived in the dashed bundle (router nudging, not placement).

In `tall4`/`tall5` **all 32 links are pinned by rules; libavoid routes nothing.** The four
remaining bends are the bundle's fan, one per member. `barCross = 3` (drops crossing the upper bar
to reach the lower, as in the target) is reported separately from `through`.

What each rule needed, as learned:
- **Flank align**: peer must have ≥ k facing ports; non-facing ports sorted after facing ones.
- **Bars**: a group shape flag; bar order; span source (attached ports, `tall5`); metric exception.
- **Lanes**: which side has room, measured against neighbouring groups; lane budget reserved
  *before* placement; through-ports packed outermost. Alignment added afterwards (`tall3al`) broke
  it: 1 crossing, 2 overlaps — the two rules compete for horizontal space and must be ordered.
- **Bundle**: rows reserved in the tier gap; without reservation libavoid routed another link
  through them. libavoid-js has no fixed-route API; fixed segments were fed back as thin obstacles
  (26 of them) — enough to keep the remaining edges crossing-free.
- **Child under parents**: needs an anchor tier; children below follow parents, parents above
  follow children; iterate with a bound; widening a parent pushes its row neighbours.
- **Label band**: must run after all segments exist; gap scan includes horizontal segments.
- **Bar span**: after lane/port-x assignment, before bar port x is written; transitive merge for
  3+ bars.

Bug found in `avoid.mjs`: unused ports sorted with key `[0,0]` and grabbed the first slot,
producing a jog on provider-3 → EAC-02; fixed in `regions.mjs` (unused ports sort last).

## Metrics implementation notes
`metrics.mjs` counts crossings by segment intersection **excluding parallel segments** — collinear
overlaps were invisible until an `overlaps` column (collinear share > 1 px, non-shared endpoints)
was added. `xlist.mjs` lists crossing pairs. `labelHits` counts segments intersecting group-label
bboxes. Aspect = w/h of the bounding box.
