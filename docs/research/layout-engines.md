# Layout-engine survey

Research agent report, 2026-09-09. All facts checked that day against npm, the GitHub API and
official docs; versions and dates are not from memory. Requirements as stated to the agent:
(1) links on ports, (2) labelled groups, possibly nested, (3) orthogonal routing with crossing
minimisation and bundling, (4) tiers/hierarchy, (5) determinism, (6) maintainable, (7) 10–100
nodes / 20–300 links.

## Summary table

| Engine | Ports (1) | Groups (2) | Orthogonal / crossings / bundling (3) | Tiers (4) | Deterministic (5) | Size (min / gz) | Worker / Node | Maintenance |
|---|---|---|---|---|---|---|---|---|
| **elkjs 0.12.0** | Yes, first-class: `portConstraints` FREE / FIXED_SIDE / FIXED_ORDER / FIXED_RATIO / FIXED_POS; `port.side`; port spacing | Yes, nested; `hierarchyHandling=INCLUDE_CHILDREN` lays out all levels in one run with cross-hierarchy edges | `edgeRouting=ORTHOGONAL` default for layered; Sugiyama crossing minimisation; **no bundling** (`mergeEdges` only for port-less edges) | `layered.layering.layerConstraint` FIRST/LAST; `partitioning.activate` + `partition` | By construction: `randomSeed` default 1 (0 = time-based) | 1.45 MB / 433 KB gz | Both; `elk-worker.js`; Node via `web-worker` | Push 2026-09-09; releases 0.10.1→0.12.0 Jun 2025–Jul 2026 (~4/yr); 2.8k★; 98 open issues; TS types; EPL-2.0 or GPL-3.0 |
| WebCola 3.4.0 | No | Yes (`groups()`, nested), `avoidOverlaps()` | visibility-graph `routeEdge()`, `gridrouter.ts`; no crossing minimisation, no bundling | Partial: hand-written separation/alignment constraints, `flowLayout()` | Yes in 2D (`PseudoRandom(seed=1)`) | 76 KB / 22 KB gz | Pure JS | Last npm release 2019-05-10; sporadic commits; single maintainer |
| @dagrejs/dagre 3.1.1 | No | Yes (compound via `setParent`) | polyline points only; Sugiyama; no bundling | layers, no pin | Yes | 47 KB / 16 KB gz | Pure JS | 4 releases in 2026; 173 open issues; `dagre-d3` renderer stale (2024) |
| Graphviz WASM (`@viz-js/viz` 3.30, `@hpcc-js/wasm-graphviz` 1.29) | Yes: `node:port:compass` | Yes (`subgraph cluster_*`) | `splines=ortho` exists but "the routing does not handle ports or, in dot, edge labels" — **ortho and ports are mutually exclusive** | `rank=same/source/sink` | dot yes; neato/fdp seeded | 2–5 MB WASM, async init | Both | Both healthy, monthly releases |
| d3-force + custom | No | hand-written forces | none: straight lines, no routing, no crossing objective | no guarantee of rows or non-overlap | Yes (fixed-seed LCG) | small | anywhere | maintained; does not solve the problem |
| @msagl/core 1.1.24 | Yes: `FloatingPort`, `RelativeFloatingPort`, rectilinear `PortManager` | Yes (`Subgraph`) | `EdgeRoutingMode`: Rectilinear, Spline, **SplineBundling**, SugiyamaSplines…; Sugiyama crossing reduction; **real bundling** | Sugiyama TB/BT/LR/RL; no layer pin found | No `Math.random` in core src (undocumented) | 7.9 MB unpacked | core plain TS | 1.1.23 Sep 2024 → 1.1.24 Apr 2026 (18-month gap); ~3 maintainers; MIT |
| @antv/layout 2.0.0 | No | combo only | wraps dagre 0.8.5; no orthogonal | via dagre | via dagre | 11.4 MB | `enableWorker` | active; adds nothing over dagre here |
| d3-dag 1.2.2 | No | **No** (README: compound unsupported) | Sugiyama, optimal decross option; no routing | layers | Yes | 136 KB / 42 KB gz | pure TS | Jul 2026 release |
| cytoscape-elk / -klay / -cola | via wrapped engine | same | same | same | same | + cytoscape | browser | adapters pin old engine versions (2020–2024) |
| libavoid-js 0.5.0-beta.5 (router only) | Yes: `ShapeConnectionPin` | n/a (obstacles) | orthogonal + polyline obstacle-avoiding router with nudging; no placement | n/a | deterministic C++ core | 44 KB JS + WASM | browser + Node (Emscripten) | beta; push 2026-09-06; single author |

## Direct answers

**1. Which engines satisfy 1+2+3+4+5 together?** Only **elkjs layered**. Gaps: no edge
bundling (post-process; multi-edges between the same ports are supported); partitioning orders
along the layout direction only (fine for tiers); port constraints on compound nodes need
`INCLUDE_CHILDREN`; 433 KB gz; async. **MSAGL** second (ports, subgraphs, rectilinear, real
bundling) but no port-side/order constraints, no layer pin, undocumented determinism, irregular
releases. **Graphviz** fails 3-with-1. **WebCola** fails 1. **dagre**, **d3-dag** fail 1 and 3.
**d3-force** fails 1, 3, 4.

**2. Mixing per diagram / group / link.** ELK skeleton + ELK routing (single engine); ELK
placement + libavoid routing (node rects as obstacles, ports as pins — useful for edges ELK routes
poorly); ELK skeleton + own channel router; **per-group algorithm inside ELK** (every compound node
may carry its own `elk.algorithm` — layered, `box`, `rectpacking`, `force`) — native, no second
engine. WebCola per group: possible but no ports. Graphviz: avoid (y-up coordinates, WASM,
ortho/ports conflict).

**3. Maintenance cost.** elkjs: Kiel University project, JS is a GWT transpile so bugs are fixed
upstream in Java; README admits the JS module setup is dated. MSAGL: Microsoft, few maintainers,
long gaps. Graphviz WASM: healthy. dagre: community, many open issues, light. WebCola: single
maintainer, no release since 2019. libavoid-js: single author, beta.

**4. Determinism.** By construction and documented: elkjs, Graphviz dot, d3-force. By
construction from source, undocumented: WebCola 2D, dagre, d3-dag, MSAGL. Need seeding: Graphviz
neato/fdp/sfdp, ELK force/stress. Non-deterministic: WebCola 3D, any force layout fed
`Math.random`. In every case, stable YAML iteration order is also required (tie-breaks follow
input order).

## Recommendation (as given)
Build on elkjs layered as the single engine: tiers via partitioning (or layerConstraint for the
extremes), zones as compound nodes with `INCLUDE_CHILDREN`, interfaces as ports with
FIXED_SIDE/FIXED_ORDER. Keep a thin post-processing step for cosmetic bundling. Treat libavoid-js
as an optional later-stage router for link classes ELK routes poorly.

*What happened next:* the prototype showed ELK's router fails with lateral fixed ports (20–76
crossings), so libavoid became the router for the remainder and region rules became the primary
router — ADR-0003.

## Sources
elkjs: registry.npmjs.org/elkjs/latest · github.com/kieler/elkjs · eclipse.dev/elk/reference/options
(portConstraints, edgeRouting, hierarchyHandling, randomSeed, partitioning-partition,
layered-layering-layerConstraint, layered-mergeEdges) · bundlephobia elkjs@0.12.0.
WebCola: github.com/tgdwyer/WebCola (descent.ts, layout.ts) · ialab.it.monash.edu/webcola.
dagre: github.com/dagrejs/dagre, /dagre-d3 · registry @dagrejs/dagre.
Graphviz: graphviz.org/docs/attrs/splines, /attr-types/portPos, /attrs/start · @viz-js/viz ·
@hpcc-js/wasm-graphviz. d3-force: d3js.org/d3-force/simulation. MSAGL: github.com/microsoft/msagljs ·
microsoft.github.io/msagljs/docs. @antv/layout v5 README. d3-dag: github.com/erikbrinkman/d3-dag.
libavoid-js: github.com/Aksem/libavoid-js. cytoscape-elk/klay/cola on npm.
