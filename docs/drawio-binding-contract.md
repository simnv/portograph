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
- All other cells (groups, icon tiles, legend, overlay marks, layers) are bare `<mxCell>`
  elements, as before. A mesh bus piece and a text cell that only needs a `tooltip` are an `<object>`
  with `tooltip` and no `pg-kind`. Such an `<object>` is not a binding; a reader keys on `pg-kind`.

```xml
<object id="pg-port~sw1~eth2~1" label="eth2" pg-kind="port" pg-id="sw1:eth2"
        pg-node="sw1" pg-port="eth2" ifname="eth2">
  <mxCell style="…" vertex="1" parent="pg-node~sw1">
    <mxGeometry x="…" y="…" width="…" height="…" relative="1" as="geometry">
      <mxPoint x="…" y="…" as="offset"/>
    </mxGeometry>
  </mxCell>
</object>
```

A pill, a node icon and a node description have `relative="1"` geometry: `x` and `y` are a
fraction of the node's size and the offset is in px, so the cell stays on its face when a user
resizes the node. Along its face a pill keeps a fixed px distance from the nearer corner; a pill
centred on its face (within the export tolerance `EPS` in `src/render/drawio.ts`, 1e-6 px today) keeps the centre: fraction 0.5 and an offset of minus half its
length. The geometry is not part of the binding.

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
| node icon | — (the cell has `pg-of`) | `pg-icon~<node>` |

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
| `pg-kind` | every bound cell | `node`, `port`, `link`, `link-label` or `node-icon` |
| `pg-id` | node, port, link | the id from section 2 |
| `pg-node` | port | the node id |
| `pg-port` | port | the port name. For a network diagram this is the OS interface name, for example `eth2` |
| `pg-from` | link | the `from` end, in the form of section 2.1, rule 2 |
| `pg-to` | link | the `to` end, in the same form |
| `pg-class` | node, port, link, only when the YAML gives it a `class:` | the class tokens of the author, see section 3.2. Optional: it does not change the schema version |
| `pg-run` | link, split into runs only | the index of this run, from `0`. See section 3.3 |
| `pg-runs` | link, split into runs only | the number of runs |
| `pg-of` | link label, node icon | the `pg-id` of the link that owns the label, or of the node that owns the icon |
| `pg-symbol` | node, only when the node has a class | the text after `symbol:` in the id of the legend row of the node's class, with `%` and `~` escaped as `%25` and `%7e`. The legend cells of the class have the id `pg-legendRow~symbol:<value>`. A "symbol" is the class variant that the legend lists, not a drawn icon: a node of a class that has no icon cell has the attribute too. When one class is drawn with two icons, the value is `<class>:<icon>`. A node has the attribute also when the sheet draws no legend. A node with no class has none. Optional: it does not change the schema version |
| `pg-rules` | root cell `id="0"` | reserved, not written in version 1. It will hold binding rules as one YAML or JSON string, versioned with `pg-schema` |

A link from `pg-from` to `pg-to` has the YAML direction. Use it to select the counter for each
direction, for example the transmit counter of the `pg-from` port.

`pg-from` and `pg-to` are the ends at export time. They do not follow an edit in draw.io: a
reconnect of a link changes the mxCell `source` or `target` only, and `pg-from` and `pg-to` keep
the old ends. A reader that must follow such edits compares them with `source` and `target`.

`pg-from` and `pg-to` name a port cell only when the end is a named port. An anonymous port has no
cell, and the link ends on the node cell.

A link end is pinned to its visible end (`visibleEnd`, D-Q7), a point of the path: on a port that
draws a pill, the first point where the path leaves the pill (its outward face on the stem, or the
stem end when the stem is shorter than the pill's half depth), or the approach point on the pill's
tangential edge for an end on an approach; on an anonymous port, the path end on the node cell. The interior waypoints
are the published path. `edgeStyle` follows that polyline: `none` for a run with no bend,
`orthogonalEdgeStyle` for a square run, and `none` for a run with a diagonal.

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

Label placement is a render option (`--labels`). `on-run`, the default, centres a link label on the
segment that supports it and fills the label with the backdrop. It moves a label only, never a route.
`measured` keeps the box stage 9 placed, beside its run, as the SVG draws it. Use `measured` to verify
an export against the layout model: every label then decodes to its measured centre.

A node's `label` is its name only. Plain text has one font per cell, so a node's description is a
separate, unbound text cell (`pg-nodeDescription~<node>`), a child of the node cell.

### 3.2 Classes

`pg-class` holds the `class:` of a node, a port or a link, as the author wrote it in the YAML:

- The value is a list of tokens with one space between them, in the written order. Each token is there once.
- A token that starts with `pg-` is not written. The export keeps that prefix for its own classes.
- A thing with no `class:`, or with no token left, has no `pg-class`. The attribute is never empty.
- The export adds no token: a link family (`routed`, `overlay`) is not in the value.

A reader selects cells by one token, not by the full value: `pg-class="downlink up"` is in the set
"all `downlink` ports" and in the set "all `up` ports".

```xml
<object id="pg-port~sw1~eth2~1" label="eth2" pg-kind="port" pg-id="sw1:eth2"
        pg-node="sw1" pg-port="eth2" pg-class="downlink up" ifname="eth2">…</object>
<object id="pg-link~sw1:eth3-&gt;cam1:eth0" label="" pg-kind="link" pg-id="sw1:eth3-&gt;cam1:eth0"
        pg-from="sw1:eth3" pg-to="cam1:eth0" pg-class="poe">…</object>
```

`pg-class` and `pg-symbol` are two attributes with two meanings. `pg-class` is what the author
wrote, on all three kinds. `pg-symbol` is on a node only and names the legend row that the node
shares, so two nodes with `pg-class="router"` and `pg-class="router extra"` can have one
`pg-symbol`. Use `pg-class` to select cells and `pg-symbol` to find the legend cells.

### 3.3 A link split into runs

A link is one cell when its path is one connected line. A path with a break becomes one cell for
each connected part, a run. The runs have the index 0 to `pg-runs` − 1, from the `pg-from` end to
the `pg-to` end.

- Every run carries the full binding of the link: `pg-kind="link"`, the same `pg-id`, `pg-from`,
  `pg-to` and `pg-class`, and every meta attribute. Thus a `bind` in the link meta is on every run.
- Only `pg-run` and the cell `id` (`pg-link~<link id>~<i>`) differ between the runs.
- The first run has the mxCell `source`. The last run has the mxCell `target`. No other run end is
  attached to a cell: it has a `sourcePoint` or a `targetPoint`.
- One run carries the label, the run that draws the segment the label stands on. It is not always
  run 0. The label is the `label` of that run or a `link-label` cell that is a child of that run
  (section 3.1). All other runs have `label=""`.
- A generated `tooltip` (section 4) for the link is on every run. The full text of a shortened label is
  on the cell that carries the label.

A reader that binds a link must collect the cells by `pg-id` and give all of them one state.

No sheet makes a split link today: gate G7 refuses a routed path whose segments do not connect,
and no sheet of the test corpus gives one. A reader can get one from a layout model that the
library exports without the gates. The example
[`docs/assets/split-link.drawio`](assets/split-link.drawio) is such a file. It is the export of
[`goldens/synthetic/drawio-binding-metadata.yaml`](../goldens/synthetic/drawio-binding-metadata.yaml)
with the path of the link `uplink` cut in two and the class `trunk` on that link
(`test/render/drawio-binding.test.ts`, "draw.io split link"). Its link `uplink` has two runs, each
with `pg-class="trunk"`, and the label `10G` is a `link-label` child of run 1.

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
- The export also writes generated text into `tooltip`, as the SVG writes it in `<title>`: the full
  text of a shortened or omitted link label (on the link, or on the label cell), the members of a
  group-link fallback, and the tooltip of a mesh bus (on every piece of the bus; these pieces carry
  `tooltip` and no `pg-` attribute). draw.io shows `tooltip` as HTML: the generated text has `&`, `<`
  and `>` escaped, and an author `meta.tooltip` is written raw, so it may hold draw.io HTML. When a
  cell also has an author `meta.tooltip`, the author text comes first, then a new line, then the
  generated text. A reader that binds by `pg-kind` ignores a
  cell with no `pg-kind`.
- No cell inherits the root `meta:`. A reader can use it as a default for every cell.

Common keys for a network diagram: `host`, `job`, `instance`, `ifname`, `device`, `capacity`
(the link limit in bit/s), `kind`. portograph does not read them.

### 4.1 Where to write the identity of a counter

A counter belongs to an interface of a host. Write each part of its identity one time, on the
thing that owns it:

| Write on | What | Example keys |
| --- | --- | --- |
| root `meta:` | a value that is the same for the full sheet | `datasource`, `site` |
| node `meta:` | the identity of the host | `job`, `instance`, `host` |
| port `meta:` | the identity of the interface on that host | `device`, `ifname` |
| link `meta:` | a property of the link itself, and the exceptions below | `capacity`, `bind` |

A link needs no copy of the identity. Its `pg-from` and `pg-to` name the two ports, and each port
names its node with `pg-node`. A reader gets the identity of a link from the port and the node at
one end. A copy on the link is a second value that can become different from the first.

Write the identity on the link only when the ends do not give it:

- the counter is on an interface that is not a drawn port, for example a VLAN interface or a tunnel,
- the link ends on an anonymous port, which has no cell and no meta (the node meta still applies),
- one port has two or more links and each link has its own counter.

When `pg-port` is the OS interface name, the port needs no `device` or `ifname`. Write one only
where the name is different.

No cell inherits a value in the file. A reader does the lookup, and this order is recommended:
the cell itself, then for a port its node, then the root cell. A reader states its own rule for the
end of a link that it reads.

```yaml
meta: { datasource: victoriametrics }
nodes:
  sw1:
    group: core
    meta: { job: node, instance: "sw1:9100" }
    ports:
      - eth2                                        # the device is the port name
      - { name: uplink, meta: { device: bond0 } }   # the device has another name
  srv1:
    group: servers
    ports: [eth0]                                   # no counters here
links:
  - [sw1.eth2, srv1.eth0]                           # the reader takes job, instance and eth2 from the sw1 end
  - from: sw1.uplink
    to: srv1
    meta: { device: bond0.20 }                      # an exception: the counter is on a VLAN interface
```

## 5. Not in version 1

These cells have no binding attributes:

- group and frame boxes,
- mesh bus bars, stubs, joints and risers. A mesh bus member link has no link cell, and its `meta:`
  and `class:` are not in the file. One stub stands for all the member links of its node, so no
  bus cell is one link. A named port of a member has its cell and its meta,
- overlay end marks, icon tiles, node descriptions and the legend,
- the canvas background (layer `Canvas`),
- the count label of a merge bundle. Its cell id comes from the bundle number, which can change
  when you reorder the links.

A decoration (port mark, bus joint, icon tile) is locked to its owner: no move, resize, edit or connect on its own. Marks and joints
cannot be deleted alone, because link ends bind to them. A reader can ignore a locked cell with no `pg-kind`.

Known difference: draw.io draws plain text at its own line pitch, `round(size × 1.2)`, and has no
style to change it. The first baseline is within about 0.5 px (measured at 11 px). When the model pitch of a multi-line label differs,
its further lines can sit about 1 px a line off the SVG, and the export reports `DRAWIO_LINE_PITCH`.

## 6. Versioning

- `pg-schema` on the root cell gives the version.
- A new attribute or a new `pg-kind` value does not change the version. A reader must ignore an
  attribute or a kind that it does not know.
- A change to an id format or to the meaning of an attribute increments the version.
- `pg-rules` is reserved for binding rules on the root cell. The export does not write it yet, and
  `meta:` cannot set it, because all `pg-` keys are reserved. A reader must ignore it until a later
  version defines its content.
