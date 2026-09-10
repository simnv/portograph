# ADR-0006: The tier contract survives at any size

Date: 2026-09-10 · Status: accepted · Decisions: Q8, Q20, Q26 as amended by codex

## Context
ELK partitioning expressed tiers correctly on the golden but threw (NPE / stack overflow) at
1,000 nodes in the scale test. Dropping partitioning above a threshold would silently drop tier
order; a crash at 1,000 proves no threshold is safe (codex F17).

## Decision
Attempt partitioning always, with `partitioning.activate=true`, inside a worker with a deadline
(10 s at ≤ 300 nodes, 20 s above). On exception **or deadline**, terminate the worker, run ELK
once per tier band without partitioning, stack the bands, record a warning. After either path,
validate that every group lies inside its tier band and no groups overlap (gate G8); a violation
after fallback is a hard failure. This ADR is authoritative over any threshold mentioned elsewhere. "Beautiful" is targeted to ~30 nodes (Störrle, Kobourov);
above that the tool warns and offers `collapsed:` groups; above 1,000 it refuses without `--force`.
"Workable" = layout under 30 s, renders, warnings not failures.

## Consequences
- Two code paths for tiering, both tested at 100 / 300 / 1,000 synthetic nodes, with fallback
  exercised by injected failure and by deadline — never by relying on a particular ELK crash.
- Work is bounded at parse: links ≤ 10 × N, ports ≤ 20 per node, degree ≤ 64 (warning beyond).
- No automatic diagram splitting in v1.
