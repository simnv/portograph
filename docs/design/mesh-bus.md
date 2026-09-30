# Mesh bus — a full mesh on one row draws as one bar

Status: design (ticket 81, 2026-09-30). Decision Q105. Implementation: tickets 82 to 85 under
`.scratch/ranked-groups/issues/`.

## 1. The problem

The overlay rule draws a link as one straight segment when no node body stands on it (Q64). On one
row, only adjacent nodes can hold a straight segment: a row of `n` nodes fits at most `n - 1`
adjacent pairs. A full mesh of `n` nodes has `n (n - 1) / 2` pairs. Ticket 78 measured that no
order of the row can straighten them. On the private NTP sheet the 56 same-row bent overlay links
are the pairs of two complete sync graphs: one row of 12 nodes (66 pairs) and one row of 3 nodes
(3 pairs). Each bent pair is an orthogonal detour along the row, and the detours stack.

The maintainer chose one **mesh bus** (2026-09-30) over arcs above the row, over the detours and
over hiding the non-adjacent pairs.

## 2. The rule in one paragraph

When the overlay links of one class join every pair of a set of three or more nodes on one row,
they draw as one **bus**: one straight **bar** along the row on the side away from the row's
title, one short **stub** from each member node to the bar, and one label. The member links stay
in the document and in layout.json. Only the drawing aggregates them. The bus is decided at stage 1
from the document. Its space is reserved during placement. Nothing about it is found during
routing.

## 3. Detection (stage 1)

Detection runs after aggregation (stage 1 step 3) and before bundle membership (step 4). It reads
the document and the resolved families only.

**Row.** A row is one layout group that is a `row` group to every stage: a rank cell `G#r`, a
group of one rank, or a group of shape `row`. Its nodes stand on one sub-tier. A bus never spans
two groups, two cells of one frame, or two cantons, so a bar never crosses a frame edge. A group
of shape `grid` or `bar` holds no bus (`MESH_BUS_DECLINED`, `shape`).

**Candidate links.** An overlay-family link (step 2) with no authored `route:`, whose two ends are
nodes of the same row. Candidates are grouped by row and by class. A link with an authored
`route:` is not a candidate, as for a group-link; `route: overlay` on every member is the opt-out.

**The bus.** For each row and class, take the graph of candidate links. Find its maximum clique
(Bron-Kerbosch with pivoting; a row holds tens of nodes, and the 64-link degree cap bounds the
work). A clique of three or more nodes is the bus. Ties between cliques of equal size go to the
clique whose members come first in declaration order. The bus takes every candidate link among its
nodes.

**Partial mesh.** A set that misses pairs is not one bus. The largest complete part becomes the
bus, and the rest stays plain overlay links, drawn by the overlay rule from their own ports. So a
12-node set that misses two disjoint pairs gives a bus of 10 nodes and 19 plain links.
`MESH_BUS_PARTIAL` (info) names the nodes left out and the pairs that are missing.

**Overlapping cliques and a second mesh.** In the first version a row holds at most one bus. A
second clique of three or more nodes on the same row, of the same class or of another class, is
reported as `MESH_BUS_DECLINED` (`second-mesh`) and its links stay plain. Ticket 85 lifts the
limit: buses of one row stack their bars outward.

**Members in different groups or cantons.** Such a set is not one row. Detection runs per row, so
the set splits by row. Each row part of three or more nodes becomes its own bus. The links between
the parts stay plain overlay links. No bar crosses a frame edge, and nothing is declined for it.

**Ports.** The bus needs one port per member. The parser gives each bare link end its own
anonymous port, so a member of a 12-node mesh carries 11 anonymous ports today and its node is
sized for them (invariant 3). Stage 1 collapses them: the **bus port** of a member is the
lowest-ordinal anonymous port among its member-link ends, every member link's end at that node is
re-attached to it, and the other anonymous ports of those ends are removed. When every member-link
end at a node names the same authored port, that port is the bus port and keeps its pill. When
the member links at one node name two or more different authored ports, the bus is declined
(`MESH_BUS_DECLINED`, `named-ports`): a named port is a drawn pill with a meaning of its own, and
the design does not merge two of them. `SHARED_PORT` does not warn on a bus port.

**Authored overrides.** No new syntax in the first version. Opt-out is `route: overlay` on the
member links. An authored opt-in for a partial mesh is an open question (Section 10).

## 4. Placement

**Side.** The bus stands on the horizontal edge of the row opposite the row's title (ADR-0011):
`bandSide` for a lone row group, the opposite of `frameSide` for a cell of a frame. Ties keep the
title on top, so the bus goes to the bottom. `bandSide` counts routed ports only, so a bus port
never moves a title. The bus side of a cell in the middle of a frame is a rank gap. That is
accepted: the bar lies in the gap and the routed parts of that gap cross it as verticals.

**Bus port side and order.** Stage 2 gives a bus port the bus side. Stage 5 never revisits it (a
same-tier overlay port is otherwise left/right from the row order). The bus port is the last port
in engine order on its side; an authored `order:` on a named bus port wins. Stage 3 counts it as
one port on that side. Identity, count and side are fixed before the freeze (invariant 4).

**Geometry.** Let `L` be the line of the outermost body or pill extent of the row on the bus
side, the line the frame padding is measured from. The bar runs at `L + BUS_STUB` (15 px, the
port-stem convention), from the x of the first member's bus port to the x of the last. A stub runs
from its port's outward face (the pill face for a named port, the body edge for an anonymous one)
straight out to the bar; it is at least 15 px long. The bar and the stubs take the class's
overlay stroke and dash.

**Bus band.** The reserved space on the bus side is the **bus band**: from `L` out to the bar,
plus the room beyond it. With a label the room is `4 px + label height + 4 px`; without one it is
the run clearance `k` (11.5 px). The band is about 34 px with a label and 27 px without, against
the 20 px of frame padding, so the frame grows on the bus edge by the difference, as a bottom
label band grows a group (ADR-0011). The label stands beyond the bar, centred on the bar's
midpoint, at heading 0 (ADR-0014). When a routed leg of the row's own ports crosses the centred
label box, the label takes the longest clear interval of the bar between two consecutive stubs and
legs; when no interval holds it, it goes to the tooltip and `labelsOmitted` counts it.

**Who reserves it.** Three places, in pipeline order:

1. Stage 4 `reserveInitialSpace` gives the row at least the band's height of padding on the bus
   side, as it does for the label band, so the skeleton leaves the room.
2. Stage 7f `produceBusBands` runs beside `produceGroupLabelBands`, before the tier-gap growth and
   again after it. It publishes the `BusBand` with its bounds and the bar and stub geometry read
   off the settled row. `rebuildFrames` adds it to the frame edge as it adds the label band.
3. The tier-gap plan (ADR-0021) reads the bus band as an O5 band anchored to the row's band over
   the bar's span, plus `k`. No planned row lies inside it. A leg that leaves a bus-side port of a
   member crosses the bar as one vertical; that is a bus. `growTierGaps` grows the gap by the
   formula and probes nothing.

Publication and restore re-run the band on a copy and reject a model it would still change, as
they do for label bands.

**Interaction with the other overlay rules.** A bus member link is not a chord. `straightOverlays`
(the count the column and centring passes hold) leaves bus members out; they are neither straight
nor bent. `stepOverChords` (ticket 77) does not read them. `placeOverlayFree` already leaves out
same-tier partners. The overlay order of ticket 78 reads the members of a bus as one contiguous
block: every pair inside the block is satisfied by contiguity, and a foreign node under the bar
costs bar length and nothing else.

## 5. layout.json

```ts
interface MeshBus extends OwnedElement {          // owner { kind: 'mesh-bus', id }, layer 'overlay'
  id: string;                                     // mesh-bus-1, mesh-bus-2, ...
  class: string;                                  // the authored class
  row: string;                                    // the row group: a cell G#r or the group id
  side: 'top' | 'bottom';
  nodes: string[];                                // members, declaration order
  ports: PortRef[];                               // the bus port of each member, same order
  members: string[];                              // member link ids, n (n - 1) / 2 of them
  bar?: { from: Point; to: Point };               // from 7f on
  stubs?: { node: string; from: Point; to: Point }[];   // from = port face, to = on the bar
  label?: string;                                 // the label id, from stage 9 on
}
interface LayoutModel { meshBuses: MeshBus[]; ... }
interface LayoutLink { meshBus?: string; technique?: Route | 'mesh-bus'; ... }
interface BusBand extends OwnedElement { id: string; bus: string; group: string; side: 'top' | 'bottom'; bounds: Rect }
```

A member link keeps its class, family and layer (`overlay`), gets `meshBus` and
`technique: 'mesh-bus'`. Stage 8 publishes its path as the path along the bus: stub, bar run, stub
(three segments, orthogonal, on the overlay layer). `route/validate` re-derives it and compares, as
for an overlay path. G7 reads each end at the port face through `overlayEndpoint`. Two members
that share a bus port start at one point, which is what a bus is.

**Score.** `segments(layout)` collects routed geometry only, so member paths enter neither the
bends nor the crossings metric, as no overlay path does. Counters gain `meshBuses`. The overlay
report the tickets use (straight, bent) counts a member as `bus`, in a third column, so the
private sheet's same-row bent count is read as 0 and not as 56 hidden links. Gates: G3 reads the
bus label as a label against routed geometry; G7 reads member endpoints; the bus band is overlay
and no gate treats it as an obstacle. `document.overlays` hides a bus with its class.

## 6. Render and draw.io

**SVG.** The bus is one `<g class="mesh-bus overlay <class>" data-id="mesh-bus-1"
data-members="...">` in the masked overlay layer: one `<path>` for the bar and one per stub, each
`link-line overlay-line <class>`, so the theme's class stroke and dash apply (`signal` is
dashed). The member links' own `<g class="link">` elements are not emitted. One endpoint mark per
stub, at the port face, drawn above the mask as every mark is. The label is a model-owned label
(`role: 'mesh-bus'`), text `<class> mesh (<n> nodes)`, `FONT_FAMILY` 9 px, drawn on the label
layer. It is not subject to the overlay density suppression, which reads overlay link labels. The
legend lists the class as it does today. A member's authored label goes to the bus tooltip, with
the member list, and leaves no omission record.

**draw.io.** The bar is one edge with `edgeStyle=none` and two free points, no terminals. Each
stub is an edge from the port's cell (the pill, or the node) to a target point on the bar,
`orthogonalEdgeStyle;jettySize=0`, as an axis-aligned overlay is exported today. Both take the
class stroke and dash the exporter already resolves for an overlay, on the `overlay` layer above
the diagram. The label is a text vertex on the `labels` layer, as a link label is. Verified with
the drawio CLI as the overlay export was (Q70): the drawn bar and stubs read back within 0.05 px.

## 7. Diagnostics

| Code | Severity | When |
|---|---|---|
| `MESH_BUS` | info | A bus formed: row, class, node count, member count. |
| `MESH_BUS_PARTIAL` | info | A same-row same-class set had nodes the bus could not take: names them and the missing pairs. |
| `MESH_BUS_DECLINED` | warning | Reasons: `named-ports` (two or more authored ports at one member), `shape` (`grid` or `bar` group), `second-mesh` (a second clique on a row that has a bus; lifted by ticket 85). |

All three are `stage: 'model'`, with the member links as owners.

## 8. What does not change

- The overlay rule (Q64) for every link that is not a bus member.
- ADR-0011: the title edge is read from routed ports; a bus port is overlay.
- ADR-0021: the plan gains one O5 band and no new part kind.
- Group-links (Q70): a bus is inside one group; a group-link joins two. A link is never both.
- The bundle rules: a bus member is overlay and never a bundle member.

## 9. Acceptance

- `goldens/synthetic/a-full-mesh-on-one-row-draws-as-one-bus.yaml`: one core node on tier 0
  with a routed link to the first and the last of five nodes in one group on tier 1, and ten
  `sync` links among the five. Expected: one bus of five nodes and ten members, one bar and five
  stubs, the title at the bottom and the bus on top, the two routed legs crossing the bar, zero
  bent overlay links, every gate passing.
- Corpus differential gains no gate finding and removes no link.
- Private NTP sheet: same-row bent overlay count 56 to 0, two buses (12 and 3 nodes). Report
  bent overlays, Q, G6, crossings and canvas.

## 10. Open questions for the maintainer

1. **The bus edge is the busy edge.** ADR-0011 puts the title on the edge with fewer routed
   ports, so the edge opposite the title is where the routed feeds enter. On a row fed from above
   the bar runs at 15 px above the bodies, and every feed leg crosses it. The alternative is the
   title edge, between the bodies and the title: nothing else stands there, and the frame grows
   by the same band. The design follows the decision; the alternative is one line in `busSide`.
2. **An authored opt-in** for a partial mesh (a `mesh:` key on the group, or `route: mesh-bus` on
   the links) is not in the first version.
3. **A bus across sibling cells of one canton** (one bar through two frames) is not in the first
   version; the set splits per row.
