# ADR-0001: A layered solver places structure; there is no force simulation

Date: 2026-09-10 · Status: accepted · Decisions: Q1, Q11, Q12

## Context
The predecessor (`ref/d3-fd`) placed everything with d3-force plus custom forces. Its rule-based
components (port stacking, sizing, orthogonal segments) reproduced the target; every simulated
component (tier order, group placement, containment) diverged, because a force model cannot
represent "above". All five reference sources agree layout carries meaning.

The engine survey (`docs/research/layout-engines.md`) found elkjs `layered` to be the only
JS-usable engine that natively provides ports with side/order constraints, compound groups,
orthogonal routing with crossing minimisation, tier ordering, and determinism.

## Decision
elkjs 0.12 `layered` produces the tier/group skeleton. No force simulation exists in the core.
Organic arrangement inside a group, if ever needed, is ELK's per-group `force`/`stress` algorithm
on that compound node — a setting, not a second engine.

## Consequences
- Determinism for free (not required, used for snapshot tests).
- 433 KB gz dependency, async API; acceptable for a build-time renderer.
- ELK partitioning throws at ~1,000 nodes → ADR-0006 fallback.
- Lateral (flank) links must be withheld from ELK, then placed by rule (ADR-0003).
