# ADR-0009: Freeze port topology before placement geometry

Status: accepted

Stage 5 freezes port identity, count, side and author `order:`, while engine-selected order and
placement geometry remain mutable only through the declared region rules. Those rules may grow or
move geometry, never shrink it below current content or author floors, and must rerun their listed
invalidations; final placement freezes after stage 7f. Freezing all dimensions at stage 5 would
make flank pitch equalisation, child widening, bar sizing and label-band growth impossible, while
leaving port topology mutable would invalidate technique and attachment decisions.

Late movement rebuilds claims atomically: boxes, anchors and tier bands; fixed-owner lane extents;
bounded centring; non-bundle row/flank paths; bar drops; bundle paths/envelopes; then label boxes,
clearances and containment. Replacements remove stale obstacle geometry, and final gates decide
failure after a diagnosed non-convergence.

ADR-0010 makes this boundary executable. Stage 5 publishes an immutable snapshot; later rules edit
one checked draft and retain the returned snapshot. Persisted topology/floor metadata survives
serialization, and restore also checks resolved document semantics. Author keys constrain relative
order, not absolute engine slots. Node text, icons and pills rebuild from measured content and the
rule's final anchors. Missing claim rebuilds reject affected changes until their producer lands.

Bundle placement now grows endpoint side pitch and node capacity, re-levels facing blocks,
repacks affected rows and reserves horizontal or vertical crossing space before paths. The
16 px member gap remains visible clearance. These movements retain topology, unequal authored
precedence, unrelated relative order, content floors and fixed lane identity/x/owners.

Amendment (2026-10-05, architecture ticket 15, phase 4): the side of a port comes from, in order, the author `side:`, a course, a side hint, the stage-2 table and the stage-5 vote. A course is an input of the placement run, as a hint is: the course round measures it on the 7f baseline and passes it to a placement re-run, and `sidesOne` fixes its faces. The sides still freeze at the end of stage 5. The `courseHint` flag marks the port, and `naturalSide` keeps the side the table gave. A course end may be a natural end (no face change), a side end or a padding end (see `course-rows.ts`). No link end records an approach in this phase.
