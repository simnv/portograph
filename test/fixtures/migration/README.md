# d3-fd migration fixture

`legacy.yaml` is a small input in d3-fd's `diagram:` format. `expected-v2.yaml` is the schema-v2
document that `portograph migrate` must emit. This topology is independent of the JPEG golden.

## Original format and allocation rule

The source checked for the fixture was d3-fd commit
`05d4699d91f4c04c45960d9418da63423067a0d1` in the analyzed local repository
`~/Projects/d3-fd`:

- `src/utils/yaml.ts:4-9` requires a top-level `diagram` key and returns its value.
- `src/types/index.ts:7-20,35-69` defines `locations` and list-shaped `nodes`; each node has an
  `interfaces` list, and links use `source` and `target` strings in `"nodeId interfaceName"`
  form.
- `src/fv.ts:345-366` walks links in declaration order. Its usage map is keyed by
  `nodeId:interfaceName`, and each source or target occurrence advances only that key's counter.
  This is the source of the name-scoped, link-order allocation rule recorded in
  `docs/design/schema.md:152-159`.
- `src/fv.ts:303-320` creates interface nodes in declaration order. That implementation embeds
  the absolute array index in the internal id, while `parseLinks` uses the name-scoped occurrence
  count. Consequently, the old renderer can fail to find mixed-name interfaces whose occurrence
  number differs from their absolute array index. Migration follows the documented rule above;
  it does not preserve this renderer bug.

For `hub-a`, the declarations are `uplink`, `mgmt`, `uplink`, while the link references are
`uplink`, `mgmt`, `uplink`. Name-scoped allocation therefore produces `uplink#1`, `mgmt#1`, and
`uplink#2`. A single counter over all names would incorrectly produce ordinal 2 for `mgmt` and
ordinal 3 for the second `uplink`. Every referenced name has enough declared interfaces, so this
fixture makes no assertion about exhaustion.

## Ticket 02 assertions

The migration test should assert the parsed YAML structures, rather than formatter whitespace:

1. `locations` become the `core` and `peers` groups, and every migrated node refers to one of
   those groups.
2. Interface declaration order, repeated names, and authored `side` values survive in `ports`.
3. CSS is carried over unchanged.
4. Every link endpoint is explicit `node.name#ordinal`; no migrated endpoint contains `*`.
5. The two `hub-a uplink` references become `hub-a.uplink#1` and `hub-a.uplink#2`, while the
   intervening `hub-a mgmt` reference independently becomes `hub-a.mgmt#1`.
6. Parsing the migrated document yields the same explicit port identities and link endpoints as
   `expected-v2.yaml`.
