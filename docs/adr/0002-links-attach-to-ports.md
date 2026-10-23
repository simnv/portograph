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
