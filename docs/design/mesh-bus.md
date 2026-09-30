# Mesh bus — a full mesh on one row draws as one bar

Status: design (ticket 81, 2026-09-30; amended the same day for a bus across frames). Decisions
Q105 and Q106. Implementation: tickets 82 to 85 under `.scratch/ranked-groups/issues/`.

## 1. The problem

The overlay rule draws a link as one straight segment when no node body stands on it (Q64). On one
row, only adjacent nodes can hold a straight segment: a row of `n` nodes fits at most `n - 1`
adjacent pairs. A full mesh of `n` nodes has `n (n - 1) / 2` pairs. Ticket 78 measured that no
order of the row can straighten them. On the private NTP sheet the 56 same-row bent overlay links
are the pairs of two complete sync graphs: one of 12 nodes (66 pairs) and one of 3 nodes
(3 pairs). Each bent pair is an orthogonal detour along the row, and the detours stack.

The maintainer chose one **mesh bus** (2026-09-30) over arcs above the row, over the detours and
over hiding the non-adjacent pairs.

**The first design assumed one group.** Ticket 82 measured the premise on the private sheet and
it failed: the 12-node mesh is spread over six location frames of two nodes each, one row of
frames on one sub-tier, and the 3-node mesh over three one-node groups. Also 60 of the 69 overlay
links at those two rows are members of group-links (one complete group-level mesh: 15 group-links
among the six groups, four members each, two nodes a side), which aggregation had taken out of the
candidates. With a bus confined to one group the sheet got no bus, and its sync links stayed as
long horizontal lines above and below the servers, each with its own "sync" label. The maintainer
chose **a bus across frames** (2026-09-30, Q106): one bar in the sub-tier gap beside the row of
frames, one stub per member that leaves its frame through the frame edge, the band reserved in
that gap by placement. The rule for the side stands: the edge that fewer legs cross, the title
edge on a tie.

## 2. The rule in one paragraph

When the overlay links of one class join every pair of a set of three or more nodes on one
**row** (the nodes of one sub-tier, in whatever groups), they draw as one **bus**: one straight
**bar** along the row on the horizontal edge that fewer legs cross (the title edge on a tie), one
short **stub** from each member node to the bar, and one label. When every member stands in one
frame the bar stands inside that frame, in its padding or its rank gap. When the members stand in
several frames the bar stands in the sub-tier gap beside the row, outside every frame, and each
stub leaves its frame through the frame edge. The member links stay in the document and in
layout.json. A group-link whose members the bus takes is dissolved. Only the drawing aggregates
them. The bus is decided at stage 1 from the document. Its space is reserved during placement.
Nothing about it is found during routing.

## 3. Detection (stage 1)

Detection runs after aggregation (stage 1 step 3) and before bundle membership (step 4). It reads
the document, the resolved families and the aggregations only.

**Row.** A row is the set of nodes that stand on one sub-tier: the nodes of every rank cell `G#r`,
one-rank group and `row` group of that sub-tier, in every frame and canton of the sheet. A node of
a `grid` group, a `bar` group or a flank is not on a row: a grid packs its nodes in several lines,
a bar spans the tier, and a flank stands beside the tier. Detection runs per row, so a set of
nodes on two sub-tiers splits by sub-tier, and the links between the two parts stay plain overlay
links.

**Candidate links.** An overlay-family link (step 2) with no authored `route:`, whose two ends are
nodes of one row. A member of an overlay group-link (step 3) is a candidate: aggregation says how
many lines stand for a set, and the bus is the stronger aggregation of the same links. A member of
a routed group-link is not overlay and is not a candidate. Candidates are grouped by row and by
class. A link with an authored `route:` is not a candidate, as for a group-link; `route: overlay`
on every member is the opt-out.

**The bus.** For each row and class, take the graph of candidate links. Find its maximal cliques
(Bron-Kerbosch with pivoting; a row holds tens of nodes, and the scale envelope of degree 64 or
less bounds the work) and read them largest first; ties between cliques of equal size go to the
clique whose sorted declaration indices come first, compared one by one. The first clique of three
or more nodes that passes the checks below is the bus. The bus takes every candidate link among
its nodes.

**Checks.** A clique that holds a node of a `grid` group, a `bar` group or a flank is declined
(`MESH_BUS_DECLINED`, `shape`). A clique in which the member links at one node name two or more
different authored ports is declined (`named-ports`, see Ports). The next clique is then read.

**Partial mesh.** A set that misses pairs is not one bus. The largest complete part becomes the
bus, and the rest stays plain overlay links, drawn by the overlay rule from their own ports. So a
12-node set that misses two disjoint pairs gives a bus of 10 nodes and 19 plain links.
`MESH_BUS_PARTIAL` (info) names the nodes left out and the pairs that are missing.

**Group-links.** A group-link is one line that stands for the complete bipartite set of same-class
links between two groups. When the bus takes every member of a group-link, the group-link is
**dissolved**: it leaves `groupLinks`, its members lose `groupLink`, and the bus draws them. The M1
render draws no group-link line today: it draws the members one by one and names the group-link in
each member's tooltip (`render/index.ts`); after the dissolution the bus tooltip names it. The
score counter `groupLinks` falls by the dissolved count, and the `ROUTE_UNSUPPORTED` warning that
`recordAggregations` gives an inferred group-link (its members as owners) is removed with it. When the bus takes only some of its members, the
group-link is dissolved too, because its set is no longer complete and a near-complete set is
drawn as its members (CONTEXT.md, *group-link*): the members the bus did not take become plain
overlay links from their own ports. `MESH_BUS` names every dissolved group-link; `MESH_BUS_PARTIAL`
names a group-link that lost only some members and counts the ones left plain. A group-link is
never kept beside a bus that holds one of its members.

**Overlapping cliques and a second mesh.** In the first version a row holds at most one bus. A
second clique of three or more nodes on the same row, of the same class or of another class, is
reported as `MESH_BUS_DECLINED` (`second-mesh`) and its links stay plain. Ticket 85 lifts the
limit: buses of one row stack their bars outward.

**Ports.** The bus needs one port per member. The parser gives each bare link end its own
anonymous port, so a member of a 12-node mesh carries 11 anonymous ports today and its node is
sized for them (invariant 3). Stage 1 collapses them: the **bus port** of a member is the
lowest-ordinal anonymous port among its member-link ends, every member link's end at that node is
re-attached to it, and the other anonymous ports of those ends are removed, unless another link
uses them. When the member-link ends at a node name one authored port (some ends may be bare), that port is
the bus port and keeps its pill, and the bare ends move onto it. When the member links at one node name two or more different authored
ports, the bus is declined (`MESH_BUS_DECLINED`, `named-ports`): a named port is a drawn pill with
a meaning of its own, and the design does not merge two of them. `SHARED_PORT` does not warn on a
bus port.

**Authored overrides.** No new syntax in the first version. Opt-out is `route: overlay` on the
member links. An authored opt-in for a partial mesh is an open question (Section 10).

## 4. Placement

**Two placements.** A bus has one of two placements, decided at stage 1 from the row and the
frames: **in-frame** when every member stands in one frame (one cell, one one-rank group or one
`row` group), and **across-frames** otherwise. The placement is fixed with the bus; a member's
frame is a fact of the document. Both placements share the side rule, the bus port, the label
and the band; they differ in where the bar stands and in what reserves the band.

**Side.** The bus stands on the horizontal edge of the row that fewer legs cross (maintainer,
2026-09-30: *"whichever has fewer legs"*). The **leg count** of an edge is the number of verticals
placement will put across the bus band on that edge, within the bar's span (from the first bus
port to the last, in the row's order):

1. one for each routed, non-stub port on that side of a node of the row that stands in the span, a
   member or not (the leg of that port);
2. one for each vertical of a planned part of the sub-tier gap on that edge (ADR-0021) that stands
   over the span: the legs and drops of the ports of the tier across the gap, and of ports of the
   row's own nodes outside the span whose part runs back over it;
3. one for each lane through that gap over the span, transit or foreign.

For an in-frame bus in a frame padding only term 1 can be non-zero, as before: a lane is reserved
beside the cells it crosses and so outside the span, and a drop of another tier runs outside the
group box. For an in-frame bus in a rank gap, term 2 counts the parts of that rank gap that stand
over the span. For an across-frames bus the span covers the gaps between the member frames, so
lanes and the parts of the other tier stand over it. A lane crosses the bar on either edge, so term 3 counts the same on
both and decides nothing; it is counted so that the label read (below) and the count read one
list. The title edge is a candidate: for an in-frame bus the bar stands between the bodies and the
title, and the title moves out by the bus band; for an across-frames bus the stub crosses the
title band (see Stubs). **Tie rule:** the title edge wins. For an in-frame bus that is the edge of
the group's title; a cell of a frame that has no title edge of its own (a middle cell) takes, on a
tie, the edge on the frame's title side, so the buses of one frame stack the same way; a frame with
no title edge (`frameSide` gives none) takes the bottom. For an across-frames bus the title edge
is the edge on which more of the member frames carry their title, read by ADR-0011's rule from the
routed ports; when as many carry it on each edge, or none has one, the bottom. A canton's title is
the canton's and does not count. `busSide` (`bands.ts`) reads the counts; the answer is one of
`top` and `bottom`, never `left` or `right`.

ADR-0011 is not changed: the title edge is still read from routed ports, and `bandSide` and
`frameSide` count only routed ports, so a bus port never moves a title. On a row whose feeds all
enter one edge the two rules agree: the title and the bus take the other edge, and the bar is
crossed by nothing. They differ where the routed ports of the row's nodes outside the span decide
the title, and the span itself is quieter on the other edge. The bus side of a cell in the middle
of a frame is a rank gap. That is accepted: the bar lies in the gap and the routed parts of that
gap cross it as verticals.

**Bus port side and order.** Stage 2 gives a bus port a provisional bus side for sizing: term 1
read from the stage-2 sides, over every node of the row, because the row's order and so the span
are not known before the skeleton. Stage 3 counts it as one port on that side. Stage 5 reads the
counts again after the routed sides are settled (a shared port recomputes its majority, which can
change a side and the title edge), now within the span read off the skeleton order, and moves the
bus port if the side changed. Term 1 is exact at that read (port sides and row order). Term 2 has
no plan yet at stage 5 (the ADR-0021 plan is made in 7a): stage 5 reads it as the routed ports of
the tier across the gap on the side that faces the gap, and the routed ports of the row's nodes
outside the span whose other end stands over it, each at its skeleton x. Term 3 is not read at
stage 5: lanes are reserved in 7a, and a lane counts the same on both edges. All inputs are
deterministic (sides, skeleton order and x), so the read is. Term 2 is provisional, because 7a to
7f move x, and the side is still fixed at the freeze. That is accepted: a leg that moves into the
span after the freeze crosses the bar as one vertical, as term 1's legs do, and nothing is
discovered in routing. No gate sees such a crossing (the bar is overlay, and every gate and the
crossings metric read routed geometry), so the differential report of ticket 84 counts, for each
bus, the verticals that cross the bar in the published layout on each edge against the stage-5
count. The read comes before stage
5 resizes the nodes and repacks the rows, so the move is one more side change of that one resize,
and no group, tier band or frame has been measured from the old side. That stage-5 read is the one
that stands: the side is fixed at the freeze and 7f never moves the bus, whatever verticals its
label read finds. Stage 5 never gives it left or right from the row order, as it does for another
same-tier overlay port. The bus port is the last port in engine order on its side; an authored
`order:` on a named bus port wins. Identity, count and side are fixed at the freeze at the end of
stage 5 (invariant 4).

**Where the bar stands, in-frame.** Let `L` be the line of the outermost body or pill extent of
the row on the bus side, the line the frame padding is measured from. The bar runs at
`L + BUS_STUB` (15 px, the port-stem convention), from the x of the first member's bus port to the
x of the last, inside the frame padding or the rank gap. A stub runs from its port's outward face
(the pill face for a named port, the body edge for an anonymous one) straight out to the bar; it
is at least 15 px long. The bar and the stubs take the class's overlay stroke and dash.

**Where the bar stands, across-frames.** The bar runs in the sub-tier gap on the bus side, at one
y over the whole span, outside every member frame. Let `L` be the outermost frame edge on the bus
side among the frames of the row that stand in the span, member frames and foreign frames alike
(the frame box, with its padding and its label band), or, for a row that is a middle cell of its
frame, that cell's body extent. A foreign frame under the bar is read so that the bar clears it. The bar runs at
`L + BUS_STUB`, which is more than the group edge clearance `e` (`GROUP_EDGE_LINK_CLEARANCE`,
10 px) plus half the stroke, so the bar keeps from every member frame edge the distance G6
`segment-group-edge` asks of a routed segment that runs along an edge. G6 does not read the bus
(it is overlay), and the design keeps the distance for the reader's eye. Between two member
frames the bar crosses the column slack and any lane that stands there. No node body stands in a
tier gap (every body stands in its sub-tier band), so nothing but verticals crosses the bar. The
one exception is a foreign multi-rank frame in the span whose rank gap is this gap: the bar would
run through a foreign frame. The order of ticket 84 keeps member frames contiguous, so the case
needs a foreign frame between two member frames; it is open (Section 10).

Where a member frame spans the gap on the bus side, the bar runs inside that frame and crosses its
side edges perpendicular: the row is a middle cell of a multi-rank frame, so the gap is its rank
gap, or the row is inside a **canton**, so the gap is inside the canton frame. The bar crosses a
canton frame edge as a stub crosses a member frame edge, once, perpendicular. **Decision: one bar
per row, across cantons** (Q106). A split per canton would leave every pair between two cantons
as a plain overlay link, `n_a × n_b` of them, which are the long lines the bus removes: 36 of 66
for a 12-node mesh split six and six. The tier gap is one height for the whole sheet
(canton-groups design, Section 3), so one band over the span serves every canton at once, and a
per-canton band would gain nothing from the plan. The bus is not a routed link: ADR-0013's rule
that a foreign link never enters a canton reads lanes, and a bus whose members the canton holds is
not foreign to it.

**Stubs, across-frames.** Each member's bus port is on the bus side, so the stub leaves the body
toward the bar. It runs straight from the port face, through the frame padding and, on the title
edge, through the label band, out through the frame edge, perpendicular to it, and on to the bar.
Where the row is a middle cell the stub crosses the cell edge (no padding) into the rank gap. The
frame padding on that side holds the stub as it holds a routed leg: nothing else is put at the
stub's x. A stub never runs along an edge, so G6 `segment-group-edge` has nothing to read on it.
The stub of a member whose frame edge stands nearer the row than `L` is longer by the difference;
a stub is at least 15 px.

**A stub through a title band.** On the title edge of a member frame the stub crosses the label
band. The title stands clear of it the way it stands clear of a routed leg (ticket 62, Q103):
`legRects` (`bands.ts`) reads the bus stub as a leg of the band's ports, `titleX` places the title
on the free x nearest the centre, and where no x on the edge clears the stub the frame widens by
the title and the clearances beside the port (`growthPlan`) where that is lane-feasible. Where it
is not, the title goes to the other horizontal edge (`MESH_BUS_TITLE_MOVED`, info), and that edge
runs the same ticket 62 and 66 rules against its routed legs, which end as today. The title is
not moved first, because the other edge is the fed edge and its feed legs cross the band at the
same x as often as the stub does: a one-node frame fed at its centre port and bussed at its centre
port has a vertical through the middle of both bands. So the nudge is unavoidable, and the title
keeps its ADR-0011 edge. The stub's x is the bus port's x, known at the freeze, so the title is
placed in 7f and nothing waits for routing.

**Bus band.** The reserved space on the bus side is the **bus band**: from `L` out to the bar,
plus the room beyond it. With a label the room is `4 px + label height + 4 px`; without one it is
the run clearance `k` (11.5 px). The band is about 34 px with a label and 27 px without. For an
in-frame bus the band lies against the 20 px of frame padding, so the frame grows on the bus edge
by the difference, as a bottom label band grows a group (ADR-0011). On the title edge the band
lies between the bodies and the label band: the label band's `clearance` grows by the bus band,
the title moves out by it, and the frame grows by the whole band. For an across-frames bus the
band lies in the sub-tier gap and belongs to no frame: it is held by the sub-tier, as a canton's
title band is (canton-groups design, Section 3), as wide as the span, on the edge outside the
member frames. Where the row is the last (or first) tier of a canton and the bus is on that edge,
the band is added to the canton box between the member frames and the canton's title band, the
canton title band moves out by it, and the canton frame grows by the whole band, as an in-frame
band grows a frame on its title edge. The label stands beyond the bar, centred on the bar's
midpoint, at heading 0 (ADR-0014). When a vertical that placement puts across the band crosses the
centred label box (a leg of term 1, a part of term 2, a lane of term 3, or a transit lane beside
the span that a label wider than the bar can reach), the label takes the longest clear interval of
the bar between two consecutive stubs and verticals; when no interval holds it, it goes to the
tooltip and `labelsOmitted` counts it.

**Who reserves it.** Three steps, all in placement, in pipeline order:

1. Stage 7f `produceGroupLabelBands` calls `reserveInitialSpace`, which grows a group by the room
   its label band still needs. For an in-frame bus it counts the bus band the same way on the bus
   side (`groupInsets` gains it), so the group grows and the tiers below move before the tier-gap
   growth. For an across-frames bus the band has no host: the shift loop of `reserveInitialSpace`
   requires the gap on the bus side to hold 20 + band + 20 (the frame margins on both sides and
   the band), and moves the lower tiers by the shortfall, as it does for a canton title band. Where
   a canton title band stands on the same edge, the need is 20 + bus band + canton band + 20.
   `cantonGapNeeds` takes the larger of the needs of one tier edge, and the loop the larger of the
   two edges of a gap; a bus band adds to a band on its own edge and never takes the maximum with
   it. The skeleton (stage 4)
   reserves no band, for a title or for a bus.
2. Stage 7f `produceBusBands` runs beside `produceGroupLabelBands`, before the tier-gap growth and
   again after it. It publishes the `BusBand` with its bounds and the bar and stub geometry read
   off the settled row and frames. `rebuildFrames` adds an in-frame band to the frame edge as it
   adds the label band, and a band on a canton's outer edge to the canton box; an across-frames
   band outside every frame is added to none.
3. The tier-gap plan (ADR-0021) reads the bus band as an O5 band anchored to the row's sub-tier
   band over the bar's span, plus `k`. No planned row lies inside it. Every vertical of the leg
   count crosses the bar as one vertical, and that crossing is accepted. `growTierGaps` grows the
   gap by the formula and probes nothing.

Publication and restore re-run the band on a copy and reject a model it would still change, as
they do for label bands.

**Interaction with the other overlay rules.** A bus member link is not a chord. `straightOverlays`
(two functions of that name, in `columns.ts` and `centre.ts`: the count the column and centring
passes hold) leaves bus members out; they are neither straight nor bent. `stepOverChords`
(ticket 77) does not read them. `placeOverlayFree` already leaves out same-tier partners. The
overlay order of ticket 78 reads the members of a bus as one contiguous block: every pair inside
the block is satisfied by contiguity, and a foreign node under the bar costs bar length and nothing
else. For an across-frames bus the block is a block of frames: `orderFramesByOverlay` keeps the
member frames contiguous in the tier, and a foreign frame under the bar costs bar length only. The
frame keep-out of ticket 75 and the column packing are not changed: the bar crosses the slack
between columns and asks no column to move.

## 5. layout.json

```ts
interface MeshBus extends OwnedElement {          // owner { kind: 'mesh-bus', id }, layer 'overlay'
  id: string;                                     // mesh-bus-1, mesh-bus-2, ...
  class: string;                                  // the authored class
  row: number;                                    // the sub-tier of the row
  placement: 'in-frame' | 'across-frames';
  frames: string[];                               // the frames (or the one group) the members stand in, tier order
  side: 'top' | 'bottom';
  nodes: string[];                                // members, declaration order
  ports: PortRef[];                               // the bus port of each member, same order
  members: string[];                              // member link ids, n (n - 1) / 2 of them
  dissolved: string[];                            // group-link ids the bus dissolved (their former ids; the tooltip names them)
  bar?: { from: Point; to: Point };               // from 7f on
  stubs?: { node: string; from: Point; to: Point }[];   // from = port face, to = on the bar
  label?: string;                                 // the label id, from stage 9 on
}
interface LayoutModel { meshBuses: MeshBus[]; ... }
interface LayoutLink { meshBus?: string; technique?: Route | 'mesh-bus'; ... }
interface BusBand extends OwnedElement { id: string; bus: string; group?: string; side: 'top' | 'bottom'; bounds: Rect }
                                                  // group: the host frame of an in-frame band; none across frames
```

A member link keeps its class, family and layer (`overlay`), gets `meshBus` and
`technique: 'mesh-bus'`, and has no `groupLink`. Stage 8 publishes its path as the path along the
bus: stub, bar run, stub (three segments, orthogonal, on the overlay layer). `route/validate`
re-derives it and compares, as for an overlay path. G7 reads each end at the port face through
`overlayEndpoint`. Two members that share a bus port start at one point, which is what a bus is.

**Score.** `segments(layout)` collects routed geometry only, so member paths enter neither the
bends nor the crossings metric, as no overlay path does. Counters gain `meshBuses`. The overlay
report the tickets use (straight, bent) counts a member as `bus`, in a third column, so the
private sheet's same-row bent count is read as 0 and not as 56 hidden links. Gates: G3 leaves
out every label on the overlay layer (`gates.ts`), as it does for an overlay link label, so the
bus label, owned by an overlay bus, is read by G3 only if ticket 84 adds the role `mesh-bus` to
what G3 reads; ticket 84 does so, against routed geometry. G7 reads member endpoints; G9 is not
changed (it reads frames against frames and bodies, and the bar is neither); the bus band is
overlay and no gate treats it as an obstacle. No gate reads a vertical that crosses the bar
(Section 4, *Bus port side and order*).
`document.overlays` hides a bus with its class.

## 6. Render and draw.io

**SVG.** The bus is one `<g class="mesh-bus overlay <class>" data-id="mesh-bus-1"
data-members="...">` in the masked overlay layer: one `<path>` for the bar and one per stub, each
`link-line overlay-line <class>`, so the theme's class stroke and dash apply (`signal` is
dashed). The member links' own `<g class="link">` elements are not emitted; a dissolved group-link has
no line today (M1 draws its members), and the bus tooltip names it. One endpoint mark per stub, at the port face, drawn above the mask
as every mark is. The label is a model-owned label (`role: 'mesh-bus'`), text
`<class> mesh (<n> nodes)`, `FONT_FAMILY` 9 px, drawn on the label layer. It is not subject to the
overlay density suppression, which reads overlay link labels. The legend lists the class as it does
today. A member's authored label goes to the bus tooltip, with the member list and the dissolved
group-links, and leaves no omission record.

**draw.io.** The bar is one edge with `edgeStyle=none` and two free points, no terminals. Each
stub is an edge from the port's cell (the pill, or the node) to a target point on the bar,
`orthogonalEdgeStyle;jettySize=0`, as an axis-aligned overlay is exported today. Both take the
class stroke and dash the exporter already resolves for an overlay, on the `overlay` layer above
the diagram, so an across-frames stub draws over the frame edge it crosses, as a routed leg does.
The label is a text vertex on the `labels` layer, as a link label is. Verified with the drawio CLI
as the overlay export was (Q70): the drawn bar and stubs read back within 0.05 px.

## 7. Diagnostics

| Code | Severity | When |
|---|---|---|
| `MESH_BUS` | info | A bus formed: row (sub-tier), class, placement, node count, member count, the frames spanned, the group-links dissolved. |
| `MESH_BUS_PARTIAL` | info | A same-row same-class set had nodes the bus could not take: names them and the missing pairs; names a group-link that lost only some members to the bus and counts the members left plain. |
| `MESH_BUS_DECLINED` | warning | Reasons: `named-ports` (two or more authored ports at one member), `shape` (a member in a `grid` or `bar` group or a flank), `second-mesh` (a second clique on a row that has a bus; lifted by ticket 85). |
| `MESH_BUS_TITLE_MOVED` | info | A member frame's title left its ADR-0011 edge because no position and no widening cleared the stub (stage `placement`, the frame as owner). |

The first three are `stage: 'model'`, with the member links as owners.

## 8. What does not change

- The overlay rule (Q64) for every link that is not a bus member.
- ADR-0011: the title edge is read from routed ports; a bus port is overlay. The bus side is a
  rule of its own (fewer legs, the title edge on a tie) and moves no title. A title stands clear of
  a stub as it stands clear of a leg (ticket 62, Q103); the move to the other edge is the last
  resort and is reported.
- ADR-0021: the plan gains one O5 band per bus and no new part kind. The tier gap stays one height
  for the sheet.
- ADR-0019 and the canton design: frames, columns, the column slack and the canton box are derived
  as today; a band on a canton's outer edge is added to the canton box as its title band is.
- Group-links (Q70): aggregation runs first and is not changed. A bus dissolves the group-links it
  takes members from, and a link is never both a bus member and a group-link member.
- The bundle rules: a bus member is overlay and never a bundle member.

## 9. Acceptance

- `goldens/synthetic/a-full-mesh-on-one-row-draws-as-one-bus.yaml`: one core node on tier 0
  with a routed link to the first and the last of five nodes in one group on tier 1, and ten
  `sync` links among the five. Expected: one in-frame bus of five nodes and ten members, one bar
  and five stubs; the title is at the bottom (fed from above), the top edge has two legs and the
  bottom none, so the bus is at the bottom too, between the bodies and the title, and the title
  moves down by the band; no leg crosses the bar; zero bent overlay links; every gate passing.
- `goldens/synthetic/a-bus-leaves-a-title-edge-with-more-legs.yaml`: a row of seven nodes, the
  first five in a `sync` mesh, the core above feeding the first and the fifth, and the sixth and
  seventh each feeding three nodes of a tier below. ADR-0011 counts top 2 against bottom 6 and
  puts the title on top; the span holds two legs on top and none at the bottom, so the bus is at
  the bottom, opposite the title. The reverse fixture is the first one above. A tie (one leg on
  each edge inside the span) takes the title edge; an inline test covers it.
- `goldens/synthetic/a-mesh-across-frames-draws-one-bus.yaml` (generic names): three groups of
  two nodes on tier 1, a core on tier 0 feeding one node of each group, and a full `sync` mesh of
  the six nodes: 15 links, of which 3 join two nodes of one group and 12 form three group-links of
  four members. Expected after stage 1: one across-frames bus of six nodes and 15 members, three
  group-links dissolved, `MESH_BUS` once, no group-link in layout.json. After placement: the
  titles are at the bottom (fed from above), the top gap holds three legs over the span and the
  bottom none, so the bar runs in the tier gap below the row, 15 px below the lowest frame edge,
  one straight segment across the three frames; six stubs, each through its frame's bottom padding
  and label band and out through the frame edge; each title nudged clear of its stubs or its frame
  widened, and `MESH_BUS_TITLE_MOVED` not reported; no group-link line; zero bent overlay links;
  every gate passing.
- `goldens/synthetic/a-mesh-of-one-node-groups-draws-one-bus.yaml`: three one-node groups on one
  tier, fed from above, three `sync` links (no group-link: a group-link needs two nodes a side).
  Expected: one across-frames bus of three, a stub through the centre of each frame's bottom
  band, each title nudged beside its stub, or the frame widened by the title.
- `goldens/synthetic/a-bus-across-cantons-crosses-the-canton-edges.yaml`: two cantons of two
  tiers each, a router on the upper tier of each feeding two servers on the lower tier of its
  canton, a full `sync` mesh of the four servers (six links, one group-link of four members
  between the two server groups). Expected: one bus of four across the two cantons; the bar runs
  inside each canton frame on the lower tier's bottom edge, between the server frames and the
  canton title band, crosses each canton's side edge perpendicular and the slack between the
  cantons; each canton frame grows by the band on its bottom edge and its title moves out by it;
  no gate finding (G9 reads no foreign body, G6 no routed segment).
- Corpus differential gains no gate finding and removes no link. An input that holds a same-row
  mesh across groups it did not hold before is reported; where a fixture's purpose is unrelated to
  the bus it takes `route: overlay` on those links (the opt-out), as ticket 82 did for
  `a-corridor-moves-after-the-grid-settles`.
- Private NTP sheet: same-row bent overlay count 56 to 0; two across-frames buses (12 nodes over
  six frames, 3 nodes over three one-node frames); 15 group-links dissolved; the repeated "sync"
  labels at those rows replaced by two bus labels. Report bent overlays, Q, G6, crossings, canvas
  and the node widths of the 12-node row before and after.

## 10. Open questions for the maintainer

The bus side was open (the busy edge against the title edge) and is answered: *"whichever has
fewer legs"* (maintainer, 2026-09-30), Section 4. A bus across frames was open and is answered:
one bar in the gap beside the row of frames (maintainer, 2026-09-30, Q106).

1. **An authored opt-in** for a partial mesh (a `mesh:` key on the group, or `route: mesh-bus` on
   the links) is not in the first version.
2. **A group-link taken in part** is dissolved and its rest drawn as plain links (Section 3). The
   alternative, a bus that takes a group-link whole or not at all (the clique then shrinks to
   whole groups), keeps the group-link line but changes the clique rule; it is not built. No input
   of the corpus reaches the case; the first that does decides.
3. **The nudged title of a one-node frame** stands beside its stub, off-centre. The first render
   of `a-mesh-of-one-node-groups-draws-one-bus` shows whether that reads well; the alternative is
   the bus port at the body's outer x instead of the engine's centre.
4. **A foreign frame in the span that spans the gap** (a multi-rank frame whose rank gap is the
   bus gap, between two member frames): the bar would run through it. The bus is decided at stage
   1 and the order at stage 4, so a decline would have to come after the freeze. Until the
   maintainer decides, the bar crosses that frame's side edges perpendicular, as it crosses a
   canton. No input of the corpus is known to reach the case; ticket 83 reports any that does.
