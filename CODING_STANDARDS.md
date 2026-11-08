# CODING_STANDARDS.md

Implementers read this file before they write code. Reviewers check each diff against it.
Each rule comes from a defect that reviewers found more than once. A reviewer cites a rule by id: "breaks R1".

This file does not repeat other documents. Read them for their topics:
[`CONTEXT.md`](CONTEXT.md) (vocabulary, invariants), [`docs/adr/`](docs/adr/) (decisions),
[`docs/design/pipeline.md`](docs/design/pipeline.md) (stages),
[`docs/design/quality.md`](docs/design/quality.md) (gates G1 to G9),
[`docs/agents/`](docs/agents/issue-tracker.md) (tickets, labels).
Use the `CONTEXT.md` terms exactly. TypeScript flags, ESLint and `.githooks/pre-commit` enforce style, imports and the denylist.

Gates, in order: `npm run typecheck`, `npm run lint`, the tests you touched, the golden, then `npm test`.
For corpus and sweep measurement, see [`docs/agents/gates.md`](docs/agents/gates.md).

## Rules

### R1. Decide once. Store the decision as data.

Placement writes each decision on the model, also when the decision is "none".
A validator, replay or restore reads that record. It never derives the decision again from later geometry.
Two readers of one predicate call one function.
For an optional record, absent and empty can mean different things. State both meanings, and test both.

```ts
// Placement: record the decision, also an empty one.
model.frozenChords = held;                          // [] = frozen, no chord held
// Replay and validator: read the record.
if (model.frozenChords !== undefined) return model.frozenChords.includes(link.id) ? path : undefined;
// Absent = not frozen yet: the pre-freeze selection may run.
```

Evidence: architecture-2 tickets 11, 13 and 16 (about 14 review rounds). `freezeChords` set no record when no chord was held,
so replays decided the chord again on widened boxes. Exits were derived again until `model.groupExits` (`src/layout/mutation.ts`).
Check: ask "where is this decision stored?" Replay a restored model after you stretch a box (grid, label band). A guarded change validates. A change that breaks a reservation refuses.

### R2. Reserve before the consumer runs. Guard every later change.

Reserve each size, row, lane and exit in placement. The router must not discover one (ADR-0021 forbids router grants).
Chord decisions freeze at the start of 7f. Final placement freezes after 7f. Every later write to a box, on both axes, asks a guard
(`src/layout/move-reservations.ts`, `src/layout/growth-guard.ts`) and refuses whole, or works on a draft.
When a loop reads `model.groups`, ask if it must read `model.frames` too.
Each iterative rule states its convergence condition, and a test replays it. Do not assume a replay is byte-idempotent
(architecture-2 ticket 05 records exceptions). Keep diagnosed non-convergence as ADR-0010 says.

Evidence: architecture-2 tickets 12, 13 and 16 (a reader of `model.groups` missed `model.frames`; `alignGrid` ignored the y axis);
m1-example-diagram ticket 27 (a move that a later stage undid); m1-example-diagram ticket 35 (bundles undid each other).
Check: a gate G4 or G6 failure on a routed fixture signals this class. Name the reservation that carries the new rule and its guard.

### R3. Keep output independent of incidental input order.

Keep an order that the document or the domain makes meaningful (for example canton members). Otherwise rank candidates by geometry and content.
Allocate conflicting candidates together. Do not let the first one win. Write the last tie-break key in a comment.
`sourceIndex` is a last key only.

Evidence: architecture-2 tickets 13 (greedy exit choice, then joint allocation, then a content tie-break) and 15 (movers took link order).
Check: `npm run r3 -- <sheet.yaml>...` runs the sheet with `links` reversed and with `nodes` reversed and prints `SAME` or the first differing path (`docs/agents/gates.md`). In a test, reverse a block with `reversed(yaml, 'links' | 'nodes')` from `scripts/r3-lib.mjs`. Every `.sort(` needs a total order.

### R4. Bound work by count, never by time.

Read the clock only to abort the whole command, with a named warning. A time-based guard that changes the layout gives a different drawing on a slow machine.
Give each loop a named bound and state its scope (`SEARCH_BUDGET` is per conflict component). Pass one budget down: a replay uses the caller's remaining budget.
When a cap truncates work, raise a diagnostic. Finite traversals need no cap.

Evidence: ranked-groups tickets 112 and 141.
Check: grep `Date.now|performance.now` in `src/layout`; a hit outside the budget, worker and timing code needs a reason. Test with an injected `clock` (`LayoutOptions`): the layout stays the same.

### R5. A validator trusts geometry and the stored record, not a diagnostic.

A diagnostic in a serialised model can be forged or stale. Do not excuse a violation because a diagnostic names it.
The one accepted exception is ADR-0010: a non-converged centring keeps its last state, records `CENTRE_INVARIANT_UNVERIFIED`, and the final gates judge it.
Limit every exemption to the owner and the stage that prove it.

Evidence: m1-example-diagram ticket 19 (a forged `CENTRE_ALIGNMENT_INFEASIBLE` bypassed the invariant; an exemption covered sibling owners);
architecture-2 ticket 16; ranked-groups ticket 114.
Check: inject the diagnostic into a violating model; the validator still throws. Test an exempt item beside a non-exempt item.

### R6. A guard that cannot read its input refuses. A skipped item gets a named diagnostic.

No `catch {}`. No `return true` on missing data. No `continue` over an unreadable plan without a diagnostic.

Evidence: architecture-2 tickets 16 (fail-open gap guard); m1-example-diagram ticket 27 (skipped links); ranked-groups ticket 112 (a dropped re-run).
Check: grep `catch {`, early `return true` and `continue` in guards. Ask what the user sees when the guard skips.

### R7. Measure the full set with the right counters.

Report before and after, on every sheet: Q, crossings, canvas, gate results, turns, removed links, bent routed links and bent overlay links.
Count bends with `pathBends` (`src/layout/objective.ts`; on a polyline, `pointTurns` of `src/geometry/planar.ts`), not `segments - 1`. Count a proper crossing with `strictCrossing` (`src/layout/read/crossings.ts`), never with a private copy. A report that names one metric is not accepted.
For architecture-2 refactor steps, no fixture may get worse on the recorded metrics without explicit acceptance.
Use `npm run corpus` and `npm run gate:compare`.

Evidence: ranked-groups ticket 110 merged on one metric and was reverted; ranked-groups tickets 100 to 102 passed the golden and failed two sweep inputs;
architecture-2 ticket 13 added a bend on a collinear exit.
Check: the ticket comment shows both TSV files compared.

### R8. Change the comment, doc and fixture header with the rule.

Search `src/`, `docs/` and `goldens/synthetic/` for the old rule text. Update the `goldens/README.md` row and the fixture `Expected` line.
Evidence: m1-example-diagram ticket 27 (stale text in two rounds); architecture-2 ticket 15.
Check: grep for the old rule words.

### R9. A rule is universal. The repository holds no real site data.

Do not add code for one sheet. Name the general principle and the other sheets it helps, or offer a per-sheet setting, or drop the change.
Fixtures, tests, docs and commit messages use invented names and documentation address ranges. The denylist hook checks staged lines.
Check: ask which other sheet the rule changes.

### R10. A tolerance has a named owner, a unit and an edge.

Compare at a name, never at a raw `1e-N` literal. Placement and routing names live in `src/layout/tolerance.ts`
(`PLACEMENT_EPS` for reservation arithmetic in px, `NO_MOVE_EPS` for every move guard, `SIGN_EPS` for products in px squared,
and the named depths, keys, grains and solver stops); published geometry reads `EPS` of `src/geometry/planar.ts`.
Two numbers that are equal answer two questions: do not merge them, and do not borrow a distance for a product.
Count turns and crossings with the shared predicates (R7), not with a private threshold.

Evidence: audit 2026-11 P-08 (62 unowned literals, a 1e-3 fraction that dropped a crossing 5 px inside a segment) and P-06-F7
(two no-move thresholds in one guard set); stress tickets 13 and 19.
Check: `test/lint/tolerance-literals.test.ts` refuses a raw literal outside the two owner files and the named exceptions it lists.

## Tests

A rule-level ticket adds a fixture in `goldens/synthetic/`, a `goldens/README.md` row, and a test that loads the fixture. Corpus tests scan that directory for invariants.
Never change the golden to make a test pass. The maintainer approves a new golden by hand, after a render review.

## Checklist (rule ids)

R1 R2 R3 R4 R5 R6 R7 R8 R9 R10

When a review finds a defect class a second time, add it here as a new R-id.
