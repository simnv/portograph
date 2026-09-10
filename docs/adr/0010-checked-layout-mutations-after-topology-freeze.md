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

All three publication paths share claim, technique, geometry and freeze validation. Required
rectangle fields, row sequence and authored flank side remain structural checks even after a
non-convergence diagnostic. Rows preserve flank placement; flank alignment translates vertically.
Technique validation preserves author overrides and M1 fallbacks while allowing automatic routed
links to select straight or orthogonal from the rows stage through their actual rule validator.

Row paths are the first derived claim. The transaction rebuilds them from final anchors in the
rows stage and after every later committed movement, replacing stale paths instead of appending.
Publication validates each row candidate against a fresh rebuild, so restore and every stage
share one producer. Callbacks cannot write or remove a row path; other path claims still reject
until their producer lands.
