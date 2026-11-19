# Changelog

All notable changes to portograph are in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[Semantic Versioning](https://semver.org/).

The draw.io binding contract ([`docs/drawio-binding-contract.md`](docs/drawio-binding-contract.md))
has its own schema version in `pg-schema`. An entry says so when a contract rule changes. A new
optional attribute does not change the schema version. It is still 1.

A version bump in `package.json` must add its section here, in the same commit. The release
workflow uses the section as the text of the GitHub release, and it stops a bump that has none.

## [Unreleased]

### Added

- `layout.moveBeforeGrow` has three modes. `true` is strict, `false` is off, and a sheet that writes nothing takes the default, which stays off for now. Once the default is on, a sheet that writes nothing and whose option-on run fails for a placement reason is laid out again with the option off; that layout carries the warning `MOVE_BEFORE_GROW_FALLBACK`, which names the first failure, and the record `moveBeforeGrowRun` (requested and effective mode). The corpus gate has a `fallback` column.
- The default-on mode of `layout.moveBeforeGrow` chooses the growth on the whole sheet (ADR-0027 amendment, dense-16x9 ticket 60). When the option-on run completed and left a seat short, the command lays the sheet out once more with the option off and keeps that run only when it is better by the unified order (fewer bent links, then turns, then crossings) draws every link that the option-on run draws, and adds no error-gate finding (counted with multiplicity); a tie keeps the option-on run. A trial that throws, or ends with the budget spent, keeps the option-on run with the note `MOVE_BEFORE_GROW_TRIAL_SKIPPED` (info for a spent budget or a refusal, warning for anything else). The routed-trial rounds now count a gate finding that repeats on the same elements once per violation. A kept option-off run carries the record `moveBeforeGrowRun.choice` (both tallies) and the info note `MOVE_BEFORE_GROW_CHOICE`. The corpus gate has a `choice` column, and the sweep writes `choice=off`; neither is judged as worse.

## [0.2.2] - 2026-11-13

### Added

- `LayoutOptions.checkCaches` now accepts `'all'` and `'sampled'` in addition to `true`, and `createWarmRouteFactory` reuses a warm libavoid worker across sequential routing sessions.

### Changed

- Faster layout on large and multi-round diagrams, with identical output across the golden corpus: indexed gap-plan graph traversal and value memoization, registered `linkById` and `linkByEnds` caches, per-reading parent-stand feed memoization, structural sharing of unchanged frozen documents in `protect()`, skipped redundant `centre-flag` reads during stage 7f, and a stage 7e course preflight that refuses course trials whose corridor demotes a kept straight chord into an unroutable stem gap before running stage 7f.

## [0.2.1] - 2026-11-12

### Added

- The draw.io export warns `DRAWIO_BUS_MEMBER_DROPPED` when a member link of a mesh bus has a `meta:`. A member of a mesh bus has no link cell, so its `meta:` was dropped without a message. The warning comes once for each export and lists the ids of the links. Put the binding meta on the member ports.

### Changed

- Contract (schema version 1): the rule for a mesh bus member now says that its `class:` forms the bus and is not written, and that its `meta:` is dropped and reported.

## [0.2.0] - 2026-11-11

### Added

- The draw.io export writes the attribute `pg-class` on the cell of a node, a port and a link, when the YAML gives the thing a `class:`. The value is the tokens of the author, in the written order, with one space between them. A reader selects the cells by one token. A token that starts with `pg-` is not written, and the export adds no token of its own. The attribute is optional, so the schema version stays 1. See section 3.2 of the contract.
- Contract section 3.3 describes a link that is split into runs: every run carries the full binding, only `pg-run` and the cell id differ, and one run carries the label. The new example [`docs/assets/split-link.drawio`](https://github.com/simnv/portograph/blob/v0.2.0/docs/assets/split-link.drawio) shows it.
- Contract section 4.1 says where to write the identity of a counter: the value for the full sheet in the root `meta:`, the host on the node, the interface on the port. A link needs a copy only when its ends do not give the identity.

### Changed

- Contract (schema version 1): `pg-from` and `pg-to` are the ends of a link at export time. They do not follow a reconnect in draw.io, which changes only the `source` and the `target` of the cell. A reader that must follow such an edit compares the attributes with `source` and `target`.

## [0.1.0] - 2026-11-10

First release.

### Added

- The command `portograph` with the verbs `render`, `layout`, `score` and `migrate`. It reads YAML (or the layout JSON) and writes SVG or draw.io, the layout JSON and the score JSON. The exit codes are 0 (done), 1 (a hard gate failed), 2 (an input error) and 3 (a processing failure).
- The library, as ESM and CommonJS with types: `parse`, `parseWithDiagnostics`, `layout`, `score`, `render`, `drawio`, `migrate`, the layout JSON functions, and `portograph/node` for the solver workers in Node.js.
- The YAML format version 2: nodes with ports on their sides, groups on tiers, and links that attach to ports and are routed per region. `portograph migrate` converts the older d3-fd format.
- The draw.io export (`--format drawio`) with the binding contract, schema version 1: the `pg-*` attributes on the cells, stable ids, and the `meta:` of the author as attributes. Themes (light, dark, print) and the Cisco glyphs of draw.io are options.
- Diagnostics with the file, line and column of the YAML, as text or as JSON lines.

[Unreleased]: https://github.com/simnv/portograph/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/simnv/portograph/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/simnv/portograph/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/simnv/portograph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/simnv/portograph/releases/tag/v0.1.0
