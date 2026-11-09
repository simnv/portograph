# AGENTS.md

`portograph`: YAML in, a laid-out SVG diagram out. Nodes carry ports on their edges, grouped into
tiers; links attach to ports and are routed per region. A CLI and a library exist; see
[`README.md`](README.md).

Never let a route, size or spacing be discovered during routing that could have been reserved
during placement. This is the pipeline's one load-bearing rule.

## Read on demand

- [`CONTEXT.md`](CONTEXT.md): always, first. Vocabulary and invariants; use its terms exactly.
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md): before you write code or review a diff. Rules R1 to R10 from review history; cite them by id.
- [`docs/design/pipeline.md`](docs/design/pipeline.md): when you change or reason about a stage.
  Read that stage's section only (`## Stage N`; stage 7 has subsections 7a to 7f).
- [`docs/adr/`](docs/adr/): when a rule or decision is in question. Pick by file name.
- [`docs/design/quality.md`](docs/design/quality.md): when you judge a render.
- [`docs/gates.md`](docs/gates.md): when you run tests or measure a change.

## Gates

`npm run gate:branch` is the one command before a merge request; `corpus`, `sweep` and `gate:compare` are its parts. Tests run only through `scripts/test-runner.mjs` (`npm test`); never call `vitest run` raw. How to run each one: [`docs/gates.md`](docs/gates.md).
