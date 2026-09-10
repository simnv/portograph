# ADR-0006: The tier contract survives at any size

Date: 2026-09-10 · Status: accepted · Decisions: Q8, Q20, Q26 as amended by codex

## Context
ELK partitioning expressed tiers correctly on the golden but threw (NPE / stack overflow) at
1,000 nodes in the scale test. Dropping partitioning above a threshold would silently drop tier
order; a crash at 1,000 proves no threshold is safe (codex F17).

## Decision
Attempt partitioning always. On any ELK failure, run ELK once per tier band without partitioning
and stack the bands; record a warning. "Beautiful" is targeted to ~30 nodes (Störrle, Kobourov);
above that the tool warns and offers `collapsed:` groups; above 1,000 it refuses without `--force`.
"Workable" = layout under 30 s, renders, warnings not failures.

## Consequences
- Two code paths for tiering, both tested at 100 / 300 / 1,000 synthetic nodes.
- No automatic diagram splitting in v1.
