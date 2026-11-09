# ADR-0006: The tier contract survives at any size

Date: 2026-09-10 · Status: accepted · Decisions: Q8, Q20, Q26 as amended by codex

Amended by ADR-0019 (2026-09-29): a group may expand into rank cells, so "every group lies inside its tier band" is checked on cells, one sub-tier band per cell.

## Context
ELK partitioning expressed tiers correctly on the golden but threw (NPE / stack overflow) at
1,000 nodes in the scale test. Dropping partitioning above a threshold would silently drop tier
order; a crash at 1,000 proves no threshold is safe (codex F17).

## Decision

> **Amended 2026-09-30 (ticket 141, Q111):** a deadline is not a fallback trigger. It ends the whole command (`COMMAND_DEADLINE`), so that the time an
> ELK run takes never picks between two layouts. Only an ELK exception runs the per-tier fallback below.

Attempt partitioning always, with `partitioning.activate=true`, inside a worker with a deadline
(10 s at ≤ 300 nodes, 20 s above). On exception, terminate the worker, run ELK
once per tier band without partitioning, stack the bands, record a warning. After either path,
validate that every group lies inside its tier band and no groups overlap (gate G8); a violation
after fallback is a hard failure. This ADR is authoritative over any threshold mentioned elsewhere. "Beautiful" is targeted to ~30 nodes (Störrle, Kobourov);
above that the tool warns and offers `collapsed:` groups; above 1,000 it refuses without `--force`.
"Workable" = layout under 30 s, renders, warnings not failures.

*Amendment (2026-09-30, Q109a, ticket 137):* the whole-command deadline is now 60 s (`COMMAND_DEADLINE_MS`), and "workable" moves to 60 s with it: layout under 60 s, renders, warnings not failures. The per-stage ELK deadlines above are unchanged.

*Amendment (2026-11-01):* the whole-command deadline is now 120 s (`COMMAND_DEADLINE_MS`, user decision, "for now"): the real NTP sheet reached 60 s and wrote nothing. "Workable" follows: layout under 120 s. The per-stage ELK deadlines and `MAX_RERUNS` (3) are unchanged.

*Amendment (2026-11-07, decision review D11):* the command limit is 120 s. The supported band ends at 100 nodes (policy, `docs/design/quality.md` "Size bands"). The parser's 1,000-node limit and `--force` are input limits, not a quality or workability claim; the "workable" wording above is history. The per-tier fallback runs on an ELK exception only; a deadline ends the command (amendment 2026-09-30). The warning `LARGE_DIAGRAM` still advises `collapsed:` groups, but the parser ignores `collapsed` with `COLLAPSED_UNSUPPORTED`: the advice needs the code change of audit ticket T-28, not text alone (D17, audit m-22).

## Consequences
- Two code paths for tiering, both tested at 100 / 300 / 1,000 synthetic nodes, with fallback
  exercised by injected failure — never by relying on a particular ELK crash.
- Work is bounded at parse: links ≤ 10 × N, ports ≤ 20 per node, degree ≤ 64 (warning beyond).
- No automatic diagram splitting in v1.
