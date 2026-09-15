# Ticket 00 fixtures

[m1-sip-edge.yaml](m1-sip-edge.yaml) transcribes
[the target JPEG](../docs/design/target-example.jpeg).
[m1-sip-edge.expected.json](m1-sip-edge.expected.json) is the hand-written
normalised model. The diagrams under `synthetic/` cover the rule counter-examples in
[quality.md](../docs/design/quality.md#test-design). Owning implementation tickets add their own
test-only parser diagnostics, API probes, gate models, remainder cases and scale generators;
those additions do not alter or reopen the approved golden.

The maintainer approved these fixture inputs and the expected normalised model
on 2026-09-10. They precede the implementation. On 2026-09-11 the maintainer
approved the render (ticket 18): [m1-sip-edge.layout.json](m1-sip-edge.layout.json)
is the exact layout snapshot (runtime block excluded), [m1-sip-edge.png](m1-sip-edge.png)
and [m1-sip-edge.svg](m1-sip-edge.svg) are the approved render, and
`Q = 0.9004061377064178` was the ticket 18 baseline. Ticket 22 (2026-09-11) re-rendered the golden with 20 px group padding and an 8 px link-free margin around group titles; ticket 23 (2026-09-12) then moved each title to the edge opposite its links (Backbone's to the bottom), and ticket 24 put linked groups on one grid (providers, Datacenter and Backbone share an x-extent; the TBR flanks share the Datacenter's y-extent); the committed snapshot is that render and `Q = 0.8984321241441757` is the baseline, pending the maintainer's visual approval. Ticket 32 (2026-09-13) repainted the SVG and PNG with the designed default theme (`ref/theme-handoff/`): the geometry, the snapshot and Q did not change. `test/pipeline/golden-snapshot.test.ts` guards them. The PNG is a 2× Chrome capture of the SVG inside a `color-scheme: light` page, so the dark sheet behind `prefers-color-scheme` never reaches it. Ticket 28 (2026-09-13) refit the canvas to the drawn union plus a uniform 12 px margin (viewBox `-1 -0.5 827.54 934.5`): the legend had sat on the bottom edge and the left margin was 11 px; every node, path, label and Q are unchanged, only `canvas` moved in the snapshot — pending the maintainer's visual approval. Ticket 34 (2026-09-14) set the node body and icon glyph stroke to 1.5 px and the radii to node 4, group 4, pill 2: node obstacle reach shrank by 0.25 px, so most nodes moved by fractions of a pixel; `Q = 0.8986107135065587` is the baseline; the maintainer approved the render on 2026-09-14 ("34 ok").

## Target transcription

The golden has six groups, 12 nodes, 52 named ports, and 26 links. Every port is
named `100G`, and every port has exactly one link. Tiers are explicit.

| Node pair | Links | Class |
|---|---:|---|
| provider-1 → EAC-01 | 1 | omitted |
| provider-2 → EAC-02 | 1 | omitted |
| EBR-01 → EBR-02 | 2 | omitted |
| TBR-001 → EAC-01 | 4 | dotted |
| TBR-001 → EBR-01 | 4 | dotted |
| TBR-002 → EAC-02 | 4 | dashed |
| TBR-002 → EBR-02 | 4 | dashed |
| EBR-01 → EBB-01 / EBB-02 | 1 each | omitted |
| EBR-02 → EBB-01 / EBB-02 | 1 each | omitted |
| RR-01 → EBB-01 | 1 | omitted |
| RR-02 → EBB-02 | 1 | omitted |

The JPEG has no arrows. Source direction here follows top-to-bottom feeds or
flank-to-tier links. Node declaration order records the visible datacenter row
and the bar stack. The engine may reorder ports; no author `order:` is imposed.
All port sides are inferred. For links to the flank's `of` group, a left flank's
ports face right and a right flank's ports face left during sides phase one.
The normalised model therefore contains no `side` fields.

The provider and RR identifiers are assigned for reference; their labels are
empty because the JPEG does not label those nodes. `Datacenter` and `Backbone`
are group labels required by the design, although the JPEG does not show them.
Node classes use the network profile vocabulary. The left TBR links are dotted;
the right TBR links are dashed. The profile theme supplies their styling.
The JPEG's `100G` text belongs to port pills, so the golden has no link labels.

## Differences from the prototype

The checked-in `prototype/out/out-tall5-av.json` uses a different topology.
`prototype/build.mjs` reads the neighbouring `d3-fd/demo/public/diagram.yaml`;
that file is not included in this repository. It was checked during ticket 00.

| Property | Target JPEG and this golden | Prototype |
|---|---|---|
| Nodes / links | 12 / 26 | 13 / 32 |
| Providers | Two, feeding the EAC pair | Three, also feeding EBR-01 |
| TBR-001 peers | Four links each to EAC-01 and EBR-01 | Eight to EAC-01 |
| TBR-002 classes | All eight dashed | Four solid to EAC-02; four dashed to EBR-02 |
| EBR → RR | None | Two per EBR/RR pair |
| RR → RR | None | One |
| Each bar's feeds | Both EBRs and one RR | EBR-01 and both RRs |
| Unused ports | None | One each on EBR-02 and EAC-02 |

The maintainer confirmed the target JPEG as the golden's source on 2026-09-10.
The fixtures already follow it. The prototype's measured baseline still applies
only to the prototype input. The M1 preflight corrected these later acceptance statements before
implementation:

- Ticket 02 now uses a separate legacy migration input because its model cannot equal this one.
- Ticket 04 now uses this golden's four four-link
  node pairs and one two-link node pair, all eligible for bundle membership.
- Ticket 09 now uses 16 flank links and four EBR-to-bar transit links; no EBR-to-RR links exist.
- Ticket 12 defers exact label positions, and tickets 17–18 measure and approve a new score
  baseline on this input.
- Link-label coverage comes from ticket-owned synthetic inputs; adding labels to the golden would
  add text absent from the JPEG.

## Normalised model contract

The expected JSON records document normalisation before placement and technique
resolution. It is authored independently of the parser and the prototype output.

- Group and node map keys are their identifiers. Group `shape` defaults to `row`;
  labels default to the identifier unless explicitly empty.
- Flanks retain `align` and `of`. Their tier comes from the referenced tier group;
  they do not receive an author `tier` alongside `align`.
- Port arrays remain in declaration order. `ordinal` counts occurrences of that
  name within the node, starting at 1. Only author-fixed sides appear here.
- Link arrays retain YAML order. Each endpoint is an explicit
  `{node, name, ordinal}` triple. No wildcard or free-name lookup remains.
- Absent optional class, route, title, CSS, and geometry fields stay absent.
  Families, bundle membership, inferred sides, anchors, and runtime data belong
  to later stages. The named classes here are intended to remain routed.

Ticket 02 can compare this normalised document directly. If ticket 03 wraps it
in a larger `LayoutModel`, compare this document projection without regenerating
the expected JSON from implementation output.

## Synthetic inputs

Each diagram starts with a one-line `Expected` comment. Every file in the table
is a standalone schema-v2 document. `stage-inputs.yaml` is separate test data.

| Diagram | Stage | Expected behaviour |
|---|---|---|
| [flank-two-peers](synthetic/flank-two-peers.yaml) | 7b | Select the two-link primary peer; route the other peer's link. |
| [unequal-pitch](synthetic/unequal-pitch.yaml) | 3, 7b | Respace both sides to the larger measured pitch before alignment. |
| [shared-peer-port](synthetic/shared-peer-port.yaml) | 7b, 7e, 8 | Retain one shared peer anchor and stem; route incompatible pairs. |
| [stacked-at-one-x](synthetic/stacked-at-one-x.yaml) | 6 | Flatten and repack the row before pinning its link. |
| [parent-two-children](synthetic/parent-two-children.yaml) | 7c | Keep the parent anchor fixed; one child link is vertical and the other fans. |
| [three-bars](synthetic/three-bars.yaml) | 7d | Preserve stack order, merge spans transitively, and count bar crossings. |
| [bar-both-sides](synthetic/bar-both-sides.yaml) | 7d | Mirror bottom-fed drops and count crossings of intervening bars. |
| [one-px-sources](synthetic/one-px-sources.yaml) | 7d | Keep the first slot; jog the second to the next pitch-safe slot and warn. |
| [author-ordered-bundle](synthetic/author-ordered-bundle.yaml) | 7e | Preserve the reversed permutation with exactly three inversions and crossings. |
| [both-margins-full](synthetic/both-margins-full.yaml) | 7a | Widen the canvas for transit lanes when both margins have zero capacity. |
| [label-no-gap](synthetic/label-no-gap.yaml) | 7f | Widen the group, push its neighbour, and re-centre the affected child. |
| [port-roles](synthetic/port-roles.yaml) | 9, 11 | Paint pills by role and status; list every role as a pill swatch in the legend; move nothing. |
| [transit-fan](synthetic/transit-fan.yaml) | 7a, 7e, 8 | One port feeds three children through a transit tier: lanes in the children's order, one shared stem tree, gates pass. |
| [bar-fan](synthetic/bar-fan.yaml) | 7d, 7e | A bar drop and two remainders from one port: the drop is split under the tree's junction ids and joins as the straight leaf. |
| [unfittable-link-label](synthetic/unfittable-link-label.yaml) | 9 | Keep the full tooltip and report one omitted visible label (with its stage precondition; the whole pipeline reserves run and band room and places the full label on the longest run, ADR-0014). |
| [fitting-link-label](synthetic/fitting-link-label.yaml) | 9 | Place the measured label along the longest segment — rotated to read bottom-to-top on a vertical run — with no collision. |
| [long-label-portless-node](synthetic/long-label-portless-node.yaml) | 3 | Grow the node to contain its measured label and description. |
| [zero-link-diagram](synthetic/zero-link-diagram.yaml) | 10 | Produce finite scores and use 1 for empty routed-link metrics. |
| [widened-child-packs-tier](synthetic/widened-child-packs-tier.yaml) | 7c, 8 | A widened child covers the group beside it; the tier is packed again, so no group obstacle contains an attachment shape. |
| [drawio-constructs](synthetic/drawio-constructs.yaml) | 11 | Carry every construct the draw.io export must translate that the golden does not exercise together: a title band on each edge, a port role and status on one pill, a dotted and a dashed class, a labelled link, and an overlay link. |
| [drawio-direct-lines](synthetic/drawio-direct-lines.yaml) | 11 | Direct lines, of both kinds. A direct line is a link whose model path is one segment. Two routed ones run down and one runs across with a label; each is a square connector with no waypoint of its own. The overlay joins two pills that share neither axis; the draw.io export gives it the shortest orthogonal detour round both pill boxes. |
| [drawio-node-text](synthetic/drawio-node-text.yaml) | 11 | Carry a node's text in each shape the draw.io export must place: a name alone, a name with a description, and a description with no name. |
| [drawio-overlay-sides](synthetic/drawio-overlay-sides.yaml) | 11 | An overlay link whose two pills face different ways, which the draw.io export routes round both pill boxes with one turn instead of the three-segment detour two pills on one side take. |
| [detoured-stem-checkpoint](synthetic/detoured-stem-checkpoint.yaml) | 8 | Two crossing links in two ownership batches: the second detours round the first and still visits both reserved stem checkpoints. The diagram fails G6; it is produced. |

The first 14 diagrams are ticket 00's approved counter-examples. `fitting-link-label` is the
test-only successful-label input ticket 14 added beside them; it needs no stage precondition,
because the whole pipeline runs on it.

The spare node in `parent-two-children` makes the parent tier the anchor tier by
the lowest-index tie rule. Explicit shared-port references exercise the network
profile warning without depending on free-name allocation.

## Stage preconditions

Schema v2 has no coordinates, margin capacities, fixed paths, or measured-label
bounds. YAML topology alone cannot force ELK to stack nodes at one x or leave a
specific 1 px gap. [stage-inputs.yaml](synthetic/stage-inputs.yaml) supplies the
six geometric preconditions that later unit tests must install at stage entry.

This file is test data, not an extension of the public YAML schema or a proposed
`LayoutModel` format. Each key names its sibling diagram. A later test adapter
normalises that diagram, prepares the stage's usual inputs, then installs the
listed boxes, anchors, measured values, paths, and obstacles before running the
named stage. Link numbers are 1-based positions in the diagram's `links` array.
Coordinates are absolute px at scale 1. Recompute derived containment boxes and
tier bands after overrides where they are not supplied. Do not run the solver
again after installing these preconditions.

The supplied measurements isolate rule arithmetic from the future font table.
The bar fixture supplies spans that overlap transitively but not all pairwise.
The 1 px fixture uses sources above and below the bar so the source nodes do not
overlap. The label omission fixture supplies occupied candidate areas to reach
the last repair branch; its stage result is an omission assertion, not an
approved whole-diagram layout snapshot.

No synthetic geometry setup is a prediction of ELK output. End-to-end tests can
also consume the diagram YAML, but must not claim to cover a forced stage case
unless its entry preconditions hold.

The command line loads `dist/`, so `npm run build` must run before `node bin/portograph.mjs render`
is used to check a golden. A source change alone does not reach the CLI.
