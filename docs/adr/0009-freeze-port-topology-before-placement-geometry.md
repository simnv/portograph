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
