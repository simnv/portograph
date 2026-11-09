You are reviewing the design record of `portograph` — a TypeScript library/CLI that turns YAML (nodes with ports, links, groups in tiers) into a laid-out SVG diagram. Implementation has not started. Your job is ADVERSARIAL: find what will break, contradict itself, or cannot be built as written. No praise, no summaries of what the docs say.

Read, in this order: AGENTS.md, CONTEXT.md, the decisions log, docs/design/pipeline.md, docs/design/schema.md, docs/design/quality.md, docs/adr/*.md, the M1 spec and every M1 ticket. Consult docs/research/codex-routing-review.md (your predecessor's findings) to check they were actually folded in, and prototype/regions.mjs to see what the rules really do vs what pipeline.md claims.

Attack along these axes, citing file:line for every finding:
1. INTERNAL CONTRADICTIONS between documents — numbers, rule order, stage names, defaults, terms (e.g. CONTEXT.md vs pipeline.md vs quality.md vs schema.md vs tickets).
2. UNBUILDABLE OR UNDERSPECIFIED RULES in pipeline.md stage 5 and stage 7 — inputs not available at that stage, circular dependencies between passes, undefined tie-breaks, rules that only worked on the one golden (compare against prototype/regions.mjs to see hand-coded assumptions that were generalised on paper only).
3. SCHEMA holes: ambiguous endpoint forms, `*` allocation order vs bundles, anonymous ports vs rendering, flank `of:` vs tier, `shape: bar` on groups with ports on both sides, validation rules that cannot be checked at parse time.
4. QUALITY gates that are unattainable, unmeasurable from layout JSON, or in conflict with a pipeline rule (e.g. G4 vs shared stems, G3 vs port pills at 12 px pitch, G6 vs bundle spacing).
5. TICKET GRAPH: cycles, missing dependencies, tickets whose acceptance references things no earlier ticket produces, acceptance criteria that are not testable, scope in spec.md not covered by any ticket.
6. PREDECESSOR FINDINGS from codex-routing-review.md that are claimed folded in but are not actually addressed anywhere.
7. SCALE: what in the pipeline is O(n²) or worse and will not meet "1,000 nodes under 30 s".
8. Anything the design silently assumes about elkjs or libavoid-js APIs that should be verified before ticket 01 (name the API).

Output: a single ranked table — Severity (breaks build / wrong output / spec gap / nit) | Finding (one line, with file:line) | Minimal fix — then a short list of the 5 things to fix BEFORE ticket 01 starts. Terse. Max ~60 findings.
