# Contributing to portograph

This page tells you how to build portograph, how to test a change, and what a pull request must
contain.

## Build

You need Node.js 22 or newer.

```sh
npm ci
npm run build
```

`npm run build` writes `dist/`. The CLI in `bin/portograph.mjs` reads `dist/`, so build again
after you change `src/`.

```sh
node bin/portograph.mjs render docs/assets/example.yaml --output /tmp/example.svg
```

## Test

Run the tests through the runner only:

```sh
npm test
npm test -- test/pipeline/turn-order.test.ts
```

Do not run `vitest run` directly. The runner holds a lock, so only one heavy job runs on a
machine, and it stops all the vitest processes when it ends. `npm run lint` fails on a raw
`vitest run` in `scripts/` or `package.json`.

Also run:

```sh
npm run typecheck
npm run lint
```

## Before a pull request: `gate:branch`

Run this command from your branch:

```sh
npm run gate:branch
```

It merges `main` into the branch, then runs the typecheck, the lint and the tests. It lays out
every sheet in `goldens/` and `test/fixtures/sweep/` on `main` and on your branch, and compares
the two. It ends with `GATE PASS` or `GATE FAIL: <reasons>`. A sheet that becomes worse, for
example with more bends or more crossings, fails the gate. For a change to documents only, add
`--skip-tests`.

[`docs/gates.md`](docs/gates.md) tells you how to run each part: `npm test`, `corpus`, `sweep`,
`gate:compare` and `r3`.

## Read in this order

1. [`CONTEXT.md`](CONTEXT.md) gives the vocabulary and the invariants. Use its terms exactly.
   [`GLOSSARY.md`](GLOSSARY.md) gives short definitions.
2. [`CODING_STANDARDS.md`](CODING_STANDARDS.md) gives the rules R1 to R10 from past reviews. A
   review cites them by id.
3. [`docs/adr/`](docs/adr/) has one decision per file. Read the ADR for the part that you change.
4. [`docs/design/`](docs/design/) has the design. Start with
   [`pipeline.md`](docs/design/pipeline.md) for the stages,
   [`schema.md`](docs/design/schema.md) for the YAML format and
   [`quality.md`](docs/design/quality.md) for the gates, the score and the checklist for a render.

The pipeline has one rule: placement reserves every route, size and spacing that it can. The
router must not find one later.

## A rule change adds a fixture

A change to a layout or routing rule adds a sheet to `goldens/synthetic/`. An inline test is not
sufficient. The name of the file is a sentence that states the rule, for example
`a-canton-holds-two-members-on-one-tier.yaml`. The first comment line starts with `# Expected:`
and tells what a correct drawing shows. `gate:branch` then measures the new sheet on every later
change.

## Look at the render

The score does not see everything. Convert each render to PNG and look at it:

```sh
npm run png -- /tmp/example.svg
```

Compare the PNG with the checklist in [`docs/design/quality.md`](docs/design/quality.md). Add
the PNG to the pull request when the drawing changes.

## Git hooks

The hooks are optional. To use them, run:

```sh
npm run hooks:install
```

The pre-commit hook runs the typecheck and the lint when you commit code files. It also checks
the added lines against your own list of terms that must not go into the repository. The hook
reads the list from `$PORTOGRAPH_DENYLIST`, or from `~/.config/portograph/denylist`. Without a
list, it skips that check.

## Fixtures and personal data

Do not put real host names, IP addresses, site names or other personal data in a fixture, a test
or a document. Use the documentation ranges, for example `192.0.2.0/24`, `198.51.100.0/24`,
`203.0.113.0/24` and `2001:db8::/32`, and names such as `core-1` or `site-a`.

## Font metrics

`src/text/font-metrics.ts` holds the Verdana glyph widths as numbers only. It has no font files.
To make the table again from the macOS fonts, run `uv run scripts/font-metrics.py`.

## Release

To release, bump `version` in `package.json` in a pull request or in a commit on `main`. The merge
publishes: `.github/workflows/release.yml` runs the checks, publishes to npm with trusted
publishing (no token), tags `v<version>` and creates a GitHub release. A push that does not change
the version publishes nothing. The npm trusted publisher names this repository and `release.yml`;
keep the file name. It must allow direct `npm publish`: a new publisher allows only staged publish
by default. See [`docs/gates.md`](docs/gates.md).

## License

When you contribute, you agree that your contribution is licensed under Apache-2.0, the license
of this project.
