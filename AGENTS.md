# AGENTS.md

`portograph` — YAML in, a laid-out diagram (SVG) out. Nodes with ports on their edges, grouped
into tiers; links attach to ports and are routed per region. Design complete, implementation
not started; see [`README.md`](README.md) for the reading order.

Before working here read [`CONTEXT.md`](CONTEXT.md) (vocabulary and invariants — use its terms
exactly) and the ADRs in [`docs/adr/`](docs/adr/). The reference corpus that informed the design
is under [`ref/`](ref/README.md); the prototype that proved it is under `prototype/`.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
