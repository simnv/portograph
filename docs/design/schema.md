# YAML Schema (v2)

Design goals: nodes keyed by id; links as two-element arrays; a node belongs to one group; tier
and alignment live on groups; every override is a single key with the same name as the concept in
`CONTEXT.md`; YAML anchors are the reuse mechanism — there is no `templates:` section.

```yaml
portograph: 2                 # schema version (required)
profile: network              # network | architecture | electrical  (default: network)
title: "SIP edge — Datacenter A"
css: |                        # optional, appended after the profile theme
  .node-rr .node-rect { fill: #f9a825; }

groups:
  providers:  { tier: 0, label: "Провайдеры / Контрагенты" }
  datacenter: { tier: 1, label: Datacenter }
  tbr-left:   { align: left,  of: datacenter, label: TBR-001 }   # a flank
  tbr-right:  { align: right, of: datacenter, label: TBR-002 }
  reflector:  { tier: 2, label: "Route-Reflector (ERR)", class: highlighted }
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
  RR-01: { group: reflector, class: rr, ports: [100G, 100G, 100G, 100G, 100G] }
  EBB-01: { group: backbone, class: router, ports: [100G, 100G, 100G] }

links:
  - [provider-1.100G, EAC-01.*]                      # `*` = next free port on EAC-01
  - [TBR-001.*, EAC-01.*]                            # repeated 8× → detected as a bundle
  - [TBR-002.*, EBR-02.*, { class: dashed }]
  - [EBR-01.*, RR-01.*, { label: "100G" }]
  - [EBB-01.*, EBR-01.*, { route: straight }]        # per-link technique override
  - [rr-cluster, edge-cluster, { route: group-link }]   # explicit group-to-group link
```

---

## Top level

| Key | Type | Required | Notes |
|---|---|---|---|
| `portograph` | int | yes | schema version; `2` |
| `profile` | string | no | `network` (default), `architecture`, `electrical` |
| `title` | string | no | rendered in the title block if the profile has one |
| `css` | string | no | appended after the profile theme |
| `groups` | map | yes | id → group |
| `nodes` | map | yes | id → node |
| `links` | list | no | |
| `overlays` | map | no | profile-level render switches, e.g. `{ flow: hidden }` |

## Group

| Key | Type | Notes |
|---|---|---|
| `tier` | int ≥ 0 | row in the hierarchy; 0 = top. Exactly one of `tier` / `align` |
| `align` | `left` \| `right` | makes the group a **flank** of `of:` |
| `of` | group id | required with `align` |
| `label` | string | default: the id |
| `shape` | `row` \| `bar` \| `grid` \| `ring` \| `free` | default `row`. M1: `row`, `bar` |
| `class` | string | CSS class for the box |
| `collapsed` | bool | render as one node with aggregated ports (v1: warning-only placeholder) |
| `layout` | map | pass-through ELK options for this group's internal algorithm (escape hatch) |

Tier inference: when `tier` is omitted and the group is not a flank, the profile infers it from
the classes of its nodes (network: `provider|internet|wan` → 0; `backbone|core` → last; others →
middle, ordered by first appearance). Explicit `tier` always wins. Inference is reported as an
info message so it is never invisible.

## Node

| Key | Type | Notes |
|---|---|---|
| `group` | group id | required |
| `class` | string | drives colour/icon via the theme and tier inference via the profile |
| `label` | string | default: the id |
| `description` | string | second line inside the box |
| `icon` | string | from the profile icon set |
| `ports` | list \| map | list of names, or `{ side: <side>, list: [...] }` to fix a side for all; per-port `{ name, side }` objects allowed in the list |
| `size` | `{ width, height }` | author override; the engine may grow it, never shrink it |

Ports are identified by **name plus ordinal**: the third `100G` on `EAC-01` is `EAC-01.100G#3`.
Authors normally never write the ordinal — they write `*`.

## Link

Two-element list `[from, to]` with an optional third element, an options map.

Endpoint forms:

| Form | Meaning |
|---|---|
| `node.port` | that named port (first with that name if several) |
| `node.port#n` | the n-th port of that name |
| `node.*` | **the next free port** on that node — allocated in link order; if none is free, a new anonymous port is created |
| `node` | an anonymous port (never rendered) — same as `node.*` when no named ports exist |
| `group` | a group-link endpoint (requires `route: group-link` or is inferred by the density rule) |

Options:

| Key | Type | Notes |
|---|---|---|
| `class` | string | CSS class; also decides the **family** through the profile (`physical` → routed, `flow|sync` → overlay) |
| `label` | string | drawn on the longest segment |
| `route` | `orthogonal` \| `straight` \| `bundle` \| `merge` \| `overlay` \| `stub` \| `group-link` | overrides the engine's choice |
| `weight` | number | line weight multiplier (profiles map speed → weight) |

## Validation

Errors (stop): unknown group/node/port reference; a node without `group`; a group with both
`tier` and `align`; `align` without `of`; a link with fewer than two endpoints; schema version
missing or unsupported.

Warnings (continue): `*` created an anonymous port on a node that has named ports (likely a typo);
more than one link on a port in the `network` profile; a tier with no nodes; a flank whose primary
peer has fewer facing ports than the flank; diagram above 30 nodes.

## Migration from d3-fd (`diagram:` format)

A converter ships as `portograph migrate <file>`: `locations` → `groups` (tier inferred);
`interfaces: [{name}]` → `ports`; `"node ifname"` strings → `node.ifname` with `*` when names
repeat (preserving d3-fd's consume-by-declaration-order semantics exactly, then emitting a
warning that the order is now explicit); `css` carried over; `side:` on interfaces carried over
as per-port `side`. Location names containing `left`/`right` become flanks with a warning to
confirm.
