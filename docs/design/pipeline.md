# Pipeline

`parse → model → sides₁ → size → skeleton → regions → sides₂ → route → labels → validate → emit`

Every stage reads the **layout model** and writes back to it. The model is plain data
(`LayoutModel` in TypeScript, serialisable to the layout JSON that `render` and `score` consume).
No stage touches the DOM.

The load-bearing idea: **space is reserved before it is used.** Lanes, bands, bar spans and bundle
rows are decided while placing, so routing never discovers it has nowhere to go. The prototype run
that ignored this (`tall3` with alignment added afterwards) produced a crossing and two overlaps;
the run that reserved first (`tall4`) produced none. Codex predicted it: "resolve placement
constraints jointly."

---

## Stage 0 — parse

YAML → validated **document** (see `schema.md`). Errors stop; warnings collect. The profile is
resolved here: aliases expanded (`device` → node, `interface` → port), tier inferred for groups
without `tier:`, link families assigned from class.

Output: nodes, ports (named + anonymous), links (with family and effective `route`), groups
(with tier or align, shape, label).

## Stage 1 — sides, phase one (tier-derived)

For each port, from the geometry the skeleton *will* have:

| Peer is in… | Side |
|---|---|
| a lower tier | `bottom` |
| a higher tier | `top` |
| a flank to the left / right | `left` / `right` |
| the same tier | **undecided** — resolved in stage 6 |
| a group that is a `bar` below | `bottom` |

Author `side:` on a port always wins. Ports on a side are ordered by the far end's expected
position (tier order and, for flanks, declaration order); exact x/y comes later.

## Stage 2 — size from sides

Per node: `height = max(minH, n_left|right × pitch + 2·pad)`, `width = max(minW, n_top|bottom × pitch
+ 2·pad)`, where `pitch` is the larger of 12 px and the measured width of the widest port label on
that side (rotated for left/right). Undecided intra-tier ports count toward the side they will most
likely take (left/right by declaration order) so the node has room; recomputed in stage 6 if needed.

Bars are sized later (stage 5c) because their width depends on drop positions.

## Stage 3 — skeleton (ELK)

One ELK `layered` run, direction `DOWN`, `hierarchyHandling=INCLUDE_CHILDREN`, groups as compound
nodes, `portConstraints=FIXED_SIDE` with phase-one sides, nodes at stage-2 size (as minimum size).
Tiers via `partitioning.partition = tier`. **Lateral links (flank↔tier) are withheld** so ELK does
not stack flanks above their tier. Flank groups are placed by rule after ELK, beside their tier,
on their `align` side, their *primary peer* pinned to the tier's outer end (`layered.considerModelOrder`
+ model order puts the peer node first/last).

Fallback: on any ELK exception (partitioning is known to throw at ~1,000 nodes), rerun **once per
tier band** without partitioning and stack the bands. The tier contract holds at any size; a warning
records the fallback.

Output: group boxes, node positions (top-left + size), intra-tier order.

## Stage 4 — row align

Per tier: all `row`-shape nodes share one top y. Then for every pair of same-tier nodes with facing
east/west ports, level the ports (move the port on the node with fewer ports on that side) and, if
no node lies between, pin the link as a straight horizontal path.

## Stage 5 — region rules

A **region** is the space between two adjacent tiers, or between a flank and its tier. The rule
for a region is chosen by what is on each side. Rules run in this order because each reserves
space the next must respect.

### 5a — reserve lanes
For every link that transits a tier it does not terminate in ("through-link"): reserve a vertical
lane in the margin beside the intermediate group, on the side nearer the link's source x. Lane
width = port pill width + gap. Lanes are allocated on the source node's outermost port slots of the
relevant side, so they are in-span verticals. If both margins are full, widen the tier gap and the
canvas (the canvas is never fixed).

### 5b — flank align
For each flank: identify the primary peer (most links). Shift the flank vertically so its k-th
facing port is level with the peer's k-th facing port. Pin those links as straight horizontals.
Links from the flank to *other* nodes are routed normally. Precondition: the peer has ≥ k ports on
its facing side (guaranteed by stage 1/2); if the flank faces two peers, only the primary aligns.

### 5c — bars
For each `bar` group: each node becomes a horizontal bar. Bar span = [min attached drop x − 30,
max attached drop x + 30], floor = own label width + 60. Stacked bars whose spans overlap by
> 50 % of the narrower share the union span. Ports on a bar sit at the source's x, ordered by x; a
drop to a lower bar crosses an upper bar (counted as `barCross`, not as `through`). Bars with links
from above and below allocate top and bottom port rows separately, at minimum pitch; coincident
source x is resolved by a short horizontal fan before the drop.

### 5d — child under parents
For each tier group fed from the tier above: centre it horizontally under the barycentre of the
feeding ports, within the space left after lanes. Then assign the parents' feeding ports x = the
child's corresponding port x, so the links are pure verticals. If assigning shifts a parent's ports
past its width, widen the parent and push its row neighbours. Iterate until stable (bounded, ≤ 8
passes). Mirror rule above the anchor tier: parents centre over children.

### 5e — bundle rows
For every set of ≥ 2 links between the same node pair whose route is `bundle`: reserve
`n × lane` rows in the tier gap below the lower of the two nodes' tier (widening the gap), route the
bundle's centreline once, offset members by `(i − (n−1)/2) × lane` with the sign chosen so port
order is preserved at both ends. Member ports are engine-ordered to match; if the author fixed
both ends in conflicting order, one explicit crossover is drawn and reported.

### 5f — label bands
Every group gets a band inside its top padding: `labelHeight + 8`. The label sits at the band's
left edge; if its bbox intersects any segment (fixed or to-be-routed lane), it slides right to the
first free gap wide enough; centre is the last resort. The label bbox becomes an obstacle.

## Stage 6 — sides, phase two

Intra-tier ports (undecided in stage 1) take `left`/`right` from ELK's row order (peer to the
left → `left`). Nodes are re-sized if a side gained ports; row align (stage 4) re-runs for the
affected tier. Then every side's port order is finalised by far-end x/y.

## Stage 7 — route

All fixed paths (stages 4, 5b, 5c, 5d, 5e) are registered as **obstacles** (thin rectangles) along
with node rectangles, label bboxes and lanes. libavoid-js routes every remaining `routed` link
orthogonally with nudging, pins unique per port, exits perpendicular with a ≥ 15 px stem.
`overlay` links are drawn as straight segments between port centres on a separate layer and are
not routed. `stub` links produce end-labels and no path. `group-link` produces one path between
group boundaries (routed like a normal link) with a count label.

**Per-link precedence** (fixed order, resolves any conflict between rules):
1. author `route:` override
2. aggregation — complete bipartite set → group-link
3. visibility — family `overlay` → overlay; stub thresholds → stub (evaluated on a trial route)
4. bundle — ≥ 2 links same node pair
5. straight eligibility — facing ports, collinear normals, clear, length < 2× larger node dimension
6. routed orthogonal

## Stage 8 — labels

Link labels: on the longest segment of the *computed* path, never at the geometric midpoint of
the endpoints. Node and port labels were sized in stage 2. Overlay labels are suppressed above a
density threshold (profile setting).

## Stage 9 — validate

All gates from `quality.md` run on the final geometry, including labels. A failed gate fails
`render` (exit code) unless `--allow-gate-failures`; `score` always reports.

## Stage 10 — emit

Layout JSON (always) → SVG (renderer). The SVG carries `data-` attributes for ids so a future
viewer can bind to it; `class` attributes from the YAML; an inline `<style>` from the profile
theme plus the document's `css:`. Overlay layer is a `<g>` beneath the routed layer with node
interiors masked out.

---

## Scale behaviour

| Nodes | Behaviour |
|---|---|
| ≤ 30 | full pipeline, all gates enforced |
| 31–300 | full pipeline; warning "above the readable size, consider `collapsed:` groups or splitting" |
| 301–1,000 | ELK partitioning attempted; on failure per-band fallback (warning); libavoid may be skipped for overlay-heavy sheets (warning); label overlap gate downgraded to warning |
| > 1,000 | refuse unless `--force`; suggest decomposition |

Measured: 100 nodes / 300 links in ~250 ms; 1,000 / 3,000 in ~2 s without partitioning.

## What the prototype proved and what it did not

Proved on the M1 golden: stages 2, 4, 5a–5f produce 0 crossings, 0 overlaps, 4 bends; every link
claimed by a rule; libavoid idle. **Not yet exercised:** stage 7 on a sheet where rules leave links
over (the NTP golden), bundle ordering with author-fixed ports, bars with 3+ stacked, per-band
fallback at scale, group-link collapse, stubs, overlay masking. Each is a ticket.
