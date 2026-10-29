import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve, restoreLayoutModel } from '../../src/internal.js';
import type { LayoutModel, PortRef, Side } from '../../src/index.js';
import { portKey, sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { rowGap } from '../../src/layout/sides-two.js';
import { groupPadding } from '../../src/layout/regions.js';
import { rawBandSide, rawFrameSide } from '../../src/layout/bands.js';
import { busSide, meshBuses } from '../../src/layout/bus.js';
import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { CreateElkAttempt } from '../../src/layout/elk-worker.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Ticket 114 (docs/design/side-faces.md, Q109): a side hint is an input of placement, applied at stage 2 of a placement run. */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
type Hints = ReadonlyMap<string, 'left' | 'right'>;

interface Run { model: LayoutModel; graph: ElkNode }
interface Forged { nodes: Record<string, { ports: { sideHint?: true; naturalSide?: string; side: string }[] }>; freeze: { nodeFloors: { node: string; size: { width: number; height: number } }[] } }
// The `reservations` field (architecture 2, ticket 03) is the declared ledger of the run, not geometry: the bytes main made have none.
const withoutRuntime = (model: LayoutModel): string => JSON.stringify(model, (key, value: unknown) => key === 'runtime' || key === 'reservations' ? undefined : value);
async function run(yaml: string, hints?: Hints, floors?: ReadonlyMap<string, { width: number; height: number }>): Promise<Run> {
  const graphs: string[] = [];
  const createElkAttempt: CreateElkAttempt = () => {
    const attempt = createAttempt();
    return { layout: graph => { graphs.push(JSON.stringify(graph)); return attempt.layout(graph); }, terminateWorker: () => attempt.terminateWorker() };
  };
  const model = await layout(parse(yaml), { createElkAttempt, createRouteAttempt: createAvoidAttempt,
    ...(hints ? { testSideHints: hints } : {}), ...(floors ? { testNodeFloors: floors } : {}) });
  return { model, graph: JSON.parse(graphs[0]!) };
}
const port = (model: LayoutModel, node: string, link: number) => {
  const ends = model.links[link]!.attachments!;
  const ref: PortRef = ends.from.node === node ? ends.from : ends.to;
  return { ref, key: portKey(ref), port: model.nodes[node]!.ports.find(item => portKey(item.ref) === portKey(ref))! };
};
/** The sizes the skeleton graph was built from: what a measured run hands the next one as its floors. */
const graphSizes = (graph: ElkNode, nodes: string[]): Map<string, { width: number; height: number }> => {
  const found = new Map<string, { width: number; height: number }>();
  const visit = (item: ElkNode): void => {
    if (item.id.startsWith('node:') && nodes.includes(item.id.slice(5))) found.set(item.id.slice(5), { width: item.width!, height: item.height! });
    for (const child of item.children ?? []) visit(child);
  };
  visit(graph);
  return found;
};

describe('a side hint puts a port on a lateral side in the next placement run (ticket 114)', () => {
  it('moves an anonymous port to the hinted side, keeps the ELK graph and the width, and passes G5', async () => {
    const yaml = fixture('a-side-hint-moves-a-port-to-a-lateral-side');
    const plain = await run(yaml);
    const { key, port: before } = port(plain.model, 'server', 1);
    expect(before.side).toBe('bottom');
    expect(before.sideHint).toBeUndefined();
    expect(before.naturalSide).toBeUndefined();
    const server = plain.model.nodes['server']!.bounds!;
    expect(plain.model.nodes['beside']!.bounds!.x + plain.model.nodes['beside']!.bounds!.width / 2).toBeGreaterThan(server.x + server.width / 2);

    const hinted = await run(yaml, new Map([[key, 'right']]), graphSizes(plain.graph, ['server']));
    const after = port(hinted.model, 'server', 1).port;
    expect(after.side).toBe('right');
    expect(after.sideHint).toBe(true);
    expect(after.naturalSide).toBe('bottom');
    expect(port(hinted.model, 'server', 0).port.side).toBe('bottom');
    expect(hinted.graph).toEqual(plain.graph);
    expect(JSON.stringify(hinted.graph)).toBe(JSON.stringify(plain.graph));
    // No narrower than the size the measured run built its skeleton from. (7c widens the unhinted server further to reach its feed; the hinted link is no feed, spec Section 7.)
    expect(hinted.model.nodes['server']!.bounds!.width).toBeGreaterThanOrEqual(graphSizes(plain.graph, ['server']).get('server')!.width - 1e-6);
    expect(hinted.model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(score(hinted.model).snapshot.gates.G5.passed).toBe(true);
    // The frozen topology and the node floors record the hint (ADR-0022).
    const frozen = hinted.model.freeze!.topology.find(item => item.node === 'server')!.ports.filter(item => item.sideHint);
    expect(frozen).toEqual([expect.objectContaining({ side: 'right', sideHint: true, naturalSide: 'bottom' })]);
    expect(hinted.model.freeze!.nodeFloors!.map(floor => floor.node)).toEqual(['server']);
    expect(plain.model.freeze!.nodeFloors).toBeUndefined();
  }, 60000);

  it('reads the natural side for the ELK port side, and the hinted side for the drawn one', async () => {
    const yaml = fixture('a-side-hint-moves-a-port-to-a-lateral-side');
    const plain = await run(yaml);
    const { key } = port(plain.model, 'server', 1);
    // Without the floors the graph may differ in size only; the port sides in it never do.
    const hinted = await run(yaml, new Map([[key, 'right']]));
    const sides = (graph: ElkNode): string[] => {
      const found: string[] = [];
      const visit = (item: ElkNode): void => { for (const p of item.ports ?? []) found.push(`${p.id}:${p.layoutOptions?.['elk.port.side']}`); (item.children ?? []).forEach(visit); };
      visit(graph);
      return found.sort();
    };
    expect(sides(hinted.graph)).toEqual(sides(plain.graph));
  }, 60000);
});

describe('what a named lateral port changes (ticket 114, spec Section 7)', () => {
  const yaml = `portograph: 2
groups:
  top: {tier: 0}
  low: {tier: 1}
nodes:
  server: {group: top, ports: [{name: uplink-to-the-edge}]}
  next: {group: top}
  under: {group: low}
links:
  - [server.uplink-to-the-edge, under]
`;
  it('grows the content inset, the group padding and the row gap on the hinted side', async () => {
    const plain = await run(yaml);
    const { key } = port(plain.model, 'server', 0);
    const hinted = await run(yaml, new Map([[key, 'right']]));
    const inset = (model: LayoutModel, side: Side): number => model.nodes['server']!.contentInsets![side];
    expect(inset(hinted.model, 'right')).toBeGreaterThan(inset(plain.model, 'right'));
    expect(inset(hinted.model, 'bottom')).toBe(10);
    const padding = (model: LayoutModel) => groupPadding(model, model.groups['top']!);
    expect(padding(hinted.model).right).toBeGreaterThan(padding(plain.model).right);
    expect(padding(hinted.model).bottom).toBeLessThan(padding(plain.model).bottom + 1e-6);
    const order = hinted.model.groups['top']!.rowOrder!;
    const [left, right] = order.indexOf('server') < order.indexOf('next') ? ['server', 'next'] : ['next', 'server'];
    if (left === 'server') expect(rowGap(hinted.model, 'server', 'next')).toBeGreaterThan(rowGap(plain.model, 'server', 'next'));
    else expect(right).toBe('server');
  }, 60000);
});

describe('a hinted face is sized at stage 3 (ticket 114, spec Section 8)', () => {
  const yaml = `portograph: 2
groups:
  top: {tier: 0}
  low: {tier: 1}
nodes:
  server: {group: top, ports: [{name: a}, {name: b}, {name: c}]}
  x: {group: low}
  y: {group: low}
  z: {group: low}
links:
  - [server.a, x]
  - [server.b, y]
  - [server.c, z]
`;
  const sized = (hinted: boolean) => {
    const model = resolve(parse(yaml));
    const keys = ['a', 'b', 'c'].map(name => portKey(model.nodes['server']!.ports.find(item => item.ref.name === name)!.ref));
    sidesOne(model, hinted ? new Map(keys.map(key => [key, 'right'] as const)) : undefined);
    return sizeNodes(model).nodes['server']!;
  };
  it('three hints on one face grow the node height by the stage-3 formula, before any later stage', () => {
    const plain = sized(false), hinted = sized(true);
    // n x pitch + 2 x padding, with the pitch the pills give the face and the 10 px padding.
    const pitch = hinted.sidePitch!.right!;
    expect(pitch).toBeGreaterThanOrEqual(14);
    expect(hinted.size!.height).toBe(Math.max(hinted.sizeFloor!.height, 3 * pitch + 20));
    expect(hinted.size!.height).toBeGreaterThan(plain.size!.height);
    expect(hinted.size!.width).toBeLessThanOrEqual(plain.size!.width);
  });
});

describe('a hint on a port that is no candidate throws (ticket 114, spec Section 4)', () => {
  const hint = (yaml: string, pick: (model: LayoutModel) => PortRef): void => {
    const model = resolve(parse(yaml));
    sidesOne(resolve(parse(yaml)), new Map([[portKey(pick(model)), 'right']]));
  };
  const at = (node: string, name?: string) => (model: LayoutModel): PortRef => model.nodes[node]!.ports.find(item => name === undefined || item.ref.name === name)!.ref;
  it('refuses a bus port', () => {
    const yaml = fixture('a-bus-in-a-rank-gap-grows-the-gap');
    expect(() => hint(yaml, model => model.meshBuses![0]!.ports[0]!)).toThrow(/mesh bus/);
  });
  it('refuses a bundle member', () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [p, q]}
  b: {group: h, ports: [p, q]}
links: [[a.p, b.p], [a.q, b.q]]
`;
    expect(() => hint(yaml, at('a', 'p'))).toThrow(/bundle/);
  });
  it('refuses an author-sided port', () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [{name: p, side: bottom}]}
  b: {group: h}
links: [[a.p, b]]
`;
    expect(() => hint(yaml, at('a', 'p'))).toThrow(/author side/);
  });
  it('refuses a transit link', () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}, m: {tier: 1}, h: {tier: 2}}
nodes:
  a: {group: g, ports: [p]}
  mid: {group: m}
  b: {group: h}
links: [[a.p, b], [mid, b]]
`;
    expect(() => hint(yaml, at('a', 'p'))).toThrow(/transit lane/);
  });
  it('refuses, at stage 5, a port whose stage-2 side was an estimate and whose vote is lateral', async () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [p]}
  b: {group: g, ports: [q]}
links: [[a.p, b.q]]
`;
    const plain = await run(yaml);
    const { key } = port(plain.model, 'a', 0);
    await expect(run(yaml, new Map([[key, 'right']]))).rejects.toThrow(/its natural side is (left|right)/);
  }, 60000);
  it('refuses a fan and a route override, and accepts the plain port', () => {
    const fan = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [p]}
  b: {group: h}
  c: {group: h}
links: [[a.p, b], [a.p, c]]
`;
    expect(() => hint(fan, at('a', 'p'))).toThrow(/fan/);
    const orthogonal = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [p]}
  b: {group: h}
links: [[a.p, b, {route: orthogonal}]]
`;
    expect(() => hint(orthogonal, at('a', 'p'))).toThrow(/route override/);
    const plain = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [p]}
  b: {group: h}
links: [[a.p, b]]
`;
    expect(() => hint(plain, at('a', 'p'))).not.toThrow();
  });
});

describe('restore checks the stored hint against the document and the geometry (ticket 114, spec Section 13)', () => {
  it('accepts the hinted layout, and rejects a forged natural side or a floor below the content', async () => {
    const yaml = fixture('a-side-hint-moves-a-port-to-a-lateral-side');
    const plain = await run(yaml);
    const { key } = port(plain.model, 'server', 1);
    const { model } = await run(yaml, new Map([[key, 'right']]), graphSizes(plain.graph, ['server']));
    const json = JSON.stringify(model);
    expect(restoreLayoutModel(json).nodes['server']!.ports.filter(item => item.sideHint)).toHaveLength(1);

    const forge = (change: (copy: Forged) => void): string => { const copy = JSON.parse(json) as Forged; change(copy); return JSON.stringify(copy); };
    const hinted = (copy: Forged) => copy.nodes.server!.ports.find(item => item.sideHint)!;
    // The hint without its natural side, and a natural side that is lateral.
    expect(() => restoreLayoutModel(forge(copy => { delete hinted(copy).naturalSide; }))).toThrow(/natural side/);
    expect(() => restoreLayoutModel(forge(copy => { hinted(copy).naturalSide = 'left'; }))).toThrow(/natural side|differs from document/);
    // A natural side other than the one the document gives.
    expect(() => restoreLayoutModel(forge(copy => { hinted(copy).naturalSide = 'top'; }))).toThrow(/differs from document/);
    // A stored floor below the node's content, and a floor above the node.
    expect(() => restoreLayoutModel(forge(copy => { copy.freeze.nodeFloors[0]!.size.width = 1; }))).toThrow(/below its content/);
    expect(() => restoreLayoutModel(forge(copy => { copy.freeze.nodeFloors[0]!.size.width = 5000; }))).toThrow(/smaller than its node floor/);
    // A floor on a node without a hinted port.
    expect(() => restoreLayoutModel(forge(copy => { copy.freeze.nodeFloors.push({ node: 'beside', size: { width: 50, height: 35 } }); }))).toThrow(/no hinted port/);
  }, 120000);
});

describe('with no hint the layout is byte-identical to main (ticket 114)', () => {
  // `a-linked-node-steps-out-of-a-straight-chord` is re-baselined for architecture ticket 10 (D3): the two top ports of `far` are centred on the widened face (31 px), and `mid` stands 17 px right under the chord; Q, crossings, bends and canvas are unchanged.
  // Hashes of the layout JSON without `runtime`, measured on main at e30c100. `a-group-holds-both-ends-of-a-bundle` is re-baselined for ranked-groups tickets
  // 100-102: link-1 takes a routed chord across its own title band (technique straight, one segment, `frozenChords`; the `ROUTED_CHORD_REFUSED` note is gone),
  // and nothing else in its layout differs (diffed against main's src at 964d77f). It is re-baselined again for architecture ticket 23, phase 1: the `GROUP_SHAPE_DECLINED` message gains `(reason: authored-side)`, and nothing else in its layout differs. The other three fixtures are untouched by them. `a-bar-end-keeps-its-corridor` is re-baselined for architecture ticket 19 (the bar is seated at the width 7d gives it: the lanes stand 3 px further out). `a-group-holds-both-ends-of-a-bundle` and `a-linked-node-steps-out-of-a-straight-chord` are re-baselined for architecture ticket 17: their free rows gain a `rowOrderDecision` record (`kept`), and nothing else differs (the hash without that key equals the old one). Each also compares a
  // no-hint run with a run with empty hint and floor maps, which is the ticket 114 claim itself.
  // Named pills use 9 px text. The hashes include the new pill size and the geometry that follows it.
  const main: Record<string, string> = {
    'a-group-holds-both-ends-of-a-bundle': '4a9c29350b722fb8',
    'a-bus-in-a-rank-gap-grows-the-gap': '2bf7ca0b64536533',
    'a-linked-node-steps-out-of-a-straight-chord': '4bf31e66a5f0601f',
    'a-bar-end-keeps-its-corridor': '3f50b23a8aa7440f',
  };
  it.each(Object.entries(main))('%s', async (name, hash) => {
    const { model } = await run(fixture(name));
    expect(createHash('sha256').update(withoutRuntime(model)).digest('hex').slice(0, 16)).toBe(hash);
    const empty = await run(fixture(name), new Map(), new Map());
    expect(withoutRuntime(empty.model)).toBe(withoutRuntime(model));
  }, 120000);
});

describe('the readers that name the natural side keep reading it (ticket 114, spec Section 7)', () => {
  const wide = `portograph: 2
groups:
  top: {tier: 0}
  low: {tier: 1}
nodes:
  server: {group: top, ports: [{name: alpha}, {name: bravo}, {name: charlie}, {name: delta}, {name: echo}, {name: foxtrot}]}
  c1: {group: low}
  c2: {group: low}
  c3: {group: low}
  c4: {group: low}
  c5: {group: low}
  c6: {group: low}
links:
  - [server.alpha, c1]
  - [server.bravo, c2]
  - [server.charlie, c3]
  - [server.delta, c4]
  - [server.echo, c5]
  - [server.foxtrot, c6]
`;
  it('a size floor keeps the width of the natural face, so the ELK graph is the same', async () => {
    const plain = await run(wide);
    const { key } = port(plain.model, 'server', 5);
    const sizes = graphSizes(plain.graph, ['server']);
    const withFloor = await run(wide, new Map([[key, 'right']]), sizes);
    const without = await run(wide, new Map([[key, 'right']]));
    expect(JSON.stringify(withFloor.graph)).toBe(JSON.stringify(plain.graph));
    // Without the floor the freed bottom slot narrows the node, and the skeleton input differs.
    expect(graphSizes(without.graph, ['server']).get('server')!.width).toBeLessThan(sizes.get('server')!.width);
    expect(withFloor.model.nodes['server']!.bounds!.width).toBeGreaterThanOrEqual(sizes.get('server')!.width - 1e-6);
  }, 60000);

  it('the title edge of a group counts a hinted port on its natural side', async () => {
    const yaml = `portograph: 2
groups:
  above: {tier: 0}
  mid: {tier: 1}
  below: {tier: 2}
nodes:
  u1: {group: above}
  u2: {group: above}
  m: {group: mid}
  d1: {group: below}
  d2: {group: below}
links:
  - [u1, m]
  - [u2, m]
  - [m, d1]
  - [m, d2]
`;
    const plain = await run(yaml);
    const { key } = port(plain.model, 'm', 2);
    const hinted = await run(yaml, new Map([[key, 'right']]));
    expect(port(hinted.model, 'm', 2).port.side).toBe('right');
    // Two ports on top and two at the bottom tie; reading the hinted side would count one at the bottom and move the title.
    expect(rawBandSide(hinted.model, hinted.model.groups['mid']!)).toBe(rawBandSide(plain.model, plain.model.groups['mid']!));
    expect(rawBandSide(hinted.model, hinted.model.groups['mid']!)).toBe('top');
  }, 60000);

  it('the mesh bus keeps the edge its natural-side leg count gives', async () => {
    const yaml = fixture('a-bus-in-a-rank-gap-grows-the-gap');
    const plain = await run(yaml);
    const { key } = port(plain.model, 'm3', 4);
    expect(plain.model.meshBuses![0]!.side).toBe('top');
    const resolved = resolve(parse(yaml));
    sidesOne(resolved, new Map([[key, 'right']]));
    expect(busSide(resolved, meshBuses(resolved)[0]!, true)).toBe('top');
    const hinted = await run(yaml, new Map([[key, 'right']]));
    expect(port(hinted.model, 'm3', 4).port.side).toBe('right');
    expect(hinted.model.meshBuses![0]!.side).toBe('top');
  }, 60000);
});

describe('review fixes (ticket 114)', () => {
  it('a hint on a node with a spare port does not throw, and the ELK graph differs only by the reserved height', async () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes:
  a: {group: g, ports: [p, spare]}
  b: {group: h}
links: [[a.p, b]]
`;
    const plain = await run(yaml);
    const { key } = port(plain.model, 'a', 0);
    const hinted = await run(yaml, new Map([[key, 'right']]), graphSizes(plain.graph, ['a']));
    // The spare port stays where the stage-2 rule put it (on `right`), so the hinted face now holds two ports and stage 3 reserves that height:
    // the node is taller in the graph, and nothing else in it differs (ports, sides, other nodes).
    const flat = (graph: ElkNode): string => JSON.stringify(graph, (key, value: unknown) => key === 'height' || key === 'elk.nodeSize.minimum' ? undefined : value);
    expect(flat(hinted.graph)).toBe(flat(plain.graph));
    expect(graphSizes(hinted.graph, ['a']).get('a')!.height).toBeGreaterThan(graphSizes(plain.graph, ['a']).get('a')!.height);
    const spare = (model: LayoutModel) => model.nodes['a']!.ports.find(item => item.ref.name === 'spare')!.side;
    expect(spare(hinted.model)).toBe(spare(plain.model));
  }, 60000);

  it('a hint that faces away after 7f publishes with SIDE_HINT_FACES_AWAY, and restore accepts it', async () => {
    const yaml = fixture('a-side-hint-moves-a-port-to-a-lateral-side');
    const plain = await run(yaml);
    const { key } = port(plain.model, 'server', 1);
    const { model } = await run(yaml, new Map([[key, 'left']]), graphSizes(plain.graph, ['server']));
    const away = model.diagnostics.filter(d => d.code === 'SIDE_HINT_FACES_AWAY');
    expect(away).toEqual([expect.objectContaining({ severity: 'warning', owners: [{ kind: 'link', id: model.links[1]!.id }] })]);
    expect(plain.model.diagnostics.some(d => d.code === 'SIDE_HINT_FACES_AWAY')).toBe(false);
    expect(restoreLayoutModel(JSON.stringify(model)).nodes['server']!.ports.filter(item => item.sideHint)).toHaveLength(1);
  }, 60000);

  it('the frame title edge counts a hinted port on its natural side', async () => {
    const yaml = `portograph: 2
groups:
  above: {tier: 0}
  stack: {tier: 1}
  below: {tier: 2}
nodes:
  core: {group: above}
  r0: {group: stack}
  r1: {group: stack}
  d: {group: below}
links:
  - [core, r0]
  - [r0, r1]
  - [r1, d]
`;
    const plain = await run(yaml);
    expect(plain.model.document.frames?.['stack']).toBeDefined();
    const { key } = port(plain.model, 'r1', 2);
    const hinted = await run(yaml, new Map([[key, 'right']]));
    expect(port(hinted.model, 'r1', 2).port.side).toBe('right');
    // One crossing port on top and one at the bottom tie, and the tie keeps the top; the hinted side would count only the top port and move the title.
    expect(rawFrameSide(plain.model, 'stack')).toBe('top');
    expect(rawFrameSide(hinted.model, 'stack')).toBe('top');
  }, 60000);
});
