# ADR-0017: Straight members instead of orthogonal crossovers for heavily inverted bundles

Date: 2026-09-14 · Status: accepted (maintainer, 2026-09-14; drafted from ticket 26) · Decisions: ticket 26

## Problem

`author-ordered-bundle` forces three inversions; the orthogonal crossover staircase is long and
busy. The maintainer (2026-09-12): "if we have so many crossings, it's better to use straight lines
instead of angled routing."

## Decision

A bundle whose authored order has more inversions than `⌊members / 2⌋` draws each member as
stem → straight diagonal → stem. Below that threshold the two shapes are built and compared by drawn
length: straight members win when the staircase is more than half as long again. Either way straight
members are used only when the geometry that already exists holds the member gap between every pair
of member segments G6 would measure — stems included, and excepting a pair that strictly crosses — nothing is moved to make room, and an infeasible bundle keeps the staircase.
The choice is automatic. (An authored override was considered: `route: straight` is a per-link key
and stage 1 excludes such links from bundles, so forcing straight members would need a new
bundle-level key — out of scope here, and the threshold covers the maintainer's case.)
Gates: G5 still requires the two perpendicular stems, and accepts `straight: true` only on a member
of a bundle that owns the segment; G4 indexes a diagonal on a uniform grid by the cells it crosses and measures the overlap
along the run; G6 measures its clearance by segment distance to anything it does not cross; the
crossing counter counts one crossing per crossing pair. Rendering:
the same stroke class as the member; the legend line sample stays horizontal.

## Consequences

`docs/design/quality.md` names the diagonal segment kind and its gate treatment; the crossing counter
gains a segment-pair intersection for non-axis-aligned segments; `author-ordered-bundle` re-baselines.

## Alternatives considered

- Keep the staircase but raise the member pitch: still busy; rejected by the maintainer's remark.
- Diagonals for every inverted bundle regardless of count: a single inversion is cleaner as a
  crossover; the threshold keeps the common case orthogonal.
