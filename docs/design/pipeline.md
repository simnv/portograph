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
2. **Aggregation** — a set of links forms a group-link only if: both endpoint groups have ≥ 2
   nodes, the links are the **complete** bipartite set between them, all share one class and
   family, and none carries an override. Membership (every member link, its ports, class) is
   retained in the model and rendered as a tooltip/legend entry, never discarded.
3. **Family** — from class via the profile: `routed` or `overlay`.
4. **Bundle membership** — ≥ 2 routed links between the same node pair (ports may differ). After
   grouping, a selected `merge` override without membership in a bundle of at least two is a
   model-time error.
5. **Stub** — deferred: needs a trial route (stage 8 marks candidates; stage 9 applies).

**M1 behaviour:** `stub` and `group-link` are parsed and recorded but not applied; a warning
says so and the links are drawn routed. This is explicit, not silent.

The layout link's `family` records its class-derived family; `layer` is the effective drawing
layer after the override and M1 fallback. Gates and routing use that effective layer. `technique`
also records the effective behavior: an M1 stub/group-link request remains on the source document
link, while its concrete members use orthogonal or bundle paths. A recorded request therefore
does not receive the missing-path exemption of an actually applied stub.

Group endpoints expand to concrete member-node attachments before placement. Empty groups cannot
supply an attachment and produce a model error. Explicit `group-link` requires two distinct groups
with at least two nodes each. Other group endpoints may expand to ordinary routed members with a
warning; they do not acquire group-link eligibility solely by using group endpoint syntax.

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

## Stage 3 — size

Per node, per side: `pitch(side) = max(12, largest rendered pill extent along that side + 4)`.
The unrotated pill width is measured text (font-metrics table) + 2×3 padding, at least 24 px;
its height is at least 10 px. Top/bottom pills and their text rotate −90°; left/right pills
stay horizontal, matching the target JPEG and d3-fd. The extent used for pitch is the rotated
box's width on top/bottom and its height on left/right. Then
`height = max(minH, contentH, n_left|right × pitch + 2·pad)`, `width = max(minW, contentW,
n_top|bottom × pitch + 2·pad)`, `contentW/H` from the measured label, description and icon.
The content interior reserves, on each side, the larger of the 10 px content padding and the
largest named pill's inward half-extent plus 4 px. Anonymous ports add no such inset. Store those
content insets so placement centres the icon/text blocks in the remaining interior, which may be
asymmetric; a long port name can therefore grow the normal node dimension without changing pitch.
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
| `elk.layered.crossingMinimization.semiInteractive` | `true` | **the** mechanism that preserves in-layer order — used with `elk.position` to put a flank's pre-skeleton proxy peer at the outer end (`considerModelOrder` is only a soft preference and does not pin) |
| `elk.layered.nodePlacement.strategy` | `SIMPLE` on compounds with flank proxies | keeps hinted peers at distinct outer positions; the default can stack different-width peers at one x, changing the final outer-edge tie |
| `elk.json.shapeCoords` / `edgeCoords` | `ROOT` | absolute coordinates; no compound-relative conversion in our code |
| `elk.randomSeed` | `1` | default; kept explicit |

**Lateral links (flank↔tier) are withheld** from the ELK graph. Flank groups are placed after ELK
by rule: beside their `of:` tier, on their `align` side, top-aligned with the tier band.

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

**Time and failure:** ELK runs in a worker with a deadline (`layoutBudgetMs`, default 10 s at
≤ 300 nodes, 20 s above). On exception **or deadline**, terminate the worker and run the
fallback: one ELK run per tier band without partitioning, bands stacked in tier order with the
standard gap. The prototype recorded a 33 s *failing* run at 1,000 nodes — waiting for the
exception is not acceptable. After either path, **validate**: every group inside its tier band,
no group overlap; violation → fallback (if not already) → hard failure.

Output: absolute group boxes, node positions, in-row order.

## Stage 5 — sides, phase two; resize; repack

Immediately after the skeleton, before anything is pinned. Undecided same-tier directions take
`left`/`right` from the in-row order; shared ports then recompute their majority across all peer
directions, including already-known higher/lower-tier directions. Nodes are **re-sized** (stage 3 formula) if a side gained ports. Each row is
then **repacked horizontally** in ELK's order, and group boxes are recomputed. The gap is at
least 20 px plus the two node half-strokes. Where facing named pills protrude farther, use the
sum of their measured half-widths and half-strokes instead. Adjacent groups and tier bands move
as needed to contain the resized rows. Each side receives a provisional engine order by far-end x (for top/bottom) or y
(left/right). Use translated skeleton peer anchors when present and peer-node centres otherwise;
shared-port peers use their mean coordinate. Capture those coordinates before the final anchor
rebuild. Author `order:` sorts the author-ordered subsequence; free ports occupy the remaining
positions. Preserve signed keys and the relative physical order of unequal author keys, not an
absolute slot number.

From here on port identity, count, side and author `order:` are **frozen**. Later bar and bundle
rules may adjust engine-selected slots and the documented stage-7 rules may grow or move geometry,
but no stage may shrink a node below its current content or author floor.

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

## Stage 6 — rows

Per tier: all `row`-shape nodes share one top y. Repack horizontally again if the flattening
created overlap (nodes ELK stacked at one x). For each same-tier pair with facing east/west
ports: level the facing ports (move the ports on the node with fewer on that side) and, if
nothing lies between, **pin** a non-bundle link as a straight horizontal. Bundle endpoints are
levelled here but remain unpinned for stage 7e.

`rows(model)` runs inside the `rows` transaction. The baseline is the highest row-node top in the
tier band; nodes move up only, and row group boxes fit the flattened nodes with the standard
padding. Repack pushes a row neighbour rightwards only when its stroke-aware clearance or
measured facing-pill gap (the stage-5 `rowGap`) is violated, then pushes displaced row groups in
the tier. Flanks and non-row groups never move or resize in this rule; a repack that would
collide with one fails explicitly, and so does a stage-5 input whose flank box lacks the padding
the containment rebuild assumes. Levelling considers routed links only; a tie in facing port counts moves the
right-hand node's ports. A target is applied only if it keeps engine order, the measured pitch
and the capacity padding (`pad + pitch / 2` from each end); infeasible targets are skipped in
engine order, ports beside a levelled port keep pitch spacing, and ports between two levelled
ports spread evenly. Rows cannot reorder ports, so an engine-inverted bundle levels one member
here and the rest waits for stage 7e.

A **row path** is a derived claim, not a callback edit. The transaction rebuilds every row
candidate from final anchors after each committed geometry change, removing the old path before
recreating it. A candidate is a routed, non-bundle, non-group-link link with an automatic,
`straight` or `orthogonal` route whose frozen sides face across a same-tier pair of row nodes.
It is pinned when the endpoints are level, the length is at least one 15 px stem and below
2 × the larger node dimension, and the corridor clears foreign geometry at gate clearance:
10 px stroke-aware to foreign nodes, no contact with foreign pills, labels, lanes, label bands,
bundle reservations or obstacles, and 10 px from other fixed segments. An automatic candidate
records `technique: straight` while pinned and `orthogonal` otherwise; authored routes keep
theirs, and a non-candidate automatic link keeps the resolver's unset technique until its own
rule validator lands. Publication compares each candidate's path and technique with a fresh
rebuild, and a callback that edits either is rejected. No separate obstacle record is written:
the pinned path itself is the obstacle for every later reservation and for stage 8.

**Invalidation:** row alignment runs before any fixed path exists, so nothing needs re-checking.
Later movement replaces row paths through the same rebuild; a candidate whose corridor a later
reservation blocks loses its pin and routes in stage 8.

## Stage 7 — regions

A **region** is the space between adjacent tiers, or between a flank and its tier. Sub-stages
run in this order because each reserves space the next respects. Each sub-stage lists what it
may move and what it must therefore re-validate.

### 7a — lanes (owned)

For every link whose path must transit a tier it does not terminate in: reserve a **lane** —
a vertical corridor of width `laneW = pillW + gap` — in the margin of the intermediate group on
the side nearer the source x. Lanes have an **owner** (the link) and a vertical-run reservation;
the lane is an obstacle to every *other* link. For a non-bundle owner the route segment through
the lane is fixed here. For a bundle member, 7a records only the owned lane x and extent; stage 7e
consumes that reservation when it creates the member path. Capacity uses actual occupied geometry, measured pills, and participating strokes. Corridor width is
`max(34, endpoint pill widths + 10, 20 + path stroke + maximum node stroke)` in pixels.
Before fixing any lane x, expand occupied intermediate margins through horizontal group/node/flank
translations and expand the canvas. Preserve transit source anchors and the groups' internal order.
Plan displacement outward from the insertion gap and propagate it through neighboring groups.
A corridor's centre cannot decide displacement direction when the corridor contains an entire
neighbor. If a transit source or an existing corridor blocks propagation, use a clear exterior
corridor without moving those owners.
An existing lane's identity, owner, x and width cannot change in later stages. Extents follow the
current intermediate band with `10 + pathStroke / 2` padding before placement freezes.

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

Anchor tier = the tier with the most main-tier nodes, including bars and excluding flanks (ties: lowest effective tier index). Empty layouts omit it. Below the anchor, each
group is centred under its feeds; above it, each group is centred over its children (mirror).
For a child group G fed from tier T−1: the **feed set** is the parents' bottom ports whose peer
is in G. **Parents are authoritative:** parent port x is fixed by stage 5/7a; G is centred
horizontally under the barycentre of the feed set within the space between the lanes (7a) and
neighbouring groups; then each child port x := its parent port x. A child port's x is feasible
only if the child node can be widened to contain it without overlapping a sibling; if not, the
link remains unpinned and is reported. Unequal-x top/bottom normals generally need two orthogonal bends; routing determines the actual count. A parent port feeding **two** children cannot be vertical to
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

### 7e — bundles

`bundles(model)` commits one checked `bars -> bundles` transaction. Its geometry-only planner
jointly orders endpoint sides, retains unequal authored precedence and unrelated relative order,
grows measured side pitch/capacity and repacks affected rows. The 16 px `memberGap` is visible
clearance. The minimum centreline pitch includes the maximum member stroke, 17.5 px at defaults.
Primary facing blocks remain aligned. Secondary flank blocks clear intervening nodes using their
actual stroke-aware bounds. Growth translates downstream bands and attached flanks before paths.
Existing lane identity, owner, x and width never change.

Reserve crossing width/rows before creating paths. Strict endpoint-pair inversions ignore shared
port ties. Distinct engine ports use a common order where authored precedence permits it. Shared
incidence uses a deterministic search capped at 4096 endpoint-order pairs. Exhaustion emits
`BUNDLE_ORDER_OPTIMIZATION_LIMIT`; it does not claim a proved minimum. A K2,2 bundle has a true
minimum of one. Contradictory intermediate lane order fails with
`BUNDLE_RESERVATION_ORDER_CONFLICT` before publication, rather than inventing endpoint inversions.

Route a clear full-width centreline and offset its members. Aligned clear bundles stay straight.
Bent channels expose `envelopeParts` as swept rectangles and `envelope` as their union. Author
inversions use isolated adjacent-swap cells. Every strict crossed member pair is independently
checked against the endpoint inversions; undeclared bend contacts and overlaps fail. Complete
member paths follow authored source-to-target direction even when bundle orientation differs.
Lane runs and the latest rebuilt bar hints/slots remain constraints. Every actual `barCross`
annotation retains its bar-owned reservation.

Collinear transits remain separate exact lane segment records, each with its own lane ID and
link owner. Connectors meeting closed lane boundaries are split and tagged only for the matching
owner/corridor; a later lane never overwrites an earlier lane's identity. Publication and restore
independently require every bundle lane's exact segment in authored traversal direction.

Shared incidence uses explicit junction trees. A root has an outward perpendicular stem of at
least 15 px. A child keeps the same port, starts at its parent point, and carries a strict subset
of its parent's members. Each member traverses its exact root-to-leaf chain. A port shared across
bundles and an unclaimed remainder has one tree. `LayoutLink.sharedRuns.from/to` records its
outward partial runs. Stage 13 consumes `from` outward and `to` in reverse order and direction;
a partial run never becomes a complete `path`. G4 exempts only validated shared runs. G6's fan
exception covers the incident run and immediate outgoing branches at the same verified vertex.

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

### 7f — group label bands

For every group: band height = label height + 8, inside the top padding; label at the band's
left edge; if its bbox intersects any pinned segment or lane, slide right to the first free gap
wide enough; if none, **widen the group** by the label width and push its row neighbours (which
re-triggers 7c for groups whose parents moved — bounded by the same 8-pass limit). The label
bbox becomes an obstacle. Centre is never a fallback.

Measure group labels with the shared font table at 12 px, weight 700 and `FONT_FAMILY`. The band
retains 4 px above and below the measured text, and the label has an 8 px horizontal inset. Convert
intersecting geometry into forbidden label-start intervals, sort by start/end/stable ID, merge, and
choose the first free x. The stable claims are `label-band:<group-id>` and
`label:group:<group-id>`; labels and bands are already separate router inputs, so no duplicate
generic obstacle is added. Group fitting and bar shaping include the band above the ordinary 12 px
node padding and retain a wider extent created by collision repair. The intervals include every
reserved rectangle of a link: its complete path, its partially fixed lane runs and the mandatory
outward shared runs of both ends. A complete path repeats the runs it consumed, so identical
stroke-aware rectangles with identical ownership collapse to one entry.

**Widening cannot cross a reserved lane.** Lane x, width, owner and side are immutable after 7a, so
a widening and its neighbour pushes are feasible only while every group keeps each lane of its tier
on the side that currently holds it. Feasibility reads the same occupied extent the lane validator
measures — group box, stroke-aware node clearance and pill gaps — and a widening leaves those nodes
and pills where they are while a push carries them along. A group whose only free gap lies beyond
that limit keeps its width and its left-first label, spends no centring pass, and is diagnosed
`GROUP_LABEL_GAP_INFEASIBLE`; the unchanged final gates decide the retained geometry.

**Band clearance for stage 8 entry.** Stage 8 routes only free gaps and must avoid whole label
bands; owning the endpoint group does not waive that obstacle. Each band therefore records the
`clearance` it reserves between its lower edge and the group's topmost node. The reservation is the
ordinary 12 px padding unless a top-side port carries a routed attachment, in which case it is the
largest outward reach at those ports plus the widest routed half stroke and a 0.25 px tolerance.
The reach is the whole mandatory shared prefix when the port has one, otherwise the ordinary
checkpoint `max(15, 10 + (node stroke + widest routed stroke) / 2 + 0.25)`, which follows the node
obstacle when a wide stroke expands it past the 15 px stem. With the default 2 px node and 1.5 px
routed strokes an ordinary top port reserves 16 px. The rule reads frozen inputs only: the constant
stem and `sharedRuns`, which every publication at or after stage 7e rebuilds and compares, so
completing a remainder in stage 8 cannot retire the reservation. Publication and restore recompute
the reservation, require the node gap, and reject any required entry point that lies inside the
stroke-aware obstacle of its own group's band.

**Atomic rebuild after 7d/7e/7f movement.** Bar-band growth in 7d and tier-gap growth in 7e move
the lower tier bands and their contents; neighbour pushes or centring in 7f move the affected row
groups and descendants.
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

After 7f, the successful `bands` transaction captures `freeze.placement`, including node content
and pill geometry, group geometry, tier bands, regions, lanes and group-label placement. Later
transactions and restore require exact equality with this projection. Canvas may expand, and
runtime/diagnostic fields remain writable. Later stages may create paths and link-label boxes but
may not move or resize groups, nodes or port anchors. An async router computes outside the
synchronous transaction, then commits its output through the route validator.

## Stage 8 — route (remainder)

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
- **lanes**, **group label bands**, **group and node labels**, **bundle envelopes** and model
  obstacles, each expanded by the routed half stroke.

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

Ownership is exact. A link may pass only through the reservations it already owns: its own transit
lanes, its own bundle envelope, its own reserved runs. Owning the endpoint group does not open a
label band. Links whose exclusion sets differ cannot share one router, because the binding has no
per-connector shape-ignore API, so they run as an ordered sequence of **ownership batches**, and
every completed route becomes a protective obstacle for the batches after it.

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
and the stage rejects the route rather than publish geometry that occupies a reservation.

Each link is stitched back in source-to-target order: its reserved runs byte-for-byte, with their
owner, lane and `barCross` annotations, and the routed gaps between them. Where a gap meets one of
its own lanes it is split at the corridor boundaries and each piece names the one lane it touches,
the same shape the region rules produce. Publication and restore then check the result
structurally — complete anchored path, orthogonal and connected, exact reserved runs, perpendicular
stems of at least the reserved reach, link ownership of every routed gap, and no entry into a
reservation the link does not own — because route geometry cannot be re-derived without the router.

`overlay` links: one straight segment between the port anchors on the overlay layer, never routed
and never sent to the worker. Stub candidates: after routing, a link whose route passes through
more than two intermediate tier bands (measured by their vertical extent, since a reserved lane
sits in the margin beside its tier) or whose arc length exceeds 3× the direct anchor distance is
marked `stubCandidate` and warned about; M1 keeps the technique and the full routed path.

**Measured on the JPEG golden:** stage 7 leaves exactly two links, `link-1` and `link-2`, the two
provider feeds into EAC-01 and EAC-02. This is a deviation from the prototype run, where the rules
claimed every link and libavoid was idle; the rules claim 24 of 26 here. Both really invoke
libavoid, in one ownership batch, and the complete 26-link diagram passes G1–G8 with 0 crossings,
0 overlaps, 0 label hits and Q 0.818586208746674 (0.8182938137778218 before ticket 16 reserved a visible wire between facing pills). Each feed leaves the datacenter group sideways,
drops beside the full-width label band and enters its top port through the 16 px clearance stage 7f
reserved for exactly that entry.

## Stage 9 — link labels

Placed after routing on the longest segment of the computed path, then checked against every
label, node and segment; on collision, try the next-longest segment, then offset to the other
side of the segment, then shorten with an ellipsis to the segment length − 8; a label that still
collides is dropped to a tooltip and reported (`labelsOmitted`). Overlay-layer labels are
suppressed when overlay density (overlay links per node, over `max(1, nodes)`) exceeds the
profile's threshold (default 3). A suppressed label leaves no record at all, so it is not an
omission.

The transaction owns the whole production, as 7f owns group labels: a callback may not author a
label. It adds labels, their diagnostics and canvas extent only — placement, every path, every
fixed segment, junction, bundle, merge run and obstacle stay exactly as stage 8 left them. Group
label bands are validated against the geometry that existed when they were reserved, so a stage-9
label never moves one.

**Typography and spacing.** Link and multiplicity labels are `FONT_FAMILY` 9 px weight 400, text
horizontal, with the measured `lines` and `lineHeight` stored; stage 11 re-measures nothing. The
box is centred on its segment's midpoint, `4 px` of visible clearance beyond the supporting
stroke's edge. Shortening uses the measured ASCII `...`, because the checked-in advance table has
no U+2026, and keeps the longest proper prefix that fits. That width does **not** grow with the
prefix: a line break inside it moves the ellipsis onto a new line and can make the box narrower, so
the search is a scan over exact prefix widths, never a bisection.

**Order of candidates.** Segments run in descending geometric length, then source-to-target index;
zero-length segments are skipped. The first side — *above* for a horizontal segment, *right* for a
vertical one — is tried across every segment before the opposite side is tried across that same
order; then both passes repeat with the shortened text; then the label is omitted with its full
text as `tooltip`. Authored labels run in link order, then merge runs in bundle and run order, so
an accepted label is an obstacle for every later one.

**What a candidate must clear.** Visible nodes and their stroke, visible pills, every already
placed label, and every routed-layer segment with its half stroke. Only the *clearance zone* of the
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
It exists only when the document draws more than one symbol or more than one line style, lists
exactly the classes present (known profile classes in declaration order, then author classes by
first use; a link without a class contributes the profile's default line style), and records the
same effective stroke width `score` measures. `LayoutModel.legend` and its `role: 'legend'` labels
are stage 9's claims: the validator re-derives both and rejects a forged, moved or removed legend.

**Stage 9 settles the canvas.** `expandCanvas` reserves group boxes and lanes; a route may leave
both, and stage 9 adds label and legend boxes, so the producer expands the canvas over every group,
lane, drawn path, visible label and the legend. Restore has no predecessor transaction, so the
"canvas may only expand" rule is restated geometrically there: the canvas must contain all of that.

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

## Stage 11 — emit

Layout JSON (always) → SVG. `render(layout, options?)` is pure: it measures nothing, moves nothing
and grows nothing. Every coordinate, size, rotation, stroke width and label metric is read from the
model, and the emitted stroke width of an element is exactly the width `score` measured for it.
A top or bottom pill's rectangle is already rotated in the model, so the renderer draws that
rectangle unrotated and turns only the text, by the label's stored `textRotation`.

`class` attributes from YAML, kept as separate tokens beside the structural class (`node router`),
on the painted element as well as its container, so a document rule of the same specificity still
owns the palette. One semantic `data-id` per object: group id, node id, `node.port#ordinal` for a
named port, the model link id, the merge-run id and the legend entry key. A detached label or
endpoint mark carries `data-owner` and, for a mark, `data-end`, instead of repeating a `data-id`.
Every text node and attribute is XML-escaped, including the inline style, so no source string is
interpolated as markup.

An inline `<style>` holds the profile theme, the generated geometry locks and the parser-filtered
document `css:`, in that order. **CSS may not change geometry**: the parser strips every locked
property from `css:` with a warning, and the theme states the same properties with `!important`.
The renderer uses no CSS custom property for a locked value, so an author `--name` cannot reach
one either. The locked set is in `schema.md`; `css:` may set colour, fill, dash and opacity.

The overlay `<g>` sits beneath the routed layer with node interiors, group labels, port pills and
visible link labels masked out; a hidden link's label is left out of the mask so it cannot leave an
unexplained gap. Overlay endpoints keep a 2 px mark, drawn above the protected elements rather than
inside the masked group. One counted merge trunk is painted once by its bundle, and the interval it
covers is subtracted from each member's own path, which still draws its approach and departure.

`RenderOptions.layers` selects the effective link families to draw as a nonempty list of `routed`
and `overlay`. With no selection both families are drawn and `document.overlays` hides overlay
links by class; an explicit selection overrides those switches. Nodes, groups, ports and the
generated legend are never hidden by it, and link-owned labels and overlay endpoint marks follow
their links. This changes emitted visibility only: stored geometry, the canvas, the score and the
gate scope are untouched, and the legend keeps its recorded full class set and geometry.

Emission order: `<defs>` (style, icon symbols, overlay mask), canvas background, group boxes,
masked overlay paths, routed paths and merge trunks, nodes with icons, text and pills, group and
link labels, unmasked overlay endpoint marks, generated legend.

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
