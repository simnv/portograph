# ADR-0002: Links attach to ports, never to nodes

Date: 2026-09-10 · Status: accepted · Decisions: Q5, Q16

## Context
The one idea the author was certain of from the start. drawthe.net (`device:label` endpoints),
Network Sketcher (`(Area, Device, Port)` identity) and d3-fd (interface nodes) all converge on it.

## Decision
Every link end is a port. A link written to a bare node gets an anonymous, unrendered port. Ports
have a side, assigned by the engine in two phases (tier-derived, then intra-tier after the
skeleton), overridable by the author. Many links may share a port; the network profile warns when
they do. Ports on a side are ordered by far-end position.

## Consequences
- Node size derives from ports (`CONTEXT.md` invariant 3), never the reverse.
- A shared port's exit stems are one stem then a fan — exempt from the overlap gate (codex F13).
- Port pitch must account for measured pill geometry after rotation, not a fixed 12 px (codex F14).
- `*` in YAML means "next free port"; d3-fd's silent consume-by-declaration-order is retired.

## Note (2026-10-23): the dot
An anonymous port still has no geometry and no pill. `render.anonymousPortMarker: dot` (the default) paints a dot at the link end on the node border, in the link stroke. It is paint only: the layout and the score do not change, and `none` restores the bare end.

## Amendment r1 (2026-11-08): link order is never input
Decision review D-Q1 (revised after the roworder PoC), ticket DR-04, R3. An anonymous port's ordinal,
a generated link id and the order ELK reads the edges in no longer follow the position of a link in
`links`. The parser lists the links in one canonical order: the smaller declared rank of the two ends,
then the larger (a node by the declaration order of its group, then by its own declaration order inside the group; group ends after
every node, in declaration order; the direction of a link is no key), the rank of a numbered port in its node's
list, then the content of the link (`src/parse/link-order.ts`). It resolves `*`, an unnumbered port name
and a bare end in that order, so `*` is the next free port in the canonical order, and an anonymous
port's ordinal is its occurrence in that order. A generated link id `link-<n>` is the place of the link
in that order, and `link-<n>-<k>` the k-th member of an expanded group end. Node and group declaration
order stay author input. A sheet that
needs a set port per link names the port with `#n`.
