# portograph — Domain Context

Glossary and invariants for the project. Use these terms exactly; do not drift to synonyms. When a
concept you need is missing here, that is a signal — either you are inventing language the project
does not use, or there is a real gap to record.

`portograph` turns a YAML description of nodes, ports, links and groups into a laid-out diagram
(SVG), choosing the drawing technique per part of the diagram so the result reads like an engineer
drew it. Network diagrams first; software architecture and electrical panels next.

---

## Core vocabulary

| Term | Definition | Not to be confused with |
|---|---|---|
| **node** | A drawn box with a label, a class, and zero or more ports. The unit that groups contain and links connect *through*. | *device* (network profile alias), *component* (architecture alias) |
| **port** | A named or anonymous attachment point on a node's **side**. Every link end attaches to a port; a link never attaches to a node directly. Named ports render (the pill); anonymous ports do not. | *interface* (network alias), *terminal* (electrical alias) |
| **side** | One of `top`, `right`, `bottom`, `left`. Each port has exactly one side, assigned by the engine from the peer's position unless the author fixes it. | |
| **link** | A connection between two ports. Has a **class** (which decides its *family*) and optionally a **route** override. | *edge* (graph-theory word; avoid), *connection* |
| **group** | A labelled container holding nodes. A node belongs to exactly one group. A group has a **tier** or is a **flank**, and has a **shape**. | *location* (d3-fd's word), *zone*, *area* |
| **tier** | An integer ordering rank on a group giving its row in the top-to-bottom hierarchy. Tier 0 is the top. Inferred from node classes by the profile when omitted; an explicit `tier:` always wins over class inference. Effective tier bands are compact after normalisation while preserving explicit-rank order. | *layer* (reserved for OSI/link-class layers) |
| **flank** | A group placed *beside* a tier rather than in it: `align: left` or `align: right`. Its links to the tier are lateral. A flank has a **primary peer** — the tier node it shares the most links with. | a tier member with `position` hints |
| **shape** (of a group) | How the group arranges its nodes: `row` (default), `bar`, `grid`, `ring`, `free`. M1 ships `row` and `bar`. | *layout algorithm* |
| **bar** | A group shape where each node renders as a horizontal bar spanning its attached ports' x-range; links onto a bar are vertical drops, ports ordered by source x. Bars may stack; a drop may cross an upper bar to reach a lower one. | a wide `row` node |
| **region** | The space between two adjacent tiers, or between a flank and its tier. Routing strategy is chosen per region by what is on each side. | *group* |
| **lane** | A reserved vertical corridor (`laneW` = pill width + gap ≈ 34 px), in the margin beside a group, for one link transiting a tier it does not terminate in. A lane has an **owner**; it is an obstacle to every other link. Reserved before anything is pinned. | *channel*; the 16 px **member gap** inside a bundle |
| **anchor tier** | The tier with the most main-tier nodes, including bars and excluding flank nodes (ties: lowest effective tier index). Groups below it are centred under their feeds; groups above it are centred over their children. | |
| **junction** | A branch point in a tree of shared runs at one port. Source and target incidence use the same outward tree. Only declared shared runs are exempt from the overlap gate. It is model geometry reserved during placement, never a runtime `JunctionRef`: stage 8 stitches the reserved run back unchanged and routes only the gap beyond its terminal. | *bundle* |
| **band** | Reserved horizontal space: a **tier band** (the vertical extent a tier occupies) or a **label band** (space inside a group's top padding reserved for its label). | |
| **skeleton** | The tier/group placement produced by ELK before region rules run. Lateral (flank↔tier) links are **withheld** from the skeleton so flanks land beside their tier. | *layout* (the whole result) |
| **bundle** | Two or more routed links between the same pair of nodes, routed through a channel and fanned to ports. Its **envelope** reserves the swept geometry, including stroke width. Parallel members cross once for each strict endpoint-order inversion; shared-port ties count as zero. Engine order minimizes avoidable inversions where incidence and reservations permit it. Selected `route: merge` members share counted trunks; other members remain parallel. | *overlay* |
| **overlay** | A link family drawn straight, thin, translucent and *unrouted* on its own layer beneath routed links. Used for flow-class links (e.g. NTP sync). Exempt from clearance gates. | *bundle* |
| **group-link** | One link drawn between two groups (each with ≥ 2 nodes) standing for the **complete** bipartite set of same-class links between their nodes, labelled with the count; membership is kept in the model. Near-complete sets stay overlay. M1: warns, draws the members. | *bundle* |
| **stub** | A link drawn as a label on each end node instead of a line ("→ loc1ntp001"), used when a route would cross more than two tiers or detour more than 3× the direct distance. Both ends are marked. | hiding a link |
| **family** (of a link) | `routed` or `overlay`, decided by the link's class through the profile. Physical links are routed; flow links are overlay. | *route* (the per-link technique within a family) |
| **profile** | A TypeScript module plus optional YAML overlay that supplies vocabulary aliases, tier-inference table, conventions (direction, which classes are routed vs overlay), default theme, icon set, and validators. Ships: `network`, `architecture`, `electrical`. | *theme* (only the visual part) |
| **golden** | A reference diagram the renderer must reproduce to the maintainer's satisfaction. M1 golden: `docs/design/target-example.jpeg`. Others: a three-tier LAN, `superspine.yaml`, the Enterprise NTP sheet. | a snapshot test |
| **gate** | A hard pass/fail check on layout output (overlap, through-node, label hit, port stem, clearance). Any failed gate fails the diagram. | *score* |
| **score** | A weighted soft quality number in [0, 1] computed from crossings, bends, continuity, compactness, alignment, flow, aspect, uniformity. Guards regressions; never repairs. | *gate* |

---

## Invariants

1. **Links attach to ports, never to nodes.** A link written to a bare node gets an anonymous port.
2. **A node has exactly one group.** Groups do not nest in M1.
3. **Node size is derived from its content and its ports:** the larger of the measured label/description/icon bounds, the author's `size:` floor, and per-side port counts × the measured pitch of that side. Never shrunk to fit.
4. **Port topology freezes before paths:** identity, count, side and author `order:` are fixed after the two side phases. Engine-selected order may still change where bar and bundle rules require it, including compatible primary-bundle order during flank alignment. Bundle rules may grow endpoint pitch and capacity, repack rows, re-level blocks and reserve crossing space before paths. Fixed lane x and owners remain immutable. Placement may grow or move geometry only through its declared rules; it never shrinks a node below its current content or author floor. Final placement freezes after all region rules.
5. **Meaning before geometry, space before use:** which technique a link gets is decided from the document (stage 1); lanes, bands, bundle rows and bar spans are reserved during placement, not discovered during routing.
6. **Every fixed path is an obstacle** for everything routed after it. All paths are validated together at the end.
7. **Region rules are the router for regular tiered diagrams.** libavoid routes only what the rules do not claim.
8. **The tier contract survives at any size:** ELK partitioning is always attempted; on exception **or deadline**, one ELK run per tier band, stacked; bands are validated after either path (ADR-0006).
9. **Nothing is styled by value in YAML.** Nodes, links and groups carry `class`; a profile theme and an optional `css:` block do the rest.
10. **The layout JSON is a first-class output.** SVG is one renderer of it; `score` reads it directly.

---

## Numbers that are decisions

| Quantity | Value | Origin |
|---|---|---|
| Port pitch on a side | max(12 px, rendered pill extent along the side + 4 px) | measured pill geometry; JPEG orientation |
| Node minimum | 50 × 35 px | d3-fd |
| Port pill | 24 × 10 px, r 3 | d3-fd |
| Node corner radius | 8 px; group 10 px | d3-fd |
| Bar padding beyond outermost port | 30 px | prototype `tall5` |
| Bar span merge threshold | spans overlap > 50 % of the narrower → shared span | prototype `tall5` |
| Lane width | port pill width + gap ≈ 34 px | prototype `tall3` |
| Group label band | label height + 8 px; label left-aligned, slides right only on collision | user decision, `tall5` |
| Clearances (gates) | node–node 20, edge–foreign-node 10, parallel edge–edge 10 px, stroke-aware, with ownership exceptions | ELK defaults; codex review |
| Port stem | ≥ 15 px, perpendicular to side | yFiles convention |
| "Beautiful" ceiling | ~30 nodes | Störrle 2014/2016, Kobourov 2014 |
| "Workable" ceiling | ~1,000 nodes; per-stage deadlines (ELK 10 s ≤ 300 nodes, 20 s above); full pipeline < 30 s — **not yet measured** | prototype: `elk.layout()` alone 2 s at 1,000 without partitioning |
| Bundle member gap | 16 px visible clearance; minimum centreline pitch = gap + maximum member stroke, 17.5 px at defaults | prototype `tall3`, stroke-aware G6 |
| Fixed-path obstacle trim | 18 px at each end | prototype `tall3` |
| Straight-link eligibility | ports face each other, collinear normals, clear path, length < 2× larger node dimension | Q30 as amended by codex |
| Stub thresholds | crosses > 2 tiers, or detour > 3× direct | Q30 |
| Group-link collapse | complete bipartite set only | Q30 as amended by codex |
