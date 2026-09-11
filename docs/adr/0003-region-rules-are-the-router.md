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
- libavoid-js is beta; it is a fallback, not the critical path. The binding is pinned to exactly
  `0.5.0-beta.5` and verified against its `embind/bindings.cpp`, not its IDL or its declarations,
  which are inaccurate and stay out of the public API. `ShapeConnectionPin.setExclusive` exists
  (shared ports need `false`); `Checkpoint` **and** `ConnRef.setRoutingCheckpoints` exist;
  `ConnRef.setFixedRoute` does **not**, and `JunctionRef` has a declaration but no class binding.
  Fixed paths are therefore registered as trimmed obstacles, as the prototype did, and a shared
  stem is model geometry — a `Junction` record reserved in stage 7e — that stage 8 stitches back
  exactly, routing only the gap beyond the reserved run's terminal, never a runtime `JunctionRef`.
  Checkpoints serve the outward port stems and the head-on approach to a reserved corridor, not the
  junction itself. libavoid may skip a checkpoint it cannot reach, so every claim is validated
  after route extraction. Its orthogonal
  visibility sweep also assumes no obstacle lies wholly inside another, so contained rectangles are
  dropped before routing using exact edges (the union is unchanged). Collision tolerance is not
  used for this removal because approximate containment can form cycles. Partially overlapping
  shapes retain their coordinates. A hand orthogonal router remains a possible
  replacement without touching the rules.
- `processTransaction()` is synchronous WASM work. A same-thread race cannot interrupt it, so the
  adapter runs in a real terminable worker with its own budget, and nothing about libavoid — no
  class, enum, WASM handle or asset URL — reaches the layout model.
- Semantic technique choice (override, aggregation, family, bundle membership) is made before
  placement (pipeline stage 1); only geometry-dependent choices wait for a trial route.
- The JPEG golden's remainder is two links of twenty-six, measured in ticket 13: the rules claim
  the rest, and libavoid routes those two through every gate. Sheets with substantial remainder
  demand, including the NTP golden, remain untested.
