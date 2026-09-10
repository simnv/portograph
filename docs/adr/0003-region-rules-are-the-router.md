# ADR-0003: Region rules are the router; libavoid routes the remainder

Date: 2026-09-10 · Status: accepted · Decisions: Q24, Q29, Q30, user observations

## Context
On the prototype source topology, ELK alone gave 3 crossings but the wrong shape; ELK with
lateral ports fixed gave 20–76; ELK skeleton + libavoid gave the right shape with 11 crossings.
Adding region rules one at a time — flank align, bars, lanes, bundle, row align,
child-under-parents, label bands, bar span — took it to 0 crossings, 0 overlaps, 4 bends
(`docs/research/prototype-results.md`). In that prototype run every link was claimed by a rule and
libavoid routed nothing. The approved JPEG golden has different topology; ticket 13 measures its
remainder count rather than inheriting the prototype result.

## Decision
Routing is decided per **region** (the space between two tiers, or a flank and its tier) by
what is on each side. The rules run in a fixed order, each reserving space the next respects
(`docs/design/pipeline.md` stage 7). libavoid-js routes only links no rule claims, with every fixed
path registered as an obstacle. Per-link technique precedence is fixed:
override → aggregation → visibility → bundle → straight → orthogonal.

## Consequences
- The product is the rule set; ELK and libavoid are substrate.
- Rules that compete for space (lanes vs child-centering) are ordered, not iterated freely.
- libavoid-js is beta; it is a fallback, not the critical path. Verified 2026-09-10 against its
  IDL: `ShapeConnectionPin.setExclusive` exists (shared ports need `false`), `JunctionRef` exists
  (shared stems), `Checkpoint` exists but `ConnRef.setRoutingCheckpoints` and `setFixedRoute` do
  **not** — fixed paths are therefore registered as trimmed obstacles, as the prototype did. A
  hand orthogonal router remains a possible replacement without touching the rules.
- Semantic technique choice (override, aggregation, family, bundle membership) is made before
  placement (pipeline stage 1); only geometry-dependent choices wait for a trial route.
- The JPEG golden's remainder count is established in ticket 13. Sheets with substantial remainder
  demand, including the NTP golden, remain untested.
