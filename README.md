# portograph

**YAML in → a diagram an engineer would have drawn, out.**

Nodes with ports on their edges, grouped into tiers; links that attach to ports and are routed
per region — straight where they can be, orthogonal where they must be, bundled, dropped onto bars,
or drawn as an overlay when they are flows rather than cables. Network diagrams first; software
architecture and electrical panels next.

Pronounced **POR-to-graf** · Портограф.

## Status

**M1 implementation is in progress.** The YAML-to-SVG pipeline and CLI are implemented; final golden visual approval is pending. Follow the [implementation map](.scratch/m1-example-diagram/map.md) for ticket status.
The repository also holds the design record, reference corpus, and prototype results below.
These measurements use the prototype topology; the JPEG golden has different wiring:

| tall2 (solver + router) | **tall5 (solver + router + nine region rules)** |
|---|---|
| 11 crossings, 60 bends | **0 crossings, 0 overlaps, 4 bends** |

Renders: [`prototype/out/out-tall2-av.png`](prototype/out/out-tall2-av.png) →
[`prototype/out/out-tall5-av.png`](prototype/out/out-tall5-av.png). Target:
[`docs/design/target-example.jpeg`](docs/design/target-example.jpeg).

## Use

Needs Node 22 or newer. Install from a tarball (`npm pack`) or from the git repository; a git
install builds the package on `npm install` (the `prepare` script).

```sh
npm install ./portograph-0.1.0.tgz
npx portograph render diagram.yaml --output diagram.svg      # also writes diagram.layout.json and diagram.score.json
npx portograph render diagram.yaml --format drawio --output diagram.drawio
npx portograph score diagram.layout.json
cat diagram.yaml | npx portograph layout - > diagram.layout.json    # - reads stdin; stdout is the default output
npx portograph layout diagram.yaml --diagnostics json 2> diagnostics.jsonl
```

A diagnostic names the file, line and column of the YAML it is about, for example
`portograph: error: UNKNOWN_KEY at diagram.yaml:7:5 ($.nodes.a.colour): Unknown key colour`.
`--diagnostics json` writes the same as one JSON object per line. The layout and score JSON hold no
timings, so two runs on one input write the same bytes; `--timings` adds them. Run
`npx portograph --help` for every option.

As a library (ESM or CommonJS), the package root exports `parse`, `parseWithDiagnostics`, `layout`,
`score`, `render`, `drawio`, `migrate`, `restoreFinalLayout`, `serializeLayoutModel`, the error
classes and the types. `portograph/node` supplies the worker factories for Node. The stage
functions and tables are in `portograph/internal`, which has no stability promise.

```js
import { parseWithDiagnostics, layout, score, render } from 'portograph';
import { createNodeElkFactory, createNodeRouteFactory } from 'portograph/node';

const parsed = parseWithDiagnostics(yaml);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const model = await layout(parsed.document, {
  diagnostics: parsed.diagnostics,
  createElkAttempt: createNodeElkFactory(),
  createRouteAttempt: createNodeRouteFactory(),
});
const report = score(model);
const svg = render(model);
```

### Font: Verdana is required

Every sheet is set in Verdana (weights 400 and 700), in the SVG and in the draw.io export, and all
text is measured from Verdana's glyph advances (`src/text/font-metrics.ts`, numbers only, no font
files). There is no fallback font, because a fallback has other widths and a label could leave its
box. Install Verdana on every machine that views or converts a sheet: it ships with macOS and
Windows; on Linux install it from the `ttf-mscorefonts-installer` package or copy the font files
into `~/.local/share/fonts`. `portograph render` and `portograph layout` write a `FONT_MISSING`
warning to stderr when they find no Verdana in the usual font directories. The check is the CLI's
alone: the library does not read the machine's fonts, so its output depends on the document only.
`uv run scripts/font-metrics.py` regenerates the table from the macOS font files.

## Read in this order

1. [`CONTEXT.md`](CONTEXT.md) — the vocabulary and invariants. Everything else uses these words.
2. [`docs/design/decisions-log.md`](docs/design/decisions-log.md) — every design question, its
   answer, and what evidence amended it.
3. [`docs/design/pipeline.md`](docs/design/pipeline.md) — the stages, in order, with the region
   rules defined precisely.
4. [`docs/design/schema.md`](docs/design/schema.md) — the YAML format.
5. [`docs/design/quality.md`](docs/design/quality.md) — gates, score, thresholds.
6. [`docs/adr/`](docs/adr/) — the architecture decisions, one per file. Read ADR-0019 for the ranked-group
   model (ranks, rank cells, frames).
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
a PNG read of each render (`npm run png`) before merge; correctness and metric regressions block.

## Toolchain

TypeScript · elkjs 0.12 (layered; tiers by partitioning with per-band fallback) · libavoid-js for
links the region rules do not claim · Vite lib build + `vite-plugin-dts` · Vitest · zero DOM in the
core. Supported Node versions: 22 or newer.

Run `npm ci`, then `npm run build`, `npm test`, `npm run typecheck`, and `npm run lint`.
The staged JSON model, font measurements and port geometry helpers are in `portograph/internal`.
See [text measurement](docs/design/text-measurement.md) for font and pill conventions.

```sh
node bin/portograph.mjs render goldens/m1-sip-edge.yaml --output diagram.svg
node bin/portograph.mjs layout goldens/m1-sip-edge.yaml --output diagram.layout.json
node bin/portograph.mjs score diagram.layout.json
node bin/portograph.mjs render diagram.layout.json --layers routed
node bin/portograph.mjs migrate test/fixtures/migration/legacy.yaml
```

`render --output diagram.svg` writes the SVG, `diagram.layout.json` and `diagram.score.json`
from the same final model. Without `--output`, stdout contains only the requested artifact;
diagnostics go to stderr. `render` accepts YAML or validated final layout JSON, regardless of file
extension. `score` accepts final layout JSON. Options may precede or follow the one required file.

Exit codes are 0 for success, 1 for a computed gate failure, 2 for input or output-file errors,
and 3 for processing failure or the 60-second command deadline. A computed gate failure still
writes the complete artifact set; `--allow-gate-failures` changes only its exit code. Link, port
and degree limits warn and continue; more than 1,000 nodes requires `--force`.
Set `PORTOGRAPH_PROGRESS=1` to see stage timings and worker startup on stderr.

The CLI enforces its deadline in a separate process, including synchronous placement and scoring;
library calls remain portable and use the supplied worker factories and optional shared budget.
The generated degree-64 hub / wide-tier / long-transit benchmark reached the old 30-second (now 60-second)
deadline at 100, 300 and 1,000 nodes. Those cases contain 389, 1,167 and 3,890 links. The simple 50-link aligned case passes every gate with zero crossings;
the high-fan scale cases remain a performance limit. Run `node scripts/scale-bench.mjs` to reproduce.
