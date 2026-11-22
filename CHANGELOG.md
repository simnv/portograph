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

- **`--fail-on-removed`** (`layout`, `render`, `score`): the command exits with 1 when the router removed a link, and still writes all its files. The warning of each removed link (`ROUTE_GAP_REJECTED`, `ROUTE_CHECKPOINT_SKIPPED`) now names the two ends of the link and its place in `links`. Without the flag, a removal still gives exit code 0.
- **`meta:` on a group** (a plain tier group, a flank, a canton, a canton member and a child group): same key rules as on a node. The draw.io export writes a group that has `meta:` as a bound cell with `pg-kind="group"` and `pg-id` (the group id) and the meta keys. A group with no `meta:` is unchanged. No layout change. The schema version of the binding contract stays 1 (a new kind and no changed rule).

### Changed

- **Breaking: Node.js 26 or newer is required (was 22).** `engines.node` is `>=26`. CI and the release run on Node 26. On an older Node, npm warns at install, and portograph is not tested there.

### Fixed

- A canton whose member holds a child group no longer fails with `Lane … crosses occupied group …`. A lane that a member holds is now reserved before a lane that the canton holds and that crosses the member.
- A link that the router ran through a rank cell of its own frame, where it does not end, is no longer always removed. Stage 8 routes it once more after the other links, with the rank cells as walls, and draws it when the route is usable.
- A layout no longer fails with `Removed link … stores an answer … that no router gives: it meets both ends of its gap, honours its checkpoints and is not orthogonal`. libavoid gives such an answer when it cannot reach a point after it passed every checkpoint. Stage 8 removes the link with the warning `ROUTE_GAP_REJECTED`, and restore now accepts that removal.

## [0.3.0] - 2026-11-19

### Changed

- **`layout.moveBeforeGrow` is now on by default. Most layouts change.** A sheet that does not write `layout.moveBeforeGrow` now runs with it on. To put a port over the port it links to, alignment first moves the node inside the free room of its row, and grows the node only by what no move gives, up to 5 times the width the node needs for itself. In 0.2.x the node grew in place, up to 12 times its width. To keep the 0.2.x behaviour, write `layout: { moveBeforeGrow: false }`. See [`docs/adr/0027-alignment-moves-a-node-before-it-grows-one.md`](https://github.com/simnv/portograph/blob/v0.3.0/docs/adr/0027-alignment-moves-a-node-before-it-grows-one.md).
- The option has three modes:
  - Not written (the default): on. When that run leaves an alignment short, the command also tries the option off and keeps the better run (the growth choice, below). When that run fails, it uses the option-off run (the fallback, below).
  - `true`: on and strict. A failure of the run is the error of the command, and there is no second run.
  - `false`: off, the 0.2.x rule. There is no second run.
- **The growth choice** (default mode only):
  - **When it runs:** the option-on run leaves an alignment short, either a row it could not seat, or a link that it could not align and that stays bent.
  - **What it does:** the command lays the sheet out once more with the option off. It keeps the option-off run only when that run is better on the whole sheet: fewer bent links, then fewer turns, then fewer crossings. The option-off run must also draw every link that the option-on run draws, and add no error-gate finding. A tie keeps the option-on run.
  - **When it keeps the option-off run:** the layout carries the info note `MOVE_BEFORE_GROW_CHOICE` with both tallies.
  - **When the second run throws, or the command budget runs out:** the option-on run stays, with the note `MOVE_BEFORE_GROW_TRIAL_SKIPPED`. The note is info for a spent budget or a placement refusal, and a warning for anything else.
- **The fallback** (default mode only):
  - **When it runs:** the option-on run fails for a placement reason and the command budget has time left.
  - **What it does:** the command lays the whole sheet out once more with the option off, on what is left of the budget.
  - **The result:** that layout carries the warning `MOVE_BEFORE_GROW_FALLBACK`, which names the first failure.
  - **What never falls back:** an input error, a deadline, a worker failure, or a bug. A failure of the second run is the error of the command.
- **The layout JSON:**
  - In the default mode, `document.layout.moveBeforeGrow` holds the mode the run had: `true`, or `false` after a kept growth choice or a fallback.
  - The record `moveBeforeGrowRun` gives the requested mode, the effective mode, the first failure of a fallback, and the tallies of a kept growth choice.
  - `restoreFinalLayout` refuses a record that does not agree with the document and the notes.
- **Time:** a sheet whose option-on run leaves an alignment short is laid out twice. On the project's test corpus, the default takes about 1.7 times as long as one option-on run. A sheet that writes `true` or `false` runs once.
- **Known defects of the new default** (measured on the project's test corpus against the option off: better on 37 sheets, worse on 20):
  - On some sheets the default keeps fewer bent links and pays for them with more crossings, more turns or a wider sheet, because the growth choice ranks bent links first.
  - The growth choice can miss a sheet where the option-on run has an extra bent link but no alignment that it left short.
  - With the option on, a face that holds a straight chord and a link leg can break the parallel clearance (gate G6).
  - With the option on, some port-order cases can keep a port-order finding (gate G5) or end the round unsettled.
  - With the option on, an end leg can run past the length its plan gives it.
  - With the option on, an overlay chord can lose its straight corridor when a row moves under it.
  - Accepted trades of the option-on run:
    - A port-order finding (G5) can be cleared at a cost of 2 to 4 more crossings and a sheet 4 to 8 percent wider.
    - A vertical link can make a tier gap taller or the sheet wider.
- Wide leaf rows, group lifts and grids aim at the aspect of the sheet (`layout.aspect`, below), not at a square.

### Added

- `layout.moveBeforeGrow` (boolean): see Changed.
- `layout.aspect`: a quoted string `"W:H"` (default `"16:9"`). It is the shape of sheet that a wide row on two lines, a group lift and a grid aim at, where they have a free choice. It is a soft aim, never a gate.
- **Flat solid blocks:** a solid block that is wider than its cap stays straight and becomes flatter, and its links stand as one sheaf. The gap of a flat block is chosen on the complete placement, toward the aspect aim. It is chosen once more on the finished sheet, and a `layout.maxWidth` that the run met still holds.
- **Placement:**
  - A child row stands under its parents' ports as one seated set.
  - Members with several links can stand on two lines.
  - The pitch of each pair of neighbour ports is reserved, and a face holds the sum.
  - Sibling frames face each other with their linked ends.
  - A u-turn course is planned in its tier gap.
  - A group with links to both the tier above and the tier below ranks its members between the two (two poles).
- **The far-end order round:**
  - It reads the order from the final positions.
  - When it declines a trial on the whole-sheet measure, it records the decision in the layout ledger (`farEndDecision`, with its reason). A later run and the restore read the decision and do not decide again.
  - The notes `FAR_END_ORDER_TAKEN`, `FAR_END_ORDER_DECLINED` and `FAR_END_ORDER_UNSETTLED` say what happened.

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

[Unreleased]: https://github.com/simnv/portograph/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/simnv/portograph/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/simnv/portograph/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/simnv/portograph/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/simnv/portograph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/simnv/portograph/releases/tag/v0.1.0
