# ADR-0010: Checked layout mutations after topology freeze

Status: accepted (2026-09-12: publication and restore also check the stage 7c alignment invariant, `centreViolations`, at every stage from centre on; its exemptions derive from geometry and topology by replaying the producer's own per-group step, never from serialized diagnostics, and the linked-group grid check replays rather than reads its diagnostic)

Known limit: a spent shared centring budget is producer state that geometry cannot witness. A model
carrying `PLACEMENT_NON_CONVERGENCE` therefore keeps its last state, as this ADR requires, and any
alignment the replay cannot confirm is recorded on it as `CENTRE_INVARIANT_UNVERIFIED` for the final
gates to judge, instead of being rejected. Every other model must hold the invariant exactly.

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
strict. Every move guard treats a displacement of at most `NO_MOVE_EPS` (`1e-9`, strict) as no
move, one name for all kinds (decision review 2026-11, D-Q6); the riser depth checks stay strict at
`RISER_DEPTH_EPS` (`1e-9`). Tolerances have named owners in `src/layout/tolerance.ts`.

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

M1 visual-review refinement: stage 5 reserves source-side transit pitch and group padding beyond
named pills before topology freezes. Stage 7a first tries source-aligned corridors using the same
checked outward margin translations; all owner and occupied-order guards remain in force. Stage 7c
leaves bar groups to stage 7d on every replay. Stage 7f prefers the centered label position, then the
nearest clear gap; its bounded widening fallback and immutable-lane checks are unchanged. Label-band
clearance also includes measured top pill padding, a frozen input independent of later route paths.

Amendment (2026-09-30, ranked-groups ticket 100 review): publication does not check the stage 7c alignment of a child port that a held cross-frame chord feeds. A chord runs between two faces at any angle, so its child port owes it no place under the feed. The excuse is narrower than the invariant: it applies only to the publication check (`ahead` false), only to a link whose `chordKind` is `cross`, and the centring loop's own check keeps asking for the alignment. The cause of one case is not traced: in `a-canton-band-holds-the-rows-off` the stage 7c step cannot resolve the child port of link-5, yet at `bands` it can (ticket 130).

After the freeze of the chords (stage 7f), the stage 7c centring reads `frozenChords` and the lane boxes: it declines a move, a port repack or a whole step that would lay a frozen chord across the box of a foreign lane it did not cross before, as it declines a step that deepens a riser keep-out breach. Before the freeze it reads neither, because the chords are decided again on every rebuild.

Amendment (2026-10-05, architecture ticket 15, phase 4): a perimeter lane (`kind: 'perimeter'`, id `perimeter:<link>`) has a derived x. Its id, owner, side, ring, span and `aligned` flag are fixed at stage 7a and stay immutable. Its x is read from the boxes over its span at each `rebuildLaneExtents` replay, with the course geometry as the one reader (`courseGeometry`). The reserved `fixedSegments` of its link (the side run or stem, the padding row and the vertical run) follow the x. The lane-identity check in `mutation.ts` compares the identity of a course lane without its x. Every other lane x stays immutable.

Amendment (2026-10-05, ticket 15, phase 4, review): the perimeter lanes of one side form one stack. A lane stands a ring pitch beyond every inner lane of its side whose extent it meets, whichever boxes each of them clears; `validateLanes` checks the pitch and that no lane stands across the box of a group on its extent. 7f replays the derived x once more on the geometry that publishes, because the settling after the last replay can move a box.

Amendment (2026-11-08, decision D-Q2, decision-review ticket 10): publication and full restore keep every run placement planned for stage 8, as they keep the fixed and shared runs: each tier-gap part (`allocateGapRuns`, ADR-0021 decision 3) and each row-gap leg (`legReservation`) stays in its link's path with its owner and its traversal, even where another route would pass the gates. No record is added. `validateRoutedPaths` calls the one producer (`placementRuns`) on the model as stage 8 received it (`preRoute`: the router's paths, removals and stub marks taken away) and requires each planned segment inside one straight piece of the path with the same link owner, running the planned way, in the planned order. A collinear merge with the same owner passes; a run moved off its line, given another owner, reversed or reordered is refused, and the error names the link. The plan leaves out every link `frozenChords` names, so restore first requires each name to hold a routed chord in the published geometry (`isRoutedChord`, the predicate the freeze writes the record with): a forged name cannot take a planned run out of the check.

Amendment (2026-11-08, DR-11, decision D-Q3): the callbacks of 7e and 7f are empty and their producers run after the rule checks, so the old `bundles` and `bands` diff checks read an unchanged draft; they are deleted. The producer is the judge: postconditions read the net draft of `bundles` and `bands` after every dependent rebuild and before commit, against the entry model, and a breach of a reservation that held at entry refuses the transaction (`PostconditionRefusal`). A producer refusal (that one, or a bundle path with no room) withdraws the trial of every round, by one rule in the round runner, and fails the main line by name. Publication and restore stay the second boundary. A newly blocked frozen chord and a new wall in a span corridor stay advisory, for output neutrality: each such break that publishes is named again by its own finding (`STRAIGHT_LINK_BLOCKED`, `SPAN_CHORD_BLOCKED`). A group exit is a held promise: its direction and the boxes it leaves are stored, its coordinates follow the box, and a change of direction is a replan that the derivation refuses after the final freeze. A required missing exit is read from the geometry and the record, never from `GROUP_EXIT_BLOCKED` (R5). Every `moveGroup` site after 7a states its guard, its proof by construction or its withdrawal path in `src/layout/box-writers.ts`, and `npm run lint` fails on a site not in that table. A direct write to a node box is outside the table; its doc names those writes.
