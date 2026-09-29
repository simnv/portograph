# drawthe.net conversion

`drawthe_net.py` converts a source document into schema v2 with groups. It preserves node
labels and endpoint label text. It reads YAML anchors through PyYAML, so named presets and each
connection's inherited style can be compared directly.

```sh
PYTHONDONTWRITEBYTECODE=1 uv run scripts/conversion/drawthe_net.py /path/to/source.yaml /tmp/converted.yaml
PYTHONDONTWRITEBYTECODE=1 uv run --with pyyaml python -m unittest discover -s scripts/conversion
```

The conversion API is `convert(document) -> (converted_document, count_report)`. The CLI prints
counts only. It does not print source node identifiers. Keep private sources and generated private
examples outside the repository; the tests contain generic topology only.

Connection styles matching the authored `ntpSync` preset become `class: sync`; those matching
`ntpFlow` become `class: flow`. Both are overlay families in the network profile. Styles matching
the physical `connection` preset become `physical`, or `dashed` when they carry a dash pattern.
An unmatched style is an error. Node connectivity never determines a link's class. These classes
preserve semantic families and the distinction between solid and dashed physical links; they do
not reproduce the source renderer's exact colours, dash spacing or line widths.

Groups used as connection endpoints expand to their declared leaf icons. An endpoint label stays
label text; it does not become a port or part of the icon name. Distinct endpoint labels are joined
with ` / ` without truncation. Declarations with other than two endpoints, unknown endpoints,
cyclic group membership and ambiguous icon/group identities fail instead of silently losing links.

The source format has no arrows. Reciprocal or repeated declarations are combined only when the
unordered pair, each endpoint's label, semantic class and full supported line style match. Parallel
physical and flow connections remain distinct. Degenerate self-pairs from group cross-products
are omitted and counted separately. The report records declarations, expanded pairs, self-pairs,
duplicates and retained links so these reductions are reviewable.

Visible groups collect icons by their authored bounding boxes, including icons not listed as
members. The smallest containing box wins, with declaration order breaking equal-area ties.
Padding is measured in grid steps, including nesting depth. Icon height extends down the screen.
The group's authored top row determines its tier. Icons outside every visible box fall back to their
source row. Groups carry no `shape:`. A box inside another box gets `parent:` (the smallest
containing box); only top-level groups get `tier:`. Nesting is one level: a box under a child is
folded into that child, with a warning on stderr.

An anonymous, opaque, stroke-free box entirely inside its nearest retained painted container of
the same opaque fill adds no visible boundary. A different-coloured zone between it and a matching
outer ancestor keeps the inner patch visible. Redundant boxes are omitted and counted as `redundant_hidden_groups`.
Named groups, translucent boxes, different fills and standalone painted boxes are retained. No
authored node or connection is removed by this containment rule.
An empty `name: ''` is anonymous, and inherited label colour, stroke width and text position do not
make an unnamed stroke-free box visible. Opacity comes from the fill colour itself, including RGBA
and four/eight-digit hex alpha. Unsupported `opacity` fields are not used. Unknown or
context-dependent colour syntax is conservatively retained instead of treated as opaque.

Node classes follow source icon roles, never declaration index. Known router, switch, cloud and
server glyphs map to supported profile icons. The named paint presets distinguish NTP stratum 1,
stratum 2 and client roles for every icon, including client routers and outlets. The semantic class
changes while the device glyph stays the same. Only paint keys supplied by the preset are compared;
missing paint information cannot imply a stratum. Symbols
without a supported equivalent retain a descriptive role with the default glyph. This is a
topology conversion: exact source icon art, original coordinates and nested group drawing are
outside schema v2's current placement model. The converter does not certify successful routing
or quality gates; run the resulting full input through the normal CLI and inspect the output.

`--canton TOKEN[=LABEL]` (repeatable) groups top-level groups into cantons. A group whose identifier (case-insensitive, not
label) starts with a token is a member; the longest token wins. Every other top-level group counts its
sync and flow links (its own and its children's) to those groups only; more than half to one canton makes it a member, else it stays
outside with a warning that names the counts. A canton whose members do not stand on consecutive tiers is
dropped with a warning. A tokenised `bar` or `grid` group stays outside with a warning. Without the flag the
output is byte-identical.
