# YAML Schema (v2)

Revision 2 (2026-09-10) after the codex design review: identifier grammar, a structured endpoint
form, `order:` on ports, constraints on `of:`, aggregation eligibility, CSS limits, and a
migration that emits explicit ordinals.

Design goals: nodes keyed by id; links as two-element arrays; a node belongs to one group; tier
and alignment live on groups; every override is a single key with the same name as the concept in
`CONTEXT.md`; YAML anchors are the reuse mechanism — there is no `templates:` section.

```yaml
portograph: 2
profile: network
title: "SIP edge — Datacenter A"
css: |
  .pill.router { fill: #a9d6db; }             # colour/fill/dash/opacity only — see CSS

groups:
  providers:  { tier: 0, label: "Провайдеры / Контрагенты" }
  datacenter: { tier: 1, label: Datacenter }
  tbr-left:   { align: left,  of: datacenter, label: TBR-001 }
  tbr-right:  { align: right, of: datacenter, label: TBR-002 }
  reflector:  { tier: 2, label: "Route-Reflector (ERR)" }
  backbone:   { tier: 3, shape: bar, label: Backbone }

nodes:
  provider-1: { group: providers, class: provider, ports: [100G] }
  EAC-01:
    group: datacenter
    class: router
    ports: [100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G]
  TBR-001:
    group: tbr-left
    class: tbr
    ports: { side: right, list: [100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G] }
  RR-01:  { group: reflector, class: rr, ports: [100G, 100G, 100G, 100G, 100G] }
  EBB-01: { group: backbone,  class: router, ports: [100G, 100G, 100G] }

links:
  - [provider-1.100G, EAC-01.*]                        # `*` = next free port on EAC-01
  - [TBR-001.*, EAC-01.*]                              # ×8 → a bundle
  - [TBR-002.*, EBR-02.*, { class: dashed }]
  - [EBR-01.*, RR-01.*, { label: "100G" }]
  - [EBB-01.*, EBR-01.*, { route: straight }]
  - { from: { node: EAC-02, port: "100G", ordinal: 3 }, to: { node: TBR-002, port: "100G" } }
```

---

## Identifiers

Node, group and port ids match `^[A-Za-z0-9][A-Za-z0-9_-]*$` — no dots, `#`, `*`, spaces or
slashes — so the compact endpoint form is unambiguous. Node ids and group ids share one
namespace (a name may not be both). Port names may repeat within a node; a port is identified by
name plus **ordinal** (1-based, in declaration order), and that identity is immutable through the
pipeline. Labels are free text; ids are not.

## Top level

| Key | Type | Required | Notes |
|---|---|---|---|
| `portograph` | int | yes | `2` |
| `profile` | string | no | `network` (default), `architecture`, `electrical` |
| `title` | string | no | |
| `css` | string | no | appended after the profile theme; **geometry-affecting properties are locked** (font-family, font-size, font-weight, stroke-width, letter-spacing, transform). Locks also cover `font`/`all` shorthands, vendor-prefixed transforms, `translate`/`rotate`/`scale`, `transform-origin`/`transform-box`, SVG dimensions/coordinates (`width`, `height`, `x`, `y`, `cx`, `cy`, `r`, `rx`, `ry`, `d`), text metrics (`font-stretch`, `font-size-adjust`, `font-variant`, `font-variant-caps`, `font-feature-settings`, `font-variation-settings`, `font-synthesis`, `font-optical-sizing`, `text-size-adjust`, `word-spacing`, `text-transform`, `writing-mode`, `text-orientation`, `glyph-orientation-horizontal`, `glyph-orientation-vertical`, `font-style`, `font-kerning`, `font-language-override`, `font-variant-ligatures`, `font-variant-numeric`, `font-variant-east-asian`, `font-variant-alternates`, `font-variant-position`, `font-variant-emoji`), text and element placement (`text-anchor`, `dominant-baseline`, `alignment-baseline`, `baseline-shift`, `dx`, `dy`, `offset`, `offset-path`, `offset-distance`, `offset-rotate`, `zoom`) and extra painted geometry (`marker`, `marker-start`, `marker-mid`, `marker-end`, `vector-effect`). Paint that leaves the measured box is locked as well: `filter`, `backdrop-filter`, `text-shadow`, `box-shadow`, `clip`, `clip-path`, the `mask` family, `stroke-miterlimit`, and the **outline** shorthand with every one of its longhands (`outline`, `outline-width`, `outline-style`, `outline-color`, `outline-offset`). An outline is painted outside its element's box, after the shape and independently of `stroke`, and it never enters the geometry the gates and the score measure, so one wide rule would cover unrelated geometry and reach past the canvas; the longhands are locked with the shorthand because `outline-style` alone paints at the `medium` default width and `outline-offset` pushes an outline arbitrarily far from its element. Colour, fill, stroke colour, dasharray, opacity are allowed, and a locked name is matched as a property, so a custom property such as `--outline` is kept: an allowed declaration may still consume it through `var()`, but every declaration that could turn it into outline paint is locked. Locked properties in `css:` are a warning and are ignored, including case and escaped-name variants. The palette a rule reaches is the drawn diagram: internal render structure is not a styling surface, and the overlay mask states its own paint on its elements, where no rule of this sheet can reach it |
| `layout` | map | no | document settings, three keys. `farEndPull` (boolean, default `true`): a member of a free row whose routed links all end on one far node of a facing band passes the unlinked members beside it toward that node (architecture-2 ticket 22, stage 4); `false` keeps the order the corridor row order leaves. `corridorRowOrder` (boolean, default `true`): a free row takes the order that the corridors of transit links through it cross least (architecture-2 ticket 17, stage 4); `false` keeps the order the skeleton gives every row, and the overlay order then reads every transit link as one diagonal, as before the ticket. `overlayOverBodies` (boolean, default `false`): an overlay link blocked by node bodies alone is drawn as the straight chord over them, with the info `OVERLAY_OVER_BODY`. A foreign pill or an own end body on the chord keeps the link bent. Stage 8 only; placement does not know it (ticket 152). Any other key is `UNKNOWN_KEY`, a non-boolean `INVALID_TYPE` |
| `groups` | map | yes | |
| `nodes` | map | yes | |
| `links` | list | no | |
| `render` | map | no | paint-only settings; nothing here reaches layout or score. One key, `anonymousPortMarker` (`dot` default, or `none`): a routed link end on an anonymous port (a link written to a bare node, ADR-0002) is closed by a filled dot in the link stroke (draw.io: `endArrow=oval;endFill=1;endSize=6`, or `startArrow` for the source end), so it does not look unfinished beside a pill. `none` draws the bare end as before. An overlay link keeps its own end mark. Camel case like `layout.corridorRowOrder`; an unknown key or value is an error with its path |
| `overlays` | map | no | render switches, e.g. `{ flow: hidden }` |
| `meta` | map | no | document metadata for the draw.io export, on the root cell; no cell inherits it. See **Meta** below |

## Group

| Key | Type | Notes |
|---|---|---|
| `tier` | int ≥ 0 | 0 = top. Omitted → inferred (below). Mutually exclusive with `align` |
| `align` | `left` \| `right` | makes the group a **flank** |
| `of` | group id | required with `align`; **must name a tier group** (not a flank, not itself). At most one flank per side per tier group; a second is an error |
| `label` | string | default: id |
| `shape` | `row` \| `bar` \| `grid` \| `ring` \| `free` | default `row`; M1: `row`, `bar`. `bar` nodes stack in declaration order |
| `class` | string | |
| `collapsed` | bool | M1: warning, ignored |
| `layout` | map | pass-through ELK options for the group's own algorithm (escape hatch; `SEPARATE_CHILDREN` semantics apply and are documented as such) |

**Tier inference** (model-time). For each non-flank group without `tier:`: rank = the profile's
class table applied to the group's nodes — `top` if any node class is in the profile's top set
(network: `provider`, `internet`, `wan`), `bottom` if any is in the bottom set (`backbone`,
`core`) and none in the top set, else `middle`. An explicit tier is an author ordering rank and
is never replaced by class inference. Normalisation forms bands in this order: one band for all
inferred `top` groups; explicit groups ordered by authored rank, with equal ranks sharing a band;
one band per inferred `middle` group in first-appearance order; and one band for all inferred
`bottom` groups. Empty categories are omitted and the resulting effective tier bands are numbered
compactly from 0. The validated input may retain the authored rank for diagnostics; the normalised
model records only the effective `tier`. A group with both top- and bottom-class nodes is `middle`
with a warning. Inference is logged as an info message.

## Node

| Key | Type | Notes |
|---|---|---|
| `group` | group id | required |
| `class` | string | |
| `label` | string | default: id |
| `description` | string | |
| `icon` | string | from the profile icon set |
| `ports` | list \| map | list of `string` or `{ name, side?, order?, class?, meta? }`; or `{ side: <side>, list: [...] }` |
| `size` | `{ width, height }` | a floor; the engine may grow, never shrink |
| `meta` | map | metadata for the draw.io export; see **Meta** below |

Per-port keys: `side` fixes the side; `order` (int) fixes the position on that side among
author-ordered ports (engine-ordered ports fill the gaps by far-end position). Declaration order
is **not** an order constraint unless `order` is given. `class` (string, space-separated tokens)
is appended to the pill, its label and the port group like any author class: a profile **role**
(`uplink downlink peer mgmt lag loopback`) paints the pill and earns a legend row; a
**status** (`up down admin-down degraded unused`) paints the stroke — `admin-down` also greys the
fill and the text — or, for `unused`, fades the whole port; any
other token is kept for a `css:` rule and listed in the legend as a role by first use. A class
never changes geometry: the pill is measured from its label text alone.

## Link

Compact form: `[from, to]` or `[from, to, options]`. Structured form: `{ from, to, ...options }`
where `from`/`to` are `{ node, port?, ordinal? }` or `{ group }`.

Compact endpoint grammar (`node` and `group` are identifiers as above):

| Form | Meaning |
|---|---|
| `node.port` | the **first free** port of that name; if all are taken, the first one (shared) |
| `node.port#n` | the n-th port of that name |
| `node.*` | the next free port of any name, in declaration order; none free → a new anonymous port |
| `node` | an anonymous port |
| `group` | a group-link endpoint |

Allocation of `*` and free-name lookups happens in **link order** at model time and is recorded
in the model as explicit `(node, name, ordinal)` triples; the layout JSON never contains `*`.

Options:

| Key | Type | Notes |
|---|---|---|
| `class` | string | CSS class; decides **family** via the profile (`physical` → routed; `flow`, `sync`, `signal` → overlay) |
| `label` | string | |
| `route` | `orthogonal` \| `straight` \| `bundle` \| `merge` \| `overlay` \| `stub` \| `group-link` | override. `merge` is selected first and validated at model time after bundle grouping; it requires membership in a bundle of ≥ 2. `group-link` requires group endpoints. M1: `stub` and `group-link` warn and fall back to routed |
| `weight` | number | line-weight multiplier |
| `id` | identifier | the link's own id; unique among links (`DUPLICATE_LINK_ID`). Without it the id is derived from the two ends (docs/drawio-binding-contract.md) |
| `meta` | map | metadata for the draw.io export; see **Meta** below |

**Aggregation eligibility** (automatic `group-link`): both endpoint groups have ≥ 2 nodes; the
links form the complete bipartite set between the two groups' nodes; all share one class and
family; none carries `route:`. Membership is preserved in the model.

## Meta

`meta:` is a flat map of scalars: a string, a finite number or a boolean. The pipeline carries it
and does not read it, so it never changes geometry. The draw.io export writes each entry as an
attribute of the cell (docs/drawio-binding-contract.md). A key starts with a letter or an
underscore and contains letters, digits, underscores or hyphens (`BAD_META_KEY`). The keys `id`,
`label`, `placeholders`, any key that starts with `pg-` and any key that starts with `xml` are
reserved, in any case (`RESERVED_META_KEY`). Another value is `INVALID_TYPE`.

## Diagnostics, by stage

| Stage | Errors (stop) | Warnings |
|---|---|---|
| parse | bad identifier; unknown reference; node without `group`; `tier` + `align`; `align` without `of`; `of` not a tier group; two flanks on one side; link with < 2 endpoints; version missing | locked CSS property |
| model | `route: merge` without membership in a bundle of ≥ 2 | `*` created an anonymous port on a node that has named ports; > 1 link on a port (network); tier with no nodes; mixed top/bottom classes; > 30 nodes; `stub`/`group-link` in M1; `MESH_BUS_DECLINED` (`named-ports`, `shared-port`, `side`, `shape`, `second-mesh`, `too-many-cliques`); info: `MESH_BUS`, `MESH_BUS_PARTIAL` (docs/design/mesh-bus.md, section 7) |
| placement | — | info: `MESH_BUS_TITLE_MOVED`; flank has more distinct links than the peer's facing ports; bar sources closer than pitch; bundle inversions from author order; both margins full (canvas widened) |
| final geometry | gate failures (see `quality.md`) | advisories; info: `OVERLAY_OVER_BODY` (only under `layout.overlayOverBodies`) |

## Migration from d3-fd (`diagram:` format)

`portograph migrate <file>`: `locations` → `groups` (tier inferred; location names containing
`left`/`right` become flanks with a warning to confirm); `interfaces: [{name}]` → `ports`;
`side:` on interfaces → per-port `side`; `css` carried over. Link strings `"node ifname"` are
resolved **first, by d3-fd's own rule** (consume the next unused interface *of that name* in link
order) and emitted as explicit `node.ifname#n` — never as `*`, which would consume across names
and change the wiring.
