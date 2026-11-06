# Adopting bgplab as an additional portograph corpus

Decision proposal, 2026-11-06. Repository unchanged; no source code from bgplab was executed.

Recommend a curated `goldens/bgplab/` corpus, with every lab accounted for in a manifest, duplicates represented by aliases, and failures retained outside the gate. Use authored YAML, assisted by a one-off extractor, rather than maintain a general netlab converter. Keep generated fabric scale cases separate.

## Evidence and limits

- Source checkout: `bgplab/bgplab` at `4bd74dbc7f19f172d51cda9ff681303f7e152a5a`; `LICENSE.md` says MIT, Copyright (c) 2023–2024 Ivan Pepelnjak.
- Read `AGENTS.md`, `CONTEXT.md`, the source headers and bodies of `small-office.yaml` and all three `avd-*.yaml`, `private-datacenter-spine-leaf.yaml`, gate documentation, quality/test-design rules, and the relevant parser code.
- `src/parse/index.ts:279–365` accepts two-ended links and creates a fresh anonymous port for each bare-node endpoint. It has no multi-endpoint LAN input.
- `src/parse/index.ts:54–136,245–273` limits nested groups and cantons. A child has no authored tier; a canton holds tier groups on consecutive tiers and holds no nodes itself.
- Inspected the Wedgies, route-server, BFD and EBGP DC PNGs. Wedgies has five AS boxes; its `external` netlab group is not a drawn container. The route-server drawing distinguishes the shared LAN from EBGP arrows.
- The inventory now lists 54 labs: basic 14, policy 15, session 9, challenge 9, lb 4, ibgp 3. Its 31 signatures are duplicate candidates, not 31 approved distinct drawings. In particular, names, roles and labels can differ within a signature.
- Current checkout has 407 golden YAML files, of which `stage-inputs.yaml` is excluded, so the corpus command selects 406. No render or gate run was needed for this design; added runtime and final admitted count remain unmeasured.

## 1. Location and gate impact

Use these paths, with `bgplab` as the first source identifier:

| Content | Location |
| --- | --- |
| Approved distinct sheets | `goldens/bgplab/<lab-slug>.yaml` |
| All-lab manifest, review records, reference PNGs and full upstream notice | `ref/corpora/bgplab/` |
| Faithful but failing or unresolved sheets | `.scratch/architecture-2/fixtures/bgplab/<lab-slug>.yaml` |
| Temporary renders, logs and conversion drafts | `/tmp/bgplab/conversions/` |

Admitted sheets join the existing corpus command automatically. Do not add duplicate YAML copies under another `goldens/` directory. There is no need for a second permanent bgplab render command initially: an explicit pending-file list can use the locked CLI render command in the Recipe.

Reason: ordinary development should exercise the new real layouts. A second optional passing corpus would be easy to forget. Quarantine preserves difficult cases without normalising known failures into every baseline.

Measure added per-sheet time and total wall time during admission. Adding all 54 would add up to 108 minutes of per-sheet deadline budget to each corpus pass, not a predicted runtime. For N representatives, the corresponding bound is 2N minutes, excluding build and orchestration costs. A fresh `gate:branch` may measure both main and head; a cached main avoids that repeated work. Small node counts do not prove cheap layouts.

Land corpus adoption separately from engine changes. Retain the pre-adoption baseline for existing-sheet comparison, then build a new main-SHA baseline after adoption. Record the source commit and the exact admitted file list alongside the TSV. Never compare aggregate scores over different file sets as a quality change.

Critical admission gap: `scripts/gate-compare.mjs:90–99` reports head-only sheets without a WORSE flag, and unchanged ERROR rows do not fail the comparison. A passing branch comparison does not admit a new sheet. Check each added row absolutely: successful layout, zero error-severity gates, zero removed links, and completed fidelity review.

## 2. Conversion method and ownership

Commit authored portograph YAML, as `goldens/real/` already does. A one-off, data-only extractor may emit nodes, source-link indices and a draft; retain its revision/hash in the import record if used. Its output is then reviewed and hand-edited. Do not promise regeneration from the netlab file alone.

Reason: 54 small labs need visual decisions regardless of automation. Group inheritance, exercise scaffolding and drawing-only roles make a maintained general converter a separate product. Supporting netlab plugins would expand that commitment substantially.

Authority is explicit:

- The static netlab files own node identity and physical link incidence, including parallel multiplicity. Read referenced local YAML as data where required; never run plugins, templates, hooks or lab commands.
- The reference PNG owns displayed AS boundaries, visible nesting, labels and broad hierarchy. It can supply an intended role or AS absent from an unfinished lab configuration; record that fact as drawing-derived.
- The author records explicit group tiers and declaration order from that hierarchy. The engine owns positions, ranks, port sides, port order, bends and spacing. Default to ranked groups and normal layout settings.
- A contradiction between YAML and PNG requires an itemised reconciliation. Unresolved active-link or AS conflicts stay pending; a worker must not silently choose whichever makes rendering easier.

For each lab keep a review record with resolved node/AS/role facts and their source, group membership and nesting, explicit tiers, and a source-link ledger. The ledger accounts for every source link as kept, projected LAN/stub, loopback omitted, or documented scaffolding omitted. This record is the durable authored hint set; no generator needs to consume it.

## 3. Field-by-field mapping

| Source concept | Portograph mapping and rule |
| --- | --- |
| Document | `portograph: 2`, `profile: network`, source lab title. No CSS or layout tuning by default. |
| Nodes | Preserve IDs and visible labels. Accept list-form nodes and null-valued node maps. Expand explicitly enabled group auto-creation using literal members; `session/9-dynamic` has five nodes, not just the explicit `hub`. Wildcard `*` adds no node. Unresolved endpoint names are errors. |
| AS values | Read both `bgp.as` and nested `bgp: { as: ... }`. Resolve node override, then applicable group values, then global value. Agreeing group values are safe; conflicting values require a recorded resolution, not an invented precedence. A missing ASN stays unknown unless the PNG supplies it. |
| Routers | `class: router, icon: router`. Do not infer host or switch from a short node name alone. |
| Hosts | `class: server, icon: server`; use explicit role or reference evidence. A lab host can run FRR. In `challenge/05-ebgp-dc`, H1–H4 are hosts in the PNG despite their FRR configuration. |
| Switches | `class: switch, icon: switch` when the source drawing or role establishes a switch. |
| Route reflectors | `class: rr, icon: server` only with configuration or drawing evidence. |
| Route servers | `class: route-server, icon: server`, with the original node label. This class is descriptive and accepted by the parser; do not call an IXP route server a route reflector. Check its legend entry during review. |
| AS boxes | One group per displayed AS domain, with IDs prefixed `as-`. Use labels such as `AS 65207` or `Customer: AS 65000`. Preserve meaningful prefixes, case and ASN; normalise whitespace. |
| Repeated ASN | Separate source site boxes remain separate groups, for example `as-65000-site-a` and `as-65000-site-b`. ASN equality does not justify merging boxes. |
| netlab groups | Resolve their inherited facts, but draw a box only when the reference shows it or a no-PNG import explicitly adopts it. `external`, `fix_frr`, `customer`, `leafs` are not automatically containers. Overlapping netlab groups cannot become overlapping portograph memberships. |
| No AS or no source box | Use an empty-label group for the source row, with explicit tier, and record the required structural group. Do not invent an AS. |
| Nested boxes | Use `parent:` only for one real child-container level inside a ranked parent; the child has no `tier` or `shape`. Use a canton only for a real outer box spanning consecutive tier groups. Its members carry `canton:` and `tier:`; the canton carries only its label/class. Unsupported nesting remains pending. |
| Tiers | Identify broad source rows from top to bottom, assign 0,1,2… to top-level groups. A horizontal hierarchy may be rotated into vertical tiers; record the rotation and exact group-to-tier table before rendering. A spanning AS normally remains one ranked group. Do not split it into invented boxes to imitate coordinates. |
| Order | Declare groups and nodes in the reference reading order, with source order as tie-break. Record this as an initial order, not a fixed output constraint. No port `side`/`order`, ELK options or forced routes to copy pixels. |
| Ports | Omit `ports`; use bare-node endpoints. Do not fabricate `eth0`, `swp1`, etc. An explicit interface label in a later source may become a named port, but bgplab's addresses and endpoint attributes are not names. |
| Two-ended links | One `links` entry per retained physical source link, routed with the default class. Stable ID `src-link-001` uses the original one-based source index. A same-AS cable does not automatically become `class: peer` or an overlay. |
| Parallel links | Preserve every occurrence, including identical endpoint pairs. Distinct IDs and anonymous ports keep the multiplicity. Never collapse to one link or use `route: merge` merely to pass gates. |
| Link names | Preserve a source `name` as `label` on a retained two-ended link, even when the PNG omits it; record this addition. For a projected LAN/stub put the name on the medium node once. Do not invent names for unnamed links. |
| Link paint | Source colour and EBGP arrow paint are not cable classes. Default physical links stay solid and routed. Preserve a meaningful physical style only with a stated source meaning. |
| Logical arrows | Drop EBGP/IBGP/BFD/session arrows from this physical-topology corpus; enumerate their type and endpoints in the record. They are not extra cables. An overlay corpus can be a separately named future variant. |
| Other configuration | Drop addressing, prefixes except needed stub labels, route policy, timers, protocol settings, validation, deployment data and credentials. List categories present; never copy credential values into artifacts or logs. |
| Notes and callouts | Drop instructional notes, callout arrows, legends and decorative styling. Name each visual callout in the record/header, so a reviewer can distinguish it from a lost physical link. |

Normalise netlab link forms before transcription: `a-b`, `[a,b]`, endpoint-key maps, and `interfaces:` arrays of strings or `{node: ...}` maps. Split shorthand only when it resolves unambiguously against known node IDs. In a map, only known node keys are endpoints; `name`, `pool`, `prefix`, `type` and protocol options are attributes. Unknown keys or forms require review rather than guessed endpoints.

### LANs, stubs and scaffolding

For a source LAN with three or more participants, create one synthetic node `lan-<source-index>` with `class: cloud, icon: cloud`. Label it with the source name or `LAN <source-index>`. Put it in an empty-label neutral group outside all AS boxes unless the drawing explicitly places the whole medium inside one domain. Connect each participant once to that node, using IDs `src-link-003-leg-01`, etc. Record the ordered participant list and the synthetic node.

This is an incidence-preserving projection of one shared medium. It adds one declared node, not an inferred switch or router. A four-member LAN becomes four legs, never a clique of six cables. Do not use `group-link`, `mesh bus` or `shape: bar` as a LAN shorthand: those constructs have different semantics. A two-participant LAN may remain one ordinary link, with that simplification recorded.

A retained one-participant physical stub gets a synthetic cloud node `stub-<index>`, labeled with its name, explicit subnet, or `Stub <index>`. It is connected to its real node with one ordinary link. Do not use `route: stub`: that is a drawing technique, and the parser currently warns and falls back. Explicit loopback-type links are configuration, not physical stubs; omit and list them.

Unused scaffolding may be omitted only when the source explicitly identifies it as unused, or accompanying documentation establishes its purpose, and the reference does not draw it. `pool: l2only` alone is insufficient evidence. A source-only active link or stub must be retained and recorded as an addition to the PNG, or stay pending if its interpretation conflicts with the drawing. The inventory's automatic unused classification is a review hint, not authority to delete links.

## 4. Duplicates

Keep one sheet per distinct retained topology-plus-drawing contract, not one sheet per exercise. Keep all 54 manifest entries, each pointing to its canonical sheet or pending fixture. Choose the lexicographically first lab ID as representative after review; do not rename it when later sources arrive.

Compare node labels/classes, physical incidence with multiplicity, LAN participant sets, retained link labels, group labels/membership/nesting, explicit tiers and authored order. Title and instructional notes alone do not warrant another layout sheet. Pixel differences limited to dropped callouts, colours or EBGP arrows do not create a variant. Different membership, label lengths, meaningful rows or roles do.

Use the inventory signatures only to nominate pairs. Its route-server/passive grouping and its BFD/multihomed grouping need visual checks; names and roles differ. Do not collapse every isomorphic graph or every same-AS-count lab. Identical YAML bodies establish an alias only after both source drawings have been reviewed.

## 5. Fidelity and approval

Review both the source PNG and the generated PNG at readable resolution. A passing numeric score cannot prove a correct conversion.

1. Match every real node, visible label and role; separate real nodes from explicitly listed medium nodes.
2. Match each AS/site boundary and its members, including repeated ASNs in different boxes and any nesting.
3. Compare undirected physical link multisets. Reconstruct each LAN from its synthetic node's exact neighbors; check stubs and parallel counts separately.
4. Reconcile every difference using the ledger. Missing active links, hidden members or unrecorded box changes fail review.
5. Check the broad authored hierarchy. Exact positions, crossings and bends need not match the reference; assess the engine's result using `docs/design/quality.md`.
6. Check all error gates and `removedLinks`, even when CLI exit status is zero. Inspect diagnostics, warnings and labels; all real connectivity must remain represented.

Record reviewer, source hashes, portograph commit, counts, tier map, artifact paths, outcome and any ticket. Approval makes this an admitted corpus input; it does not silently create an exact-layout snapshot or a new Q threshold. Those require the existing golden-approval process.

## 6. Failing sheets

A faithful sheet with ERROR, TIMEOUT, any error-severity gate, or removed links stays outside `goldens/`. Preserve its full input, source ledger, exact diagnostics, timing and reproduction command in the pending location. Create a focused architecture issue and link it from the manifest. This follows ticket 49's original quarantine rule; that ticket is now fixed and its sheet has since moved into `goldens/real/`.

Warnings are reviewed and recorded, not automatically disqualifying. Unresolved source fidelity is a separate pending status from an engine defect. Conversion errors are corrected before filing an engine ticket.

Never shorten true labels, delete troublesome links, change classes to overlay, remove boxes or raise the normal deadline to obtain admission. After an engine fix, rerun the unchanged faithful fixture, review its PNG, then move it into the corpus. Report pending counts prominently so a curated green set is not mistaken for support of all 54 labs.

## 7. Header and filenames

Use `<category>-<original-lab-directory>.yaml`, lower case, replacing `_` with `-`; for example `policy-e-wedgies.yaml`, `session-1-allowas-in.yaml`. Preserve numeric/letter prefixes. If normalisation collides, stop and allocate a manifest-approved suffix. New sources use their own source directory.

```yaml
# Source: https://github.com/bgplab/bgplab/blob/4bd74dbc7f19f172d51cda9ff681303f7e152a5a/policy/e-wedgies/topology.yml
# Reference: https://github.com/bgplab/bgplab/blob/4bd74dbc7f19f172d51cda9ff681303f7e152a5a/docs/policy/topology-wedgies.png
# Licence: MIT; Copyright (c) 2023–2024 Ivan Pepelnjak
# Author: Ivan Pepelnjak (bgplab/bgplab)
# Fetched: 2026-11-06
# Conversion: authored from static YAML and reference PNG; recipe bgplab-v1
# Record: ref/corpora/bgplab/reviews/policy-e-wedgies.json
# Kept: <N real nodes, AS/site boxes, P physical pairs, L LANs, S stubs, names>
# Added: <synthetic medium IDs and exact participants; source-only visible labels>
# Simplified: <two-member LANs, orientation, icon substitutions; or none>
# Dropped links: <source indices, endpoints and evidence; or none>
# Dropped annotations: <individual callouts and logical-arrow sets; or none>
# Dropped configuration: <categories present; no values or secrets>
# Tiers/order: <group-to-tier table and source reading order; engine may reorder>
# Aliases: <other lab IDs using this sheet; or none>
portograph: 2
profile: network
```

Replace placeholders, use the actual source-capture date, and add fixed-commit URLs for every YAML dependency that contributed a retained fact. If no reference exists, write `Reference: none; static-source reconstruction` and identify the hierarchy evidence. Store SHA-256 hashes of input files and reference images in the review record. Preserve the complete upstream licence notice in `ref/corpora/bgplab/LICENSE.md`; a header URL alone is not the notice copy.

## 8. Batches without collisions

Use four conversion workers, each responsible for every lab in its assignment, including duplicate candidates and failures:

| Worker | Categories | Labs |
| --- | --- | --- |
| w01 | basic | 14 |
| w02 | policy | 15 |
| w03 | session and ibgp | 12 |
| w04 | challenge and lb | 13 |

Freeze a 54-row assignment manifest before dispatch. Workers write only their own `/tmp/bgplab/conversions/wNN/<lab-slug>/` directory: draft YAML, review JSON, source references, renders and logs. They do not edit shared indexes, gate scripts, notices or another lab's files. They may nominate aliases but cannot delete another worker's candidate.

The coordinator reconciles cross-batch duplicates, assembles the single manifest and licence, installs approved representatives, and files pending fixtures. This avoids shared-file collisions and duplicate gate entries. Use one coordinator-owned queue for expensive renders; never bypass the machine-wide lock to obtain four-way render concurrency.

## 9. Netlab fabric as a separate generator

Adopt the fabric idea as a small portograph-owned parametric generator, not a bgplab lab and not a dependency on executing netlab. The [fabric documentation](https://netlab.tools/plugins/fabric/) defines spine/leaf counts, names/groups, copied group attributes and per-node formatted attributes; it prepends complete leaf-to-spine links, while hosts are supplied separately. Pin a documentation/source revision when implementing the generator.

Use a typed parameter record: positive integer `spines`, `leafs`, `hostsPerLeaf` restricted initially to 0 or 1, and `mode: ibgp|ebgp`. Emit every spine/leaf pair once; with hosts, emit H_i–L_i once. Link count is S×L + H×L and real node count is S+L+H×L. This is a deliberately smaller contract than arbitrary netlab expressions; never evaluate source strings with `eval`.

For iBGP use AS 65000, RR spines, leaf routers, and an AS canton over tier-0 spines and tier-1 leaves; hosts belong to tier 2 outside it. For EBGP use spine AS 65100 and leaf AS 65000+i, with one box per AS; no spines are labelled RR. Physical links stay routed; neither mode synthesizes session overlays.

Proposed scale matrix: S×L = 1×2, 2×4, 4×8, 8×32, 16×64; each with 0/1 host per leaf and both modes. Keep these 20 generated cases and parameters under `.scratch/stress/fabric/`, with a future explicit locked `stress:fabric` command and bounded per-case runtime. No claim that the largest cases meet 120 seconds. Reuse the stress reporting conventions, but treat old measurements as historical.

Initially consider at most two additional passing small goldens: 2×4 iBGP without hosts and 2×4 EBGP with hosts, under `goldens/fabric/`. Admit only if their grouping/role contract adds coverage beyond bgplab, `private-datacenter-spine-leaf.yaml` and `avd-dual-dc-l3ls.yaml`. The shared-AS canton versus separate-AS groups is the useful distinction; more 2×4 physical meshes alone add little. Use names such as `s02-l04-h1-ebgp.yaml`.

Do not place the full matrix in `test/fixtures/sweep/`: sweep runs in every branch gate and checks removals, not the whole scale contract. A later minimal reproducer may join sweep when a specific removal bug requires it. Share a portograph emitter or review format if useful, but do not build one general netlab converter for bgplab and fabric. One is an authored reference import; the other is an owned parameter generator.

## Later external sources

Apply the same contract under `goldens/<source>/` and `ref/corpora/<source>/`: pinned source, notice, full inventory, authored semantics, source-link ledger, absolute admission checks and documented aliases. Keep source-specific parsers outside the engine. Cross-source duplicates can point to an existing canonical sheet while retaining their own provenance; a new source must add a distinct retained layout contract to justify another gate row. Sources without a PNG use an explicitly marked static reconstruction review.

## Recipe

1. Read this decision, `CONTEXT.md`, the assigned inventory rows and the source licence. Confirm the pinned source commit.
2. Create only your assigned lab directories. Record source paths, fixed URLs, capture date and hashes.
3. Open each source topology and reference PNG. Follow relevant YAML dependencies as data; execute no upstream code.
4. Resolve all nodes, inherited AS values and roles. Include auto-created literal group members; resolve unknown references explicitly.
5. Write the group, label, tier and order table. Record PNG-derived facts and any rotated hierarchy before rendering.
6. Normalise every link into a source-indexed ledger. Preserve multiplicity; classify LANs, stubs, loopbacks and proven unused scaffolding.
7. Author schema-v2 YAML using the mappings above. Give all retained links stable IDs and all synthetic nodes explicit provenance.
8. Fill the complete header and review record. List every dropped cable and annotation; do not copy configuration secrets.
9. Submit the file to the coordinator's render queue. Use the existing build and locked CLI, writing outputs to your own temporary directory:
   `node scripts/with-lock.mjs bgplab-review -- node bin/portograph.mjs render <draft.yaml> --output <out.svg> --diagnostics json`
10. Generate a PNG with `npm run png -- <out.svg> <out.png>`. Read it beside the source; inspect score JSON and diagnostics.
11. Record fidelity, gates, removed links, runtime and warnings. Keep failures unchanged and nominate their pending status or engine ticket.
12. Review every duplicate candidate independently. Submit alias proposals and all assigned records; leave final selection to the coordinator.
13. Coordinator: reconcile all 54 rows, install representatives and pending fixtures, then run `npm run corpus -- <head.tsv>` and inspect every new row.
14. Coordinator: complete normal `gate:branch` checks after the adoption changes are ready; regenerate the main baseline after merge.

## Open questions for the user

1. Is the physical-topology scope sufficient, with instructional session arrows omitted and shared LANs shown as labelled medium nodes? Recommended: yes.
2. Should fabric generation be a follow-up after bgplab admission? Recommended: yes, so its matrix and runtime cost are reviewed separately.
