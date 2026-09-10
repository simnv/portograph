# What is known about readable diagrams — and the scorer derived from it

Research agent report, 2026-09-09, verified against the cited papers. Distinguishes
*experimentally validated* from *conventional wisdom*. `docs/design/quality.md` is the
implementation of section 5.

## 1. Classic aesthetics, ranked by evidence

| Rank | Criterion | Status | Key result | Sources |
|---|---|---|---|---|
| 1 | **Edge crossings (minimise)** | Validated, replicated | "By far the most important aesthetic" (Purchase 1997); most influential variable on response latency across 4 experiments (Körner & Albert); significant for small graphs, **not at 120 nodes** (Kobourov 2014) | Purchase 1997; Körner & Albert; Kobourov et al. 2014; Purchase/Allder/Carrington 2002 |
| 2 | **Path continuity** | Validated | After path length, continuity and crossings are the strongest cost factors | Ware et al. 2002 |
| 3 | **Crossing angle (near 90°)** | Validated | response time falls as angle grows, flat near 90° | Huang 2007/2008/2014 |
| 4 | **Bends (minimise)** | Validated, smaller effect | "lesser effect" than crossings; bend count correlates negatively with human ranking (r −0.5 to −0.73), but humans *add* bends for symmetry/continuity | Purchase 1997; HOLA 2016 |
| 5 | **Symmetry** | Validated for preference and memory | small task effect; strongly aids recall (Marriott 2012) | Marriott et al. 2012; HOLA |
| 6 | **Orthogonality / grid alignment** | Mixed; domain-dependent | not significant on abstract graphs; 2nd priority in UML; "gridiness" r 0.52–0.88 in HOLA | Purchase 1997; JGAA 2002; HOLA |
| 7 | **Flow direction** | Validated as preference | 3rd in UML ranking; direction changes distract but don't change understanding (2024 eye-tracking) | JGAA 2002; DSS 2024 |
| 8 | **Compactness** | Validated for preference (orthogonal) | strongest positive correlate of human ranking in HOLA (r 0.69–0.87) | HOLA |
| 9 | Edge-length uniformity | Correlational | negative correlation of segment std-dev with ranking | HOLA |
| 10 | Angular resolution | Not significant for orthogonal | fixed at 90/180 in orthogonal drawings | Purchase 1997; Huang 2013 |
| 11 | Node distribution | Conventional wisdom | defined, not tested in isolation | Purchase 2002 |

Two cross-cutting findings: **improve several aesthetics a little rather than one to the
extreme** (Huang 2013: doubled task efficiency with −26 % crossings, +5 % angle, −7 % length,
+15 % resolution); **diagram size dominates** — the size effect matches or exceeds any layout
factor (Störrle 2014, 2016).

## 2. Metrics specific to orthogonal / port-based drawings

| Metric | Definition in practice | Origin |
|---|---|---|
| Bends per edge | direction changes per polyline; TSM minimises total | Tamassia 1987; GD Handbook ch. 7 |
| Edge–edge crossings | segment intersections excluding shared endpoints; Purchase normalisation `1 − c/c_max` | Purchase 2002; Mooney 2024 |
| Edge–node crossings | route through a non-incident node; libavoid obstacle penalty; yFiles `nodeCrossingCost` | Wybrow 2009; yFiles |
| Port ordering violations | wrong exit direction or order; libavoid `portDirectionPenalty` 100; ELK FIXED_SIDE/ORDER | libavoid; ELK |
| Shared-path nudging | parallel segments at `idealNudgingDistance`, ordered so crossings occur only at entry/exit | Wybrow 2009 |
| Bundling | reduces clutter but **ambiguous**: no accuracy loss, slower reading, perceived false connectivity | Bach 2017; CHI 2025 |
| Grid alignment | % nodes in an alignment of ≥ 3 (HOLA R4) | HOLA |
| Compactness | node area / bbox area (HOLA R3) | HOLA |
| Aspect ratio | min/max; Sugiyama layouts worst (median 0.18 vs 0.83) | Mooney 2024 |
| Label overlap | Rule 1 of Kakoulis & Tollis; area-aware preferred | Kakoulis & Tollis 2001; Sprawlter |

## 3. Combined scores — there is no standard

Purchase 2002 normalises each to [0,1]; Huang 2013 uses standardised terms with interactions;
router cost functions encode vendor judgement (libavoid defaults: segment 50, angle 50, crossing
200, fixedSharedPath 110, **clusterCrossing 4000**, portDirection 100 — crossing = 4× bend, cluster
crossing = 20× crossing); Mooney 2024 deliberately does not combine and warns that Edge
Orthogonality and Crossing Angle are negatively correlated; Greadability.js is a mean of 4.

## 4. Practical guidance (conventional wisdom, verified sources)

ELK defaults: `spacing.nodeNode 20`, `edgeNode 10`, `portPort 10`. yFiles EdgeRouter demo:
`minimumEdgeDistance 5`, `minimumFirst/LastSegmentLength 15`, `minimumNodeToEdgeDistance 5`;
top-to-bottom flow → source ports bottom, target ports top, monotonic paths. C4: title, legend for
every shape/colour/line style, every line labelled, one arrow direction, diagram survives removal
of colour. AWS: label every icon, direct lines, whitespace, group boxes carry meaning. Störrle:
align, don't obscure; layout patterns and correspondence to the message matter more than any
single low-level criterion. Moody: perceptual discriminability, graphic economy.

## 5. Proposed scorer

**Hard gates:** node overlap 0 and containment; edge–node crossings 0; label overlap 0
(area-aware); port side/order violations 0 with ≥ 15 px perpendicular stems; clearances
node–node ≥ 20, edge–node ≥ 10, edge–edge ≥ 10.

**Soft score** `Q = Σ wᵢMᵢ`: crossings 0.30 (`c/m ≤ 0.05` at ≤ 30 nodes, `≤ 0.15` at 100 — use raw
`c/m`, the normalised value saturates); bends 0.15 (mean ≤ 1, none > 3); continuity 0.10 (≥ 0.7);
compactness 0.10 (≥ 0.25, also per container); grid alignment 0.10 (≥ 0.6); aspect 0.05 (≥ 0.5);
flow 0.10 (≥ 0.8); uniformity 0.05 (≥ 0.5); symmetry 0.05 report-only. Angular resolution and
crossing angle dropped (degenerate in orthogonal). Score per container as well as globally;
regression tolerance ±0.05; **size gate: warn above ~30 nodes.**

Caveats: thresholds are grounded in distribution data and vendor defaults, not experiments; no
study ranks aesthetics for port-based network diagrams specifically; the nearest validated
analogue is HOLA's orthogonal user study.

## Sources
Purchase 1997 (doi 10.1007/3-540-63938-1_67); Purchase 2002 metrics; Purchase/Allder/Carrington
JGAA 2002; Ware et al. 2002 (IVS); Huang eye-tracking (arXiv 0810.4431); Huang et al. 2013;
Kobourov et al. 2014 (crossings); Marriott et al. 2012 (InfoVis); HOLA 2016 (Kieffer, Dwyer,
Marriott, Wybrow); Mooney et al. 2024 / GD 2025; Dunne et al. 2015; Störrle 2014, 2016; Wybrow et
al. 2009 (libavoid); Kakoulis & Tollis 2001; Bach et al. 2017; CHI 2025 bundling; Moody 2009;
ELK option docs; yFiles EdgeRouter docs; c4model.com notation; Greadability.js.
