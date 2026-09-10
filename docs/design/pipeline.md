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

After 7f, the successful `bands` transaction captures `freeze.placement`, including node content
and pill geometry, group geometry, tier bands, regions, lanes and group-label placement. Later
transactions and restore require exact equality with this projection. Canvas may expand, and
runtime/diagnostic fields remain writable. Later stages may create paths and link-label boxes but
may not move or resize groups, nodes or port anchors. An async router computes outside the
synchronous transaction, then commits its output through the route validator.

## Stage 8 — route (remainder)

libavoid-js (`Router(OrthogonalRouting)`). Registered as obstacles: node rectangles; every
**pinned path** as thin rectangles with **18 px trimmed at each end** so a remaining link that
shares an endpoint can reach it; lanes not owned by the link; label bands; bundle envelopes.
Ports are `ShapeConnectionPin`s, one class id per port, **`setExclusive(false)` for ports with
> 1 link**, direction = the side. Terminal escape: libavoid-js exposes no fixed routes or
checkpoints (verified: `connector.idl` has `Checkpoint` but no `setRoutingCheckpoints`); the
≥ 15 px stem is enforced by placing the pin on the boundary and validating the first segment
in stage 10. `overlay` links: straight segments between port centres on their own layer, not
routed. Stub candidates: after routing, a link whose route crosses > 2 tiers or is > 3× the
direct distance is marked; M1 only warns (stage 1).

## Stage 9 — link labels

Placed after routing on the longest segment of the computed path, then checked against every
label, node and segment; on collision, try the next-longest segment, then offset to the other
side of the segment, then shorten with an ellipsis to the segment length − 8; a label that still
collides is dropped to a tooltip and reported (`labelsOmitted`). Overlay-layer labels are
suppressed when overlay density (overlay links per node) exceeds the profile's threshold
(default 3).

## Stage 10 — validate

All gates in `quality.md` on final geometry including labels. Any failed gate fails `render`
(non-zero exit) unless `--allow-gate-failures`; `score` always reports. The gate-enforcement
table by size is in `quality.md` and is authoritative.

## Stage 11 — emit

Layout JSON (always) → SVG. `class` attributes from YAML; an inline `<style>` from the profile
theme plus the document `css:`. **CSS may not change geometry**: font-family, font-size,
stroke-width and transforms are set by the theme and locked (`!important` in the emitted style);
`css:` may set colour, fill, dash, opacity. The overlay `<g>` sits beneath the routed layer with
node interiors, group labels, port pills and link labels masked out; overlay endpoints keep a
2 px mark.

---

## Scale — authoritative table

| Nodes (N) | ELK | Deadline | Gates | Notes |
|---|---|---|---|---|
| ≤ 30 | partitioning | 10 s | all enforced | the "beautiful" regime |
| 31–300 | partitioning | 10 s | all enforced | warning: above readable size |
| 301–1,000 | partitioning, fallback on failure/deadline | 20 s | G3 (labels) downgraded to warning; others enforced | warning: fallback may apply |
| > 1,000 | refused without `--force` | 30 s | as above | |

Budgets that bound work, checked at parse: links ≤ 10 × N, ports ≤ 20 per node, node degree
≤ 64; beyond them, a warning and best-effort. Geometry algorithms use interval sweeps and a
uniform grid index; anything O(S²) over segments is a defect, not a design choice.

Measured so far: `elk.layout()` alone, 100 nodes / 300 links ≈ 250 ms; 1,000 / 3,000 ≈ 2 s
without partitioning. The **full pipeline** at 1,000 nodes has not been measured — ticket 17.

## What the prototype proved and what it did not

Proved on the prototype source topology (`prototype/regions.mjs`, `tall5`): stages 3, 6, 7a–7f
produce 0 crossings, 0 overlaps, 4 bends with every link claimed; libavoid idle. The approved M1
JPEG fixture has different topology and must be measured independently. **Not yet exercised:**
stage 8 with real remainder demand (NTP golden), bundles with author-fixed ports, 3+ stacked
bars, fallback at scale under a deadline, aggregation, stubs, overlay masking, label repair.
Each is a ticket or an explicit M2 item.
