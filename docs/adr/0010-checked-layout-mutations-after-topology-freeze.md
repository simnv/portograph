# ADR-0010: Checked layout mutations after topology freeze

Status: accepted

After stage 5, publish immutable layout snapshots and apply each later stage through one checked
draft transaction, so accidental direct writes cannot bypass the topology, floor and movement
rules in ADR-0009. Persist the topology/floor baseline and final placement projection, and use an
explicit restore API that also compares resolved link semantics with the authored document;
ordinary JSON parsing does not reinstate runtime protection or prove historical authenticity.

This replaces unrestricted geometry mutation with a copy-and-validate boundary. Existing mutating
helpers operate on the draft, while callers retain the returned snapshot; runtime and diagnostic
updates remain legal through the transaction. The cost is linear copying per committed stage and
a resolver pass on freeze/restore, measured by ticket 17. Author order preserves relative ordering
keys, not incidental absolute slot numbers. Placement freezes after group label bands, while
remaining routing and link-label output are still permitted by their own stage rules.

The public entry points are `freezePortTopology`, `withLayoutMutation` and `restoreLayoutModel`.
The transaction owns stage progression and timing. Its callback is synchronous and returns void;
asynchronous producers compute before committing their result. It rejects document, membership,
attachment, topology and stored-floor changes, plus changes outside the current rule's scope.
Committed geometry includes node labels, descriptions, icons and port pills. Unsupported claim
rebuilds reject the affected edits, and restore rejects claims whose validator has not landed.

The final projection excludes runtime, diagnostics and canvas expansion. Non-convergence can
retain coherent geometry for the final gates through a placement diagnostic with code
`PLACEMENT_NON_CONVERGENCE`; it never permits structural, floor or topology violations.

Derived containing-box rebuilds retain an existing left, top, right or bottom edge when the newly
computed padded edge differs by at most `1e-6`. This removes arithmetic no-ops before the exact
movement permissions run; meaningful movement, structural JSON equality and lane guards remain
strict.

All three publication paths share claim, technique, geometry and freeze validation. Required
rectangle fields, row sequence and authored flank side remain structural checks even after a
non-convergence diagnostic. Rows preserve flank placement; flank alignment translates vertically.
Technique validation preserves author overrides and M1 fallbacks while allowing automatic routed
links to select straight or orthogonal from the rows stage through their actual rule validator.

Row paths are the first derived claim. The transaction rebuilds them from final anchors in the
rows stage and after every later committed movement, replacing stale paths instead of appending.
Publication validates each row candidate against a fresh rebuild, so restore and every stage
share one producer. Callbacks cannot write or remove a row path. Flank paths now use the same derived-claim boundary;
other complete path claims still reject until their producer lands.

Stage 7a permits whole-group horizontal translation on occupied intermediate tiers before lane
allocation. Transit source anchors remain fixed. Lane owner, identity, x and width then remain
fixed; only band-derived extents rebuild before the final placement freeze. Non-bundle lane runs
use ordered `fixedSegments`, separate from complete paths. Publication and restore check exact
transit coverage, ownership, corridor capacity, extents and segment direction. Final placement
includes the partial runs. Regions derive from current groups and tier bands.

Stage 7b may normalize primary bundle members jointly on facing sides when authored precedence
allows it. This narrow exception handles engine interleaving and inversions before flank
alignment. Other ports retain their relative order and unrelated sides cannot reorder. The
transaction checks the exact normalization; restore checks its consistent final order. Later
bundle producers must extend this check alongside their own order/path validation.

Stage 7c initializes the anchor tier from main-tier node count, including bars and excluding
flanks, with the lowest effective tier breaking ties. It uses one shared eight-pass budget across
all groups and replay calls. Infeasible alignment stays an orthogonal routing remainder. The
ordered replay API rebuilds regions, fixed-owner lane extents, bounded centering, measured node
geometry, row paths and flank paths. A later stage must still obey its declared movement scope.

Stage 7d may increase a bar band's height to fit an authored outward stem and stroke-aware
foreign-node clearance between stacked bars. The checked transaction compares the actual band
before and after shaping, then translates every downstream tier and its attached flanks vertically
by the positive growth. It preserves prior tier gaps and all x coordinates. Callback-authored
movement outside the bar group remains invalid. The ordered replay rebuilds anchors, bands,
fixed-owner lane extents, measured node geometry, and paths; a repeated replay observes zero band
growth and does not translate tiers again.

Review refinement for stage 7a: plan margin translations outward from the insertion gap and
propagate them through neighbors in their existing order. Preserve transit sources and every
earlier corridor; when either blocks a push, allocate a clear exterior corridor instead.
Stage 7b checks every unrelated anchor against the common flank translation and actual boundary
growth. Merely retaining its pitch and engine slot does not authorize moving that anchor.
Fixed-segment equality uses structural JSON values: object key order is irrelevant, while array
traversal order, ownership, dimensions and coordinates remain exact.

Stage 7e's transaction finalizer owns bundle capacity planning and claim creation. It reuses the
row repacker, band translation, fixed-owner lane extent rebuild, bounded centering, bar shaping,
measured node content and earlier path producers. Callback-authored order corruption rejects
before the planner runs. The same bundle producer validates publication and restore by rebuilding
complete paths, envelopes, junction trees, partial shared runs and counted merge records.

Junction children declare a strict membership subset and exact parent-point continuity at the
same port. Complete paths and outward `sharedRuns.from/to` handoffs must match their root-to-leaf
traversal. The final placement snapshot includes those partial runs. They remain partial for a
routing remainder, so score's complete-path requirement is unchanged. Merge geometry preserves
existing shared-run ownership and reserves any additional selected trunk before paths.

Bar replay retains exact original fixed lane segments and tags only collinear owner approaches
that touch the same closed corridor boundary. Same-source bar jogs use stroke-aware staggered
rows in source order, avoiding coincident approach segments. Span subtraction keeps the explicit
width floor even when floating-point cancellation would produce a slightly smaller value.

Stage 7f installs measured group-label bands inside each group, then uses stage 7e's ordered replay
with one shared eight-pass budget. Group fitting and bar shaping preserve the installed top inset
and any wider collision-repair extent. The checked producer replaces stable band and group-label
claims, validates them again on restore, and captures final placement only after the coherent
claims exist. It does not create duplicate generic obstacles.

A label band also carries the `clearance` it reserves below itself for stage 8 entry geometry. That
number is derived from frozen inputs only — the outward stem, which follows the node's frozen
stroke, and the mandatory shared runs — so it cannot change when a remainder receives its path. It is part of the frozen placement
projection. Publication and restore recompute it, require the reserved node gap, and reject a
required entry point that falls inside the stroke-aware obstacle of its own group's band.
