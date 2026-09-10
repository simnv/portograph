# ADR-0005: Generic core vocabulary; domain profiles on top

Date: 2026-09-10 · Status: accepted · Decisions: Q4, Q15, Q27, Q28

## Decision
The core speaks node / port / link / group / tier / flank. A **profile** (TypeScript module plus
optional YAML overlay) supplies: vocabulary aliases (`device`, `interface`, `location`…), a
tier-inference table by node class, conventions (direction; which link classes are `routed` vs
`overlay`), a theme, an icon set, and validators. Ships: `network` (M1), `architecture`,
`electrical` (later). Explicit `tier:` always beats inference; inference is logged.

## Consequences
- `CONTEXT.md` is the glossary the conventions require; profiles map onto it, never replace it.
- Generality is proven by the second profile, not assumed.
