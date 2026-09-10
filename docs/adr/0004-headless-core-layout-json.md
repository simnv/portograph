# ADR-0004: Headless core; layout JSON is a first-class output

Date: 2026-09-10 · Status: accepted · Decisions: Q3, Q13, Q14

## Decision
The core is TypeScript with zero DOM or framework dependency: `parse → layout → render`. The
layout JSON (`LayoutModel`) is emitted alongside SVG and is what `score` and tests consume. CLI
verbs: `layout`, `render`, `score`, `migrate`. A viewer, if built, is a separate package
consuming the same JSON; React is not a v1 question. Text measurement in the core uses a
font-metrics table (not `getBBox`), so Node and browser agree.

## Consequences
- Goldens are JSON snapshots; SVG diffs are secondary.
- Other renderers (PNG, draw.io, PowerPoint for Network Sketcher) can be added without touching
  layout.
- The dev preview page (YAML editor + live SVG) is the only UI in M1/M2.
