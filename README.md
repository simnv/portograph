# portograph

**YAML in → a diagram an engineer would have drawn, out.**

Nodes with ports on their edges, grouped into tiers; links that attach to ports and are routed
per region — straight where they can be, orthogonal where they must be, bundled, dropped onto bars,
or drawn as an overlay when they are flows rather than cables. Network diagrams first; software
architecture and electrical panels next.

Pronounced **POR-to-graf** · Портограф.

## Status

**Design complete, implementation not started.** This repository currently holds the design
record, the reference corpus it was built from, and the prototype that proved the approach on the
first golden diagram:

| tall2 (solver + router) | **tall5 (solver + router + nine region rules)** |
|---|---|
| 11 crossings, 60 bends | **0 crossings, 0 overlaps, 4 bends** |

Renders: [`prototype/out/out-tall2-av.png`](prototype/out/out-tall2-av.png) →
[`prototype/out/out-tall5-av.png`](prototype/out/out-tall5-av.png). Target:
[`docs/design/target-example.jpeg`](docs/design/target-example.jpeg).

## Read in this order

1. [`CONTEXT.md`](CONTEXT.md) — the vocabulary and invariants. Everything else uses these words.
2. [`docs/design/decisions-log.md`](docs/design/decisions-log.md) — every design question, its
   answer, and what evidence amended it.
3. [`docs/design/pipeline.md`](docs/design/pipeline.md) — the stages, in order, with the region
   rules defined precisely.
4. [`docs/design/schema.md`](docs/design/schema.md) — the YAML format.
5. [`docs/design/quality.md`](docs/design/quality.md) — gates, score, thresholds.
6. [`docs/adr/`](docs/adr/) — the architecture decisions, one per file.
7. [`.scratch/m1-example-diagram/`](.scratch/m1-example-diagram/) — milestone 1 spec and tickets.

## Research behind it

- [`docs/research/layout-engines.md`](docs/research/layout-engines.md) — why elkjs, verified
  against current registries and docs.
- [`docs/research/aesthetics.md`](docs/research/aesthetics.md) — what is experimentally known
  about readable graph drawings, and the scorer derived from it.
- [`docs/research/codex-routing-review.md`](docs/research/codex-routing-review.md) — the
  adversarial review of the routing design: 29 findings, 17 that would break output, all folded in.
- [`docs/research/codex-design-review.md`](docs/research/codex-design-review.md) — the second
  adversarial review, of the whole record: 55 findings, all folded in (see the decisions log).
- [`docs/research/naming.md`](docs/research/naming.md) — twenty-nine names vetted against
  registries, GitHub, DNS and trademark sources; why `portograph`.
- [`docs/research/prototype-results.md`](docs/research/prototype-results.md) — sixteen ELK variants
  and five region-rule iterations, with metrics.
- [`ref/`](ref/README.md) — the reference corpus: five published sources on diagram layout, the
  Network Sketcher layout-rules extraction, and the analysis of the predecessor project (`d3-fd`).

## Working conventions

See [`AGENTS.md`](AGENTS.md): tickets live in `.scratch/<feature>/issues/`, decisions in
`docs/adr/`, vocabulary in `CONTEXT.md`. Every ticket is reviewed adversarially by codex (code) and
agy (renders) before merge; correctness and metric regressions block.

## Toolchain (decided, not yet scaffolded)

TypeScript · elkjs 0.12 (layered; tiers by partitioning with per-band fallback) · libavoid-js for
links the region rules do not claim · Vite lib build + `vite-plugin-dts` · Vitest · zero DOM in the
core. Node ≥ 18.
