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

Stage 0 returns a serialisable **normalised document** (`NormalisedDocument`). Stage 1 wraps that
document in the **layout model** (`LayoutModel`); stages 1–11 read and write that model. The layout
JSON is the serialised `LayoutModel` that `render` and `score` consume. No stage touches the DOM.

Three principles, each learned the hard way:

1. **Decide meaning before geometry.** Which technique a link gets (override, aggregation,
   overlay, bundle membership) is decided in stage 1 from the document alone. Only *geometry-
   dependent* choices (straight eligibility, stub) wait for a trial route.
2. **Reserve space before using it.** Lanes, bands, bar spans and bundle rows are allocated while
   placing, never discovered while routing.
3. **Freeze topology before pinning.** Port identity, count, side and author `order:` freeze in
   stage 5. Engine-selected order and geometry may still change only where a later stage says so.
   Dimensions never shrink below their current content or author floor. Anything a later stage
   moves must be re-validated; placement freezes after stage 7f.

Every stage that counts turns or crossings reads one predicate for each (decision review 2026-11, D-Q6). A turn is
`pieceTurns` of `src/geometry/planar.ts` (`pathBends` reads a link with it): a change of direction or a reversal, a
collinear or zero-length piece is no turn. A proper crossing is `strictCrossing` of `src/layout/read/crossings.ts`: two
segments meet at a point that is farther than the planar `EPS` from every end, never a fraction of the segment. The course
round counts the links a polyline crosses with `polylinesCross`, a pair once. Tolerances have named owners
(`src/layout/tolerance.ts`, `src/geometry/planar.ts`); `CODING_STANDARDS.md` R10 states the rule.

---

## Stage 0 — parse

YAML → validated and normalised document (`NormalisedDocument`; `schema.md`). Diagnostics are staged: **parse-time** (references,
structure, identifiers), **model-time** (after normalisation: tier inference, families,
port allocation), **placement-time** (capacity, facing ports — see stage 7b) and **final-geometry**
(gates). A diagnostic is never emitted before its inputs exist.

## Stage 1 — resolve techniques (semantic)

For every link, in this fixed order, from the document only:

1. **Author `route:`** — selected first. Syntax and `group-link` endpoint shape are validated now;
   `merge` membership is validated after bundle grouping in step 4.
2. **Family** — from class via the profile: `routed` or `overlay`. Resolved before aggregation,
   because aggregation's eligibility reads it; Q30's precedence names only the steps that may
   *override* a family, and this is the step that establishes one.
3. **Aggregation** — a set of links forms a group-link only if: both endpoint groups have ≥ 2
   nodes, the links are the **complete** bipartite set between them, all share one class and
   family, and none carries an override. Membership (every member link, its ports, class) is
   retained in the model and rendered as a tooltip/legend entry, never discarded. Aggregation
   decides **how many lines stand for the set, never on which layer they are drawn**: the
   group-link takes its members' family layer, and each member keeps its own. An authored
   `route: group-link` names the aggregation and leaves the family's layer alone.
3a. **Mesh bus** — overlay links of one class, with no authored `route:`, whose two ends stand on one
   sub-tier (the `tier` of the layout group that holds each end: a rank cell, a one-rank group or a
   `row` group, in any frame or canton) form a graph per row and class. A member of an overlay
   group-link is a candidate; a routed group-link is not. The maximal cliques of ≥ 3 nodes
   (Bron-Kerbosch with pivoting) are read largest first, ties by declaration order, and the first
   one that passes the checks is the bus. A clique with a node of a `grid` or `bar` group or a flank
   is declined (`shape`); one where a member holds two authored ports is declined (`named-ports`).
   Only the clique taken removes edges, so a declined clique hides no other. The member links get
   `meshBus` and `technique: 'mesh-bus'`, and each member node keeps one port for the bus (the
   lowest-ordinal anonymous port of the member ends, or the one authored port, onto which bare ends
   move). One bus per row; a clique with no node in the bus is declined as `second-mesh`. A
   group-link that lost a member to the bus is dissolved, whole or in part: it leaves `groupLinks`,
   its members lose `groupLink`, its inferred `ROUTE_UNSUPPORTED` warning goes, and the bus keeps its
   ids in `dissolved`. The bus records `placement` (`in-frame` or `across-frames`) and `frames`.
   `MESH_BUS`, `MESH_BUS_PARTIAL` and `MESH_BUS_DECLINED` report it. The step runs on the final
   model, after the ranked groups are cells, and reads the document only, so resolving
   `model.document` reproduces it. No geometry until tickets 83 and 84 (`docs/design/mesh-bus.md`,
   Q105, Q106).
3b. **Fan family** — after the mesh buses, `detectFanFamilies` (`src/resolve/fan-family.ts`) groups the
   dashed or dotted routed links (no bundle, group-link or bus member, no authored route but `straight`,
   no shared port, no flank or bar end) whose ends stand on adjacent document tiers in two different
   units (outermost frame, canton or free group), by the hub's tier group and the class. A cohort with
   ≥ 2 hubs, ≥ 3 units and complete incidence is a family: `model.fanFamilies`, `link.fanFamily`,
   `FAN_FAMILY`. A link two families claim declines both (`FAN_FAMILY_DECLINED`). Nothing is written on a
   sheet with no family. It reads the document only, so resolving `model.document` reproduces it. The
   admission, the reservation and the score are in `docs/design/routed-chords.md` Section 16 (ticket 40).
3c. **Complete solid block** — ticket 83 detects a complete solid node relation on adjacent document tiers after the faint fan-family pass.
   It supersedes inferred aggregation, counts far nodes within a canton, and records solid ownership for full crossing weight.
   `docs/design/routed-chords.md` Section 17 states its limited scope.
4. **Bundle membership** — ≥ 2 routed links between the same node pair (ports may differ) that
   leave each shared node on one authored side; links whose authored sides differ at a shared node
   form separate cohorts, and a cohort of one stays routed with a `BUNDLE_MIXED_SIDES` warning
   (ticket 35). After
   grouping, a selected `merge` override without membership in a bundle of at least two is a
   model-time error.
5. **Stub** — deferred: needs a trial route (stage 8 marks candidates; stage 9 applies).

**M1 behaviour:** `stub` and `group-link` are parsed and recorded but not applied; a warning says
so. A `stub` falls back to a routed line. A `group-link` falls back to its members, each drawn on
the layer its own family chose — an overlay set stays overlay (stress ticket 23). This is explicit,
not silent.

The layout link's `family` records its class-derived family; `layer` is the effective drawing
layer after the override and M1 fallback. Gates and routing use that effective layer. `technique`
also records the effective behavior: an M1 stub/group-link request remains on the source document
link, while its concrete members use orthogonal, bundle or — for an overlay family — overlay
paths. A recorded request therefore
does not receive the missing-path exemption of an actually applied stub.

**Rank cells (ADR-0019).** After the links are resolved, `expandRankedGroups`
(`src/layout/rank-cells.ts`) derives ranks per group (`deriveRanks`, `src/layout/ranks.ts`) and
replaces each group of more than one rank with cells `G#0..G#k-1`. A cell is a `row` group with
`frame: G` on its own sub-tier. Sub-tiers are dense integers. The document gains `frames`. Stages
2–8 learn no new concept: they run on cells. A group of one rank stays as it is. When no group has
more than one rank, the document is unchanged. **Idempotence guard:** a document that already
carries `frames` is never expanded again, because a second expansion would split the cells.
A rank inside a child span becomes cell `child#r` (`frame: child`), not `G#r`. The parent has no
cell at that rank, unless the child is a leaf child.

Rank is the breadth-first depth from the anchors over the routed links inside the group. Two
members of equal depth are joined by a peer link. The node class decides nothing. A **leaf child**
feeds no deeper member and holds no anchor. It keeps its depth ranks and pushes no parent member.
The parent members of its ranks stand in the parent's own cells `G#r`, so one sub-tier holds both
`G#r` and `child#r`. A child that feeds a deeper member, a child that holds an anchor and a
group anchored from below keep the push. `docs/design/ranked-groups.md` § 1 has the full rule.

Group endpoints expand to concrete member-node attachments before placement. Empty groups cannot
supply an attachment and produce a model error. Explicit `group-link` requires two distinct groups
with at least two nodes each. Other group endpoints may expand to ordinary members with a warning;
they do not acquire group-link eligibility solely by using group endpoint syntax. Expansion
multiplies a line, it does not change what the line is: an overlay-family member keeps the overlay
layer and its derived path, a routed one takes the M1 orthogonal fallback.

## Stage 2 — sides, phase one

| Peer is in… | Side |
|---|---|
| a lower tier, or a `bar` group below | `bottom` |
| a higher tier | `top` |
| a flank on the left / right of this node's tier | `left` / `right` |
| this flank's `of` group, with this flank aligned left / right | `right` / `left` |
| the same tier | **undecided** until stage 5 |

Author `side:` on a port always wins. A port with **several peers in different directions** takes
the side of the majority by link count, ties broken in `bottom`, `right`, `top`, `left` order; the other links
leave through that side and route. An **unused port** takes the side with the fewest ports
(ties: `bottom`) and renders last on it.

Same-tier peers remain unresolved until row order exists. For a shared port with both known and
unresolved peer directions, commit the known winner only if allocating all unresolved votes to
either lateral side cannot change that winner, including tie priority. Otherwise defer its side
and retain only a provisional sizing side. Stage 5 recomputes its majority from all peers.

**A mesh bus port** (`docs/design/mesh-bus.md`, ticket 83) has only same-row peers and would take `left`/`right`, but a bus stands on a horizontal
edge. Stage 2 gives it a provisional bus edge for sizing (`sizingSide`): `busSide` (`bus.ts`) with term 1 over every node of the row, read
from the stage-2 sides (a port with no side yet counts by its sizing side), because the row's order and so the span are not known before
the skeleton. Stage 3 counts it as one port on that edge.

## Stage 3 — size

Per node, per side: `pitch(side) = max(12, largest rendered pill extent along that side + 4)`.
The unrotated pill width is measured text (font-metrics table) + 2×3 padding, at least 24 px;
its height is at least 10 px. All generated text uses at least 9 px, including descriptions and port pills.
Placement measures the text at that size before it reserves space. Top/bottom pills and their text rotate −90°; left/right pills
stay horizontal, matching the target JPEG and d3-fd. The extent used for pitch is the rotated
box's width on top/bottom and its height on left/right. Then
`height = max(minH, contentH, n_left|right × pitch + 2·pad)`, `width = max(minW, contentW,
n_top|bottom × pitch + 2·pad)`, `contentW/H` from the measured label, description and icon.
Sizing stores a separation axis for every corner with perpendicular named faces (`portCorners`).
When the centred horizontal face already clears the lateral pill bodies in x, protect that x margin.
Otherwise reserve equal lateral end margins in y. Both choices include the two pill half-strokes.
The face capacity is `(count - 1) × pitch + low inset + high inset` (`portEndInsets`).
Stage 5 replaces provisional choices after final sides and pitches, before the topology freeze.
All later face installers consume the stored insets; publication and restore guard the chosen axis,
including after body growth. An unoccupied corner has no record. Routing discovers no corner room (ticket 156).
The content interior reserves, on each side, the larger of the 10 px content padding and the
largest named pill's inward half-extent plus 4 px. Anonymous ports add no such inset. Store those
content insets so placement centres the icon/text blocks in the remaining interior, which may be
asymmetric; a long port name can therefore grow the normal node dimension without changing pitch.
Author `size:` is a floor. Undecided ports count on their most likely side. Bars are sized in 7d.

**Content style** (ticket 159). A node's content stands as `card` or `stacked`. The document field `layout: { nodeContent: card | stacked }` picks
it; the default is `stacked`. It is a layout input, because it changes node sizes (unlike `theme:`, which only paints). One resolver
(`resolveNodeContentStyle`) decides, in this order: a node of a `bar` group is `stacked` whatever its class and the document value (a bar is a
line-like shape that its own drops cross, so its label stays one centred column between them); else a profile class that states a style
(`NodeClassStyle.content`; the shipped profile states none); else the document's `nodeContent`. The resolver is read inside `measureNodeContent`, so
stage 3 and stage 5 (`rebuildNodeGeometry`) measure and place the same style. A `card` is the 24×24 icon tile (radius 4, glyph inset 3), 8 px, then a
left-aligned text block: the title (11 px, 700) and, only when the node has a description, 2 px and the subtitle (9 px, 400). Line heights are the
text module's (14 and 11). Authored newlines stay; nothing wraps. A card with no icon has no tile and no gap. `contentW = tile + gap + max(title,
subtitle)`, `contentH = max(tile, text block)`, each plus the insets above; the minimums and the port-capacity rule are unchanged. The tile and the
text block are centred together in the inset interior. Ports stay centred on their faces. `stacked` is the column above: icon (12 px), label (9 px),
description (9 px), centred.

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
| `elk.layered.crossingMinimization.semiInteractive` | `true` | **the** mechanism that preserves in-layer order — used with `elk.position` to put a flank's pre-skeleton proxy peer at the outer end (`considerModelOrder` is only a soft preference and does not pin) |
| `elk.layered.nodePlacement.strategy` | `SIMPLE` on compounds with flank proxies | keeps hinted peers at distinct outer positions; the default can stack different-width peers at one x, changing the final outer-edge tie |
| `elk.json.shapeCoords` / `edgeCoords` | `ROOT` | absolute coordinates; no compound-relative conversion in our code |
| `elk.randomSeed` | `1` | default; kept explicit |

**Lateral links (flank↔tier) are withheld** from the ELK graph. Flank groups are placed after ELK
by rule: beside their `of:` tier, on their `align` side, top-aligned with the tier band. A flank
stands as one row here; stage 5 may stand it, or the tier group beside it, as a **column
arrangement** (ticket 52), where the port sides are final.

Primary-peer selection has two explicit phases. Before ELK, choose a **proxy peer** by greatest
link count; a count tie uses declaration row order nearest the flank's side, then node id. Use the
proxy for the `elk.position` outer-end hint. After ELK, choose the stored **primary peer** among
the greatest-count peers by nearest distance to the final row's flank-facing outer edge, then node
id. If it differs from the proxy, update the selection and repack that peer to the outer end while
preserving the other nodes' final row order. Recompute the affected row and group boxes before
stage 5, while no path is pinned. Store the selected peer on the flank; later stages consume it
without reselecting after geometry moves.

If opposite flanks select the same primary in a multi-node row, the first flank in authored
group declaration order owns that peer's outer position. Keep both stored primary IDs and emit
one placement warning identifying the competing flanks and peer. This is an explicit exception
to the outer-end contract for the other flank; its obstructed links remain for routing. A
single-node row satisfies both ends and needs no conflict warning.

**Grid groups repack after ELK, and move every band.** ELK is given one row per group, because its
layered pass is what *orders* the nodes; a `shape: grid` group then takes that order and packs it
into columns and rows (`src/layout/grid.ts`, stress ticket 26). Four consequences are settled here
and not left for a later stage to discover.

1. The rows follow the exits, not the reading order alone. A node whose links leave the group
   **upward** takes the first row, one whose links leave **downward** takes the last, the rest sit
   between them, and ELK's order survives inside each rank. A grid has rows below its rows, so a
   downward port that is not in the last row descends through them, and nothing reserves that —
   `bars.ts` `crosses` tests bar nodes alone.

   **A column is a corridor, so the count obeys the ranks too** (stress ticket 31). A rank cannot
   separate two nodes that exit the same way: they share a rank, a rank is one row, and *k* like
   exits in fewer than *k* columns put two of them in one column with one above the other. The
   column count is therefore bounded below by `max(upward exits, downward exits)`, which forces a
   group whose nodes all exit one way to a single row — the `row` shape, which is what one corridor
   per exit means, and which measures better than the stacked grid it replaces. The bound is the
   count only; the rows are then **built from the ranks** rather than sliced off the ranked order,
   because a count that satisfies the bound can still chunk a downward exit into a row above the
   last. Both the count and the rank read one `exitRanks` map, taken once from `side ?? sizingSide`,
   so they cannot disagree (ADR-0015).

   A node that exits **both** ways is the same rule one step further: it needs the first row and the
   last at once, so the only count that answers it is the node count, and such a group takes one row
   too. Measured, the answer is one-sided — the shipped both-ways fixture publishes 3 violations at
   Q 0.8030 as a grid and 0 at Q 0.9081 as one row.

   One case the bound does not reach: a side stage 5 overturns was read by stage 4 as something
   else. Stage 7d warns `BAR_DROP_OBSTRUCTED` for it rather than publishing a reserved run through a
   node body in silence; no shipped fixture reaches it.

   The count is also now scored on the arrangement the grid will really pack, which changes which
   counts tie. The tie still goes to the fewer columns.
2. A flank's stored primary peer takes the outer end of **its own row**, which is what the lateral
   link runs along; a ragged row that holds a right-aligned peer is packed against the right columns
   rather than the left.
3. **A group that holds both ends of a link owes that link its space, and a stacked shape has to
   earn it** (stress ticket 32). A row gives it for nothing — every node of a row stands on one
   line, so the two bodies are beside each other in an order the row fixes, with only the row gap
   between them. Two faults, and **two different answers**, because the measurements give two
   different answers.

   **A bundle: decide its direction before the rows are stacked** (architecture ticket 23, Q117). Its
   members turn in a **channel**, the space between the two endpoint bodies along the bundle's own
   normal; `parallelPaths` reads it as the signed difference of the two port faces, and
   `straightPaths` beside it reads the same difference for `BUNDLE_CROSSOVER_CAPACITY`, and neither
   asks whether the two faces are in order. Measured on the gridded golden with `shape: grid` on
   `datacenter`: with the endpoints in one row and adjacent, `EAC-02` grew to 322.75 px tall in
   `EBR-02`'s own column and covered it — `BUNDLE_CHANNEL_BLOCKED`; with them in different rows,
   pre-ticket-31 code packed `[EAC-01 EBR-01 EAC-02] / [EBR-02]` and reported `have -368.25`, two
   faces out of order. Both faults have one cause: nobody decided the bundle's direction before the
   rows were stacked. It is decided now, from the document alone (`stackChains`, `grid-chains.ts`):
   the enclosed bundles of the group form **chains** (simple paths); stage 2 fixes the member ports
   (`bottom` on the upper end, `top` on the lower), stage 3 gives the chain nodes the widest chain
   width as a floor, and the packer seats each chain as one unit k rows tall in one column, with the
   gap under each chain link `max(bandGap, need)`, `need` read from `bundle-need.ts`, which 7e reads
   too. 7e grows nothing there (`GRID_BUNDLE_CHANNEL_SHORT`, error, if it would). A hard rule: no
   offer, no re-run. The group declines the shape, as before, only where no chain can be seated, and
   `GROUP_SHAPE_DECLINED` names the reason (`authored-side`, `branch`, `cycle`, `exits`, `rows`).

   That predicate is **incomplete, by construction**: it is "both ends in this group", so a
   bundle between a **flank** and one node of the grid cannot be seen. Delete the two
   `EBR-01`↔`EBR-02` links from the gridded golden and `datacenter` keeps the grid, where
   `TBR-002`'s two cross-group bundles stack their reserved blocks into two different rows and fail
   `Nodes EBR-02 and EAC-02 violate clearance` — on `main` too. The gridded golden survives because
   it happens to carry an intra-group bundle.

   **A like-facing `top` pair in one column: constrain the count.** Nodes of one column share the
   column's x and are left-aligned in it, so two of them overlap in x: the lower one's `top` stem
   points straight into the upper one's body, and the upper one's `top` port is on the far side of
   that body — above the **first row**, where the group has only its own top padding and a label
   band. `label-no-gap.yaml` gridded is the case: `exitRanks` skips a link whose peer is a group
   member, so both nodes rank "neither way", the floor is 1, closest-to-square takes one column, and
   stage 8 fails `Router skipped a required checkpoint`. Here an arrangement *does* answer it, so a
   count that would put such a pair in one column is not a candidate. A **filter, not a floor**: a
   count that already keeps them apart is unchanged, and one row of *n* has no two nodes in a
   column, so a candidate always survives.

   The predicate is a **column**, not a row, and it is `top`, not "the same vertical side". Both
   halves are measured, and getting either wrong is expensive:

   | pair | arrangement | result |
   |---|---|---|
   | `top`/`top` | one column | `Router skipped a required checkpoint` |
   | `top`/`top` | different rows, different columns | publishes. A 20-node grid packs 5 × 4 at 408 × 785; read as "different rows" the filter collapses it to one row of 20, a **1 480.5 × 498** canvas — the ribbon this whole rule exists to avoid, and silently |
   | `top`/`top` | side by side | publishes, count untouched (`a-grid-already-seats-a-like-side-pair`) |
   | `bottom`/`bottom` | one column | **publishes**, Q 0.5586682246067611, in the identical arrangement `top`/`top` fails in |
   | `right`/`left` | one column | publishes — both stems leave the column and join outside it |
   | `right`/`left` | side by side | publishes; declining it cost a 12-node grid Q 0.8476 → 0.6472 and a canvas 2.62 × wider |

   `bottom`/`bottom` is the asymmetry worth naming: below the last row lie the group's bottom padding
   **and** the tier gap, so the way round the lower body is room a rule already reserved, where above
   the first row there is none. Only **routed** links count — an overlay link is unrouted and exempt
   from the clearance gates, so it can never produce the fault, the same kinship stress ticket 34
   names in the both-ways floor. An end the author left **free** is not counted either: the
   same-group vote reads the packed geometry, so `a-grid-of-twelve-keeps-its-columns` links `n01` to
   `n02` in its own row and to `n05` in the row below and stays a 4 × 3 grid.

   A declined group takes `row` **to every rule** — `groupShape` is the one reader, because
   `rows.ts`, `row-paths.ts`, `sides-two.ts` and `mutation.ts` each test `shape === 'row'`, and a
   group that is neither grid nor row reaches stage 8 with no row path. `parse` already answers
   `ring` and `free` with `row` and a diagnostic, so `groupShape` can never see them; what carries
   over to a future stacked shape is the rule, stated about the link's own space, not this code
   path.
4. A grid box is narrower and taller than the ribbon ELK sized its band for, so the tier is packed
   left to right again — otherwise the width the grid gives back never reaches the canvas — and the
   bands are **re-stacked** in place of the ordinary rebuild. That last part is global: **one grid
   group anywhere discards ELK's vertical placement for every tier**, so a sheet cannot adopt the
   shape group by group without re-reading the whole sheet. An input with no grid group keeps ELK's
   geometry untouched.

**A free row counts the corridors through it (architecture-2 ticket 17, `corridor-order.ts`).** ELK keeps
the declared order of every row, and the overlay order re-orders only the tiers an overlay link touches.
Neither sees the corridors 7a reserves later, so a run from a corridor to its far end can cross the
feeds of a row whose other order would let it pass clear. After the overlay order, the draft measure
cuts each link that owns transit lanes at its predicted corridor, one straight piece per tier gap: beside
the main group of the crossed tier nearest the source, on the side of 7a's direct plan at the source x
(`directPlan`, the function 7a calls, with the draft boxes and the groups 7a holds, `fixedSourceGroups`),
which faces the target where it can; where no direct plan exists, on the side the source asks for
(`corridorSide`). A link foreign to a frame of the crossed tier keeps the diagonal (the draft has not the frame columns that 7a's
gap choice reads). Every end of a routed link is read at the port x `sides-two` will give it: the ports of a top or bottom face
centred at the face's pitch (at least the lane width on a face an alignment end leaves), in the provisional engine order, read with
the functions `sides-two` calls (`farCoordinate`, `sortFace`, `seatAuthored`, `lanePitchFloors`), without the planned first turns
and without a bundle's pitch (ticket 17 follow-up). So links that share a node meet at their own ports, and a pair whose port order
disagrees with the order of its far ends counts as a crossing; at one body centre it never did. The overlay order
reads the same measure. A candidate is measured over every region it can change: the whole span of each
routed link with an end in a candidate row or crossing a candidate row's tier (`reach`), because a turned
row moves the source x, and so the corridor, in every tier the link crosses. Then one step per sub-tier that a transit link spans, down from the anchor
tier and then up, judges the free rows (`movable`, `row`, no flank beside them; frame cells and canton
members keep their order; so does a row whose `reach` holds a tier with a frame cell, because the frame
columns are packed after this step and the draft has not their x) of that tier together with those of the next tier away from the anchor: every
order of a row of at most 5 nodes, else its adjacent swaps, within a count cap per step and per sheet
(`ROW_ORDER_SEARCH_CAPPED`, info, names a truncation). A candidate stands only when the routed
crossings drop strictly, the straight overlay links do not fall and the blocked row links do not rise;
ties keep the current order. Every free row records `rowOrderDecision` (`kept`, `corridor-crossings`,
`frame-columns` for a row kept for a frame cell in its reach, or `author` under `layout.corridorRowOrder: false`), and the stage-4 validator checks the row order against
the record without searching again; a free row of two or more nodes without a record fails it. The setting
`false` also switches the corridor cut off, so the overlay order measures as before ticket 17. The prediction is not 7a's answer: a later round (a course, a
spanning chord, centring) can still move the link, so the corpus measures the rule.

**A free row, the outward group order and the corridor sides are decided together (architecture-2 ticket 72, `joint-order.ts`).**
The sweeps above do not judge the anchor tier or a tier no transit link spans, and a key of a free row alone cannot judge it: the
draft does not hold the x where 7c puts the far groups, and the corridor of a far source can take the far side of the row. After the
sweeps and before the far-end pull, each sub-tier with a free row the sweeps may turn, the anchor tier first, then down, then up, judges
three things together: the free rows' candidate orders (the current order and five key builders over the normalized ranks of both neighbour sub-tiers, routed
same-row peers that stand side by side kept together), every order of each movable group run of the sub-tier away from the anchor
(`JOINT_GROUP_RUN` groups, `JOINT_GROUP_ORDERS` combinations), and every side vector of the transit corridors through the sub-tier
(`JOINT_TRANSIT_SIDES` corridors). The outward groups stand at a prediction of their 7c centres (`seatPredicted7c`, a surrogate of 7c,
which reads ports and lanes that do not exist yet; the ticket measured its error: on the corpus 38 sheets accepted a candidate, 27
published fewer crossings, 11 as many, none more). A candidate stands only when the draft crossings drop strictly, the straight
overlay links do not fall and the blocked links do not rise; ties take the most straight links, the fewest blocked, the fewest
crossings, then the least feed stretch, then the first enumerated (the current orders first). Every evaluation spends one candidate
of the sweeps' budget; a truncation is a `ROW_ORDER_SEARCH_CAPPED` reason. A row the draft does not model (a link to a lateral port in
another group, a same-row U-turn, a labelled same-row link) is not judged, and `JOINT_ORDER_LEFT_OUT` (info) names it. The record:
a turned row records `feed-order`; a turned run a **`groupOrder`** entry `{tier, order, feeds}` whose premise is the free rows in the
order they stand in after the pull (checked at stage 4 and on every restored stage; a refresh drops a broken one by name,
`FEED_ORDER_WITHDRAWN`); and each corridor of the accepted candidate a **`corridorSide`** entry `{link, tier, group, side}`. Every
consumer reads the side through `reservedCorridorX` (`corridorXOnSide` is the one predicate of a corridor x from a side): the draft,
`farCoordinate` of stage 5, and 7a, which allocates the lane on that side and refuses a direct plan or an in-span slot on the other.
The side is checked against the lane from 7a on; 7f may move a corridor to its child (`reseatLanes`), and then withdraws the entry by
name (`CORRIDOR_SIDE_WITHDRAWN`). `layout.feedOrder: false` switches the joint order off.

**A row pulls a member toward its link's far end (architecture-2 ticket 22, `pullTowardFarEnds`).** Declaration
order is a hint (user, 2026-10-24). After the corridor search, a member of a free row is pulled when all its links are
routed and end on one node of a band that faces its row across one tier gap, no other member of the row feeds that node,
and the node will stand farther off in x than the straight-link length limit of the two bodies: the pull serves a link
that would bend, and a member whose link a chord can take keeps its place. Where the node will stand is predicted: 7c
seats its siblings under their feeds, so it stands beyond the farthest feed of every sibling before it in its row and
short of the nearest feed of every sibling after it. It trades places with a neighbour while that brings its centre strictly
nearer the far node's centre. The neighbour is an unlinked member, or a linked member that is no pull target, has not been
passed yet, and whose links all stay straight or chords one slot away: its centre stands over the far node's box or nearer it
than the straight-link length limit (user, 2026-10-24: "move f1 to the right side of container"). So a passed linked member
moves one slot, and the pulled members keep their relative order. A row
next to a frame cell takes the pull too, because the frame column is later centred on its feeds. A pull stands only
where the draft measure over the regions the row reaches is no worse (straight overlay links, blocked routed links,
crossings). The record keeps the order the search left (`rowOrderDecision.pulledFrom`) and the members the pull served
(`pulled`). The validator checks that the pulled members are linked and kept their relative order, that the other linked
members kept theirs, that each of those was passed by one pulled member at most, and that every pulled member moved and
ends nearer the place its far node is predicted at than it stood in the order the search left. The prediction reads the
far node's own row only: a node of another rank of its group stands on another sub-tier and pushes nothing. After the
frames are ordered (`placeFlanksAndPeers`), the prediction is read again, and a pull that no longer brings its member
nearer is undone with every pull of its row (`withdrawPullsAcrossFlips`, every member it had moved recorded in
`pullWithdrawn`), rows in id order and again until none changes: a withdrawn row moves the far nodes of the row that
faces it. The validator reads the prediction again, so its check holds on the stage-4 model right after the withdrawal,
on the same geometry, and nowhere later. The test of a link that would bend is one
function (`wouldBend`): a pull target reads the far node's predicted x, a passed linked member the draft box of its far
node. `layout.farEndPull: false` switches the pull off and keeps the corridor row order: a
test input whose subject needs a node where it is declared pins it so. `layout.corridorRowOrder: false` keeps the declared
order of every row, with no pull either.

**Order follows the feeds (architecture-2 ticket 25, `feed-order.ts`).** After the free rows are ordered and before the frames
are packed, the rank cells and the child frames take the order their feeds give. A unit is a node of a rank cell (a `row` cell of
two or more nodes, no flank beside it), or the frame's own cells or a child frame among the units of a frame that stand beside each
other (`besideRows`). Its **feed key** is the mean position, in the feeding row, of the far ends of its routed links into the sub-tier
directly above its first sub-tier: the rule reads downward feeds only, and a fan from below decides nothing. The feeding row is one
group, read in the order it stands in (a row a flank stands beside is none: the flank re-packs it); the cells are judged top-down, so a
cell reads the order this step gave the cell above it. Feeds from two groups are not comparable before the frames are packed, and
decide nothing. A row is decided when two of its units have different keys: in a cell the keyed nodes take the keyed slots in key
order, a node without a feed keeps its slot, a tie keeps the order ELK gave (its input is the declaration order), and two neighbours
a peer link joins move as one block; in a frame every unit must have a key, and a tie keeps the declaration order (own cells first,
then the children). Feed order beats declaration order. A canton is author-fixed (D1) and a free row keeps the corridor order and the joint order (ticket 72). Each
decided row is one **`rowOrder`** entry of the ledger, the one decision (R1; `rowOrderOf` is the one reader), with its premise: the
feeding rows and the order they were read in. A cell is re-seated in its order here, the replay of ELK's output (ELK gets no hint,
because the feeding row's order is known only after ELK and the free-row orders, and the column pack, not ELK, places a child frame);
`standOf` stands a child frame on the side its entry names; the overlay order of the frames chains neither a reserved cell nor a
feeding row (`feedingRowsOf`). A pull that `withdrawPullsAcrossFlips` undoes turns a free row after the pack, so the feed orders are
read again (`refreshFeedOrders`): a cell is re-seated inside the room its tier leaves or refused by name (`FEED_ORDER_REFUSED`), and a
frame order the feeds no longer give is dropped by name (`FEED_ORDER_WITHDRAWN`). A re-seated cell can move the far node of another
pull, so the two steps repeat until no pull is withdrawn (`settlePullsAndFeeds`; a withdrawn row records no pull, so at most one round
per row with a pull, and one more). `validateFeedOrders` checks every entry and its
premise at the end of stage 4, and `validateReservations` on every later snapshot (R2). One sort per row, no search, so no cap.
`layout.feedOrder: false` writes no entry: ELK's order and the overlay side stand (a test input whose subject needs the declared order
pins it so). On NTP the MPLS fan follows its hubs (`crt001` before `crt002`) and the zone of Location 4 stands under its feeds.

**Time and failure:** ELK runs in a worker with a deadline (`layoutBudgetMs`, default 10 s at
≤ 300 nodes, 20 s above). On exception **or deadline**, terminate the worker and run the
fallback: one ELK run per tier band without partitioning, bands stacked in tier order with the
standard gap. The prototype recorded a 33 s *failing* run at 1,000 nodes — waiting for the
exception is not acceptable. After either path, **validate**: every group inside its tier band,
no group overlap; violation → fallback (if not already) → hard failure.

Output: absolute group boxes, node positions, in-row order.

**The tier gap starts at its minimum.** `stackBands` opens each tier gap to `tierGapMin(model)`: the larger of `SKELETON_SPACING.tierGap` and
the node clearance plus the widest stroke (architecture-2 ticket 57; today 60 px). `bandGap` keeps the horizontal uses (sibling columns,
grid columns, flanks, ELK layer spacing). A gap is never lower than `tierGapMin`. The bands, the rows and the labels that stand in a gap
raise it later and never lower it.

## Stage 5 — sides, phase two; resize; repack

Ticket 83 reserves block-face pitch before sizing and rejects a provably over-cap span at the end of stage 5, before region placement. It records declaration ties in the stage-4 row draft, preserving foreign-group slots and carrying the parents' geometric order through the terminal follower tier. Terminal follower rows are then fitted jointly on a draft: seats that add or deepen a sibling/frame spacing violation all decline by name before any node moves. Each refusal restores that row and rechecks the remaining proposals; the loop is bounded by the number of candidate rows.

Immediately after the skeleton, before anything is pinned. Undecided same-tier directions take
`left`/`right` from the in-row order — except inside a **grid**, where a peer may stand above or
below as well as beside, and the vote reads the packed geometry instead: a peer that overlaps this
node's y span votes `left`/`right` by x, one that does not votes `top`/`bottom` by y. Shared ports
then recompute their majority across all peer
directions, including already-known higher/lower-tier directions. Nodes are **re-sized** (stage 3 formula) if a side gained ports. Each row is
then **repacked horizontally** in ELK's order — a grid is laid out again as a grid at the same
column count, at these gaps between columns and the band gap between rows — and group boxes are recomputed. The gap is at
least 20 px plus the two node half-strokes. Where facing named pills protrude farther, use the
sum of their measured half-widths and half-strokes instead. Adjacent groups and tier bands move
as needed to contain the resized rows. Each side receives a provisional engine order by far-end x (for top/bottom) or y
(left/right). Use translated skeleton peer anchors when present and peer-node centres otherwise;
shared-port peers use their mean coordinate. Capture those coordinates before the final anchor
rebuild. Author `order:` sorts the author-ordered subsequence; free ports occupy the remaining
positions. Preserve signed keys and the relative physical order of unequal author keys, not an
absolute slot number.

**A group box holds its own title from here on** (snack-theme ticket 157). The box a group's content asks for (`contentBox`, which
`fitRegionGroup` fits) is at least as wide as the group's measured title plus the 8 px title inset on each side and one clearance step
beyond each (`ownTitleFloor`, `titleRoom`, `title-room.ts`, the same geometry 7f places the title with), centred on its nodes. The step is
there because a lane stands on the box edge, its link-free margin to the title is the inset itself, and 7f refuses a title x within one
tolerance of that margin. 7a therefore stands its lanes beside a box that already
holds the title, and 7f only places it. The same floor holds the rank cell that hosts a frame's title (`frameHost`, on the edge
`frameTitleSide` reads), and a canton's title holds its union through the widest cell of its title-edge sub-tier (`cantonTitleFloor`,
`regions.ts`: the title room less the other cells of that sub-tier and the two margins). No stage widens a box for a title
(architecture-2 ticket 54).

**Stage 5 decides the inputs of the bands that stand in a tier gap** (architecture-2 ticket 57): the title edge of a canton, the bus side
and the title text. Stage 6 seats the gap with them (`gapBandDemand`). Stage 5 does not reserve the band height. A stage-5 reservation made
7a to 7e plan in boxes that were taller than before and cost bends and crossings on the corpus (branch `t57-step2-stage5`, not taken). The
start of 7f reserves the height, on the y axis only (`topUpBandClearance`).

**The bus edge is read again here** (ticket 83). Once every routed port has its final side, and before the nodes are re-sized and the rows
repacked, `busSide` counts the legs each horizontal edge of the row carries within the bar's span (the members' bus ports, first to last, at the
skeleton's x) and fixes `bus.side` at the edge with fewer, the title edge on a tie. Term 1 is exact: the routed, non-stub ports on that edge of
the row's nodes in the span, member or not. Term 2 has no plan before 7a, and is read as the routed links that pass the whole row (an end in a
tier above and an end in a tier below), at the x of the port in the tier across the gap; a link between the row and the tier across the gap ends in
a port term 1 counts, and its run lies below the band. Term 3 (lanes) is not read: it counts the same on both edges. The bus ports take that
edge (never `left` or `right`), each is the last port in engine order on its side (an authored `order:` on a named bus port still wins), and the
move is one more side change of the one resize. The edge is fixed at the freeze; 7f never moves it. A stage-2 estimate of the other edge is
corrected here.

A bundle's members leave each shared node on one side: the ports one bundle ties at a node (and,
through a port in two bundles, both bundles' ports) vote as one component in stage 2 and again here
for what stage 2 left open, so they take one side; an authored side wins, and stage 1 never bundles
two different authored sides (ticket 35). From here on port identity, count, side and author `order:` are **frozen**. Later bar and bundle
rules may adjust engine-selected slots and the documented stage-7 rules may grow or move geometry,
but no stage may shrink a node below its current content or author floor.

**A routed+overlay parallel set keeps one order at both ends** (architecture-2 ticket 80). A parallel set (`parallelSets`, `parallel-sets.ts`) is every bundle,
and every group of two or more links between one node pair that holds a routed link and an overlay link (any family class) and whose ends share one face
at each node when the two faces face each other. Stage 5 sorts a face by the far ends' anchors; the node sorted second would read the slots the skeleton left, not the order the first one
took, and a cable and an overlay link written in opposite directions then flip at both ends and cross (the draft of a reversed ELK edge is
mirrored). So a sorted face hands its slots to the ports of a set in their new order before the next face is sorted. The guards are the bundle's:
one port per link, each port with one peer, and the end with an authored `order:` leads. Where no end is authored, the lead end of a mixed set is the end in the upper tier, then the smaller
node id (`visitOrder`): the visit order of the sort puts every lead before its follower, and no document order decides it (R3). The overlay trades of 7f (`nestOverlayPorts`) leave the
overlay port of such a set where stage 5 put it. What this does not hold: which of the links stands first follows the stage-4 draft as the lead end reads it, so it can differ with the
authored direction of the links (stage 4 gives ELK each edge in its authored direction); two overlay links between one pair, and two routed links without a bundle, are no set
(as sets they changed 8 older sheets and made 2 worse) and can still cross (`an-overlay-frame-reorder-is-refused-with-six-sync-links`).

Stage 5 also produces measured node and description labels, icon bounds, named pills and exact
port-associated pill labels. Centre content inside its asymmetric content insets. Anonymous ports
receive anchors only. `rebuildNodeGeometry(draft, ids, 'current')` lets later rules retain their
explicit anchors while replacing content geometry by stable owner/ID. The renderer consumes
these bounds without measuring or reflowing text. Group and link labels have later producers.

`freezePortTopology` publishes an immutable clone with a serializable topology/floor baseline.
Every subsequent stage uses `withLayoutMutation(previous, rule, draft => { ... })` and retains
its returned snapshot. Existing mutating helpers receive the draft. The closed rule validators
check membership, resolved semantics, relative author order, measured capacity and floors before
commit. A retained draft reference cannot change the published clone; failure leaves the input
unchanged. Runtime measurements and diagnostics remain writable inside the transaction.

A rule must integrate its real claim rebuild and validator before it can create or change that
claim. An unimplemented rebuild rejects the affected mutation. Claim-free geometry changes still
run geometry and ownership checks. Plain `JSON.parse` does not resume placement. Use
`restoreLayoutModel`, which validates the baseline and compares complete link/attachment,
bundle and group-link semantics with `resolve(document)`. This proves serialized
self-consistency, not historical authenticity. See ADR-0010.

A **stagger** is reserved at the end of stage 5, before the topology freeze (ADR-0024; tickets 166 and 51). `staggerRows` holds the existing feed order, exit face, the centre pitch of each gap and the line step. Odd members stand away from the feeds. The pitch reserves same-line node and pill clearance and the router's stroke-expanded obstacle beside each passing vertical. A gap between the members of two parents is wider: it also holds both parents, seated over their drops, a row gap apart. The members of each parent are one run of the order. Ordinary feeding faces take their child x positions before transit lanes are reserved; bar faces retain stage 7d's span rule. The containing frames and tier bands grow for both lines. A wrapped rank cell (a **fan wrap**, decision review 2026-11, D-Q4) then packs its document tier again (`packTier`, the column packer's own rule), so the sibling units close up to the narrower block, and its **feeding chain** stands over it again: the first seat of the row decides the chain once (`StaggerRow.chain`, column units sorted by id; `[]` when no unit qualifies) and every seat moves those units as one block in x, by one move that stands each unit on the tier next to the block over its own feeds into the block (`chainFeeds`, `unitOffsets`), before the feeding faces are seated. Near units that need different moves refuse the row by name. A chain is, from the block tier by tier toward the row's feeds, every unit with a routed link into the units that joined on the tier before; a node that also links to another unit of that tier is a shared parent and keeps its unit out, and a unit of an earlier row's chain or a unit that holds a stagger row stays out. Whole units move, so every reservation inside a unit holds. A move that would bring a chain box nearer than `besideGap` to a box beside it, or a stored chain with no feed left, refuses the row by name. The seat then proves every drop, or refuses the row by name: the far end is the horizontal face over the member; the vertical from the parent face to the member meets no foreign body, pill or group box, and where it crosses a tier between (a transit) it clears the occupied box of each group there by half a lane, as 7a stands the lane; the parent port stands over the member; and the anchor tier is the row's tier or lies beyond it, so the centre rule (7c) moves the parents over the row and not the row under them. The freeze stores the decision, and every publication and restore checks the two lines, the pitches and current port corridors, and that a rank cell carries its chain record (a plain row none) and that each near unit of a chain still stands over its own feeds (the same `chainFeeds` and `unitOffsets` readers, offset within `PLACEMENT_EPS`; a mean would pass two units moved by equal and opposite amounts); a stage that moved a unit off refuses as a stagger refusal. 7c reads the chain (`chainBlockOf`): a chain node does not grow for an alignment, and it is centred only on its feeds inside its chain or into its block.

Two sources give the rows. With `layout.maxWidth`, the width-budget search tries rows on complete runs (ADR-0024). Without a budget, stage 5 of the first placement run chooses itself (`arrangeGroups`, ticket 51; D-Q4), right before the seat. It skips a group with an authored `shape` (any shape the author wrote), a flank, a group of fewer than three members, a group whose members do not each have one plain routed link out of the row through one face, and a row where a hub feeds fewer than three of its members (a **fan** is one hub with three or more members; the runs of several hubs stand side by side, and interleaved runs are refused by the seat). It tries the remaining candidate rows widest first, each on a draft of the model, behind one of two triggers (`triggerReason`). A rank cell takes the **block trigger**: its one line must be wider than the widest other group of its block (its top-level frame with the child frames), read on the one-line stage-5 model; the reason of a block refusal starts with `block:`. A plain row takes the **aspect trigger**: its band must be the one widest band and the sheet wider than tall. The seated draft must then pass the seat's proof and the freeze validation, and meet the objective (`objectiveReason`): a stage-5 canvas area strictly less, and for a plain row also nearer square (`|ln(W/H)|` strictly smaller; W and H are the stage-5 canvas that `stackBands` sets from the band extents, before and on the draft). A draft that a stage-5 stagger refusal refuses is dropped and the row stays; the reason of an aspect refusal starts with `aspect:`. Any other error of a draft, the freeze validation included, is a defect: it ends the run and is never recorded as a reason. The seat refuses by name a parent that, seated over its drops and the other links of its feeding face, breaks one of the freeze's own tests: clearance to a node of its group, the row order, the pitch, capacity and authored order of every port of that face (an overlay or unused port is not seated), or the band and flank tests of its tier. `groupArrangements` records `stagger`, or `row` with the reason, for every group; there is no record when no group passes the rules before a draft and no group takes the column (below), or under `layout.autoArrange: false`. Every later placement run of the command keeps the record and the rows; it does not choose again, also when the first run chose nothing. When a later stage of the first run refuses a stagger it chose, the run is placed once more with those rows declined (one line, the refusal as the reason), within `MAX_RERUNS`; a fan re-run that a kept stagger refuses is cut and the baseline stands. **The acceptance gate** (D-Q4) then judges the staggers the first run chose. One comparison run keeps the first run's record with every chosen stagger a `row` (reason: the acceptance gate, `FAN_WRAP_DECLINED`) and places no stagger at all, so it cannot choose another one; both models go through 7f as trials (`wrapGateVerdict`). The two lines stand only when the complete placement takes less area, every link the comparison places straight (facing faces on one axis, a held routed chord, an overlay link drawn as one segment) stays straight, and no hard separation is shorter. Otherwise the comparison is kept, with an info diagnostic `FAN_WRAP_DECLINED` that names the reason. A stagger refusal in the wrapped run's 7f declines the lines too. The comparison run is one placement run per command; it spends no `MAX_RERUNS`, and its placements, trunk re-runs included, stand outside the placement cap (`env.gateRuns`), so it is always available, and its ledger, declined blocks and re-run count are its own: a kept stagger goes on as if it had not run.

A **column arrangement** (ticket 52) is decided in the same run, earlier in stage 5: after the first re-size, on final sides, and before the rows are repacked and the faces sorted (`reserveColumns`, `column-arrangement.ts`). It reads stage-1 and stage-4 facts only. A group takes the column when it is a flank, or a tier group with a flank beside it and a lateral link, and all of these hold: no authored `shape`, not a rank cell, two or more members, one facing group (a tier group with a flank on each side keeps the row; so does a flank whose primary peer another flank shares), and every member has exactly one link, a plain routed lateral link through the facing faces to the **one** node of the facing group that all members link to, on a port of its own with no authored side or order, and that node's facing face holds no other port. The prediction is structural: a row of two or more members beside one facing node hides every member but the nearest behind the nearest body, and the column predicts 0 crossings, 0 removed links and straight links, so an admitted column is never worse than its row (the row's routes are not read at stage 5). The facing face takes the column's centre pitch (the tallest member plus the node gap) and the nodes are sized again; the repack seats the members one on each line, centred on one x, from the row's top, in the stage-4 order (all members share one peer, so the order of their ports follows); the face sort then orders the facing ports by the members' y, so the links keep the order of their ports, and `stackBands` grows the band. 7b keeps each member's face as it is, and its one translation levels every pair. `groupArrangements` records `column`, or `row` with the column's reason for every flank group and every tier group with a lateral link that stays a row; the record exists when a group took the column or a stagger draft was tried, and later placement runs seat the recorded columns again (a recorded column that a later run no longer admits refuses that run by name). Rows, the row-order check and `packRowsOf` read a column as one member per line (`columnOf`), and publication and restore check one centre x and one centre pitch (`validateColumns`).

A **feed split** (architecture-2 ticket 73, `feed-split.ts`) runs last in stage 5, after the arrangement and the stagger seat and before the freeze, on final
sides and sizes. It walks the centring steps from the anchor tier outward, the step next to the anchor first and the two sides in turn (each occupied
sub-tier with the adjacent one toward the anchor, its authority). For two sibling groups of the step's sub-tier side by side whose feeds (`centringFeeds`)
stand apart in x, both can stand under their feeds only when the two inner feeds stand at least `reach(left) + band gap + reach(right)` apart; the reach is
the distance from the child port of the outer feed to the box edge. Where the first pair in x stands closer by more than `MIN_SPLIT` (0.5 px), every body,
port and box of the feeding side (the authority tier and the tiers beyond it, away from the child) right of a line halfway between the two
inner feeds moves right by the deficit; the child tier and the far side stay, and 7c then centres each group under its feeds. A body never stretches: a
split line through a body of the authority tier (a node that feeds both groups) is declined, and a crossed body of a tier beyond moves whole when its
centre stands right of the line and stays otherwise (where stage 4 put it is incidental, R3; 7c centres it again). A group box the line crosses grows
only when some of its nodes move and some stay; it moves whole when all move, and stays when none moves. Only plain groups split (no rank cell, frame or
flank in the pair), and a feeding side with a frame, flank, canton member, bar or grid declines (so does a model that holds a lane: 7a reserves them later).
The moved model must keep the room of this split and of every split made before it (a later split can grow the box of a recorded pair, and so its
reach) and every seated stagger row; a rebuild or a check that refuses it puts the saved model back. A decline names the pair (`FEED_SPLIT_DECLINED`) and ends its step; a step stops after `MAX_SPLITS_PER_STEP`
(8) splits with `FEED_SPLIT_CAPPED`. `feedSplits` records each split made (`tier`, `authority`, `pair`, `at`, `width`), `[]` when stage 5 decided and made
none; absent means no stage 5 of this pipeline ran on the model. Each placement run decides on its own stage-5 geometry. The freeze keeps a copy
(`freeze.feedSplits`); every publication checks the record against it and its shape, and the stage-5 publication and its restore check that each recorded
pair has its room (`feedPairRoom`, the one reader of a recorded pair, which the check of each split calls too). Later stages move the feeding tiers again (7c, the close-up), so no later stage reads the
room or decides the split again.

## Stage 6 — rows

Per tier: all unstaggered `row`-shape nodes share one top y. A reserved stagger keeps both lines and its pitch; each line is a row to later horizontal repacks. Repack horizontally again if the flattening
created overlap (nodes ELK stacked at one x). After `flattenRows`, `reseatBands` seats the bands
again: each band starts one `tierGapMin` under the band above, or `gapBandDemand` under it when that is more, and its groups, nodes and
icons move by one vertical shift (flanks, bars and grids with it). `tierGapMin` serves the boundary
between sub-tiers and between document tiers. `gapBandDemand(above, below)` is the height that the bands in the gap ask: a canton title
band on the edge of the gap asks 20 + title height + `bandExtra` + 20, and an across-frames mesh bus band asks 20 + band + 20. Two bus
bands that face each other in the gap add: 20 + upper band + lower band + 20. A canton band and a bus band on one edge add too. The tier-gap
plan reads the same figure as its floor. So a band that ELK layered deeper than its sub-tier
needed does not keep the extra height as gap. Room that stage 7 allocates is added on top: the solve at the end of 7f adds the rows of
the parts and the room of the link labels, once. For each same-tier pair with facing east/west
ports: level the facing ports (move the ports on the node with fewer on that side) and, if
nothing lies between, **pin** a non-bundle link as a straight horizontal. Bundle endpoints are
levelled here but remain unpinned for stage 7e.

`rows(model)` runs inside the `rows` transaction. The baseline is the highest row-node top in the
tier band; nodes move up only, and row group boxes fit the flattened nodes with the standard
padding beyond the complete named pills (including their half stroke), not just node bodies. Repack pushes a row neighbour rightwards only when its stroke-aware clearance,
measured facing-pill gap or pass-by stem (the stage-5 `rowGap`) is violated — the stem is the
side's checkpoint (`sideStemReach`: 15 px, or beyond the side's pill text, ticket 156) plus the neighbour's obstacle reach that a port needs when its link does not enter
the neighbour's facing side, whether it goes to a third node or to the neighbour's far side, top or
bottom (ticket 29) — and, when links turn inside the gap (a pass-by, or a facing link
that enters at another height and jogs), one stem on each side that contributes a leg plus one pitch
between every two legs, counted by link (ADR-0015 rule 1) — then pushes displaced row groups in
the tier. Flanks and non-row groups never move or resize in this rule, except for the vertical
shift of `reseatBands`; a repack that would
collide with one fails explicitly, and so does a stage-5 input whose flank box lacks the padding
the containment rebuild assumes. Levelling considers routed links only; a tie in facing port counts moves the
right-hand node's ports. A target is applied only if it keeps engine order, the measured pitch
and the capacity padding (`pad + pitch / 2` from each end); infeasible targets are skipped in
engine order, ports beside a levelled port keep pitch spacing, and ports between two levelled
ports spread evenly. Rows cannot reorder ports, so an engine-inverted bundle levels one member
here and the rest waits for stage 7e.

Known bundle membership reserves its minimum stroke-aware side pitch during phase-two sizing,
before rows and lanes. The largest requirement propagates across sides that participate in the
same bundle. Stage 7e can then order those ports without discovering a mandatory capacity increase
inside an already allocated lane corridor. Transit alignment-end sides (7a) with top/bottom ports likewise
reserve the required lane width as their minimum pitch before topology freezes; adjacent source
ports can then own separate source-aligned corridors. Groups are fitted around the resulting
node bodies and named pills before rows or lane ownership begin.

A **row path** is a derived claim, not a callback edit. The transaction rebuilds every row
candidate from final anchors after each committed geometry change, removing the old path before
recreating it. A candidate is a routed, non-bundle, non-group-link link with an automatic,
`straight` or `orthogonal` route whose frozen sides face across a same-tier pair of row nodes.
It is pinned when the endpoints are level, the length is at least one 15 px stem and below
2 × the larger node dimension, and the corridor clears foreign geometry at gate clearance:
10 px stroke-aware to foreign nodes, no contact with foreign pills, labels, lanes,
bundle reservations or obstacles, and 10 px from other fixed segments. An automatic candidate
records `technique: straight` while pinned and `orthogonal` otherwise; authored routes keep
theirs, and a non-candidate automatic link keeps the resolver's unset technique until its own
rule validator lands. Publication compares each candidate's path and technique with a fresh
rebuild, and a callback that edits either is rejected. No separate obstacle record is written:
the pinned path itself is the obstacle for every later reservation and for stage 8.

**Invalidation:** row alignment runs before any fixed path exists, so nothing needs re-checking.
Later movement replaces row paths through the same rebuild; a candidate whose corridor a later
reservation blocks loses its pin and routes in stage 8.

**A link inside one frame is a chord (tickets 34 and 38).** A routed link is a *frame-link
candidate* when both ends lie in one frame: the same document group, or a parent and its direct
child. The candidate test is stage-1 topology. A bundle member, a stub, a flank or bar link and an
authored route that is not straight are not candidates. A group-link member is a candidate, like
any other routed link (ticket 38). The row rebuild confirms the candidate: one straight segment
between the two port faces (`overlayEndpoint`), when it clears every node body, every pill that is
not its own and the title strip. A chord reserves nothing: no lane, no gap run, no stem, no cover
for stage 8. A link that crosses a tier it does not end in never takes the chord, because it owns a
lane. A member never takes the level (row) path of a facing pair (`expectedRowPath` skips it). A link
whose chord a body blocks keeps its orthogonal route. The chord is re-derived after each move up
to the end of `bundles`. Then `bands` starts with `freezeChords`, and from there a 7f move that
would put a body on a held chord is refused when a lane can refuse it (`chordsHold` in
`laneSidesHold`, `STRAIGHT_LINK_HELD`). A 7f move that cannot be refused keeps the chord and
reports `STRAIGHT_LINK_BLOCKED`. The chord of a group-link
between two rank cells of one group is ticket 40.

## Stage 7 — regions

A **region** is the space between adjacent tiers, or between a flank and its tier. Sub-stages
run in this order because each reserves space the next respects. Each sub-stage lists what it
may move and what it must therefore re-validate.

### 7a — lanes (owned)

For every link whose path must transit a tier it does not terminate in: reserve a **lane** —
a vertical corridor of width `laneW = pillW + gap` — in the margin of the intermediate group on
the side nearer the source x. Lanes have an **owner** (the link) and a vertical-run reservation;
the lane is an obstacle to every link, the owner included. The owner enters it only as that
vertical run, which stage 8 stitches back unchanged. For a non-bundle owner the route segment through
the lane is fixed here. For a bundle member, 7a records only the owned lane x and extent; stage 7e
consumes that reservation when it creates the member path. Capacity uses actual occupied geometry, measured pills, and participating strokes. Corridor width is
`max(34, endpoint pill widths + 10, 20 + path stroke + maximum node stroke)` in pixels.
The lane's **alignment end** is the endpoint nearer the anchor tier (7c), because 7c holds that end fixed and aligns the other end under the lane; when both ends are equidistant, and for bundle members (7e owns their geometry), it is the authored source. "Source" in this stage means that end. The other end is the **target**. First try the source port x, considering every insertion gap in the intermediate group order.
Choose the feasible outward translation plan with the least total displacement, keeping all
previous corridors and transit source groups fixed. If no such plan exists, use the in-span
allocation and then the exterior fallback described below.

**A corridor passes its tier on the side that faces the target.** The source decides where inside
that side the column goes; the target decides which side. Of the insertion gaps, the in-span slots
and the two exterior columns, take the one that leaves the transited group between the corridor and
the target, so the run leaves the tier already on the side it has to reach.

The rule reads the target only where placement already knows the x it will keep. Five targets have
no such x, and the corridor then keeps the side the source asks for, exactly as before:

- a **bundle member** — it keeps the authored source and 7e owns its geometry;
- a target in a **bar** group — 7d takes its port x from the other end of the drop;
- a **shared port** — it is a fan, and 7c settles its x from all of its peers at once;
- a target **7c seats under the lane** — it takes the lane's own x, so reading it here would read
  this rule's own answer back. 7c seats it when the two ports face each other across the tiers: the
  source port on the side towards the target's tier and the target port on the side towards the
  source's tier, neither end in a flank (that is the same test `feeds` makes in 7c). A wrapped
  port — one on the side away from its peer — fails it, and its target keeps the x it has;
- a target the **transited tier itself feeds** — it travels with the groups this stage moves aside.

The fourth and fifth read the target's *node*. 7c centres the target's whole group, so a sibling's
feed can still carry the target sideways after this stage reads it — measured at 105–157 px on two
probes, with no side flipped by it. The rule is not tightened for that: the corridor that ends up
away from its child is the case the move in 7f answers, and that move is the safety net here.
Before fixing any lane x, expand occupied intermediate margins through horizontal group/node/flank
translations and expand the canvas. Preserve transit source anchors and the groups' internal order.
The held groups are one set, `heldSourceGroups`: the group of the authored source of every routed link
that crosses a tier, a link with a course or a spanning chord included. The lane plans, the span
corridors and the lane-stage guard read it, so a plan refuses the push the guard would throw on.
A span corridor judges against the prior lanes of its band only the units it pushes: a unit that does not move crosses no lane it did not
cross before, and the corridor itself is judged against every prior lane at its own x (architecture-2 ticket 35).
Plan displacement outward from the insertion gap and propagate it through neighboring groups.
Repeated pushes publish node positions and anchors from their original coordinates plus the
final group delta, avoiding accumulated rounding under the exact translation guard.
A corridor's centre cannot decide displacement direction when the corridor contains an entire
neighbor. If a transit source or an existing corridor blocks propagation, use a clear exterior
corridor without moving those owners.
An existing lane's identity, owner and width cannot change in later stages, and its x cannot either
except under the one rule below. Extents follow the current intermediate band with
`10 + pathStroke / 2` padding before placement freezes.

**A corridor whose child cannot sit under it follows the child.** 7c aligns each transit feed's
child port under the lane the feed owns (§ 7c). Where it could not, the child's route has to reach
the corridor sideways, and it crosses whatever stands between them. The corridor then moves to the
child's port x instead. Only the corridor in the tier next to the child moves; the corridors before
it carry the link across tiers it has left behind, and the jog between two corridors is what this
stage already accepts. "Next to the child" is read from the child, not from the transit order: that
order runs from the authored source to the authored target, so its last tier is the child's
neighbour only when the child is the authored target, and reading it the other way would make the
answer follow the authoring.

The move is made only when every one of these holds:

- the **corridor at the child's port x is free of foreign geometry** over the whole distance it
  runs — no occupied group of the transited tier, no other corridor of that tier, and, from the
  band out to the child's port, no foreign node, no foreign group box, no reserved run of another
  link and no group title with its link-free margin (ADR-0013);
- the **child node keeps its feed order**: two corridors of one tier may not swap the children they
  serve, because each link's descent would then cross the other's;
- neither end is a **shared port**, neither end is in a **bar** group, and the link holds no
  **shared run** — 7e has already cut that geometry against the corridor where it stands, and 7d
  takes a bar's port x from this very corridor, so a move would make the bar rebuild every
  publication replays contradict the declaration-order geometry it re-derives;
- the move leaves the **centring invariant no worse**. A corridor that follows its child can open
  an alignment 7c could not reach, and the invariant would then read the published placement as
  unfinished work. The rule measures `centreViolations` both ways and keeps the corridors where
  they were rather than publish that contradiction;
- the move leaves **no body on a frozen chord**, no label that loses its room and no corridor off its child (`chooseReseat`).
  The move turns the part in the gap beside the corridor from a drop into a stepped part. A gap that
  cannot seat the new row is no refusal since architecture-2 ticket 57: the judge reads no short gap
  (it did before), because the one solve of the tier gaps runs after the move and grows the gap by
  the row (§ 7f).

**The move runs late in 7f**, after the rounds and the group label bands and before the solve of the tier gaps (§ 7f), and that
is a measured choice. Every centring replay reads lane x as that feed's authoritative x, so a
corridor moved before one is a corridor the replay chases: on
`goldens/synthetic/own-lane-is-an-obstacle.yaml` the same move made at 7c widened the child node
from 145.78 to 1150.89 px and the canvas from 500.05 to 1505.16, and made before the tier-gap
growth, to 622.89 px and 977.16 — the growth's own replay chases it (that growth was the fixed point of `growTierGaps`, which ticket 57
removed). Made late, nothing moves at
all: the corridor alone changes, and crossings go 3 → 1 with Q 0.5122 → 0.6704. Nothing else moves
either, so the label bands 7f has just placed stay where they are, and the corridor is measured
clear of them.

The row the move creates is therefore **solved, not refused** (amended by architecture-2 ticket 57; before it, the row was refused where
the gap had no room for it). The solve of the tier gaps runs once after the move and reads the plan with the new row, so the gap grows by it.
Running the move before the rounds, so that the height rule counts the row, was measured and rejected for the number above — the golden is
byte-identical either way, but the fixture the rule exists for loses its whole point.

The reservation follows the corridor: extents and `fixedSegments` are rebuilt from the new x, and so are the frames (a frame holds the lanes of its own links, so a moved corridor can move a frame edge), so
the tier-gap plan that reads lane x after 7a and 7c reads the moved one. A moved corridor
reports `LANE_FOLLOWS_ITS_CHILD`.

**The runs between the lanes are planned too (ADR-0015 rule 1, superseded for the tier gap by
ADR-0021; `docs/design/tier-gap-rows.md`).** A **tier gap** is the open band between two adjacent
tier bands. The lane extents that face it bound it. The **part** of a routed link is its path inside
one tier gap, from one end to the other. An end is a **tip** (a port's stem tip, where `stemPlan`
puts it, nested or flat) or a **mouth** (a lane's approach point, one router stem inside the gap
boundary). The plan (`src/layout/gap-plan.ts`) reads the placed model and gives every part its
legs, its row and its vertical, before the first ownership batch runs. 7a fixes the lane x the plan
reads and owns none of the gap's height: the plan asks for it, and 7f reserves it (§ 7f).

- A **drop** is a part whose two ends stand less than one run clearance `k` apart in x
  (`k = nudgingDistance`, `10 + stroke` = 11.5 px). It takes one vertical, with a jog where the ends
  differ; the vertical stands on the end x that keeps `k` from every foreign leg, and the jog on the
  tip row, one clearance off it.
- A **stepped part** is any other. It takes an upper leg, a **run** on its **row**, and a lower leg,
  each on its own end's x.
- A **Z part** is a stepped part with two rows and a **middle drop** between them, used only where
  one row is impossible (a cycle among the rows).

The order is four rules over the parts. O1: parts that run the same way, do not interleave and
overlap in x are ordered by their upper ends. O2: where the upper end of one part and the lower end
of another stand within `k` in x, the one leaving the low boundary turns first. O3: two parts share
a row only where their x-spans, each grown by `k`, are disjoint, or where they come from opposite
sides and turn the same way at facing ends at least `k` apart (ticket 22); every other pair takes rows a
pitch `P = k` apart. O4 and O5: a run keeps `k` from every foreign tip, drop, lane box, bundle
envelope, bar band, shared run and fixed obstacle, and `e = 10.75` px from a group edge it would run
along (an obstacle anchored to the band above is a lower bound of the row, one anchored to the band
below is a need). O1 and O2 can form a cycle; the latest unsplit part on it becomes a Z part. The
parts are packed in topological order from the low boundary, each on the highest row it may take.
Two crossings are reserved, not discovered: a run crosses the leg of an interleaving part, or a
drop, on geometry both reserve.

Two parts on one port share the leg from the tip to the higher row; the plan record names them and
stage 8 exempts the overlap through it. Two legs of two nodes within `k` are both planned and named
`crowded`; G6 reports them, which `quality.md` item 11 prefers to a removed link.

A part the plan declines is **residual**, with a reason: `spans-two-gaps`, `lateral-port`, `u-turn`,
`faces-away`, `off-boundary`, `crosses-lane`, `crosses-shared-run`, `leg-blocked` (a leg would pass
through a label, a lane box or an obstacle) and `row-cycle` (a cycle that no Z split breaks). 7f
names each `TIER_GAP_PART_RESIDUAL` (`TIER_GAP_ROW_CYCLE` for a cycle). A residual part is routed by
stage 8 among the reserved parts (§ 8); nothing in placement seats it.

The plan writes no model geometry. Stage 8 reads it again on frozen placement (`allocateGapRuns`)
and reserves every planned part tip to tip. A gap whose parts are all planned asks the router for
nothing. Publication and restore read it again too, on the model as stage 8 received it, and keep
each planned part in its link's path with its owner and its traversal (decision D-Q2, § 8). A part with no lane terminal on either boundary is planned all the same: the old
allocation seated only runs with a lane.

**A node side that feeds another tier nests its own stems (ADR-0015 rule 1).** A side carries one
stem per port, and a leg travels along that side after it turns. Where the travel reaches a second
port of the same side, the two turns may not stand at one depth: the first route laid covers the
second port's stem, and the second link is left with a reserved turn no route can reach. The order
is forced there — the leg that reaches another port turns beyond it — so port `p` turns
`base + rank(p) * pitch` out of its node, `base` being the side's ordinary reach (beyond the pill
text of the side, ticket 156), `rank` being the longest chain of ports it must turn
beyond and `pitch` the same `16 px + widest routed stroke`. That is the depth stage 8 gives the
checkpoint and the depth `routerEntryPoints` reports, read from one rule, so the two cannot drift.

A leg's travel is measured to the near edge of the other port's **strip**, half a strip
(`nudgingDistance`, 11.5 px at the default strokes) short of its column: a leg that stopped between
the two would force no order and then run into a cover its own batch is no longer exempt from.

The reservation is a **depth**, not a run: where the leg goes after it turns stays routing's
business, as it does in a row gap. A side keeps the flat stems it had, and with them the side-wide
exemption of § 8, when

- no leg reaches another port's strip, or two legs each reach the other's so no order is clean;
- a leg's shape is not wholly known here: its far end is not the facing side of a node in **another
  tier** — any other tier, above or below, adjacent or not — or the port has no anchor;
- the side carries its group's **title**, which stage 7f places after these depths are chosen, in
  the room a deeper stem turns in;
- a nested turn would stand in frozen geometry, measured against the obstacles stage 8 itself
  reads;
- a nested turn would stand where G6 `segment-group-edge` refuses to let its leg travel away from
  it: on its own group box edge, or within the edge margin beyond it. Strictly inside the box a
  link turns in the group's padding and owes nothing.

A leg whose geometry a rule has already fixed — `path.fixed`, a fixed segment, a shared run — and a
bundle member are **passed over**, not declined: each is already an obstacle the frozen-geometry
test reads, so it neither takes a slot nor stops the side from nesting.

A gap does not grow for a nested stem, and neither does a band: the label band's clearance reads
only the entry points on its own side, and the side that carries the title never nests.

A link transiting several tiers reserves a lane at each, ordered from source to target even for
upward links. Prefer in-span corridors. When they do not fit, retain source geometry, reserve an
outside-span corridor, and warn that routing must complete its attachment jog. Non-bundle runs
live in `fixedSegments`; they may be disconnected. `path` always means a complete attached path.
Bundle members carry lanes only until 7e. *Moves:* horizontal translation of occupied intermediate
groups before allocation, group boxes and canvas. *Re-validate:* existing row paths and every lane.

### 7b — flank align

For each flank, consume the stored primary peer selected and packed at the end of stage 4. It must
be a node of the flank's `of:` tier; 7b never reselects it after movement. Consider only **distinct
port pairs** (a shared peer port counts once); compute the translation that levels the first
pair; a pair is *compatible* if the same translation levels it within 0.5 px — this holds when
both sides use the same pitch, so before comparing, **respace both facing sides to the larger of
their two pitches** (stage 3 formula re-run for those two sides only; sizes may grow). A primary bundle may first normalize its members' engine order jointly on both facing sides.
Only this primary block moves; unrelated ports retain their relative order. All author keys and
unequal-key precedence remain fixed. If that precedence prevents compatible ordering, keep it
and report the incompatibility for 7e. This handles the golden's interleaved left primary members
and reversed right primary members without claiming final bundle paths or global port-stem gates.
Shift the
flank vertically by one common translation for all its nodes. Unrelated anchors follow only
that translation and actual right/bottom boundary growth; only participating facing sides may
respace. Pin a compatible non-bundle pair as a straight horizontal
only when foreign geometry is clear. This check also applies when stage 4 reports opposite
flanks sharing a primary: the other flank may have a row node between it and the stored peer.
Obstructed pairs remain for routing; aligned bundle members remain unpinned for 7e. Route the rest. Links from the flank
to other nodes route normally.
*Placement-time diagnostic:* flank has more distinct links to the peer than the peer has facing
ports → warning, extra links route. *Moves:* the flank, two nodes' sizes. *Re-validate:* row
links on the peer.

### 7c — child under parents

Ticket 83 block feeds centre the row without stretching its faces toward individual peers.
The gap decision waits for settled 7e geometry and its disposable mandatory label/grid packing forecast; an earlier 7c replay reserves no speculative height. The forecast transfers only gap demand, before the real chord freeze.
The pre-freeze draft seats the stored 34-degree/top-entry deficit, at most a 600 px tier-band gap.
An over-cap block restarts from resolution with a named refusal and its original owners; shared-node blocks decline for ticket 84.

Anchor tier = the tier with the most main-tier nodes, including bars and excluding flanks (ties: lowest effective tier index). Empty layouts omit it. Below the anchor, each
group is centred under its feeds; above it, each group is centred over its children (mirror).
For a child group G fed from tier T−1: the **feed set** is the parents' bottom ports whose peer
is in G, plus every non-bundle link that terminates in G and transits T−1 through a lane it owns
(7a); for such a **transit feed** the authoritative x is that lane's x, not the far parent anchor.
Its identity is still the parent port, so one parent port fanning through several lanes is vertical
to its first child by x and the others fan, as for adjacent feeds. A transit feed never contests a child
port another feed already owns: it yields with `CENTRE_FAN_REMAINDER` and is excluded from the
centring barycentre, because contesting it would exhaust the shared budget. Bundle members are
not transit feeds; 7e owns their geometry. **Parents are authoritative during the steps:** a step never moves a parent port; parent
port x is fixed by stage 5/7a, and below the anchor tier by the parent spread made once before the first step (below; Q120 reverses
the old rule "parents are authoritative" there, architecture-2 ticket 32). G is centred
horizontally under the barycentre of the feed set within the space between the lanes (7a) and
neighbouring groups; then each child port x := its parent port x. A child port's x is feasible
only if the child node can be widened to contain it without overlapping a sibling; if not, the
link remains unpinned and is reported. A widening is bounded a third way as well: the body may not
end wider than `ALIGNMENT_MAX_GROWTH` × the width the node itself needs — its content and author
floor, or its own ports on that side at their reserved pitch — and a body already wider than that,
from a bar span or an earlier rule, aligns inside the width it has (ticket 29). A fourth bound is an
overlay chord. An overlay link with no end on the node, whose chord reaches the rows of the body and
is not already under the body, stops the growth on its side at the chord less the node clearance
(20 px) and half the node stroke. A port the stop declines stays at pitch from the last kept one, and
the feed is reported `CENTRE_ALIGNMENT_INFEASIBLE`; the stop is reported `ALIGNMENT_STOPPED_AT_OVERLAY`. A node of a stored feeding chain (stage 5, fan wrap) has no growth allowance at all (`alignmentAllowance` returns its width), and `centringFeeds` gives it only its feeds from its own chain or its block: stage 5 stood the chain over the block, and a feed from elsewhere would pull it off.
The bound of `ALIGNMENT_MAX_GROWTH` is unchanged. A body that has grown wider than its own width
does not move past the same chord when centring moves its group. A body that has not grown moves as
before. Unequal-x top/bottom normals generally need two orthogonal bends; routing determines the actual count. A parent port feeding **two** children cannot be vertical to
both: the first (by child x) is vertical, the rest fan through a shared stem — the junction tree 7e
reserves for every port with two or more routed links (ticket 20; a rule-fixed member joins it under
ADR-0016).
Iterate child-widening → sibling push → re-centre at most 8 times, ε = 0.5 px. **A run ends when a
pass changes no geometry, within ε** (ticket 75), and the passes it did not use stay in the shared 7f
budget. A group whose alignment is infeasible has its `CENTRE_ALIGNMENT_INFEASIBLE` warning and is a
stable state: it neither keeps the run going nor raises `PLACEMENT_NON_CONVERGENCE`. That warning is
reported only when the last pass still changes geometry, or when the geometry stands and the check
that publication runs (`centreViolations`, run on a context built where the model now stands) still finds a
port the step would move. On non-convergence keep the last state and report. A run that stands at a
fixed point of a context built earlier is run again on a fresh context. The windows of the overlay barycentre are placed once
after the passes (ticket 143). A window that moves a partner moves the ends of its overlay chords, and a chord is an overlay
stop of the alignment: it can free a growth the passes declined, or stop one they kept. A window can also move a group that
walled another, and the step of its sibling then has room. So after the windows the publication check runs again. While it
finds an alignment off its feed and budget is left, the passes run again, then the parent ports, the seated faces and the
windows, as after the first run. Each round spends a pass, so the rounds end. A round that changes neither the geometry nor
what the check finds is a stall the passes cannot see: the rounds stop there and keep the rest of the shared budget for the
stages after 7c. A check that still finds an alignment when the rounds stop is reported as the stall
(`PLACEMENT_NON_CONVERGENCE`, ADR-0010) (snack-theme ticket 157). A step that keeps no target, and leaves every one of its feeds no
nearer its x than it found it, puts its group back where it started and packs the tier instead: the
passes are a solver, and a step that solves nothing only gives the next pass a new position to chase
the barycentre from. A transit feed is exempt, because its x is a reserved lane the child must reach
and 7f moves the corridor to the child it leaves behind (ticket 29). *Moves:* child groups, child widths. *Re-validate:* lanes (7a
positions are fixed; if a child now overlaps a lane, push the child, not the lane). A child this
step leaves off its lane is not left there for good: 7f moves the corridor to it under the rule
§ 7a states, after the last replay of this step.

**A step keeps the verticals it reached** (architecture-2 ticket 65). From 7e on, a step counts its verticals before it moves and after
the clamp: first the feeds that owe one (an orthogonal link, a frame chord, a direct member) and stand on it, then every feed that stands
on one; a held cross-frame chord owes none (any angle) and is not counted on a face where two wanted ports, one of them a transit, cannot
both stand at pitch. A step that ends with fewer (in that order) keeps the geometry it found, clamped into its window, when that stands
more and passes the step's other post-conditions; it names the feeds it leaves off their x (`CENTRE_ALIGNMENT_INFEASIBLE`) and gives back
the warnings the undone step wrote. Without it a group that aligns K of its N feeds moves by the mean of all N, crawls by (N - K) / N of
the miss, and gives up an alignment it reached when the next mean jumps; the output then depends on where the budget stops. The kept
geometry stands more than the step would, not always as many as it found (the clamp can cost one), so the budget bounds the passes. Beside the riser, lane and span post-conditions, a step that leaves a held chord nearer
than the chord clearance (`STRAIGHT_PATH_CLEARANCE.path`, stroke-aware) to another held chord or to a foreign body, where the pair stood
clear when the step began, is declined (`chordNearPairs`, read on the ports as they stand). A miss up to half a pixel counts as standing,
so no later step moves it and the router would draw a hair jog: after the clamp, a face whose wanted ports within that tolerance all miss
by one shift moves by that shift (its ports keep their pitch), when it stays inside its body edges and no other port of it ends a link
with a corridor of its own, a bundle member or a held chord. Before the freeze a frame chord takes the parent-port move as an orthogonal feed does (it already has its
pinned path then); a frozen chord keeps its recorded wall move, and a routed chord names no jog.

**The alignment-target record** (architecture-2 ticket 66, `LayoutModel.alignmentTargets`). Each step writes, at its end and on every exit,
what it did with each wanted port, per node face (`faceKey`) in port-key order: `kept` (it stands), `grown` (the body grew toward it, or it
stood and a later step moved it off; `extent` is the body's room from the far end's x) or `declined` (with `reason` and `by`). The far end
is a port id or `lane:<id>`, never an x, so the record moves with the geometry. The kept branch above keeps its geometry only when, beside
ticket 65's post-conditions, it leaves every overlay link that the step's own geometry draws straight (`straightChordIds`, by identity, not
by count as ticket 75's guard reads it) still straight. A refused keep falls through to the step's geometry and declines the targets only
the kept geometry stands: reason `riser`, `lane-crossing`, `span`, `chord-clearance` or `overlay-straight`, by the first key in key order.
A decline is final for the placement attempt: the tally counts it neither before nor after, so no later pass tries the keep again. The
centre rule creates the record `{}` at its input; it is read and written through 7f (the replays of the region too), published with the
output of 7f, and dropped by the route rule, so a routed layout does not carry it. A routed model with the record and a decline in a model
before the output of 7f (no producer before 7f runs the tally) are refused, as is a malformed record. A model whose centre rule ran no
producer (a hand-made transaction) has none: a later run records and declines nothing and warns `ALIGNMENT_TARGETS_UNDECIDED`. At the output of 7f the publication check names a face where its replay declines a target the record does not
(`alignment-targets-differ`), and no diagnostic excuses it; `kept` and `grown` are history a later move leaves behind and are not compared. A guard on
port order (G5) was measured and dropped: on the three sheets it changed it gave back the two bends ticket 65 won, because the only kept
geometry that stands them turns another node's ports out of order (ticket 77 owns the face order).

**A stranded growth is given back** (architecture-2 ticket 71, `LayoutModel.givenBack`, `src/layout/given-back.ts`). A step can widen a
body toward its targets (`alignSide`) and then clamp the group into its window, so that no target stands; the width stays, and no later
rule removes it (the end trim keeps the port x). The centre rule judges this once, at its end, on the record above: a node gives its
growth back when its body is wider than at the rule's input, its faces hold a `grown` target and no `kept` one, none of its links stands
vertical (a kept chord), and no parent spread grew it. A node at one end of a transit link gives back only when the port at the other end
is given back too: 7f moves a corridor to a child it could not seat (`reseatLanes`) and refuses the move when the parent could then align
to it, so a narrow child whose parent still chases the corridor would lose the follow. When anything is given back, the passes run once
more from the rule's input with the record, and a step that widens a given-back body and leaves every aligned port of its group off its x after the clamp is
declined as a window decline is: the group stands near its feed with the widths it began with. The judgement reads the end of all the
passes, not one pass: a growth one pass strands is the one a later pass may complete. At most two runs, each with its own budget; a growth
the second run strands is kept and named (`CENTRE_GROWTH_KEPT`, info), as is a given-back body a sibling's standing target lets keep its width. The record names each node and its `grown` ports in code-unit
order; it is kept by every later rule and published, so the 7d to 7f replays and the publication check read the same decline (R1). A
malformed record, or one before the centre rule, is refused.

**The sibling push covers the whole tier.** A widening takes the space of the groups after it.
Those groups move right. This includes a group the step does not centre. It also includes a group
whose own window is too narrow to hold it.

Reserve that room before you grant the widening. Pack the later groups backwards against their own
windows. Decline a widening the reservation cannot hold.

A reserved lane and a flank bound the push. The window holds the group box and the stroke-aware
reach of its nodes and pills. That is the extent the lane validator measures. A group that cannot
clear its left neighbour inside the window keeps its box. Report it as
`CENTRE_TIER_PACK_INFEASIBLE`.

Two overlapping group boxes are not a poor diagram. They are an input stage 8 refuses. A foreign
group obstacle would then contain an attachment shape.

Bar groups do not participate in row centering: stage 7d owns their stacked spans and source-derived
port positions, including on later replay. Repacking their bars as a row would widen the group
again after every replay.

**A canton member above the anchor tier reserves its aligned extent** (architecture-2 ticket 31). The canton column of a
member just above the anchor tier is only as wide as the anchor row of its canton, and the member aligned over that row needs
its end-port insets and its side-face pills beyond the outer feeds. That room is known before centring, so the centre rule
records it before its first step (`alignedExtents`): the box the step would give the member, moved by the step's own main move
and grown to the targets `keptTargets` keeps (the alignment's own bounds: the row siblings, `ALIGNMENT_MAX_GROWTH` and the
overlay stops), with the margins and pills the box has beyond its bodies. Each edge is stored against an anchor-tier feed port,
so the record moves with the canton. A member with a feed from outside its canton, or a transit feed, reserves nothing. Only
the centre rule decides; a later replay that finds no record in a model with a canton reserves nothing and warns
`ALIGNED_EXTENTS_UNDECIDED`. One reader, `memberRoom`, gives a member its room: the member window of the step
(`columnWindow`), the canton wall of the inner column pass of 7f (`pullTier`) and the slide of a member frame off a chord
(`stepOverChords`) call it. The member may stand past the canton wall up to the record, and the canton, derived from its
members, grows with it. A step whose window still cannot hold the aligned group declines the alignment as a whole and names
its group and its feed links (`CENTRE_WINDOW_DECLINED`, one warning per group). When centring ends, and again after the last
move of 7f, the warning names only the links whose child port still stands off the x its seat wants. Below the anchor tier
nothing is reserved by that record; a parent there spreads instead (next paragraph).

**A parent below the anchor tier spreads its ports over its children** (architecture-2 ticket 32, Q120). Below the anchor tier the
child side alone aligns, and a child row cannot put two ports closer than its row gap: where the fed bottom ports of a parent stand
closer together than the top ports of its children, the drops slanted, and the child row stood under a neighbour of the parent. The
centre rule therefore spreads such a parent once, at its first run, before its first step and before the aligned extents
(`reserveParentSpreads`): each fed port goes to the spacing of its child, about the mean of the fed ports, so a block centred on its
face stays centred (ticket 10). The body grows by the deficit and no further (`alignSide`, bounded by `ALIGNMENT_MAX_GROWTH` and the
overlay stops, with no sibling bound), the nodes of its row before it move left by the growth on the left, the ones after it right
by the growth on the right, and the group is clamped into the window the step of the parent's tier gives it (`stepWindow`: the lanes
and flanks of 7a, the frame columns, the group before it and the room the groups after it reserve). A resize is no translation: the
group box can come back to its x while its nodes have moved. So the spread is made on the model and judged where it stands
(`resizeHolds`, `move-reservations.ts`): every reserved lane window and span corridor meets the new box no more than the old one,
every lane keeps its side, no facing port goes deeper in a riser keep-out, no new wall stands in a corridor or across a trunk
extension, and every far port that stood on its side lane still does. The child side must hold too: the child group, centred under
the spread ports, stays inside its own reserved window. A spread that fails any bound is undone whole and named
(`PARENT_SPREAD_DECLINED`, with the reason). A feed spreads only when it is adjacent, no bundle member or mesh bus, its parent port
feeds no other child of the step, and no other parent feeds its child node: a child of a complete block (the X) cannot stand under
two parents, so neither parent spreads over it. A parent in a bar, a flank or a grid keeps its ports. A parent with two or more such
feeds whose children stand further apart than its ports spreads when the children stand in one group and in the order of its ports;
otherwise it keeps its ports and is named. The deepest parent tier spreads first, because a spread moves the row that holds the
children of the tier above. The decision is stored once (`parentSpreads`). While the centre rule runs, `{}` records that no parent
spreads, so the later runs of the passes on that model (after a wall move is given back) do not decide again; the wide twin of the
rule is a copy taken before the first run and decides once on its own copy, from the same geometry. The rule drops an empty record
when it ends, so a sheet that spreads nothing keeps its bytes, and after the rule absent means no spread. Later runs, replays and the
publication check read the geometry the spread left and never decide again: a replay outside the centre rule spreads nothing. One
reader, `parentSpread`, holds a spread face where the spread put it in the face recentring (`recentreSeatedFaces`); the width, port
offsets and net row shift of an entry are a record for diagnostics and tests, read by no rule. A `CENTRE_ALIGNMENT_INFEASIBLE` whose
link stands vertical after the last move of 7f is withdrawn (`refreshAlignmentDeclines`).

**A group with no links steps out of an overlay chord** (ranked-groups ticket 76). `placeOverlayFree` ends with
`stepOutOfChords`. A free group with no link of any member has no partner, so no target: it would stay a wall at ELK's
arbitrary x, in the way of a chord that crosses its tier. After every partner is settled, such a group (not in a frame,
never in the anchor tier) stands at the x nearest its own where its box crosses no straight overlay chord. The chords are
the ones the overlay rule would draw face to face, counted when they are straight once the group's own nodes are taken
away. Every such chord that runs through the box's rows bans an interval of the box's x, not only the chords that cross
it now. The x also keeps the band gap to the other groups, columns and lanes of the tier and prefers their span. When
none fits, the group goes past the tier's end. A move that bends an overlay link that was straight is undone and reported
as `LINKLESS_GROUP_MOVE_REFUSED`. The 7f rounds that close up the cantons run the same step again (`stepLinklessOutOfChords`),
because a move in x changes the slope of a chord. The rounds grow no tier gap (architecture-2 ticket 57). The one solve of the gaps at the
end of 7f moves y only. It changes the slope of a chord that spans a gap, and no round follows it: a body that then stands on a held chord
is named `STRAIGHT_LINK_BLOCKED`.

**A chord between two tiers keeps the tiers between free of nodes** (ranked-groups ticket 77, Q64). A straight overlay chord
between nodes on two tiers reserves its path through the tiers between them. `stepOverChords` (`chord-clear.ts`) runs once
in each 7f round, after `stepLinklessOutOfChords`, and not in 7c: a move made there cannot be judged on the geometry that
settles after it. A group (with an overlay link, not in the anchor tier, not in a frame of several cells) or a node of a row
that stands on the chord of a longer link tries the x where one of its bodies or pills meets the end of the chord's blocked
interval, nearest first. A group moves whole, keeps the band gap to the groups, columns and lanes of its tier (inside its
canton for a member), stays inside the box of the whole layout, and, when it holds a routed link, keeps its place in the
order of its tier. A node moves alone, inside the box its group has and in its row's order. A candidate stays only when the
straight overlay count rises, `laneSidesHold` passes, every routed link that ran on one axis or held a chord still does, and
a copy of the model run through one round of the close-up and the keep-out (`settleRound`; it grows no tier gap since architecture-2 ticket 57) has no G6 or G5 finding that the same
copy without the move lacks (`parallelClearance` and `portOrder`, the gates' own predicates). Left bent: a chord blocked by
two groups, and a blocker in a frame of several cells. A step that moved runs the round again, so the close-up and the keep-out
are measured on the geometry that stands. `refreshHeldWarnings` withdraws only a warning that states a jog.

### 7d — bars

For each `bar` group, after 7c so all source ports are final: each node is a horizontal bar;
stack order = declaration order, top to bottom. Bar port x := source port x, ordered by x; where
two sources are closer than `pitch`, the later drop fans horizontally to the next free slot
(a 2-bend jog) and is reported. Bar span = [min port x − m_l, max port x + m_r], where each end
margin m is at least 30 px and is raised to the end inset stored by the stage-3 corner reservation
(ticket 156), so a long pill on the bar's side face keeps its clearance; floor = label + 60;
spans of stacked bars are merged to their union transitively when any pair overlaps by > 50 % of
the narrower; a bar with no ports spans the group's label only. A drop to a lower bar crosses the
upper bar (`barCross`); a link entering a bar from **below** is the mirror case and also counted.
For a bundle-member drop, compute and reserve its bar slot, span contribution, drop hint and
`barCross` ownership here, but do not pin a member path. Stage 7e consumes the reservation and
preserves the bar-owned `barCross` annotation on the resulting member path. Non-bundle drops are
pinned here. A drop crossing several bars has one `BarDrop` reservation per crossed bar, with
distinct IDs and `{ kind: 'barCross', node, link }` owners but the same source, port, slot and span.
A drop with no crossings has one link-owned reservation. Segment `barCross` lists retain all
crossed bars; gates require each exemption to match its bar-owned reservation.
When required inter-bar stem clearance increases the bar band's height, translate every lower
tier and any flank attached to it down by that band's actual positive growth. Preserve the
existing tier gaps, tier order, and every x coordinate. The checked transaction derives this
translation from the pre-shaping and final band geometry; callbacks still cannot move anything
outside the bar group. Rebuild bands, fixed-owner lane extents, measured geometry, and derived
paths through the atomic replay below. *Moves:* bar geometry plus this derived downstream-tier
vertical translation.

Bar shaping retains top/bottom port count × reserved side pitch + twice the content padding as a
width floor, including on replay and after span subtraction. A bar can itself source an upward
transit; its lane-capacity reservation survives the same shaping rule as a downward target.

### 7e — bundles

`bundles(model)` commits one checked `bars -> bundles` transaction. Its geometry-only planner
jointly orders endpoint sides, retains unequal authored precedence and unrelated relative order,
grows measured side pitch/capacity and repacks affected rows. The 16 px `memberGap` is visible
clearance. The minimum centreline pitch includes the maximum member stroke, 17.5 px at defaults.
Primary facing blocks remain aligned. Secondary flank blocks clear intervening nodes using their
actual stroke-aware bounds. Growth translates downstream bands and attached flanks before paths.
Existing lane identity, owner, x and width never change.

A block seated along x records its lead, `Bundle.lead`: the end whose first port stands farthest
along the tier, which the other end grows to and follows. A block with no single lead, a lane
that decides its start, or a far end that cannot grow to it (the block stands bent) records none. The column pull reads the record: a column whose every feed is the far end of
a block it leads has no feed range in the outer pass, because the seat has decided where that
feed stands (architecture-2 ticket 74). The canton inner pass keeps the feed range of such a
member.

Reserve crossing width/rows before creating paths. Strict endpoint-pair inversions ignore shared
port ties. Distinct engine ports use a common order where authored precedence permits it. Shared
incidence uses a deterministic search capped at 4096 endpoint-order pairs. Exhaustion emits
`BUNDLE_ORDER_OPTIMIZATION_LIMIT`; it does not claim a proved minimum. A K2,2 bundle has a true
minimum of one. Contradictory intermediate lane order fails with
`BUNDLE_RESERVATION_ORDER_CONFLICT` before publication, rather than inventing endpoint inversions.

Route a clear full-width centreline and offset its members. Aligned clear bundles stay straight.
Bent channels expose `envelopeParts` as swept rectangles and `envelope` as their union. Author
inversions use isolated adjacent-swap cells, unless the gap holds the member pitch (ADR-0017 as
amended by ticket DR-03: both stems fit between the placed faces and the existing geometry holds
the member gap), when each member is drawn as stem, one straight diagonal, stem instead; the
inversion count plays no part, and an infeasible bundle keeps the staircase. Every strict crossed member pair is independently
checked against the endpoint inversions; undeclared bend contacts and overlaps fail. Complete
member paths follow authored source-to-target direction even when bundle orientation differs.
Lane runs and the latest rebuilt bar hints/slots remain constraints. Every actual `barCross`
annotation retains its bar-owned reservation.

Collinear transits remain separate exact lane segment records, each with its own lane ID and
link owner. Connectors meeting closed lane boundaries are split and tagged only for the matching
owner/corridor; a later lane never overwrites an earlier lane's identity. Publication and restore
independently require every bundle lane's exact segment in authored traversal direction.

Shared incidence uses explicit junction trees. A root has an outward perpendicular stem of at
least 15 px. Fan peel rows also clear the whole pill body on their face, half the pill stroke,
half the widest routed stroke and the 0.25 px entry tolerance (`sidePillBodyReach`, ticket 156).
This keeps a peel beyond the pill-face start of a neighbouring straight chord. Ordinary router
stem tips retain the text-only depth, inside the node obstacle. A child keeps the same port, starts at its parent point, and carries a strict subset
of its parent's members. Each member traverses its exact root-to-leaf chain. A port shared across
bundles, between a bundle and an unclaimed remainder, or by a plain fan of routed links that no
bundle claims, has one tree (ticket 20); only a port whose links all belong to one bundle is that
bundle's own fan. A bar drop (its path fixed by 7d) joins the tree as its straight-through leaf when
its plain straight run out of the port reaches the last junction row plus a pitch: stage 7d has
already split that run into the tree's stems and the continuation under the junction ids 7e will use
(`junction:<port>:shared:<depth>`, ADR-0016), the continuation ending where the drop turns if that is
before the tree's usual end, so the scorer sees one owner on every shared segment. At most one fixed
member joins a port — the first by source order whose run fits the rows its cohort would have — and
it is always peeled last. The straight row and flank paths of stages 6 and 7b join the same way
(ticket 37): each producer offers its candidates to `treeCohorts` through the same pending map, and
a pinned path is offered at **both** of its ports, because either end may be a fan root. Where both
ends carry one, the two trees split the one path from opposite sides, so the row gap reserves both
continuations (`rowGap`) instead of one of them and the far side's stem; where that room is not
there, the deeper tree keeps the member. A drop whose run is too short and a drop at its bar end
stay outside the tree, and the cohort shrinks accordingly — one rule (`treeCohorts`) decides this in
7d from the traversals under construction, and in 7e and on restore from the root junction id a split
path carries. An excluded member keeps its own stem out of the port, which covers the tree's root:
7e reports it with `FAN_MEMBER_UNRESERVED` and G4 reports the overlap, until ticket 47 adopts the
last two shapes. A track also stands strictly inside every group or frame box its branch leaves, or outside it
one edge margin off its edge, whichever face is nearer the coordinate it wanted (ticket 18 of
architecture-2): a track outside the box ends its run there, so no group exit covers it. Instead of that
step, a member alone on its side of the port whose coordinate stands in that outer band is the **edge
keeper** (`edgeKeeper`): it is peeled last, and the tree's last junction moves out along the shared
normal past the margin of every box it leaves (plus `EXIT_SLACK`). The member peeled there turns the
other way and the keeper turns toward the coordinate it wanted: one L each. It is refused (and the step
stands, named `FAN_TRACK_STEPPED_AT_GROUP_EDGE`) when the depth passes the deepest row `fanRows` holds,
a node or stem wall stands on the coordinate, another member rises within the member pitch of the
extended stem, its turn crosses or crowds another port's row on the side, or its runs come within the
member gap of a run another link reserved. The junction records the keeper and its depth; final
placement freezes them in `LayoutModel.fanKeepers` (present only when held) after 7f; once `freeze.placement` stands, a replay reads the record and never
chooses again from a box (R1). A fan built later than the keeper's does not read its runs. A last pass releases the branch whose reserved run closes the checkpoint another
link's port must be approached from, and every branch of the link it hems (`FAN_BRANCH_HEMMED`,
ADR-0018 rule 3). **Only an end that reserved nothing is measured there**, and only for a link the
router really approaches — never one whose path a rule fixed, and never a bundle member, since
`planRoute` passes over a link that already holds a complete path. An end whose own fan reserved a
run is approached at that run's terminal, so the port's checkpoint stands inside the link's own
reservation. That terminal can be shut in turn and then throws (stress ticket 11), but a release
does not open it: it pins the gap's end in the middle of the tier gap, where the route the router
finds for one released link can wall in the point another has to reach. A release must leave the
router a gap it can answer orthogonally (stress ticket 10).
`LayoutLink.sharedRuns.from/to` records its outward partial runs. A checkpoint
the reserved run already passes through — a lane's approach point that a deep leaf has reached — is
consumed by the run and not asked of the router. Stage 13 consumes `from` outward and `to` in reverse order and direction;
a partial run never becomes a complete `path`. G4 exempts only validated shared runs. G6's fan
exception covers the incident run and immediate outgoing branches at the same verified vertex. A junction's stem is one
run in every member's path. A member's segment paired with another member's copy of the stem is judged as a pair of that
member's own segments: its staircase tread (a branch that turns off the stem by less than the clearance and goes on
outward) or its own neighbour segment (the run that leaves the stem's end, also one the junction does not claim) is not a
clearance pair.

A global shared prefix is consumed even when only one member of a bundle uses that port. Ordinary
endpoints keep ordinary approaches. Reserved lane/bar routes connect to the shared tree's leaf
endpoints, with the fan plus outward continuation and lane buffer reserved before paths. The
endpoint approach is replaced up to the nearest mandatory run; its exact segment and the remaining
hint traversal survive. Source and target prefixes are composed before converting the complete
path to authored direction, so no member retreats through its own fan or reservation.
When a facing bar hint has no lane or crossed-bar constraint, its old common approach is not a
mandatory splice boundary: rebuild the independent channel between fan leaves and retain the
bar's actual attachment through the tree. A free shared bar star projects leaves onto its distinct
peer tracks; reserve twice the regular peer pitch before paths so a mean bar slot still leaves
clearance between its shared normal and the neighboring independent approaches.

Only explicitly selected `merge` members enter `Bundle.mergeRuns`. Each run has a stable ID,
exact members, count and actual shared trunk path. Counts change when membership changes along a
trunk. Ordinary parallel bundles create no count. A singleton selected merge keeps its authored
technique and ordinary anchored path, with `MERGE_SINGLE_MEMBER` warning because it has no
selected merge partner. It does not recruit parallel members, and may still use a junction stem.
Stage 14 measures and places multiplicity labels from these records after routing. Stage 16 emits
that final geometry and labels; it never measures or invents a count-label position. Parallel
inversion crossings are individually visible; merged trunks do not claim to depict them.

All bundle paths, shared runs, junctions and envelopes are derived claims. Publication and restore
rebuild and compare them with the same producer. Callbacks cannot edit these claims. Frozen
identity, side, authored precedence and floors reject before replay can repair them. The ordered
replay is reusable by stage 7f and consumes one caller-owned eight-pass centering budget. The final
scorer still requires every complete path; a stage-11 subset score is not a full golden result.

A group exit (`model.groupExits`) is a held promise (DR-11): its direction and the boxes it leaves
are a stored decision, and each replay derives only its coordinates again. A replay offers a held
end its held direction alone while that direction is free; any other outcome is a replan, allowed
before the final freeze and refused after it. A required exit that the geometry admits and the
record lacks fails the producer postcondition, whatever diagnostic the model carries.

The crossover room of an inverted side-facing bundle moves groups in x without their lanes, so it
asks `holdsMove` first: for a group wholly right of the threshold, its moved box; for a group that
straddles the threshold, its box widened by the room, and `holdsNodeMove` for its moved nodes. Refused, no room is taken (`BUNDLE_ROOM_HELD`): the bundle draws
straight members where its gap holds the member pitch (ADR-0017), or refuses by name.

For facing, non-inverted members whose endpoint tracks differ, each bend receives a distinct
member-pitch row. Members moving toward smaller tangent coordinates turn in increasing source
order; those moving toward larger coordinates turn in decreasing order. This avoids bend contact
and coincident lateral runs even when unrelated ports create unequal endpoint spacing. The rows
stand centred between the two stems, unless a row would then bring its member into a foreign box:
a group or frame box that gate G2 holds the member out of, or a node body that is no end of the
bundle and not on the overlay layer, each with its gate margin. A box over the member's run forbids its own depth band; a box
over the leg from the near end also forbids every deeper row, and a box over the leg to the far end
every shallower row. Such rows move toward the near end, or else toward the far end, past the box,
the same way they move one edge margin off the edge of a group box: the boxes gate G6 reads
(`groupBoxes`, every frame and every plain group, the bundle's own included), not the frames only
(architecture-2 ticket 76: the lower end's group padding is part of the channel, so centred rows
could stand under a foreign box that the upper end stands over). Optional
projection onto a common endpoint block is declined if its full side capacity would cross a sibling
or immutable lane; local slots remain valid and the bundle bends instead.

### 7f — group label bands, tier gap room, group label bands again

7f does these things, in this order (architecture-2 ticket 57): it reserves the height of the group label bands on the y axis only
(`topUpBandClearance`); it runs the rounds (the close-up of the cantons, the keep-out, the steps over a chord), which
grow no tier gap; when the rounds did not replay the draft and the centring left its non-convergence or a violation the publication would
refuse, it settles the centring once on the frozen geometry (one `replayRegions`, architecture-2 ticket 65: the bands'
single budget gave no pass after it); it lets a corridor whose child 7c could not seat follow that child (`reseatLanes`, § 7a); it settles the overlay ports;
it solves the tier gaps once (`solveTierGaps`, `gap-room.ts`): the stem depths are recorded, every plan and every label room across a gap
is read once, and each gap grows by what it lacks; it trims each node body to its ports and content (the end trim, below, architecture-2
ticket 68) and closes a group up toward its sibling by the width the trim freed (the close-up, ticket 69); and, last, it places every group title once (`placeGroupTitles`, architecture-2 ticket 54). The corridor move is after the rounds because every centring replay before it — 7c's own and the label bands' — reads lane x
as that feed's authoritative x and chases a corridor that has moved. It reserves no room itself: the solve after it grows the gap for the
new row (§ 7a states the whole condition).

**Direct families come first** (architecture-2 ticket 22; `docs/design/routed-chords.md`, Section 15). Before `freezeChords`,
`planDirectFamilies` counts the orthogonal crossings of each facing pair on a copy, and decides each triggered family's chords
together, at any angle, before the freeze; it records them (`directFamilies`, triggered families only) and moves nothing. The
freeze holds the accepted members. When the
centring after the freeze brings a member within the chord clearance of a leg or a held chord, the attempt runs again with that
member refused (`DIRECT_RETRIES`, 2).

**A frame keeps out of a foreign drop's clearance** (ticket 75). A routed link between a cell of a frame and a port of another tier
drops to the x of that port from a row in the padding of the frame. When that x stands outside the frame, closer to a left or right
edge than `GROUP_EDGE_LINK_CLEARANCE` plus half the routed stroke, the drop runs along the edge and G6 refuses it. Routing can only
discover that, so placement reserves it: the column plans (`pullTier`) leave a frame where it stands rather than take a left inside the
band, and in the rounds of the close-up `settleKeepOut` moves a frame that a mover without a plan (the push of a widened neighbour, a
lane reseated) left inside it, right by the smallest amount. The frames after it give way to the moved geometry (the sweep is read after
the keep-out is applied, and both are applied together until neither has anything left); a lane that forbids the move, or a move that
leaves fewer overlay links straight, refuses it. A sweep that ends with a hard separation (G9) broken or deepened, read on the frames
derived from the moved boxes, is undone whole, the boxes and anchors restored exactly, and `KEEP_OUT_UNDONE` names the groups: a flank beside the moved row does not give way, and no close-up runs after this step
(ticket 162).

**A diagonal may cross text** (ticket 162, ADR-0023). A straight, non-orthogonal segment of a held chord, a straight member or an
overlay chord takes no room from a group title or a link label: the title placement reads no rectangle from it (`linkRects`,
`chordCrossings`), the label room cuts no window of a label's line at it (`fixedLinkRuns`), and the row-path corridor
reads no label against it. Each asks `diagonalMayCross` (`diagonal-text.ts`). A segment within 10 degrees of an axis
(`DIAGONAL_MIN_DEGREES`) keeps the rules of the label room and the corridor. Since ticket 54 no title refuses or crowds any
chord, diagonal or not (below), so a chord that 7f turns onto an axis keeps its chord and the title yields to it
(`a-chord-that-turns-onto-an-axis-meets-a-title`).
The rule applies to a frame and to a one-rank row group. A canton keeps its band gap (ticket 65) and is not moved for it. From 7f on (the replays of the bundled model), a centring replay also declines a step that leaves fewer
overlay links straight, or that puts a frame inside a band it was not in: the group stays where it stood.

**Titles last: a group title yields to its links** (architecture-2 ticket 54, ADR-0023 amendment, user 2026-11-02). Stage 5 fixes the
title edge (ADR-0011) and the width floor (`ownTitleFloor`); the start of 7f reserves the band height, on the y axis only
(`topUpBandClearance`; ticket 57). No placement reader
sees a title: no chord is refused for one, no fan or direct member is refused or crowded by one, and the gap plan, the leg clearance
(`legClear`), the corridor (`straightCorridorClear`) and the lane corridor keep no clearance from one. No box grows and no link bends for a
title. At the end of 7f, after the last move of a box, a lane or a port (`nestOverlayPorts`), `placeGroupTitles` places each title once,
per band in gap order then id order (R3): the left edge nearest the centre of its holder (the host cell's box, or a canton's band) where no
blocker meets it (`titleBlockers`: the legs of the band's ports, bus stubs and risers, lanes, reserved runs, envelopes, feed corridors,
nodes, pills, other text and the titles placed before it); a tie goes left. With no free span the title stands at the centre (or the
nearest x clear of text, which stays hard; with none, it stands on the text with `GROUP_TITLE_ON_TEXT`, G3 judges, and the validator
proves that no x was clear) with the halo (`yield: 'halo'`) and records the routed links that cross it (`crossedBy`, id
order). A slid title records `crossedBy: []`; an absent record means not placed (R1). It moves nothing and retries nothing. The validator
reads the record (`groupTitlesFault`): one title per band, inside its band less the insets, on no text, a title with no yield meets no
blocker, and `crossedBy` equals the links whose geometry crosses it (R5). G3 excuses a segment of a link in `crossedBy` (not a horizontal segment through the text); stage 8 lists those
links as consumers of the title's obstacle and reservation and keeps the title an obstacle to every other link (`ROUTE_TITLE_DETOUR` names
a routed link that turns beside a title it does not cross; a turn of a tier-gap run is placement's, so it is never named, ticket 56). A jog of a
planned drop stands one group-edge margin off every group box (the O5 obstacle of each box and node, whatever the sign of its bound, so a box
lower than its band top holds the jog too), and the verticals of a jogged drop cross a title band only at the x of a port leg, which the title
already reads (ticket 56, fixed by construction).

**The mesh bus band** (ticket 83; `docs/design/mesh-bus.md`, section 4). A bus with a fixed side asks for a band of `BUS_STUB` (15 px) plus
`4 px + label height + 4 px` (the label is `<class> mesh (<n> nodes)` at 9 px). Two placements reserve it.
*In-frame*: the group that holds the members (a cell or a group) holds the band on the bus edge as it holds a label band, through
`groupInsets`: on the title edge the label band's `clearance` grows by the bus band and the title moves out by it; on the other edge the
inset is the larger of the padding and the band. `topUpBandClearance` shifts the nodes and grows the box by the room still missing (it
reads the bands the model carries, so the second call reserves nothing more); it moves no x, and the tiers below move down by the growth
of the band. The frame follows its cells.
*Across frames*: the band stands in the sub-tier gap on the bus edge and belongs to no frame; the sub-tier holds it as it holds a canton title
band. `gapBandDemand` asks 20 + band + 20 there, and 20 + bus band + canton band + 20 where a canton band stands on the same edge (the
sum, never the larger); stage 6 (`reseatBands`) seats the gap at that height, so 7f moves no tier for it. A canton whose outer edge carries the band
grows by it between its member frames and its title band (`deriveFrames`).
`syncBands` publishes the `BusBand` records (`busBands`; `group` names the host of an in-frame band) and the bar, the stubs and the label's room
(`bus.bar`, `bus.stubs`, `bus.labelRoom`) beside the label bands, so every replay that rebuilds the label bands rebuilds them, before the
tier gaps are solved and again after it. The bar runs at `L + 15` from the first bus port to the last, `L` being the outermost body or pill extent
of the members' cell in-frame, and the outermost edge on the bus side of every group of the row in the span across frames (a foreign frame
included). A stub runs from its port's outward face straight to the bar. The label's room is the centre of the bar where no vertical crosses
the band there, else the longest clear interval; a stub ends at the bar and the label stands beyond it, so a stub never blocks it.
A stub of an across-frames bus leaves through the padding and the label band of its frame on the bus edge: `legRects` reads it as a leg of the
band's ports, so the title slides clear of it, or takes the halo where no span is free (ticket 54; the edge flip of ticket 83 is gone). The tier-gap plan reads an across-frames band as an O5 band (`tier-gap-rows.md`).
Bus members are neither straight nor bent: both `straightOverlays` and `stepOverChords` leave them out.
Ticket 96 (`mesh-bus.md`, section 11.5): stage 7a, after the lanes of every routed link, fixes the riser x of a joined pair and reserves one overlay-layer riser lane in each sub-tier between the two rows (`riser:<bus>:<sub-tier>`); both bars run to the riser x; two facing bus bands in one gap are added (`gapBandDemand`, seated in stage 6); the tier-gap plan reads the riser as a vertical that a middle drop keeps `k` from.

**A tier gap is as high as its reservations need, and placement computes that height once (ADR-0021, amended by architecture-2 ticket 57).**
Each gap has this height: the largest of the tier-gap minimum (`tierGapMin`), the bands that stand in it (`gapBandDemand`), the rows and
drops of its parts (the plan, with the stored stem depths) and the room of the link labels that ride across it. Stage 4 opens the gap to
`tierGapMin`. Stage 6 seats it at `max(tierGapMin, gapBandDemand)`. The start of 7f reserves the band height on the y axis only
(`topUpBandClearance`). The rows and the labels need the final x, so one solve reads them once, after the last move in x. No later step
grows a gap, and no step reads the height of a gap to make a decision that the height then changes.

**The solve (`solveTierGaps`, `gap-room.ts`)** runs once per 7f attempt, after the last move in x (`nestOverlayPorts`) and before
`placeGroupTitles`. It takes these steps:

1. It records the stem depths (`recordStemDepths`; below).
2. It reads every plan once (`tierGapPlans`). No title stands in the gap plan: a title yields to the rows and drops (ticket 54), and is
   placed after them.
3. It reads the label term: `reserveLinkLabelRoom` runs on a copy, at the growth that the gap takes anyway, and gives the deficit of each
   gap. A label that raises its gap is read again with the others at the new height, at most `LABEL_SOLVE_READS` (4) times. A room that still
   rises is given up to the label placement (`labelRoomUnsettled`, `LINK_LABEL_ROOM_UNSETTLED`).
4. Each gap grows by `max(0, H - room, label deficit)`. Every band below it moves down by the running total (`moveBands`), and a y-only
   rebuild follows (regions, node geometry, lanes, the grid and the label bands) with no centring. A rebuild that moves an x throws.
   The grid of that rebuild holds a linked pair that stood apart in x before the growth and that a live grid would widen after it
   (architecture-2 ticket 73): its x guard (`holdsMove`) reads the gaps, so a growth can admit a widening the last move in x refused. The
   held pair stays as it stands and is recorded in `gridRefusals`, which the validator and the replays after the solve honour; every other
   pair is judged and recorded as before. The centring replay below holds nothing (sweep input v6-2-1, fixture
   a-tier-gap-growth-widens-no-grid-pair-in-x).
   `TIER_GAP_GROWN` names what set the gap: a part of the plan, or "the label of link-N".
5. It checks the gaps as they stand. None of these checks grows a gap, and each one is named. None of them fires on the corpus (390 sheets).
   - A growth that breaks an alignment the centring had excused replays the centring once (`TIER_GAP_CENTRING_REPLAYED`). This replay
     is the only x move of the solve. Since architecture-2 ticket 65 the settle at the end of the 7f rounds reaches the alignments before
     the solve, so the replay is a safety net: it fires on no corpus sheet.
   - A stem record that the grown geometry no longer calls for is decided again (`STEM_DEPTHS_REDECIDED`).
   - A label room across a tier gap that is still short is given up.
   - A plan that still asks for room names its gap (`TIER_GAP_SOLVE_SHORT`).

Except for that one replay, nothing moves horizontally and nothing moves up, so lane x, the groups' order and every reservation 7a to 7e made stay as they are. A gap
whose parts already fit grows by nothing. A part that the plan declines is named (`TIER_GAP_PART_RESIDUAL`, `TIER_GAP_ROW_CYCLE`) and left
to the router.

The height `H` of one gap is computed from the rows of its parts, packed from the low boundary:

```
lb_i   = max( own upper tip row (or low + e where that tip is in the padding), own mouth row,
              tip row + k for every foreign upper tip strictly inside the span,
              O5 bands anchored to the band above, over the span )
need_i = max( depth(own lower end), e where the span crosses a group's top edge,
              k + depth(j) for every lower leg the run really crosses,
              k + depth(d) for every drop d inside the span (2k + depth(d) with a jog),
              O5 bands anchored to the band below, plus their clearance )
drop d:  lb_d = own upper tip row;  need_d = depth(own lower end) + (k with a jog)
residual r between the two tiers:  need_r = depth(upper tip, from low) + 2k + depth(lower tip)
H      = max( floor, max_i ( y_i - low + need_i ), max_d ( lb_d - low + need_d ), need_r )
growth = max( 0, H - (bandTop - low) )
```

`depth` of a lower end is `bandTop` less its row: 15 for a flat tip on the boundary, 32.5 or 50 for
a nested one, negative for a tip in the padding, `overhang + m` for a mouth. `floor = max(tierGapMin, gapBandDemand) - (low -
bottom(band above))`: a lane overhang takes its part of the minimum. The largest term without the
floor is the **demand**.

**The stem depths are decided once and recorded (`stemDepths`).** The plan depends on the height of the gap only through the stems: a stem
nests only where the leg is clear (`sidePlan`, `legClear`). `legClear` reads the nodes, group boxes and lanes of the stem's own sub-tier only
and no tier across the gap, so a growth of the gap cannot change a stem. The solve decides the depths first and records them on the model:
the node, the side and the reach of each port with a leg there. `[]` means decided, no side nests; an absent record means a model from
before the end of 7f or an older layout, and the readers derive the plan (`stemDepth`, `routerEntryPoints`, `stemCheckpoint`). The
validator and a restore refuse a record that differs from what the published geometry calls for (`stemDepthsFault`, R5). So one read of
the plan is the answer. Until ticket 57, `growTierGaps` iterated to a fixed point of `extra = H(grown by extra) - room` on trial copies
(at most six rounds), because `H` was not monotone in the growth; that loop, its trial copies and its caps are gone. The fixture
`a-band-holds-the-group-that-set-its-edge` is the case of that non-monotone `H`.

The height is a reservation, not a discovery: stage 8 receives a gap that already holds its rows.
Stage 8 is the **consumer** of the gap and never its owner. It reads the plan again on frozen placement. A gap that then does not fit is
named `TIER_GAP_PART_UNFIT` at stage 8 (`unfitGaps`) and its links are the router's. That is a safety net (R6), and it must not fire.

**The end trim (`trimBodies`, `end-trim.ts`; architecture-2 ticket 68).** After the solve, the last move in x, and before the titles, each
node body is trimmed to the span of its `top` and `bottom` ports with their stored end insets (`portEndInsets`), never below its stage-3
size read on the final faces (`sizeFloor`, `contentSize`, the content measured again, the capacity of each horizontal face, a side hint's
node floor). A face with lateral ports keeps its x; a node with ports on both lateral sides and a `bar` node are not trimmed. Ports keep
their x and no node moves, so no plan, chord, lane or course changes. Each group box shrinks to its content (title floor
included) inside the box it had; the linked-group grid runs again (honouring `gridRefusals`) and may grow a box onto a linked partner's
extent, as its rule says; the regions, frames, tier bands and label bands are derived again. A trim whose grid would move a node, change a
box's height or widen the drawing, or that would change a label band's clearance, end a grid refusal or contradict a lane, is declined
whole (`END_TRIM_DECLINED`, with the reason) and the draft is the one 7f left. A held chord that now leaves a narrower frame by a
side edge is named by `STRAIGHT_LINK_EDGE`, as every 7f move after the freeze is. The record `bodyTrims` holds the body and box each
trimmed node and changed group had before the trim; the centring replay of the publication check reads that geometry (`untrimmedModel`),
the one its producer decided on, never the narrower bodies (R1), and the validator checks each recorded node against `trimmedBody` of its
recorded body (`bodyTrimsFault`, R5). Absent = no body was trimmed.

**The close-up (`closeUpSiblings`, `close-up.ts`; architecture-2 ticket 69).** A kept trim is followed by the close-up, in the same
transaction. Tiers from top to bottom, movers from left to right (ties by id): a mover is a top-level group with no frame cell, flank,
cells or `bar` shape that has a group or frame box on its left in its rows. It moves left as far as every box on its left that overlaps it
in y (a group box, a frame cell, a frame, a lane) allows, each keeping the gap it had to the mover before the trim, at least the band gap:
only the width the trim freed closes. A lane that stands on a port of the mover on its owner link (a corridor that follows its child)
moves with it and stops the move at the boxes on its left beside it. The node geometry and every rule-owned geometry are derived again
with no centring (`rebuildRegionGeometry(..., false)`), then the label bands and the grid. A move under 1 px is not made. A guard
declines the move, undone whole (`CLOSE_UP_DECLINED`, with the group and the reason), when a port does not move by the shift with its
node (a bundle seats it again), a label band changes, the grid moves a box or a grid refusal would no longer hold, two boxes overlap that
did not, `validateLanes` fails, a frozen chord becomes blocked or leaves its frame by an edge, a reservation fails that held, a tier-gap
plan needs more height or gets a new residual part or crowded leg, a link whose two ends stood on one x does not, an overlay link loses
its straight chord, or a link label loses its room. The shifts are recorded in `bodyTrims.shifts` and `bodyTrims.laneShifts`; the
replay (`untrimmedModel`) moves the groups and lanes back, drops the routed paths and derives the rule geometry again, and the validator
requires the close-up of that geometry to give the same shifts (`checkBodyTrims`). The close-up runs after the last move in x: before
the chord freeze every centring replay of the 7f rounds reads a lane's x as its feed's x and moves the group back.

The plan is read at the end of 7f and not at 7a because the count of stepped parts and drops depends on every
rule before 7f: 7c aligns a child under its lane, 7d spans a bar across its ports, and 7e orders a
bundle's ports, and each turns a row into a drop. Measured: the M1 golden's one populated tier gap
owes four rows after 7a and none after 7d, so a plan read at 7a would grow a gap the finished
diagram does not need. The solve is after the last move in x, so its plan is the one stage 8 receives. The solve moves y only, and the
titles are placed after it and move no box. The plan is recomputed at consumption as a check, and a part that then does not fit is residual
with `TIER_GAP_PART_UNFIT`, never a silent discovery.

For every group: band height = label height + 8, inside the padding of the **title edge**: the
horizontal edge with fewer incident routed link ports, so a group fed from above carries its title
at the bottom and no link routes around it; ties, including groups linked only sideways, keep the
top (ADR-0011). A bottom band grows the group downward. Every group's nodes move down by the largest
top-band shift of their tier, so mixed title edges and unequal clearances keep the tier's node row
level and flanks stay level with their peers. The label is placed last (`placeGroupTitles`, above): centred when
its measured box is clear, otherwise at the nearest free position within the horizontal
insets, equal-distance ties to the left; with none free, centred with the halo, recording the links that cross it (`crossedBy`).
No box grows for it. Its **link-margin** is 8 px on every side: a free position keeps that far from every reserved link rectangle (paths,
lane runs, legs, shared runs, envelopes, feed corridors); stage 8 expands the label obstacle by it for every link not in `crossedBy`; G3
fails a routed segment closer than stroke/2 + 8 px to a group title unless its link is in `crossedBy`.

Measure group labels with the shared font table at 12 px, weight 700 and `FONT_FAMILY`. The band
retains 4 px above and below the measured text, and the label has an 8 px horizontal inset. Convert
intersecting geometry into forbidden label-start intervals, sort by start/end/stable ID, merge, and
choose the free x nearest the centered position. The stable claims are `label-band:<group-id>` and
`label:group:<group-id>`; bands remain placement reservations and measured labels are router inputs, so no duplicate
generic obstacle is added. Group fitting and bar shaping include the band above the measured
node-and-pill padding and retain a wider extent created by collision repair. The intervals include every
reserved rectangle of a link: its complete path, its partially fixed lane runs and the mandatory
outward shared runs of both ends — and, for a non-bundle top/bottom feed whose two anchors already
share an x (7c) and whose straight corridor is clear of every node, pill, lane and fixed run, that
**feed corridor** itself: stage 8 will route it as that straight line, so a label placed on it would
force a detour placement could have avoided. The check ignores group and stage-9 labels so planning
and restore agree. A complete path repeats the runs it consumed, so identical
stroke-aware rectangles with identical ownership collapse to one entry.

**A described link is long enough for its description (ADR-0014).** Before labels are planned,
every authored link label (bars and unsuppressed overlay links included; bundle members excluded) is
measured and its link's run — symmetric about the midpoint the label will take, out to the nearer
pill face or node edge — is made at least the label width plus both 8 px shortening margins: a link between tiers
moves nothing in the reservation: its deficit is a term of the height of the tier gap, which the one solve at the end of 7f reads
(`solveTierGaps`, `reserveLinkLabelRoom` with `gapRoom`, architecture-2 ticket 57); a link between two ends of one tier inserts the room at
the gap: every group in every tier at or beyond the split between the two pill faces moves right,
and a group straddling the split shifts only the nodes beyond it — in the link's own tier those that
start beyond it, elsewhere those with any part beyond it — so alignments, flank sides and
bar-to-source slots all survive and nothing moves left into a preceding group; a reserved lane at or
beyond the split makes the link unreservable. A routed link will detour when its ends are not level
or when the straight run between them is not clear by the corridor check — a node, pill, foreign group
box with its margin, lane, fixed run, bundle row or bundle envelope in the way — and its run is then reserved with both stroke-aware
router stems and twice the anchor-side pill protrusion on top of the label. That midpoint is the
anchor midpoint for a routed link. For an **overlay** link it is the midpoint of the longest run of
the path the overlay rule derives: the rule reads both of its branches off boxes placement has
already frozen, so placement runs the very producer stage 8 will run instead of assuming the shape
(synthetics review ticket 04 B). 7f grows room on one axis, so it can reserve wherever the longest
run has reach on that axis — the whole orthogonal branch, and the straight branch's diagonal, which
widening lengthens. Only a run lying wholly across the axis leaves nothing to widen. The required
room is one figure for both families — the text and its two shortening margins — because the room is
measured out to the two pill faces and an overlay link's straight run is measured between those same
two faces, so the run the label rides *is* the room. An overlay link once carried one
`OVERLAY_PILL_CLEARANCE` per end on top (synthetics review ticket 01), which was true while its
labelled run started a stub beyond each face; stress ticket 30 removed the stub, and the allowance
with it, as 8 px of over-reservation.
**A label stays in one region, and placement reserves the region (ticket 19).** The run must also hold
the label in one of its **windows** (`labelRunWindows`, the windows stage 9 places the label in): on
every run a label rides — a straight drop between two level anchors, a side lane's vertical run (at
the lane's x, down to the lateral port's y), an overlay link's longest run, and a straight run
between two facing pill faces in one row — `labelWindowDeficit` computes the growth at the split
(the top of the lower tiers, or the split between the two faces) after which a window between the
borders the run crosses holds the label, with the same `windowHolds` stage 9 asks. The growth is the
larger of that and the symmetric deficit. A routed link that bends or detours has no run for
placement to read, and stage 9 decides. A run whose window no growth at the split can open (a box
that moves with the far end cuts it) is diagnosed `LINK_LABEL_ROOM_UNRESERVED`, and so is an overlay
L's side run that has no gap to grow and whose windows do not hold the label now. **Room across a run
(ticket 21).** An overlay link's longest run that lies in a group's padding, between the node bodies and
one edge of the box, carries its label on the side of that edge: always on the top and right edges (the
side stage 9 tries first), and on the bottom and left edges when the box on the side of the bodies meets a
body, a pill or a border. The box is the one stage 9 tries (`runLabelBox`). When the padding on that edge,
from the bodies to the box edge, is less than the label's reach beyond the bodies plus the border's half
stroke (`acrossRunPadding`), 7f grows that edge by exactly the deficit: the group's own content and the tiers
below move down for the top edge (a sibling of its tier stays), the tiers below for the bottom edge, and the
room is inserted at the bodies' face for a side edge. The room is recorded per group and edge with the links
it was grown for (`model.labelPadding`: `room`, `links`; the room only grows), `groupPadding` reads it, so
every rebuild keeps it. 7f writes a room only above the edge's ordinary padding. The validator refuses an
entry with no link, a link the model does not have, or a room short of what a named link needs now (room ≥
need); a named link with no labelled run now, or a room a later padding row reached, is no fault (both follow
legal later geometry). The replay reports a box that no longer holds the room. The title edge is left
to the title band; a rank cell's border is its frame's, and is not grown. **Track room (ticket 23).** A run
that track separation moved further into a plain group's padding (`paddingOf`, the reader this rule and
the overlay paths share) needs the padding to reach it plus one overlay track pitch to the border, or plus
the label (half the stroke, the normal gap, the text, half the border) when the run carries the link's
label (`trackRoomPadding`). 7f grows those edges first, before the label windows are read, by the same
growth and into the same record (`labelPadding`, the link that holds the track); the validator reads the
same need. **Overlay ports nest (ticket 23).** The free overlay ports of each face
trade slots where the tracks then nest instead of crossing: the outer track takes the port nearer the side
the tracks come from (on a lateral face, the lower track the lower port when both come from below). Stage
5 cannot decide it: it orders a face before any detour is derived, and the side and the track of a detour
depend on the geometry 7f settles and on the whole layer. The measure is the separation itself
(`nestOverlayPorts`: the published overlay paths, then fewer shared tracks, fewer bent links and turns,
fewer crossing points). On a face where detours and direct links leave, the direct links trade too: a
link that turns up takes a port above one that leaves straight or on a diagonal, one that turns down a port
below it (user, 2026-10-24). Only a free port moves: no authored `order:`, no other link on it (so no routed
port), no bus, no course, on a face where a free port leaves by a detour, and a pill of the same size. A
pair is tried only when its two paths cross or share a track, and at most `NEST_TRIALS` (24) trades are
tried per attempt (R4). The two ports trade anchor and
`engineOrder`, so no size or spacing changes, as 7e bundles reorder their own ports. It runs at the end of
the 7f attempt, after every placement move was judged on the order stage 5 gave (a trade made earlier
would stand under the judges of later moves), and it makes no trade that would need room 7f did not
reserve (`roomHolds`: the record holds every need, and a replay reserves nothing more). The anchors are
its record; no replay asks it again (a choice, not a fixed point).
**A diagonal run has windows too (ticket 20).** A label on a diagonal overlay line, or on a held routed chord
(ticket 22), lies on the line,
turned to its angle (ticket 16), and is tested by its turned rectangle (text plus halo). Its windows
(`labelRunWindows` with the turned box's height) are the line less the shorten margins, less every
stretch where a cross-section of the turned box touches a border's stroke, grown by the border margin
and the halo along the line. The windows also keep clear of the link geometry placement reserved
(`reservedLinkRuns`: every frozen chord and every routed lane, the label's own link left out; user
decision 2026-10-23): a stretch where a cross-section of the turned box comes within the run's half
stroke (G3) is cut, grown by the halo. 7f and stage 9 pass the same runs, so stage 9 places the text
in the window placement reserved. A link placement did not reserve is left to stage 9's collision
test. **Two labels on diagonal lines do not take each other's window** (ticket 20 follow-up). A label on a
diagonal line lies in the line's **band**: the line, with half the turned box's height plus the halo. When
two bands can meet, one label yields: its windows also keep clear of the other band, and in stage 9 every
candidate on its line does too (a candidate beside the line is left to the collision test). The ranking
(ticket 21): first, a label for which some growth 7f can make gives a window clear of the other band
(`labelWindowDeficit` defined, at the split 7f grows at, `tierGapSplit`) yields, rather than one no growth
can help; then the label with the more slack yields (the longest window of its line clear of the borders, the
reserved runs and the other band, less its text); last, the later link. The other label lies in its own band, so the two never
meet, whichever stage 9 places first. The decision is made once per pair, when the bands first can meet, and
recorded (`model.labelYields`, `recordLabelYields`: a key for every label on a diagonal line, `[]` = it
yields to none); 7f and stage 9 read the record (`labelBands`), and the validator refuses a record that is
forged or that a replay would complete. Without this rule a label placed first took the window 7f had grown
for a later one, and the growth was spent for a label that fell back across a border. A label that yields
and finds no window, at any growth, is diagnosed `LINK_LABEL_ROOM_UNRESERVED` and no growth is spent on it;
a label that yields to two or more others can stay without a window that way. A decision never flips and
growth only increases, so the passes end. The tier gap grows (in the solve at the end of 7f) until a window holds the text; the line turns as the lower end moves, so
`labelWindowDeficit` finds the least growth by bisection (`LABEL_WINDOW_BISECTIONS` steps, rounded up
to `LABEL_WINDOW_GRAIN`).
Self-links, same-tier links
through top/bottom ports, pairs whose ports do not face each other across the gap, and overlay links
whose longest run lies wholly across the axis the room grows on are diagnosed `LINK_LABEL_ROOM_UNRESERVED`.
Room that lies beyond a reserved lane is inserted, and the lane and everything beyond it move out
with it (`insertRoomAt`; label room wins over an adjacent lane, architecture-2 ticket 23). Moves settle pills before the next link measures; the
reservation re-runs after the grid inside the 7f loop and any movement replays the region producers. That group's band clearance also
reserves the label's room beside the detour run under the title. **Label room is reserved by the producer and by the tier-gap
solve only (ADR-0014 r2, amended 2026-11-07; decision review ticket DR-02).** A settle round (`settleRound`) runs the close-up and the
keep-out and reserves no label room: architecture-2 ticket 27 once ended each round on `reserveLinkLabelRoom` with a bound of 4 passes
(`LABEL_ROOM_PASSES`), and ticket DR-02 deleted that loop because the bound at 0 changed no drawing on 467 sheets. A label room across a
tier gap is recorded as a shortfall and not moved; the solve at the end of 7f pays it with height, and the validator and the room check
(`roomHolds`) count a tier-gap shortfall as a fault. A room the solve cannot open is given up (`labelRoomUnsettled`, named
`LINK_LABEL_ROOM_UNSETTLED`, see 7f solve). The reservation then reserves nothing for those links (`LINK_LABEL_ROOM_UNRESERVED`) and the
label placement decides: with no window the label may lie across a border, with `LINK_LABEL_ON_BORDER`, and stage 9's collision test refuses
a place on a link. No gate judges it (G3 leaves out overlay labels; `labelBorderCrossings` is a counter). The validator refuses a record that
names no described link. The settled chord and rank judges, as the lane reseat, refuse a move that names a new link in the room set
(`noNewFindings('room')`, `roomFindings`): a room given up, and a room a reservation would still grow.
A move that runs after the reservation keeps a same-tier row room: `holdsMove` has the kind `labelRoom` (`label-room-guard.ts`), which refuses a move that shifts the ends of a described same-tier link apart and leaves a row shortfall the model did not have (decision review ticket DR-02, R2). Nothing reserves the room again.
Publication and restore re-run the reservation on a copy and reject a model it would still change.

**Linked groups share a grid (ADR-0012).** Before labels are planned, groups joined by vertical
ports take one x-extent and groups joined by horizontal ports take one y-extent — the union of the
two boxes — whenever neither box is smaller than that union by more than 30 % of it. Boxes only
grow; a union that would overlap a third group or cross a reserved lane window is skipped; chains
converge in at most eight passes. Publication and restore re-run the pass and reject a model it
would still change.

**Widening cannot cross a reserved lane.** Lane x, width, owner and side are immutable after 7a, so
a widening and its neighbour pushes are feasible only while every group keeps each lane of its tier
on the side that currently holds it. Feasibility reads the same occupied extent the lane validator
measures — group box, stroke-aware node clearance and pill gaps — and a widening leaves those nodes
and pills where they are while a push carries them along. A group whose only free gap lies beyond
that limit keeps its width and its left-first label, spends no centring pass, and is diagnosed
`GROUP_LABEL_GAP_INFEASIBLE`; the unchanged final gates decide the retained geometry.

**Band clearance for stage 8 entry.** A band reserves room for its label during placement. Stage 8
protects the measured label bbox, including from links attached to that group, and may cross unused
band space. Treating the entire group width as an obstacle forced ten aligned links around one
edge, producing 80 avoidable crossings; ticket 17 corrects that earlier stage-8 interpretation.
Each band retains the
`clearance` it reserves between its lower edge and the group's topmost node. The reservation is the
larger of the measured top padding (20 px beyond the complete named pill and its half stroke)
and the largest top-side routed outward reach plus the widest routed half stroke and a 0.25 px tolerance.
The reach is the whole mandatory shared prefix when the port has one, otherwise the ordinary
checkpoint `max(15, 10 + (node stroke + widest routed stroke) / 2 + 0.25)`, which follows the node
obstacle when a wide stroke expands it past the 15 px stem. Every checkpoint on a side that holds a
named port also stands beyond the pill text of that side (`sideStemReach`): half the longest pill text, half the widest routed stroke
and 0.25 px (`portStemReach`, ticket 156). Pill text is centred on the anchor, so at 9 px a name of
about five characters reaches past the 15 px stem, and a run that starts or turns at the plain tip
crosses the text (G3). Fan rows also clear the whole pill bodies and their strokes (`edgeAwareRows`, `sidePillBodyReach`),
so a peel stands beyond the pill-face start of a neighbouring straight chord. With the default 1.5 px node and 1.5 px
routed strokes the entry requirement is 16 px; a default named pill instead reserves 24.5 px
to retain its visible gutter. The rule reads frozen inputs only: measured port names, the constant
stem and `sharedRuns`, which every publication at or after stage 7e rebuilds and compares, so
completing a remainder in stage 8 cannot retire the reservation. Publication and restore recompute
the reservation, require the node gap, and reject any required entry point that lies inside the
stroke-aware extent of its own group's band. This conservative checkpoint reservation preserves
room below any label position without making unused band space a routing obstacle.

**Atomic rebuild after 7d/7e/7f movement.** Bar-band growth in 7d and the tier-gap solve at the end of 7f move
the lower tier bands and their contents; neighbour pushes or centring in 7f move the affected row
groups and descendants. The solve moves y only and replays no centring: a rebuild after it that moves an x throws (architecture-2
ticket 57). The cost is that a centring the growth would have changed is not run again; three corpus sheets gained bends from it
(a follow-up ticket for the centring is planned).
After any such movement, rebuild changed claims atomically in this order:

1. Recompute moved node/group boxes, port anchors and tier bands.
2. Update owned lane extents without reallocating their fixed x positions or owners.
3. Rerun affected child-under-parents centring within the shared 8-pass limit.
4. From the final anchors, rebuild affected non-bundle row paths, non-bundle flank paths, bar
   drops, then bundle paths and envelopes; preserve bar-owned `barCross` annotations.
5. Place or recheck group-label bboxes, then check all affected clearances and containment.

Remove the old versions of changed paths, envelopes, label boxes and obstacle entries before
installing their replacements; never append a replacement beside stale geometry. If rebuilding
moves geometry again, repeat the same bounded pass. Non-convergence is diagnosed, the last state
is kept, and final gates decide whether the diagram fails.

The bands transaction owns this production after its callback checks, reuses one centring budget
across every replay, and captures placement only after the final coherent claims. A callback cannot
publish provisional bands or labels for the finalizer to repair.

The callbacks of 7e and 7f are empty, so their rule checks never see the producer output. The
producer postconditions (`postconditions.ts`, DR-11) judge it: on the net draft, after every
dependent rebuild and before commit, each reservation that held at entry still holds (riser
keep-out, trunk extension, lane sides, side alignment, group exit, the stored ledger). A breach
refuses the transaction with a `PostconditionRefusal`. A producer refusal (that one, or a bundle
path with no room) withdraws the trial of every round, by one rule in the round runner
(`producerRefusal`), and fails the main line by name. A newly blocked frozen chord and a new wall
in a span corridor stay advisory, for output neutrality: each such break that publishes is named
again by its own finding (`STRAIGHT_LINK_BLOCKED`, `SPAN_CHORD_BLOCKED`). The `moveGroup` writers,
with the guard or proof of each, are listed in `box-writers.ts`; a direct write to a node box is
outside that table, and its doc names those writes.

After 7f, the successful `bands` transaction captures `freeze.placement`, including node content
and pill geometry, group geometry, tier bands, regions, lanes and group-label placement. Later
transactions and restore require exact equality with this projection. Canvas may expand, and
runtime/diagnostic fields remain writable. Later stages may create paths and link-label boxes but
may not move or resize groups, nodes or port anchors. An async router computes outside the
synchronous transaction, then commits its output through the route validator.

### Frames

`rebuildFrames` (`src/layout/frames.ts`) runs where `rebuildBands` runs, after every stage that
moves a box. It calls the pure `deriveFrames`, which derives one frame per document group. The
frame x extent is the union of the cell bodies grown by 20 px and the cell boxes. The frame y
extent is the outermost body plus 20 px per side. The label band adds to the title side. A child
frame is the same union over the cells of its span. The parent frame holds the child frame plus
20 px. The layout JSON has `frames`. The renderer draws frames and never cells.

Cells have no label band and no padding of their own. The first and last cell of a frame hold
the 20 px margin and the label band, so tier bands and gap rows measure them. The edges between
two cells of one frame hold 0. The rank gap is 60 px between bodies. A title is hosted only in an
own cell of its frame, on the top or bottom edge. A frame with no such cell has no title and gets
`FRAME_TITLE_UNHOSTED`. This happens only when a child spans every rank of its parent.

A link that ends in a cell of a frame is not foreign to it. Its lane stands beside the bodies,
and `transitLanes` grows the frame to hold the lane. A link that is foreign to a frame gets one
lane x outside the frame for all the sub-tiers it crosses (`foreignReach`). It never enters the
frame.

Lane x is immutable, and a frame only grows. So a lane that a frame holds is reserved before a
foreign lane: `allocateLanes` takes the links that hold a lane in a frame first (`holdsLane`). A
foreign lane then reads the held lane through `heldLaneReach`. A held lane also stays on its own
frame's side of a foreign frame: it takes the one gap between the foreign frames where its own
cells stand (`heldGap`). It may stand beside its own frame, between the frames, or beyond the pair
on its own side. It never stands on the far side of a foreign frame. A fixed-point rule (reserve
the held lane, grow the frame, place the foreign lane, repeat) was tried and dropped. It does not
converge: a held lane that may pass a foreign frame makes the frame reserved second grow over the
first lane.

Sibling frames of one tier are columns. A column is the frame box plus `COLUMN_SLACK` (20 px) on
each side. `packFrameColumns` (`src/layout/columns.ts`) runs in stage 4 after ELK and packs the
frames and the one-rank groups of a document tier left to right, anchor tier first. Each axis
lands on the mean x of its routed feeds, and the columns stand a band gap apart
(`packStep`). The column is a wall for the centring and the overlay sweeps. Centring spends the
slack and never leaves less than a band gap between two frame boxes, or less than a band gap and
`COLUMN_SLACK` between a frame box and a plain group. One function says how far two units of the
root scope stand apart, `besideGap` (architecture-2 ticket 75): gate G9, `runSpacing` (the column
passes), `flankRoom`, `frameColumns` and every wall a column puts to a plain group (`columnWindow`,
the overlay placement, the step over chords) read it. A frame has no slack on a side where a plain
group of its sub-tiers stands, so every wall a plain group reads is the frame box and `besideGap`,
wherever the group stands: a fixed point. Slack read from the group's own place moved it again
(halved, every replay of the linkless step moved the group in by half; whole, a group placed while
the slack was 20 px stayed 20 px beyond the gap; from the nearest unit only, a group that became
the nearest took the slack away and moved once more). Toward a frame the slack is half of what the two
boxes leave beyond a band gap. `separateFrameColumns` runs
in the `rows` rule, after every row group has its width, and moves each frame as a whole with one
dx until the gap is a band gap again. `orderFramesByOverlay` re-packs the columns in the order the
overlay links ask for.

`holdColumnAxes` pulls each frame column of a tier toward its feeds: the units of the tier keep the
spacing of `runSpacing` by pool adjacent violators on the moves that reach each feed range
(`fitRun`). In the outer pass a unit with no feed range (no feed, or every feed follows it,
`Bundle.lead`, 7e) has no wish in the pool: it stands where it stands until a sibling pushes it
(architecture-2 tickets 74 and 75). With a wish to stay it took half of a sibling's deficit, and the
next call took half again (after the seat moved its feeds, where they followed it): every replay
moved the tier in x, and the y-only rebuild of the tier-gap solve refused the move. The pass is
idempotent: a second call moves nothing.

## Stage 8 — route (remainder)

**A mesh bus member's path is the path along the bus** (ticket 84; `docs/design/mesh-bus.md`, section 5). Stage 8 states nothing of its own for
a member: its path is stub, bar run, stub, three orthogonal segments on the overlay layer, read off the geometry 7f published on the bus
(`bus.stubs`, `bus.bar`; `busMemberPath` in `overlay-paths.ts`, which `overlayPath` answers for a member). `route/validate` re-derives it with the
same producer and compares, as for every overlay path, and G7 reads each end at the port face through `overlayEndpoint`. Members are neither
straight nor bent and enter neither the bends nor the crossings metric (routed geometry only, as no overlay path does). The verticals that cross
each bar in the published layout are counted (`busVerticals`) beside the stage-5 leg count (`busLegCounts`); no gate reads them.
Ticket 97: a cross link of a joined pair takes the path stub, bar run, riser, bar run, stub (three to five orthogonal segments, `busMemberPath`); `route/validate` derives it again from the published stubs, bars and riser x, and G7 reads its ends at the port face.

**Group boxes are obstacles for foreign links (ADR-0013).** Every group box, grown by the 10 px
edge margin, obstructs each link that neither attaches inside it, nor owns a lane in its margin,
nor crosses one of its declared bars. Attached links still cross their own boundary at ports. The
same margin keeps any routed segment from running along a group edge from on or outside the box;
stage 7e producers move fan, merge, channel and bar-bypass rows off such edges and reserve that
room in their tier-gap capacity.

`libavoid-js@0.5.0-beta.5`, `Router(RouterFlag.OrthogonalRouting.value)`, with
`shapeBufferDistance = 0`: every obstacle carries its own exact clearance, so a terminal trim is
never expanded shut afterwards. `processTransaction()` is synchronous WASM work, so the whole
adapter runs in a **real terminable worker**; the host prepares serializable batches outside the
checked transaction, awaits the worker under `routeBudgetMs` (default 30,000; stage 17 injects
what is left of the pipeline budget) and commits only validated geometry. The budget bounds the
worker — that is the part no same-thread race could stop; preparing batches and validating the
answer are host work, measured with the stage. A diagram with no routed remainder never loads the
WASM.

Registered as obstacles, each expanded once in the adapter and never in the model:

- **nodes**, by `10 + (node stroke + widest routed stroke) / 2`, grown to swallow their own visible
  pills; a pill on a top or bottom side reaches further out than that clearance, and one rectangle
  per node keeps the obstacle set identical for every connector;
- **every reserved run** — a complete pinned path, a partially fixed lane run, an outward shared
  prefix — covered by rectangles of half-width `10 + (its stroke + widest routed stroke) / 2`,
  with **18 px of arc length trimmed once per whole chain at each end that is one of its own port
  anchors**, so a link that shares that port can still reach it. Interior bends keep square corner
  coverage; the trimmed ends keep butt caps. A chain of 36 px or less protects nothing, which is
  the explicit limit of the trim constant;
- **lanes**, **group and node labels**, **bundle envelopes** and model
  obstacles, each expanded by the routed half stroke;
- **the reserved outward stem of every link no batch has routed yet**, covered by the same
  `10 + (its stroke + widest routed stroke) / 2` clearance. A stem is left out at a **port** the
  current batch attaches to: one port carries one stem, and the links that share the port share it.
  A stem on a node **side** the batch attaches to elsewhere is left out as well, but only where
  placement left that side's stems flat. Two ports of one side stand one port pitch apart and the
  strip is wider than that pitch, so a rectangle over one of them blocks the other. Where § 7a
  nested the side, each port turns at a depth of its own and its strip is covered for every batch
  that has not routed its owner: the strips still overlap, but a strip clears its neighbour's
  **anchor column** by half a pitch less a half strip — 0.5 px at the defaults, and the pitch only
  grows — so the router can always reach the port under one. A port on another side of the same node
  stands in its own strip and keeps its reservation.
  These rectangles are added per batch. They never enter the ownership exclusions, so they cannot
  change a batch; they remain for the attachments no planned part reaches.
- **every planned tier-gap part** (§ 7a, in the height § 7f reserved for it), tip to tip: the upper
  leg, the run on its row and the lower leg, a Z part's two rows and middle drop, or the one vertical
  of a drop. Each is covered by the clearance a reserved run carries, for every batch from the first.
  This is the head-on approach to a lane, reserved rather than covered by a rectangle. Measured over
  322 diagrams, a 23 × 38 px cover repaired 8 failures and broke 4. The wall it put in a tier gap
  pushed other links into routes their own checkpoints could not meet. A part's **row** does not
  obstruct the **residual** links of that gap, which the plan names as its crossers. Its verticals
  obstruct them, and a route can pass those by, except a residual part that stands within `k` of a
  vertical: it is granted the cover of that vertical alone. The owner is not given the row either.
  Its route meets the part at the two terminals, so the end rectangles keep the owner and the ones
  between do not. Two planned parts on one port share the leg from the tip to the higher row, and the
  plan record exempts the overlap.

**What the router still does in a tier gap.** Nothing inside a gap whose parts are all planned: the
stem from a port anchor to its tip is a gap with one possible route, and stage 8 claims it (below).
It routes the **residual** parts (§ 7a, nine reasons), lateral ports, shared-run ends, bundle members,
flank regions and bar drops, and every link of a gap the plan does not fit. It no longer seats a
row, holds a row for an interleaved pair, orders the rows of a gap, or keeps a band off a tip: the
plan reserves what they reserved, and the corpus never reached them at this stage (ticket 52).

**A lane obstructs its owner too.** The corridor admits the owner's collinear run and nothing else.
Stage 8 stitches that run back. It never routes it. The owner therefore needs no exemption here.
Without the obstacle the router treats the corridor as free space. Measured, one gap then crossed
its own lane sideways. Another descended beside the centre. The stitcher refuses both.
A gap that meets a lane starts or ends at a terminal of that lane. That terminal lies half the
widest routed stroke inside the expanded rectangle. libavoid connects an endpoint inside a shape to
that shape's boundary, so the run stays reachable. The approach checkpoint keeps the entry head-on.
Its direction mask cannot carry the rule in this build. The mask is advisory (see below).

A rectangle that lies wholly inside another is dropped before routing. libavoid's orthogonal
visibility sweep assumes no obstacle is contained in another: a contained rectangle opens a false
corridor along its own edge straight through the containing obstacle. Dropping it leaves the
obstacle union exactly as it was. This is measured, not theoretical — the datacenter group label
inside its own band let a golden route cross that band.

Containment for this removal uses the exact rectangle edges, not collision `EPS`.
Approximate containment can form directed cycles, so it cannot preserve both the union and the
absence of contained survivors. Nearly overlapping rectangles remain unchanged; the real binding
routes around them. A left-edge sweep with two-dimensional prefix maxima finds surviving
containers in O(S log² S) time and O(S log S) space. Exact duplicates keep their first input ID,
and surviving shapes retain input order. An exactly contained attachment shape is an error.

Ownership is exact. A link may pass only through the reservations it already owns: its own bundle
envelope, its own reserved runs, its lane runs included, and the row of a planned tier-gap part its own
(residual) route must cross. A transit lane is not one of them: the corridor holds the owner's run, and stage 8
stitches that run back rather than route it. Owning the endpoint group does not open a label band.
Links whose exclusion sets differ cannot share one router, because the binding has no per-connector
shape-ignore API. They run as an ordered sequence of **ownership batches**, and every completed
route becomes a protective obstacle for the batches after it.

A completed run may be crossed by a later link. `gapNeeds` grants the passage when one of the later
link's legs, or either L-shaped path of one of its legs, crosses the run's interior; the endpoint chord
never grants it (ticket 37, closed by deletion in ticket 52: no cover on the corpus was granted by the
chord alone). A stem of a later batch is an obstacle for the batches before it. An L that the router
does not take frees a cover for nothing. That costs quality, not validity. A batch is not split by the
covers its links cross or by the stems of batchmates (`crossingParts` and `crossedStems`, tickets 22
and 30, are gone: no batch of the corpus was ever split at this stage).

**A link the stage cannot use is removed (ticket 24).** After each batch part, `tryStitch` judges
one link: the required checkpoints first, then the stitch. Two cases reject the link. The router
skipped a required checkpoint: `ROUTE_CHECKPOINT_SKIPPED`, with the link, the checkpoint, the
connector and the rule that asked for it (`stem:`, `lane:` or `entry:`). Or the stitch refused the
route: `ROUTE_GAP_REJECTED`, with the reason. Only a `GapRejected` is a rejection, and a stitched
path that retraces itself is one (ticket 46; `validateRoutedPaths` keeps the same check as an
assertion). Any other error stays fatal. A removed link loses its routes, adds no protective run, and keeps no label. Stage 8
alone sets it. The layout JSON gains `LayoutLink.removed` and `removedLinks` (both absent when
none), and the score counts `removedLinks`. The renderer and the drawio export draw a link only
where it has a path, so a removed link is not drawn; `score` skips it. With `strictCheckpoints`
every case keeps the throw.

Ports are `ShapeConnectionPin`s, one non-zero class id per port (its ordinal after the topology
freeze), direction = the side, **`setExclusive(false)` for any port carrying more than one link
end**, counting ends a region rule already fixed. A link that consumes a declared shared run does
not attach to the pin at all: its connector starts at the run's terminal point.

Checkpoints replace the fixed routes this binding does not have. They constrain the two things a
route may not choose for itself — its outward stem and its head-on entry to a reserved corridor.
A junction is not one of them: its reserved run is stitched back exactly, and the router only fills
the gap beyond that run's terminal. Each attachment gets one
checkpoint `max(15, 10 + (node stroke + widest routed stroke) / 2 + 0.25)` px along its outward
normal — the same number stage 7f reserved below each label band — constrained to be entered
(source) or left (target) along that normal. A gap beside a reserved run gets one 15 px approach
checkpoint on the run's own line, outside the reservation, so the route joins it head-on: a
reserved corridor admits only its owner's collinear run. `setRoutingCheckpoints` exists in this
version; `ConnRef.setFixedRoute` and a real `JunctionRef` class do not (ADR-0003). libavoid may
skip a checkpoint it cannot reach, so every required one is verified against the returned polyline
and the stage rejects the route rather than publish geometry that occupies a reservation. A
rejected link is removed (below), not fatal, unless `strictCheckpoints` is set.

**A gap with one possible route is claimed, not asked for.** A planned gap whose two ends stand on
one axis-aligned line, whose two ends may both travel along it, and every checkpoint of which stands
on that line, between the ends and in the order asked, has exactly one route. Where the run between
the two ends is also clear of everything placement froze — judged by `straightCorridorClear`, the
predicate the rows rule and 7f's feed corridor already use — stage 8 reserves it and asks the router
for nothing. It is then a reserved run like any other: covered for every batch from the first, with
the same 18 px trim at an end that is its own port anchor, and stitched in exactly.

The reason is the pipeline's load-bearing rule. Placement fixed both ends, so the run is a
reservation, and an ownership batch that runs earlier is otherwise free to lay its own route across
it. libavoid then cannot reach the checkpoint inside that route's cover, drops the whole checkpoint
without a word, and answers with the two **node centres** and a diagonal between them — measured on
`goldens/synthetic/a-straight-gap-needs-no-router.yaml`, where the gap asked for
(132.50, 270.00) → (132.50, 370.00) and the answer was (138.50, 246.50) → (132.50, 393.50), which is
neither reserved endpoint. 7f already states this claim for one shape of it: the feed corridor it
reserves against its group labels is "a top/bottom feed whose two anchors already share an x … will
be routed as that straight line in stage 8" (§ 7f). This is that sentence made true, for every piece
of a path rather than for a whole link.

A link every piece of which is claimed asks the router for nothing and joins no ownership batch, so
a diagram made only of such links never loads the WASM.

Each link is stitched back in source-to-target order: its reserved runs byte-for-byte, with their
owner, lane and `barCross` annotations, the tier-gap parts the plan made for it, and the routed
gaps between them. A planned part is not a claim the lanes rule wrote on the model, so the
stitcher names the corridor it leaves exactly as it names a routed gap that meets one. Where a
planned part and the gap beyond it are one straight run, the stitcher joins them. A run a rule
wrote on the model is reproduced exactly and is never joined. Where a gap meets one of
its own lanes it is split at the corridor boundaries and each piece names the one lane it touches,
the same shape the region rules produce. Publication and restore then check the result
structurally — complete anchored path, orthogonal and connected, exact reserved runs, perpendicular
stems of at least the reserved reach, link ownership of every routed gap, and no entry into a
reservation the link does not own — because route geometry cannot be re-derived without the router.
The runs placement planned for stage 8 can be derived again, and they are kept as the fixed and
shared runs are (decision D-Q2, ADR-0010): `validateRoutedPaths` calls the one producer
(`placementRuns`: the row-gap legs and the tier-gap parts) on the model as stage 8 received it
(`preRoute`: the router's paths, removals and stub marks taken away), and each planned segment must
lie inside one straight piece of the path with the same link owner, running the planned way, in the
planned order. A collinear merge with the same owner passes; a run moved off its line, given another
owner, reversed or reordered is refused by name, even where another route would pass the gates.
The plan leaves out every link `frozenChords` names, so each name must hold a routed chord in the
published geometry (`isRoutedChord`), or the model is refused.

`overlay` links: never routed and never sent to the worker. Their path is the one
`src/layout/overlay-paths.ts` derives from the two ports placement froze, and stage 8 only publishes
it. **Straight by default, orthogonal by exception, and the exception is a node in the way**
(maintainer, 2026-09-16). The default branch is **one straight segment** joining the two ports'
outward faces — the pill's, or the node's when the port draws none — at whatever angle that is, and
nothing else. The path **begins and ends on that face**, which is also where the endpoint mark is
drawn: the anchor is the pill's centre, the overlay layer is masked out of every pill, and a run from
the anchor was never drawn (*"path should also start on the point"*, maintainer, 2026-09-16, stress
ticket 30). `overlayEndpoint` names the point; `route/validate` and G7 `endpoint-anchor` read it, so
both still name exactly one point per end, and an end that states no side has no face to read and
keeps its anchor.

There is **no stub on this branch**. The same review removed it — *"no point in stub then"* — because
the stub's two jobs were to make the line meet the pill square and to keep the endpoint mark clear of
it, and a path that starts on the face does both; all the stub added was a 4 px kink under the mark.
`OVERLAY_PILL_CLEARANCE` belongs to the **orthogonal** branch alone, which has to step outward before
it can turn. Placement's own job is to position nodes so that as many overlay links as possible take
the straight branch.

The straight branch has a condition of its own before any shape is consulted: **the segment must
leave each port outward.** At both ends the segment's direction, taken out of that end, may not point
back along that port's own outward normal. Strictly inward does not leave, because a line
leaving a port inward runs back **under that port's own pill**, and the overlay layer is masked out of
every pill, so the mask would cut the line away from its own endpoint mark. A port that fails the
condition is facing away from its partner, and the orthogonal branch answers it. The tilt this allows
is generous: a facing pair takes any angle short of the two faces being level.

**No face is ridden (architecture-2 ticket 34, user 2026-10-25).** An overlay line never rides along
a face or a foreign pill. A segment that runs along an axis (its drift across it is at most the link's
stroke width) and lies within one stroke width of a face of any body or pill, its own included, over a
stretch of that face's span, is not straight-clear (`ridesAFace`): a line on the tips, or a fraction of
a pixel off them, reads as on them. A segment that passes a face further off than that, but nearer than
the clearance, stays straight: refusing it bent lines whose detour then ran at the same gap, since the
ways round test only `enters` (measured on the corpus, 2026-10-26); that wider clause is ticket 41. Two
ports level on one side are therefore not one segment along their tips: the orthogonal branch answers
with a U, up out of each face by the clearance and along one run one clearance beyond the furthest
shape across its span (the two pill tips, a taller pill or body between them, or the body edges of two
anonymous ports), taken when it clears every shape and rides no face. The segment that leaves its own
pill perpendicular to the face meets that pill and its body only at its end point, so it is exempt. An
angled segment keeps the outward test and `crosses`. This reverses the 2026-09-16 reading "level counts
as leaving". The routed straight technique reads the same `straightBetween` through `straightChord`
with faces ridden, since the ruling names the overlay alone. The U is an ordinary detour, and every
reader asks the one `straightBetween`, so placement, 7f and stage 8 cannot disagree. A U that stays in
place relies on the group padding (`GROUP_PADDING`) beyond the pill tips to hold its run; only a run
that track separation moved out is reserved, through `trackRoomPadding`, and a label beside a run
through `acrossRunPadding`.

Because the condition holds, the segment's distance along each port's outward normal rises from zero
and never falls, so it cannot re-enter the pill behind it. A link's **own two pills** therefore carry
nothing the condition does not already have, and are **not** among the shapes the segment is tested
against (maintainer, 2026-09-16) — testing them only restated the condition in sub-pixel arithmetic,
where a tilt reaching 0.02 px inside a pill read as an obstruction. The exception is read on that one
segment against **every node body, the link's own two included, and every other drawn port pill**,
and the face test above reads every shape, the own pills included. Nothing else blocks: not another overlay line, which is drawn thin and translucent
precisely so that overlays may cross each other and is exempt from the clearance gates, and not a
group box, a lane, a routed path or a label. A blocked segment is answered by the orthogonal
derivation: the shortest of eight ways read off the two end boxes — two single turns, four ways
right round the pair one clearance outside its own extent, two down the middle of the gap the pair leaves
— that enters no node body and no pill, with ties going to the single turn that carries on the way
the source faces, and with no candidate that walks back along a run it already drew. When every way
is blocked the shortest that clears the link's own two end boxes is taken, and the renderer's mask
carries the body it then crosses. The clearance is the **overlay port clearance** of the link's stroke
(`overlayPortClearance`: the bare-end dot, stroke + 6 px across, plus `OVERLAY_GAP` 4 px; 7.75 px at
1.5 px), on every face, for the turn out of each face and for the margins of the ways round (ticket 23;
it was 4 px, and the turn read as lying on the face).

**Two overlay detours never share a track (ticket 23).** The per-link rule reads each link alone, so two
detours out of one face rose on one riser and ran over the row on one line, and read as one line. The
layer is read once (`overlayTracks`, kept per model and blocker index): the paths that cannot move
(straight segments, courses, a link drawn straight over a body under `overlayOverBodies`) hold their
tracks, then the detours with a middle run take theirs, unlabelled before labelled, shortest first (last
key `sourceIndex`). Mesh-bus members are not read, as the scorer does not read them. Placement judges read
the per-link path (`overlayBasePath`); only 7f reservations, stage 8 and the scorer read the separation. Two runs of two paths are on
one track when they lie on one axis nearer than the **overlay track pitch** (half of each stroke plus
`OVERLAY_GAP`: 5.5 px) and overlap or meet end to end within it; two paths that leave one port draw their
common stretch once and may fork there (`sharedTrackPairs`, `forks`). A middle run on a shared track
moves across its axis by one, two or three pitches; its two neighbours lengthen or shorten, so no bend
appears. Every way round with the same bends is tried (a non-collinear alternative before an offset, and
the way with fewer crossings where the bends are equal). A candidate walks back along nothing, enters no body or pill, keeps the overlay port
clearance from each (or the distance the derived way kept, where less), stays out of the room of every label an unmoved overlay path shows
(the box beside its longest run that stage 9 tries and 7f reserves, `overlayLabelRoom`; ticket 24), and stands to every group and
frame box as the derived run did; it may cross the padding edge of a plain group on a side no title
holds, which 7f then grows. 7f reserves the room across a moved run (the track, and the label the link shows
beside it, `trackRoomNeed`); where a reserved lane stands beyond that edge, the room is inserted and the
lane and everything beyond it move out with it (`insertRoomAt`): label room wins over an adjacent lane, and
the lane keeps its distance to what it serves (R2). Rank: fewest shared tracks, no growth beyond the box as it stands (a track the
grown room holds is no growth, so a replay after 7f keeps it), fewest crossings with the held paths (the
tracks nest), for a labelled detour the way out of its U, the nearest track, out of the U, the positive direction. The
greedy order gives the later detour the outer offset on every run it shares; two U's out of one face need the outer track over the
row and the inner riser beside the face. So after the last detour, two detours that cross and that the separation moved apart off
one track (a run of each on one track in the ways round, `onOneTrack`, no fork) trade the offsets of those two runs, when each moved
run keeps the rules above, label rooms included, and the two then no longer cross. Every such trade of every pair is ranked
together: by the change to the layer's shared tracks, then to its crossing points (the measure of the port trade), then by the two
moved runs, last by the links' `sourceIndex`; no key reads the order of a path's points or a link's direction. The best one that
lowers the layer is made, and the rest are ranked again; a pair trades once at most (`nestTracks`, ticket 24). A labelled
detour is not traded: its label keeps the outer side and the room 7f reserved on its run. The port trade of 7f
(`nestOverlayPorts`) measures this result. The
result is a function of the frozen geometry, so nothing is recorded: stage 8 publishes it and
`route/validate` derives it again and compares (R1, R5). A run no candidate frees keeps its track, and the
scorer counts the pair (`overlayTrackShares`); a column gap that holds fewer risers than need it is not
widened yet.

Two ports facing each other on one line closer than their
two clearances ride their own faces on the orthogonal branch instead, which keeps its two ends in
order (ticket 04 A). The straight branch reads no retrace test: it publishes one segment, and one
segment cannot walk back along a run it already drew — the test that stood there read two stubs that
could be stated the wrong way round. Where an end states no side to leave by,
the one straight segment is kept and the mask carries it, that end at its anchor. `route/validate`
re-derives the path, compares it and reads `retraces` over it; it checks no orthogonality on an
overlay path, because the straight branch is not orthogonal. Stub candidates: after routing, a link whose route passes through
more than two intermediate tier bands (measured by their vertical extent, since a reserved lane
sits in the margin beside its tier) or whose arc length exceeds 3× the direct anchor distance is
marked `stubCandidate` and warned about; M1 keeps the technique and the full routed path.

**Measured on the JPEG golden:** stage 7 leaves exactly two links, `link-1` and `link-2`, the two
provider feeds into EAC-01 and EAC-02; the rules claim 24 of 26. Each of the two is one straight run
between two anchors on one x with a clear corridor, so stage 8 claims both and no ownership batch is
formed: the prototype's idle router, reached by a different road. The geometry is byte-for-byte the
one libavoid returned before the claim — what the router was answering with was the geometry
placement had already fixed. The complete 26-link diagram passes G1–G8 with 0 crossings,
0 overlaps, 0 label hits and Q 0.8424281545245618 (before link-label placement). The previous
candidate's Q was 0.818586208746674; allowing the feeds through unused band space removes the
avoidable detours. Node, port and group placement remains unchanged.

**Nudging.** libavoid's `idealNudgingDistance` is the gate clearance plus the widest routed stroke,
so two remainders of one batch that turn side by side land at least that far apart, never at its
4 px default (ADR-0015 rule 2). It is the clearance G6 demands, not the wider nested-stem pitch of
rule 1, which placement reserves.

**Collinear checkpoints.** The pinned libavoid build can truncate a straight route at its final
checkpoint. The adapter omits redundant hints only after checking exact collinearity, direction,
checkpoint order and the full expanded obstacle set. The connector still participates in the real
routing transaction. If a bent route ends at its final checkpoint and a clear straight continuation
exists to the requested port, the adapter re-solves once without that final hint. It never appends
coordinates to a returned path. The host still checks every original checkpoint, attachment,
reservation and stem, so a changed route that misses any requirement is rejected.

**A dropped checkpoint, and the direction mask that causes it.** A checkpoint carries two things: a
point, which is a reservation the host verifies, and a direction mask, which is a hint —
`checkpointsHonoured` reads the point only. This build's `Avoid.Checkpoint` names its two *vertical*
sides the other way round from the rest of its API: measured with a blind corridor open on one side
only, a checkpoint entered through its top side is honoured with bit 2 and dropped with bit 1, and
the reverse for one entered through its bottom side, while the two horizontal bits need no change.
A `ShapeConnectionPin` reads the same bits in the host's own screen convention, so the two cannot be
expressed alike. A mask the build cannot meet makes it drop the whole checkpoint, without a word, so
the host sees only a route that misses a reservation. The adapter therefore re-solves a connector
once, with the same points and no masks, when the answer misses a checkpoint it asked for. That
costs one more transaction on a batch that would otherwise fail the command. Swapping the vertical
bits instead would make every mask bite, which turns each stem checkpoint from a minimum into a
pinned turn — measured, that puts two runs 3.5 px apart where nothing reserves the pitch between
them. ADR-0015 rule 1 now reserves that room in a row gap, in a tier gap (ADR-0021: the plan) and on a node side that
feeds one, but only where an order is forced; a side it leaves flat still has no room reserved for a
pinned turn, so the masks stay advisory.


## Stage 9 — link labels

Placed after routing on the longest segment of the computed path, then checked against every
label, node and segment; on collision, try the next-longest segment, then offset to the other
side of the segment, then shorten with an ellipsis to the segment length − 8; a label that still
collides is dropped to a tooltip and reported (`labelsOmitted`). Overlay-layer labels are
suppressed when overlay density (overlay links per node, over `max(1, nodes)`) exceeds the
profile's threshold (default 3). A suppressed label leaves no record at all, so it is not an
omission.

**The bus label** (ticket 84). Each mesh bus gets one model-owned label, `role: 'mesh-bus'`, layer `overlay`, id `label:bus:<bus>` (also `bus.label`),
text `<class> mesh (<n> nodes)`, 9 px, heading 0, on the room 7f reserved on the bar (`bus.labelRoom`): beyond the bar, 4 px from it. It is placed
first, so no link label takes the room, and it is not subject to the overlay density suppression. Where no interval holds it (`labelRoom`
absent) it is omitted with its text as tooltip, and `labelsOmitted` counts it. A bus member's authored label is not placed: it goes to the bus
tooltip in stage 11 and leaves no omission record, and 7f reserves no room for it. G3 reads a `mesh-bus` label against routed geometry (it
leaves out every other overlay-layer label).
Ticket 97: a joined pair has one label, `<class> mesh (<n> nodes)` with `n` the nodes of both buses, on the bar with more members (the upper on a tie); the other bus has no label and no label room.

**A drawn overlay run is an obstacle for a label.** G3 measures a label against routed geometry
only, and the renderer masks an orthogonal overlay run out of every drawn label it meets (a diagonal
runs on under the label's halo, ticket 162), so a label over an overlay stays readable — but the mask
cuts the *overlay* under it, and an overlay path goes round the shapes
it crosses precisely so that the line stays whole. The label is the thing that can move, and the path
cannot dodge it in return: a link label's box is measured here, after stage 8 built the path. Where
both sides of every segment are covered the ladder runs again with overlay runs ignored, because a
label that is drawn beats a line that is whole; the mask then carries the crossing, as it always
did. That second run comes **before** the shortened text, not after it: a truncated label is the
last thing tried, because the mask gives the overlay back under a whole label and nothing gives a
shortened label its characters back (synthetics review ticket 04 C). The second run also lets a link's own label lie across a
diagonal of any layer (ticket 162, `diagonalMayCross`): the first run keeps the label clear of it where it can, and G3 does not count
the crossing; the label's halo breaks the line under its letters. Node
bodies and pills on the overlay *layer* stay out of the set: they are not drawn. Every placed label
is in it, whatever layer its link is on.

The transaction owns the whole production, as 7f owns group labels: a callback may not author a
label. It adds labels, their diagnostics and canvas extent only — placement, every path, every
fixed segment, junction, bundle, merge run and obstacle stay exactly as stage 8 left them. Group
label bands are validated against the geometry that existed when they were reserved, so a stage-9
label never moves one.

**Typography and spacing.** Link and multiplicity labels are `FONT_FAMILY` 9 px weight 400, with
the measured `lines` and `lineHeight` stored; stage 11 re-measures nothing. Text follows its
supporting segment (ADR-0014): upright along a horizontal run, rotated −90° along a vertical run so
it reads bottom-to-top — gravity: never upside down, never top-to-bottom. The stored box is the
rotated one, its long side along the run. The box is centred on its segment's midpoint, `4 px` of
visible clearance beyond the supporting stroke's edge. Shortening uses the measured ASCII `...`, because the checked-in advance table has
no U+2026, and keeps the longest proper prefix that fits. That width does **not** grow with the
prefix: a line break inside it moves the ellipsis onto a new line and can make the box narrower, so
the search is a scan over exact prefix widths, never a bisection.

**Order of candidates.** Segments run in descending geometric length, then source-to-target index;
zero-length segments are skipped. The first side — *above* for a horizontal segment, *right* for a
vertical one — is tried across every segment before the opposite side is tried across that same
order; a segment carries the full text only when it is at least the text plus the 8 px shorten
margin at each end long, so a placed label never reaches past both ends of its run (ticket 30);
then the same two passes run with drawn overlay runs ignored; then the pair repeats with the
shortened text, strict first and relaxed after, and among the clear shortened candidates the
one keeping the most characters wins (ADR-0014); then the label is omitted with its full text as
`tooltip`. Four rungs in all: whole text clear of the overlay, whole text across it, shortened text
clear of it, shortened text across it. Authored labels run in link order, then merge runs in bundle and run order, so
an accepted label is an obstacle for every later one.

**A link label stays in one region.** A label never lies across the border of a drawn group or
frame box (`groupBoxes`: a frame in its cells' place). Each text first runs both overlay rungs with
those borders as walls: on an axis-aligned run that a border cuts, the label may stand only in a
**window** of the run (`labelRunWindows`: the run less the 8 px shorten margin at each end, less
every stretch within 8 px of a border's stroke), at the point nearest the midpoint; a shortened
text fits the longest window. A run no border cuts keeps the midpoint, as before. Only when no
place clears every border do both overlay rungs run again at the midpoint without the walls (a
whole label across a border still beats a shortened one), and the label is reported as
`LINK_LABEL_ON_BORDER`. Placement reserves the window: 7f's `reserveLinkLabelRoom` measures every
run a label rides with the same windows (`labelWindowDeficit`) and grows the row, or, for a tier gap, gives the solve of the tier gaps
its deficit (the solve grows the gap; ticket 57), when no window holds the text (ticket 19), and grows a group's padding when the label beside a run in
that padding reaches the edge (ticket 21, room across a run). A label on a diagonal line takes the step nearest the midpoint
whose text lies wholly in a window of the line, or the point of a window nearest the midpoint (ticket 20).
A label that yields to the band of another label on a diagonal line (`model.labelYields`, recorded in 7f)
keeps clear of that band with every candidate on its line, on every rung; stage 9 never decides a yield. The band is read on
the line placement derives (`overlayPath`), as in 7f; a recorded yield whose other line carries no label on a diagonal line now is
not applied and is reported (`LINK_LABEL_YIELD_UNAPPLIED`).
The scorer counts the crossings as `labelBorderCrossings`.

**What a candidate must clear.** Visible nodes and their stroke, visible pills, every already
placed label, and every routed-layer segment with its half stroke. A **turned label** (a heading that
is not 0 or ±90: a label on a diagonal line, or beside a declared straight member) is tested by the
rectangle its text occupies, turned, not by its upright box (ticket 20): the label records the
rectangle's size (`turnedSize`), and the border check, this test and G3 read it through one
predicate (`labelArea` and the separating-axis helpers of `src/geometry/oriented.ts`). A label beside
a straight member stands half its text height plus the visible gap off the run. An upright label is
tested by its box, exactly as before. Only the *clearance zone* of the
one segment the label was finally measured against is exempt, through a persisted `support`
reference that G3 reads; text drawn across a segment is a hit whatever it claims, and a stale,
absent or foreign reference exempts nothing. A **multiplicity label** carries its bundle's owner
and a `merge-run` reference, gets no segment exemption at all, and must clear every routed member
segment.

Obstacle queries use a balanced four-dimensional rectangle index. Each rectangle is stored as
`(left, top, -right, -bottom)`; intersection is four upper-bound comparisons. Subtree minima
reject disjoint rectangles before visiting members. Queries stop at the first actual collision
without collecting a candidate list. Static geometry builds one tree; accepted labels enter a
forest of balanced blocks. No query enumerates coordinate cells or falls back to every obstacle
because a coordinate is large. Shared-stem copies remain semantically distinct; their multiplicity
is not assumed to be bounded by G4 or G6. Scale checks count visited tree nodes and candidate tests
separately from text measurement.

**The generated legend is measured here too.** It is drawn geometry with text and symbol bounds, so
it belongs to the layout model, not to an unmeasured renderer margin. After the ordinary link
labels and before publication, the same transaction measures it and places it in newly reserved
space below everything the diagram draws — group boxes, lanes, pills, paths and visible labels —
with a 20 px gap. Frozen node, group, port, band and path geometry never moves for it, group label
bands are not replanned around it, and the anchor is that drawn-geometry union rather than the
canvas, so re-deriving the legend from a published model puts it back in exactly the same place.
It exists only when the document draws more than one symbol or more than one line style — or a
port role beside any other variant, since nothing else says what a role's paint means — lists exactly the classes present (known profile classes in declaration
order, then author classes by first use; a class with several tokens is keyed by the profile class that paints it, so `router extra`
shares the router row and `dashed extra` the dashed row, and stage 3 gives `router extra` the router icon (draw.io ticket 8); a
link without a class contributes the profile's default
line style; a line row whose links are all overlay links draws an overlay sample, the paint those links take (audit A1-16);
each role token of a drawn pill's `class` contributes one `port:<role>` entry, drawn as
a 26 × 10 pill with that role's paint, while status tokens contribute nothing), and records the
same effective stroke width `score` measures. `LayoutModel.legend` and its `role: 'legend'` labels
are stage 9's claims: the validator re-derives both and rejects a forged, moved or removed legend.

An entry ID is built from the class, which is accepted free text, so each field of it is encoded:
`%` and the `:` separator, and every character an XML attribute cannot carry unchanged — a C0
control, a lone surrogate, the two non-characters, and the tab, carriage return and newline a
parser folds to a space. `%XX` below U+0100, `%uXXXX` above it. Two classes that differ at all
therefore keep two identities all the way into the drawn `data-id`, and because `%` always encodes,
no class can spell another one's encoded form. The text a legend row *displays* is separate: it is
the class as authored, substituted for display by the serializer like any other visible text.

**Stage 9 settles the canvas.** `expandCanvas` reserves group boxes and lanes; a route may leave
both, and stage 9 adds label and legend boxes, so the producer *refits* the canvas: the union of
every group, lane, drawn path (stroke included), visible label and the legend, plus `CANVAS_MARGIN`
(12 px) on every side (ticket 28). "Canvas may only expand" governs the placement transactions,
where a later rule must never lose room an earlier one reserved; publication owns the final extent,
so growth during placement leaves no dead space below and no zero margin on the side that grew, and
a canvas that an undone push had stretched shrinks back. Restore has no predecessor transaction, so
the rule is stated geometrically there: the published canvas equals that refit — one that clips a
drawn box or leaves dead space is rejected.

**Multiplicity labels.** One per `Bundle.mergeRuns` record, `label:multiplicity:<run id>`, with the
decimal count as its text. `count` must equal the member count, be at least two, and every member
must really be a selected `merge` member of that bundle; anything else is an error, not a repair.
Ordinary parallel bundles, a singleton merge member and the M1 golden produce no count label. A
count has no meaningful prefix, so the shortening rung never applies to one: it is placed or
omitted.

## Stage 10 — validate

All gates in `quality.md` on final geometry including labels. Any failed gate fails `render`
(non-zero exit) unless `--allow-gate-failures`; `score` always reports. The gate-enforcement
table by size is in `quality.md` and is authoritative.

**G9, frame containment.** Every frame contains its cells and its child
frames. Frames of one tier do not overlap. No foreign node body lies inside a frame. G1 and G8
read cells.

## Stage 11 — emit

Layout JSON (always) → SVG. `render(layout, options?)` is pure: it measures nothing, moves nothing
and grows nothing. Every coordinate, size, rotation, stroke width and label metric is read from the
model, and the emitted stroke width of an element is exactly the width `score` measured for it.
A top or bottom pill's rectangle is already rotated in the model, so the renderer draws that
rectangle unrotated and turns only the text, by the label's stored `textRotation`.

`class` attributes from YAML, kept as separate tokens beside the structural class (`node router`),
on the painted element as well as its container, so a document rule of the same specificity still
owns the palette. One semantic `data-id` per object: group id, node id, `node.port#ordinal` for a
named port, the model link id, the merge-run id and the legend entry key. A detached label, endpoint
mark or bar body carries `data-owner` and, for a mark, `data-end`, instead of repeating a `data-id`.
Every text node and attribute is XML-escaped, including the inline style, so no source string is
interpolated as markup.

**A mesh bus** (ticket 84) is one `<g class="mesh-bus overlay <class>" data-id data-members>` in the masked overlay layer: one `<path>` for the bar
and one per stub, each `link-line overlay-line <class>`, so the class stroke and dash apply; a `<title>` lists the members, the dissolved
group-links and the members' authored labels. The member `<g class="link">` elements are not emitted, and one endpoint mark per stub is drawn
above the mask at the port face. The bus label is drawn on the label layer (`link-label mesh-bus-label`). `document.overlays` hides the bus
with its class. The draw.io export writes the bar as one `edgeStyle=none` edge with two free points, each stub as an
`edgeStyle=none` edge (a run with no bend is straight, Q118) from its port's cell to a free point on the bar, a mark per stub on its pill, and the label as a text
vertex on the `labels` layer; the drawn bar and stubs read back from the drawio CLI (`-x -f svg`) within 0.05 px.
Ticket 97: the riser of a joined pair is one more `<path class="link-line overlay-line <class> riser">` in the upper bus's group, both groups carry `data-joined`, the tooltip names both buses, the members and the cross links, and a cross link draws no `<g class="link">`. draw.io: the riser is one `edgeStyle=none` edge with two free points on the overlay layer (`pg-busRiser~<bus>`).

An inline `<style>` holds the profile theme, the generated geometry locks and the parser-filtered
document `css:`, in that order. The theme is three paint-only sheets emitted from one data table
(`ref/theme-handoff/`, ticket 32): light, then dark behind `@media (prefers-color-scheme: dark)`,
then greyscale behind `@media print`; a document's `css:` follows all three, so an author's rule
still wins in every mode. **CSS may not change geometry**: the parser strips every locked
property from `css:` with a warning, and `restoreFinalLayout` re-runs that same filter over a
published model's CSS, so a hand-written layout JSON cannot reach the renderer with a locked
declaration either. The generated locks restate the measured stroke widths and typography with
`!important`; the rest of the locked set — paint that leaves the measured box, such as an outline
or a shadow — is held by that one parser policy on both routes, not restated per element.
The renderer uses no CSS custom property for a locked value, so an author `--name` cannot reach
one either. The locked set is in `schema.md`; `css:` may set colour, fill, dash and opacity.

**What both renderers compute is stated once** (`render/shared.ts`, draw.io tickets 13 and 8). The theme sheet is a table of paint
rules (`paintRules`, and `washRules` for the sheet's own node classes): the SVG writes it as CSS, and the draw.io export reads the same
table and the document's `css:` (`authorRules` in `render/author-css.ts`) and resolves each cell's paint by the CSS cascade
(`PaintSheet`, `computePaint`): an important declaration wins, then the more specific rule, then the later one; a property no rule
states is inherited from the element's parent (every paint property but `opacity`), and the opacity a cell is drawn at is the
product of `opacity` along the path. The match runs on the path of class attributes from the SVG root to the element (`paintPath`,
`svgClass`, which the SVG writes too), so a descendant or child rule reaches both renderers. A mode reads the light rules and, for
dark or print, that mode's rules on top, as a browser reads the unconditional rules and the matching `@media` blocks. A class token
the theme does not know, or the order of the tokens, changes the paint in neither. What draw.io cannot carry of the author's rules (a
selector beyond class compounds and the two combinators, a property beyond fill, stroke, their opacities, `opacity` and the dash, an
at-rule other than a plain `@media`, or a value draw.io has no key for, such as a stroke on a text) is named in one
`DRAWIO_CSS_UNMAPPED` warning. The glyph box in an icon tile (`iconGlyphBox`: the inset,
1.5 px or the card's own, is at most a quarter of each tile side) and the runs of a path (`pathRuns`: a new run where a segment does
not start at the end of the one before, at the planar tolerance) are the other two. The SVG starts a subpath per run; draw.io writes
a connector per run.

**Every text outside node bodies carries a halo** (ticket 162, ADR-0023): group titles, link, multiplicity and bus labels and
legend labels have the class `pg-halo` and a depth class `pg-halo-<n>`, where `n` counts the group boxes behind the text's centre
(`boxesBehind`). The style states `paint-order: stroke fill` with a 4 px stroke, and per depth the colour behind the text
(`backdropColour`: the page with each group fill laid over it at its opacity) in light, dark and print. draw.io has no outline for
a plain-text label, so a text in its labels layer takes `labelBackgroundColor` in that colour; a group title lies under the links
there and shows a line drawn over it.

The overlay `<g>` sits beneath the routed layer with node interiors, port pills, multiplicity and bus
labels masked out. A line that text cuts has a mask of its own (`pg-line-mask-*`, ticket 162): a link label
cuts its own line (a routed one only where the label lies on a direct line, ticket 16), and a group title or
a foreign link label cuts an overlay line where an orthogonal run of it meets the text, the text box cut to
the run's stroke. A diagonal (`isDiagonal`, 10 degrees or more from both axes) is not cut; the halo breaks it; a hidden link's label is left out of the mask so it cannot leave an
unexplained gap. Overlay endpoints keep a 2 px mark, drawn above the protected elements rather than
inside the masked group. One counted merge trunk is painted once by its bundle, and the interval it
covers is subtracted from each member's own path, which still draws its approach and departure.

**A bar that a drawn run crosses paints its body beneath the routed layer.** A drop onto a lower bar
crosses the upper bar by design: the crossing is reserved during placement, annotated `barCross` on
the segment and reported by G2, so the bar's opaque fill may not hide the run that crosses it. Those
bodies are emitted in one `nodes crossed-bars` layer between the overlay and the links; the bar keeps
its icon, label and pills in the node layer above the run, as the approved target draws them. The
renderer reads the annotation from the geometry it really paints, so a crossing that no drawn run
declares — a layer selection that hides it, or a link with nothing left to draw — moves no body, and
no other node body moves either: G2 keeps every other routed segment out of every foreign node.

The detached body is the same rectangle, with the same classes, in a container of the same kind
(`<g class="node …">`), inside a second node layer. **A document styles the palette by name**, and
every name is kept: the theme, the geometry locks and a `css:` rule naming the body, the node class,
the container or the node layer all reach a crossed bar's body exactly as they reach any other. What
no rule can follow is the element's place in the tree — a selector written on the owner's `data-id`,
on sibling order or with `:has()`. That is not new here: a detached label and an endpoint mark leave
their link the same way, and internal render structure is not a styling surface. The container is a
detached element, so it carries `data-owner`, and the node's one `data-id` stays on the group its
content is drawn in. Two differences are accepted: an author who makes a node translucent composites
a crossed bar's body and its content as two groups rather than one, and a rule that names the node
layer applies to both of its groups.

**The mask is internal render structure, not an author styling surface.** The theme states no rule
for it: a rule in that sheet is reachable by an accepted `css:` rule of the same specificity and
importance, which then wins by source order, and an ordinary global rule reaches it as well. Each
mask element carries its own paint instead, as a presentation attribute and as important inline
declarations — colour, fill and element opacity, stroke, display, visibility, blending, and `mask`,
`clip-path` and `filter` — with `mask-type: luminance` on the mask itself. An important inline
declaration outranks every rule of an author style sheet whatever its specificity, importance and
source order, and the presentation attribute keeps the mask correct for a renderer that reads no
style at all. An author `css:` block still owns the palette of every element the diagram draws.

`RenderOptions.layers` selects the effective link families to draw as a nonempty list of `routed`
and `overlay`. With no selection both families are drawn and `document.overlays` hides overlay
links by class; an explicit selection overrides those switches. Nodes, groups, ports and the
generated legend are never hidden by it, and link-owned labels and overlay endpoint marks follow
their links. This changes emitted visibility only: stored geometry, the canvas, the score and the
gate scope are untouched, and the legend keeps its recorded full class set and geometry.

Emission order: `<defs>` (style, icon symbols, overlay mask), canvas background, group boxes,
masked overlay paths, crossed bar bodies, routed paths and merge trunks, nodes with icons, text and
pills, group and link labels, unmasked overlay endpoint marks, generated legend. An endpoint mark is
drawn at its overlay path's own first and last point, which is the port's outward face, so it sits on
the pill's side where the line leaves it rather than over the port's name (stress ticket 30). draw.io
already put its own mark there, on 2026-09-15, and the two renderers now agree.

---

## Scale — authoritative table

| Nodes (N) | ELK | Deadline | Gates | Notes |
|---|---|---|---|---|
| ≤ 30 | partitioning | 10 s | all enforced | the "beautiful" regime |
| 31–300 | partitioning | 10 s | all enforced | warning: above readable size |
| 301–1,000 | partitioning, fallback on failure/deadline | 20 s | G3 (labels) downgraded to warning; others enforced | warning: fallback may apply |
| > 1,000 | refused without `--force` | 30 s | as above | |

Budgets that bound work, checked at parse: links ≤ 10 × N, ports ≤ 20 per node, node degree
≤ 64; beyond them, a warning and best-effort. Geometry algorithms use interval sweeps and indexed
rectangle queries; anything O(S²) over segments is a defect, not a design choice.

Measured so far: `elk.layout()` alone, 100 nodes / 300 links ≈ 250 ms; 1,000 / 3,000 ≈ 2 s
without partitioning. The **full pipeline** at 1,000 nodes has not been measured — ticket 17.

## What the prototype proved and what it did not

Proved on the prototype source topology (`prototype/regions.mjs`, `tall5`): stages 3, 6, 7a–7f
produce 0 crossings, 0 overlaps, 4 bends with every link claimed; libavoid idle. The approved M1
JPEG fixture has different topology: it was measured in ticket 13 and leaves two links for
libavoid, which routes them and keeps every gate (stage 8 above). **Not yet exercised:** stage 8
at scale or with substantial remainder demand (NTP golden), bundles with author-fixed ports, 3+
stacked bars, fallback at scale under a deadline, aggregation, applied stubs, overlay masking,
label repair.
Each is a ticket or an explicit M2 item.
