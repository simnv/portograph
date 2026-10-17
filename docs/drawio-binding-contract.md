# draw.io binding contract

Schema version: **1**.

This document is the interface between the portograph draw.io export and the tools that read it,
for example a Grafana panel that binds cells to Prometheus series. A reader can depend on each
rule in this document. A change to a rule increments the schema version.

## 1. File format

- The export is one plain, uncompressed XML file: `<mxfile host="portograph"><diagram id="pg-diagram" name="…"><mxGraphModel>…`.
- The root cell (`id="0"`) is a draw.io `UserObject`. It carries `pg-schema="1"`.
- A bound cell is an `<object>` element around an `<mxCell>`. The `<object>` holds the cell `id`,
  the `label` (the old `value`) and the binding attributes. The inner `<mxCell>` holds `style`,
  `vertex` or `edge`, `parent`, `source`, `target` and the geometry. It has no `id` and no `value`.
- All other cells (groups, icons, legend, mesh buses, overlay marks, layers) are bare `<mxCell>`
  elements, as before.

```xml
<object id="pg-port~sw1~eth2~1" label="eth2" pg-kind="port" pg-id="sw1:eth2"
        pg-node="sw1" pg-port="eth2" ifname="eth2">
  <mxCell style="…" vertex="1" parent="pg-node~sw1">
    <mxGeometry x="…" y="…" width="…" height="…" as="geometry"/>
  </mxCell>
</object>
```

draw.io keeps the attributes when a user edits the diagram. Its *Edit Data* dialog shows them. An
SVG or PNG export from draw.io keeps them only when it embeds the diagram XML.

## 2. Ids

Bind to `pg-id`, not to the cell `id`. A copy and paste in draw.io gives the cell a new `id` but
keeps `pg-id`. The cell `id` follows from `pg-id` and is for convenience only.

| Thing | `pg-id` | Cell `id` |
| --- | --- | --- |
| node | the YAML node id: `sw1` | `pg-node~sw1` |
| port | `<node>:<port>`: `sw1:eth2`; `<node>:<port>#<n>` for the n-th port of one name, n > 1 | `pg-port~sw1~eth2~1` |
| link | see section 2.1 | `pg-link~<link id>`; `pg-link~<link id>~<i>` for run i of a split link |
| link label | — (the cell has `pg-of`) | `pg-linkLabel~<link id>` |

In a cell `id`, the separator is `~`. The export writes a `%` or a `~` inside a part as `%25` or
`%7e`, so two different things cannot get the same cell `id`.

### 2.1 Link ids

1. A link with `id:` in the YAML has that id.
2. Any other link has `<from>-><to>`, in YAML direction. An end is:
   - `<node>:<port>` for a named port (`<node>:<port>#<n>` when n > 1),
   - `<node>` for an anonymous port (the YAML end names a node and no port),
   - `<group>` for a group end.
3. When that id is already used, the link gets `<from>-><to>@<k>`, with the smallest free k from 2.
   Rule 2 goes through the links in YAML order.

An end never contains `>` or `@`, and a YAML id never contains `:`, `>` or `@`. Thus an id from
rule 1 never equals an id from rule 2, and two links with different ends never get the same id.
In the XML file, `>` is written `&gt;`. An XML parser gives it back as `>`.

Examples: `sw1:eth2->srv1:eth0`, `router->isp` (two anonymous ports), `router->isp@2` (a second,
parallel link).

The id does not change when you reorder the links. It changes when an end of the link changes.
Some ids can still move:

- `@k` follows YAML order. When you move a parallel link before another link with the same ends,
  the two links exchange their ids.
- The YAML ends `node.port` (a port name used more than once) and `node.*` select a port in link
  order. A reorder can change the selected port, and with it the id.

Give a link an `id:` when a dashboard must bind to it through such changes.

## 3. Attributes

All attribute values are strings. A reader must parse numbers and booleans.

| Attribute | On | Value |
| --- | --- | --- |
| `pg-schema` | root cell `id="0"` | `1` |
| `pg-kind` | every bound cell | `node`, `port`, `link` or `link-label` |
| `pg-id` | node, port, link | the id from section 2 |
| `pg-node` | port | the node id |
| `pg-port` | port | the port name. For a network diagram this is the OS interface name, for example `eth2` |
| `pg-from` | link | the `from` end, in the form of section 2.1, rule 2 |
| `pg-to` | link | the `to` end, in the same form |
| `pg-run` | link, split into runs only | the index of this run, from `0` |
| `pg-runs` | link, split into runs only | the number of runs |
| `pg-of` | link label | the `pg-id` of the link that owns the label |
| `pg-rules` | root cell `id="0"` | reserved, not written in version 1. It will hold binding rules as one YAML or JSON string, versioned with `pg-schema` |

A link from `pg-from` to `pg-to` has the YAML direction. Use it to select the counter for each
direction, for example the transmit counter of the `pg-from` port.

`pg-from` and `pg-to` name a port cell only when the end is a named port. An anonymous port has no
cell, and the link ends on the node cell.

### 3.1 Labels

A link label is in one of two places:

- the `label` attribute of the link `<object>` itself, or
- a separate cell with `pg-kind="link-label"` and `pg-of="<link id>"`. This cell is a child of the
  link run that it stands on.

To find the label of a link, look for a `link-label` cell with its `pg-of` first. If there is no
such cell, use the `label` of the link object. A split link carries its label on one run only.

The labels are plain text: the style has no `html` key, and a label of more than one line has its
lines one newline (`&#10;`) apart. An SVG export of the file draws each line as a native `<text>`,
not as a `<foreignObject>` with a PNG fallback. The export does not set `placeholders`, so draw.io
shows a `%name%` in a label as it is.

A node's `label` is its name only. Plain text has one font per cell, so a node's description is a
separate, unbound text cell (`pg-nodeDescription~<node>`), a child of the node cell.

## 4. Author metadata

The YAML `meta:` map on a node, on a port (map form) and on a link becomes attributes of that
cell. The root `meta:` becomes attributes of the root cell (`id="0"`).

```yaml
meta: { datasource: victoriametrics }
nodes:
  sw1:
    group: core
    meta: { job: node-sw1, instance: sw1 }
    ports:
      - { name: eth2, meta: { ifname: eth2 } }
links:
  - from: sw1.eth2
    to: srv1.eth0
    id: sw1-uplink
    meta: { capacity: 1e9 }
```

Rules:

- A value is a string, a finite number or a boolean. The export writes it as a string. A number
  uses the JavaScript form: `1e9` becomes `1000000000`. A tab, a newline or a carriage return in a
  string is written as a character reference (`&#9;`, `&#10;`, `&#13;`), so a parser keeps it.
- A key starts with a letter or an underscore. It contains letters, digits, underscores or
  hyphens. The key goes into the attribute name with no prefix and no change.
- These keys are reserved, in any case: `id`, `label`, `placeholders`, all keys that start with
  `pg-`, and all keys that start with `xml`. The parser refuses them.
- The `pg-` attributes come first. The meta attributes come after them, in sorted key order.
- `tooltip` and `link` are not reserved. draw.io shows `tooltip` when the pointer is on the cell
  and makes the cell a hyperlink with `link`.
- No cell inherits the root `meta:`. A reader can use it as a default for every cell.

Common keys for a network diagram: `host`, `job`, `instance`, `ifname`, `device`, `capacity`
(the link limit in bit/s), `kind`. portograph does not read them.

## 5. Not in version 1

These cells have no binding attributes:

- group and frame boxes,
- mesh bus bars, stubs, joints and risers (a mesh bus member link has no link cell),
- overlay end marks, icons and the legend,
- the count label of a merge bundle. Its cell id comes from the bundle number, which can change
  when you reorder the links.

## 6. Versioning

- `pg-schema` on the root cell gives the version.
- A new attribute or a new `pg-kind` value does not change the version. A reader must ignore an
  attribute or a kind that it does not know.
- A change to an id format or to the meaning of an attribute increments the version.
- `pg-rules` is reserved for binding rules on the root cell. The export does not write it yet, and
  `meta:` cannot set it, because all `pg-` keys are reserved. A reader must ignore it until a later
  version defines its content.
