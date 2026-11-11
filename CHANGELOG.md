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

[Unreleased]: https://github.com/simnv/portograph/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/simnv/portograph/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/simnv/portograph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/simnv/portograph/releases/tag/v0.1.0
