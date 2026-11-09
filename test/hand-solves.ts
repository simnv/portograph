import { readFileSync } from 'node:fs';

// Hand-solved sheets that several tests lay out. Each constant is the YAML text of one sheet, unchanged.

export const RING_IN_A_ROW = `# Hand-solve case 01. Four routers in a ring, each with a host below. All four stand on one tier,
# so the closing link R4-R1 is a peer link along the row. Stage 5 gives its ports lateral sides
# from the row order, and the path must leave the tier band to pass R2 and R3.
portograph: 2
profile: network
groups:
  ring: { tier: 0, label: Ring }
  hosts: { tier: 1, label: Hosts }
nodes:
  r1: { group: ring, class: router, label: R1 }
  r2: { group: ring, class: router, label: R2 }
  r3: { group: ring, class: router, label: R3 }
  r4: { group: ring, class: router, label: R4 }
  h1: { group: hosts, class: server, label: H1 }
  h2: { group: hosts, class: server, label: H2 }
  h3: { group: hosts, class: server, label: H3 }
  h4: { group: hosts, class: server, label: H4 }
links:
  - [r1, r2]
  - [r2, r3]
  - [r3, r4]
  - [r4, r1]
  - [r1, h1]
  - [r2, h2]
  - [r3, h3]
  - [r4, h4]
`;

export const MESH_ACROSS_A_TIER = `# Hand-solve case 04. Three nodes on tier 0 and three on tier 2 form a full mesh of nine routed
# links. One core node stands on tier 1 between them. Each mesh link transits tier 1 through its
# own lane beside the core frame, so nine lanes stand beside one body.
portograph: 2
profile: network
groups:
  north: { tier: 0, label: North }
  core: { tier: 1, label: Core }
  south: { tier: 2, label: South }
nodes:
  n1: { group: north, class: router, label: N1 }
  n2: { group: north, class: router, label: N2 }
  n3: { group: north, class: router, label: N3 }
  c1: { group: core, class: router, label: C1 }
  s1: { group: south, class: switch, label: S1 }
  s2: { group: south, class: switch, label: S2 }
  s3: { group: south, class: switch, label: S3 }
links:
  - [n2, c1]
  - [c1, s2]
  - [n1, s1]
  - [n1, s2]
  - [n1, s3]
  - [n2, s1]
  - [n2, s2]
  - [n2, s3]
  - [n3, s1]
  - [n3, s2]
  - [n3, s3]
`;

export const FLANK_LINK_AROUND_A_NEIGHBOUR = `# Hand-solve case 09. A left flank of the core links to a canton member on tier 1 and to the core.
# A branch group stands between the flank and the canton. The flank link to the member must pass
# the branch; the tier-gap plan covers gaps between tiers only, so the route runs along the core
# edge and fails G6 (architecture ticket 12, cause C). The port lists follow the ticket 12 matrix
# sheet, so the sizes are the ones that show the fault.
portograph: 2
profile: network
groups:
  campus: { label: Campus }
  wan: { tier: 0, label: WAN }
  core: { tier: 1, label: Core }
  branch: { tier: 1, label: Branch }
  dist: { tier: 1, canton: campus, label: Distribution }
  access: { tier: 2, canton: campus, label: Access }
  mgmt: { align: left, of: core, label: Management }
nodes:
  wan-1: { group: wan, class: router, label: WAN 1, ports: [100G, 100G, 100G, 100G, 100G, 100G] }
  core-1: { group: core, class: router, label: Core 1, ports: [100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G] }
  br-1: { group: branch, class: router, label: Branch 1, ports: [100G, 100G, 100G, 100G, 100G, 100G, 100G, 100G] }
  dist-1: { group: dist, class: router, label: Dist 1, ports: [100G, 100G, 100G, 100G] }
  acc-1: { group: access, class: switch, label: Access 1, ports: [100G, 100G] }
  mg-1: { group: mgmt, class: server, label: Mgmt 1, ports: [100G, 100G] }
links:
  - [wan-1.100G, core-1.*]
  - [wan-1.100G, br-1.*]
  - [wan-1.100G, dist-1.*]
  - [dist-1.100G, acc-1.*]
  - [mg-1.100G, dist-1.*]
  - [mg-1.100G, core-1.*]
`;

export const SYNC_MESH_ON_THREE_ROWS = `# Hand-solve case 11. Nine nodes on three tiers, three per tier, in one full sync mesh of 36
# overlay links, with a routed spine a1 -> b1 -> c1. A mesh bus spans one row, and a join takes
# two rows at most, so each row gets its own bus and the 27 cross links stay plain overlay lines.
portograph: 2
profile: network
groups:
  top: { tier: 0, label: Top }
  mid: { tier: 1, label: Middle }
  low: { tier: 2, label: Low }
nodes:
  a1: { group: top, class: server, label: A1 }
  a2: { group: top, class: server, label: A2 }
  a3: { group: top, class: server, label: A3 }
  b1: { group: mid, class: server, label: B1 }
  b2: { group: mid, class: server, label: B2 }
  b3: { group: mid, class: server, label: B3 }
  c1: { group: low, class: server, label: C1 }
  c2: { group: low, class: server, label: C2 }
  c3: { group: low, class: server, label: C3 }
links:
  - [a1, b1]
  - [b1, c1]
  - { from: a1, to: a2, class: sync }
  - { from: a1, to: a3, class: sync }
  - { from: a1, to: b1, class: sync }
  - { from: a1, to: b2, class: sync }
  - { from: a1, to: b3, class: sync }
  - { from: a1, to: c1, class: sync }
  - { from: a1, to: c2, class: sync }
  - { from: a1, to: c3, class: sync }
  - { from: a2, to: a3, class: sync }
  - { from: a2, to: b1, class: sync }
  - { from: a2, to: b2, class: sync }
  - { from: a2, to: b3, class: sync }
  - { from: a2, to: c1, class: sync }
  - { from: a2, to: c2, class: sync }
  - { from: a2, to: c3, class: sync }
  - { from: a3, to: b1, class: sync }
  - { from: a3, to: b2, class: sync }
  - { from: a3, to: b3, class: sync }
  - { from: a3, to: c1, class: sync }
  - { from: a3, to: c2, class: sync }
  - { from: a3, to: c3, class: sync }
  - { from: b1, to: b2, class: sync }
  - { from: b1, to: b3, class: sync }
  - { from: b1, to: c1, class: sync }
  - { from: b1, to: c2, class: sync }
  - { from: b1, to: c3, class: sync }
  - { from: b2, to: b3, class: sync }
  - { from: b2, to: c1, class: sync }
  - { from: b2, to: c2, class: sync }
  - { from: b2, to: c3, class: sync }
  - { from: b3, to: c1, class: sync }
  - { from: b3, to: c2, class: sync }
  - { from: b3, to: c3, class: sync }
  - { from: c1, to: c2, class: sync }
  - { from: c1, to: c3, class: sync }
  - { from: c2, to: c3, class: sync }
`;

const BY_NAME: Record<string, string> = {
  'hand-solves/01-ring-in-a-row.yaml': RING_IN_A_ROW,
  'hand-solves/04-mesh-across-a-tier.yaml': MESH_ACROSS_A_TIER,
  'hand-solves/09-flank-link-around-a-neighbour.yaml': FLANK_LINK_AROUND_A_NEIGHBOUR,
  'hand-solves/11-sync-mesh-on-three-rows.yaml': SYNC_MESH_ON_THREE_ROWS,
};

/** The text of a sheet: a hand-solved sheet by its `hand-solves/<name>.yaml` key, any other sheet from the file at that path. */
export const readSheet = (path: string): string => BY_NAME[path] ?? readFileSync(path, 'utf8');
