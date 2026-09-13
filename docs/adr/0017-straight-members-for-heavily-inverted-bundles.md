# ADR-0017: Straight members instead of orthogonal crossovers for heavily inverted bundles

Date: 2026-09-14 · Status: **proposed** (drafted for the maintainer from ticket 26) · Decisions: ticket 26

## Problem

`author-ordered-bundle` forces three inversions; the orthogonal crossover staircase is long and
busy. The maintainer (2026-09-12): "if we have so many crossings, it's better to use straight lines
instead of angled routing."

## Decision (proposed)

A bundle whose authored order has more inversions than `⌊members / 2⌋`, or whose crossover
staircase would be longer than the straight span between its two stems, draws each member as
stem → straight diagonal → stem. The choice is automatic; `route: straight` on a bundle forces it.
Gates: G5 still requires the two perpendicular stems; the diagonal is a new segment kind
(`straight: true`) that G4 and G6 measure by segment distance (already stroke-aware for any angle
in `segmentBox`) and that the crossing counter counts as one crossing per crossing pair. Rendering:
the same stroke class as the member; the legend line sample stays horizontal.

## Consequences

`docs/design/quality.md` names the diagonal segment kind and its gate treatment; the crossing counter
gains a segment-pair intersection for non-axis-aligned segments; `author-ordered-bundle` re-baselines.

## Alternatives considered

- Keep the staircase but raise the member pitch: still busy; rejected by the maintainer's remark.
- Diagonals for every inverted bundle regardless of count: a single inversion is cleaner as a
  crossover; the threshold keeps the common case orthogonal.
