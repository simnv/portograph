# Quality — gates, score, and what "beautiful" means

Decision Q7: goldens decide, metrics guard regressions, the checklist is the spec. This document is
the metrics half. It derives from `docs/research/aesthetics.md` (what is experimentally validated)
and from the codex review (what makes gates attainable).

`portograph score <layout.json>` computes everything below from the layout JSON, never from SVG.

---

## Hard gates

A failed gate fails the diagram. Each gate names the object pairs it applies to; the overlay layer
is out of scope for all clearance gates.

| # | Gate | Definition | Exceptions |
|---|---|---|---|
| G1 | **No node overlap** | no two node rectangles intersect; every node inside its group box | — |
| G2 | **No link through a foreign node** | no routed segment intersects a node rectangle it is not incident to | a drop crossing a **bar** on its way to a lower bar (`barCross`, reported separately) |
| G3 | **No label collision** | no label bbox (node, port, link, group) intersects another label, a node, or a routed segment, area-aware | port labels inside their own pill |
| G4 | **No link–link collinear overlap** | no two routed segments on the same line share > 1 px of length | segments inside a declared **bundle** (reported as bundled length); the shared **stem** of links leaving one port (one stem, then fan) |
| G5 | **Ports exit correctly** | every routed link leaves its port perpendicular to the side, first/last segment ≥ 15 px; port order on a side matches far-end order unless author-fixed | overlay, stub |
| G6 | **Clearances** | node–node ≥ 20, link–node ≥ 10, parallel link–link ≥ 10 px, stroke-aware | inside bundles (bundle spacing applies) |
| G7 | **Containment** | every node's ports lie on its boundary; every link endpoint is on its port | — |

Why G4 exists: the prototype's crossing counter used a segment-intersection test that returns
*false for parallel lines* — overlaps were invisible until a user asked how they would be scored.
Overlap is its own family, computed by bucketing axis-aligned segments and sweeping.

## Soft score

`Q = Σ wᵢ · Mᵢ`, each `Mᵢ ∈ [0, 1]`, 1 = good. Weights follow the evidence ranking (crossings first
by a wide margin; compactness and grid alignment correlate strongest with human preference for
orthogonal drawings).

| Metric | Formula | Weight | Threshold (≤ 30 nodes) | Threshold (≤ 100) |
|---|---|---|---|---|
| Crossings | `1 − min(1, c / m)` where `c` = crossings **outside bundles**, `m` = routed links | 0.30 | `c/m ≤ 0.05`; golden M1: `c = 0` | `≤ 0.15` |
| Bends | `1 − min(1, mean bends per routed link / 3)` | 0.15 | mean ≤ 1.0, none > 3 | mean ≤ 1.5 |
| Path continuity | fraction of multi-segment links whose segments keep direction between turns | 0.10 | ≥ 0.7 | ≥ 0.6 |
| Compactness | node area / bbox area, per group and global | 0.10 | ≥ 0.25 | ≥ 0.2 |
| Grid alignment | fraction of nodes in an alignment of ≥ 3 | 0.10 | ≥ 0.6 | ≥ 0.5 |
| Flow consistency | fraction of routed segments pointing along the declared direction | 0.10 | ≥ 0.8 | ≥ 0.7 |
| Aspect ratio | `min(w,h) / max(w,h)` | 0.05 | ≥ 0.5 | ≥ 0.4 |
| Segment uniformity | `1 − std/mean` of segment lengths | 0.05 | ≥ 0.5 | report |
| Symmetry | reflective-pair fraction (HOLA's cheap version) | 0.05 | report only | report |

Use raw `c/m` in assertions, not the Purchase-normalised value — the normalised form saturates
near 1.0 for every non-random layout and cannot discriminate.

Also reported, not scored: `overlaps`, `bundledLength`, `barCross`, `labelHits`, `stubs`,
`groupLinks`, `lanesUsed`, `fallbackUsed`, canvas size, layout time.

## Size warnings

| Nodes | Message |
|---|---|
| > 30 | "Above the readable size (Störrle 2014/16, Kobourov 2014). Consider `collapsed:` groups or splitting by layer." |
| > 300 | "Tier partitioning may fall back to per-band layout." |
| > 1,000 | refuse without `--force` |

## Test design

- **Golden tests**: one YAML per golden; `render` output reviewed by the maintainer once and
  approved; thereafter the layout JSON is an **exact snapshot** (ELK and the rules are
  deterministic; determinism was not required but is free). Any change to a snapshot is a
  reviewed diff.
- **Gate tests**: every golden passes G1–G7.
- **Score tests**: `Q` within ±0.05 of the approved value; crossings-outside-bundles may only go
  down without a waiver.
- **Rule unit tests**: each region rule has a small synthetic fixture that isolates it (flank with
  two peers; three stacked bars; through-link with both margins occupied; bundle with author-fixed
  reversed ports) — the codex counter-examples, verbatim.
- **Scale tests**: 100 / 300 / 1,000 synthetic nodes: completes, time bound, fallback path taken
  where expected.
- **Review**: codex on every ticket's diff; agy on every golden render against the checklist below.

## The checklist (the spec half of Q7)

From the reference corpus, the rules a reviewer applies to a render:

1. Hierarchy reads top-to-bottom; external/providers at the top, backbone/core at the bottom
   (Auvik, drawthe.net's y-up).
2. Segments are all horizontal or all vertical within a tier; mixed only to flag a special
   segment (Auvik).
3. Ports leave perpendicular; parallel links are bundled or evenly spaced (yFiles, libavoid).
4. Redundant pairs sit side by side (Auvik L2).
5. Every group is labelled; labels never sit on links (this project).
6. Colour encodes role or link property, and the diagram survives removal of colour (C4).
7. Link property encoded consistently: weight = speed, style = class (Auvik, Creately).
8. No crossing that a topology rewrite could avoid — bar, stub, duplicated cloud
   (networkdiagram101 TIP 4).
9. Whitespace is even; object : gutter ≈ 60 : 40 (drawthe.net).
10. A legend exists when more than one symbol or line style is used (networkdiagram101 TIP 7).
