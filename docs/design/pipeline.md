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
4. **Bundle membership** — ≥ 2 routed links between the same node pair (ports may differ) that
   leave each shared node on one authored side; links whose authored sides differ at a shared node
   form separate cohorts, and a cohort of one stays routed with a `BUNDLE_MIXED_SIDES` warning
   (ticket 35). After
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

A bundle's members leave each shared node on one side: the ports one bundle ties at a node (and,
through a port in two bundles, both bundles' ports) vote as one component in stage 2 and again here
for what stage 2 left open, so they take one side; an authored side wins, and stage 1 never bundles
two different authored sides (ticket 35). From here on port identity, count, side and author `order:` are **frozen**. Later bar and bundle
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
padding beyond the complete named pills (including their half stroke), not just node bodies. Repack pushes a row neighbour rightwards only when its stroke-aware clearance,
measured facing-pill gap or pass-by stem (the stage-5 `rowGap`) is violated — the stem is the
15 px checkpoint plus the neighbour's obstacle reach that a port needs when its link does not enter
the neighbour's facing side, whether it goes to a third node or to the neighbour's far side, top or
bottom (ticket 29) — and, when links turn inside the gap (a pass-by, or a facing link
that enters at another height and jogs), one stem on each side that contributes a leg plus one pitch
between every two legs, counted by link (ADR-0015 rule 1) — then pushes displaced row groups in
the tier. Flanks and non-row groups never move or resize in this rule; a repack that would
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
The lane's **alignment end** is the endpoint nearer the anchor tier (7c), because 7c holds that end fixed and aligns the other end under the lane; when both ends are equidistant, and for bundle members (7e owns their geometry), it is the authored source. "Source" in this stage means that end. First try the source port x, considering every insertion gap in the intermediate group order.
Choose the feasible outward translation plan with the least total displacement, keeping all
previous corridors and transit source groups fixed. If no such plan exists, use the in-span
allocation and then the exterior fallback described below.
Before fixing any lane x, expand occupied intermediate margins through horizontal group/node/flank
translations and expand the canvas. Preserve transit source anchors and the groups' internal order.
Plan displacement outward from the insertion gap and propagate it through neighboring groups.
Repeated pushes publish node positions and anchors from their original coordinates plus the
final group delta, avoiding accumulated rounding under the exact translation guard.
A corridor's centre cannot decide displacement direction when the corridor contains an entire
neighbor. If a transit source or an existing corridor blocks propagation, use a clear exterior
corridor without moving those owners.
An existing lane's identity, owner, x and width cannot change in later stages. Extents follow the
current intermediate band with `10 + pathStroke / 2` padding before placement freezes.

**The runs between the lanes are allocated too (ADR-0015 rule 1).** A **tier gap** is the open band
between two adjacent tier bands. The lane extents that face it bound it. Every run that crosses one
is allocated before the first ownership batch runs. The rule that owns the lanes owns this too,
and reads the same frozen placement.

A run whose two ends share one x takes that **column**, straight across the gap. A run whose ends
differ takes a **row**: a horizontal line inside the gap. A vertical segment joins the row to each
end. Where the far end is a port beyond the gap, that segment reaches the gap's far boundary at the
port's x. The piece from the boundary out to the port is the port's own approach. It stays routed,
and the gap allocates only where it is clear.

Rows pack from the low boundary. The pitch between two of them is `16 px + widest routed stroke`.
Each row takes the first position clear of frozen geometry at or beyond that pitch past the one
before it. The first and the last keep half a pitch from their own boundary. Two runs that stand on
one x would share length there. A lane can sit under a lane of the same x in the band above, and a
port can sit over a lane's mouth. The one that leaves the low boundary turns first. Two such runs
from one boundary have no clean order, and the gap allocates neither.

Every run with a lane terminal on a boundary owes a head-on approach of one router stem on the
lane's own x. It owes it whether the gap seats that run or not, and every seated row keeps the
gate's clearance from it. A gap allocates nothing when no run in it needs a row. A diagram whose
transit links all descend on one x is therefore untouched.

An allocated run also keeps that clearance from every reserved run of its own link that runs the
same way and never meets it. A pair that meets at a corner is one turn of one path. A pair that runs
the same way and does not meet is the pair G6 measures, whichever link owns it.

Every routed attachment holds an outward stem, whether a rule has claimed its path or not. An
allocated run may not stand in one. The link that owns that stem would otherwise have no route to
its own port. A run also stays out of the link-free margin every group edge keeps (ADR-0013). That margin is not
an obstacle for a link the group holds, because such a link has to reach a port inside the box. G6
still refuses a segment that *runs along* the edge from on or outside it, whoever owns the group.
The allocation therefore keeps the margin on the edge a run would follow. The edge a run crosses is
free.

Two allocated runs of one gap may **cross**. Neither is routed, so the crossing is reserved rather
than discovered and neither needs an exemption from the other. A link that must cross the gap
without a lane terminal on either boundary keeps the route it has today. The rows do not obstruct
it: a run along a gap is a wall along it and never across it (ADR-0015 rule 3). A gap that cannot
leave every one of its approaches clear allocates nothing.

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
is in G, plus every non-bundle link that terminates in G and transits T−1 through a lane it owns
(7a); for such a **transit feed** the authoritative x is that lane's x, not the far parent anchor.
Its identity is still the parent port, so one parent port fanning through several lanes is vertical
to its first child by x and the others fan, as for adjacent feeds. A transit feed never contests a child
port another feed already owns: it yields with `CENTRE_FAN_REMAINDER` and is excluded from the
centring barycentre, because contesting it would exhaust the shared budget. Bundle members are
not transit feeds; 7e owns their geometry. **Parents are authoritative:** parent port x is fixed by stage 5/7a; G is centred
horizontally under the barycentre of the feed set within the space between the lanes (7a) and
neighbouring groups; then each child port x := its parent port x. A child port's x is feasible
only if the child node can be widened to contain it without overlapping a sibling; if not, the
link remains unpinned and is reported. Unequal-x top/bottom normals generally need two orthogonal bends; routing determines the actual count. A parent port feeding **two** children cannot be vertical to
both: the first (by child x) is vertical, the rest fan through a shared stem — the junction tree 7e
reserves for every port with two or more routed links (ticket 20; a rule-fixed member joins it under
ADR-0016).
Iterate child-widening → sibling push → re-centre at most 8 times, ε = 0.5 px; on non-convergence
keep the last state and report. *Moves:* child groups, child widths. *Re-validate:* lanes (7a
positions are fixed; if a child now overlaps a lane, push the child, not the lane).

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

Reserve crossing width/rows before creating paths. Strict endpoint-pair inversions ignore shared
port ties. Distinct engine ports use a common order where authored precedence permits it. Shared
incidence uses a deterministic search capped at 4096 endpoint-order pairs. Exhaustion emits
`BUNDLE_ORDER_OPTIMIZATION_LIMIT`; it does not claim a proved minimum. A K2,2 bundle has a true
minimum of one. Contradictory intermediate lane order fails with
`BUNDLE_RESERVATION_ORDER_CONFLICT` before publication, rather than inventing endpoint inversions.

Route a clear full-width centreline and offset its members. Aligned clear bundles stay straight.
Bent channels expose `envelopeParts` as swept rectangles and `envelope` as their union. Author
inversions use isolated adjacent-swap cells, unless the bundle is heavily inverted (ADR-0017) and
the existing geometry holds the member gap, when each member is drawn as stem, one straight
diagonal, stem instead; an infeasible bundle keeps the staircase. Every strict crossed member pair is independently
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
bundles, between a bundle and an unclaimed remainder, or by a plain fan of routed links that no
bundle claims, has one tree (ticket 20); only a port whose links all belong to one bundle is that
bundle's own fan. A bar drop (its path fixed by 7d) joins the tree as its straight-through leaf when
its plain straight run out of the port reaches the last junction row plus a pitch: stage 7d has
already split that run into the tree's stems and the continuation under the junction ids 7e will use
(`junction:<port>:shared:<depth>`, ADR-0016), the continuation ending where the drop turns if that is
before the tree's usual end, so the scorer sees one owner on every shared segment. At most one fixed
member joins a port — the first by source order whose run fits the rows its cohort would have — and
it is always peeled last. A drop whose run is too short, a drop at its bar end, and the straight row
and flank paths of stages 6 and 7b (ticket 37) stay outside the tree, and the cohort shrinks
accordingly — one rule (`treeCohorts`) decides this in 7d from the traversals under construction, and
in 7e and on restore from the root junction id a split path carries. An excluded member keeps its own
stem out of the port, which covers the tree's root: 7e reports it with `FAN_MEMBER_UNRESERVED` and G4
reports the overlap, until ticket 37 adopts every fixed member. `LayoutLink.sharedRuns.from/to` records its outward partial runs. A checkpoint
the reserved run already passes through — a lane's approach point that a deep leaf has reached — is
consumed by the run and not asked of the router. Stage 13 consumes `from` outward and `to` in reverse order and direction;
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

For facing, non-inverted members whose endpoint tracks differ, each bend receives a distinct
member-pitch row. Members moving toward smaller tangent coordinates turn in increasing source
order; those moving toward larger coordinates turn in decreasing order. This avoids bend contact
and coincident lateral runs even when unrelated ports create unequal endpoint spacing. Optional
projection onto a common endpoint block is declined if its full side capacity would cross a sibling
or immutable lane; local slots remain valid and the bundle bends instead.

### 7f — group label bands

For every group: band height = label height + 8, inside the padding of the **title edge**: the
horizontal edge with fewer incident routed link ports, so a group fed from above carries its title
at the bottom and no link routes around it; ties, including groups linked only sideways, keep the
top (ADR-0011). A bottom band grows the group downward. Every group's nodes move down by the largest
top-band shift of their tier, so mixed title edges and unequal clearances keep the tier's node row
level and flanks stay level with their peers. Center the label when
its measured box is clear. Otherwise choose the nearest free position within the horizontal
insets, breaking equal-distance ties to the left. If none fits, retain the existing first-free
widening rule and push row neighbours (which re-triggers 7c for groups whose parents moved,
bounded by the same 8-pass limit). The label bbox becomes an obstacle, together with its **link-margin**: 8 px on every side that no
link may enter. Placement keeps the label that far from every reserved link rectangle (paths, lane
runs, shared runs, envelopes, feed corridors); stage 8 expands the label obstacle by it; G3 fails a
routed segment closer than stroke/2 + 8 px to a group title.

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
measured and its link's run — symmetric about the anchor midpoint, out to the nearer pill face or
node edge — is made at least the label width plus both 8 px shortening margins: a link between tiers
moves every lower tier down by the deficit; a link between two ends of one tier inserts the room at
the gap: every group in every tier at or beyond the split between the two pill faces moves right,
and a group straddling the split shifts only the nodes beyond it — in the link's own tier those that
start beyond it, elsewhere those with any part beyond it — so alignments, flank sides and
bar-to-source slots all survive and nothing moves left into a preceding group; a reserved lane at or
beyond the split makes the link unreservable. A routed link will detour when its ends are not level
or when the straight run between them is not clear by the corridor check — a node, pill, foreign group
box with its margin, lane, fixed run, bundle row or bundle envelope in the way — and its run is then reserved with both stroke-aware
router stems and twice the anchor-side pill protrusion on top of the label. Self-links, same-tier links
through top/bottom ports, pairs whose ports do not face each other across the gap, and links whose room
lies beyond a reserved lane are diagnosed `LINK_LABEL_ROOM_UNRESERVED`. Moves settle pills before the next link measures; the
reservation re-runs after the grid inside the 7f loop and any movement replays the region producers. That group's band clearance also
reserves the label's room beside the detour run under the title. Publication and restore re-run the
reservation on a copy and reject a model it would still change.

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
obstacle when a wide stroke expands it past the 15 px stem. With the default 1.5 px node and 1.5 px
routed strokes the entry requirement is 16 px; a default named pill instead reserves 24.5 px
to retain its visible gutter. The rule reads frozen inputs only: measured port names, the constant
stem and `sharedRuns`, which every publication at or after stage 7e rebuilds and compares, so
completing a remainder in stage 8 cannot retire the reservation. Publication and restore recompute
the reservation, require the node gap, and reject any required entry point that lies inside the
stroke-aware extent of its own group's band. This conservative checkpoint reservation preserves
room below any label position without making unused band space a routing obstacle.

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
  `10 + (its stroke + widest routed stroke) / 2` clearance. A stem is left out on a node **side**
  the current batch attaches to as well. Two ports of one node side share that strip. A port on
  another side of the same node stands in its own strip and keeps its reservation.
  These rectangles are added per batch. They never enter the ownership exclusions, so they cannot
  change a batch; they remain for the attachments no gap allocation reaches.
- **every allocated tier-gap run** (§ 7a), covered by the clearance a reserved run carries, for
  every batch from the first. This is the head-on approach to a lane, reserved rather than covered
  by a rectangle. Measured over 322 diagrams, a 23 × 38 px cover repaired 8 failures and broke 4.
  The wall it put in a tier gap pushed other links into routes their own checkpoints could not meet.
  A run's **row** does not obstruct the links that must cross that gap, which the allocation names.
  Its vertical segments obstruct them, and a route can pass those by. The owner is not given the row
  either. Its route meets the run at the two terminals, so the end rectangles keep the owner and the
  ones between do not.

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
envelope, its own reserved runs, its lane runs included, and the row of a tier-gap run its own route
must cross. A transit lane is not one of them: the corridor holds the owner's run, and stage 8
stitches that run back rather than route it. Owning the endpoint group does not open a label band.
Links whose exclusion sets differ cannot share one router, because the binding has no per-connector
shape-ignore API. They run as an ordered sequence of **ownership batches**, and every completed
route becomes a protective obstacle for the batches after it.

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
owner, lane and `barCross` annotations, the tier-gap runs the allocation made for it, and the routed
gaps between them. An allocated run is not a claim the lanes rule wrote on the model, so the
stitcher names the corridor it leaves exactly as it names a routed gap that meets one. Where an
allocated run and the gap beyond it are one straight run, the stitcher joins them. A run a rule
wrote on the model is reproduced exactly and is never joined. Where a gap meets one of
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
them. ADR-0015 rule 1 reserves that room in a row gap and in a tier gap, not beside a node side, so
the masks stay advisory until the room a pinned turn needs is reserved there too.


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
then both passes repeat with the shortened text, and among the clear shortened candidates the
one keeping the most characters wins (ADR-0014); then the label is omitted with its full text as
`tooltip`. Authored labels run in link order, then merge runs in bundle and run order, so
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
It exists only when the document draws more than one symbol or more than one line style — or a
port role beside any other variant, since nothing else says what a role's paint means — lists exactly the classes present (known profile classes in declaration
order, then author classes by first use; a link without a class contributes the profile's default
line style; each role token of a drawn pill's `class` contributes one `port:<role>` entry, drawn as
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

The overlay `<g>` sits beneath the routed layer with node interiors, group labels, port pills and
visible link labels masked out; a hidden link's label is left out of the mask so it cannot leave an
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
pills, group and link labels, unmasked overlay endpoint marks, generated legend.

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
