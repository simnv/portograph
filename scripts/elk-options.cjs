'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const elkRoot = path.dirname(require.resolve('elkjs/package.json'));
const ELK = require(path.join(elkRoot, 'lib/elk.bundled.js'));

const elk = new ELK();
const base = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.randomSeed': '1',
};

function node(id, layoutOptions = {}) {
  return { id, width: 30, height: 20, layoutOptions };
}

async function partitionProbe() {
  const graph = {
    id: 'root',
    layoutOptions: base,
    children: [
      node('tier-0', { 'elk.partitioning.partition': '0' }),
      node('tier-1', { 'elk.partitioning.partition': '1' }),
    ],
    edges: [{ id: 'reverse', sources: ['tier-1'], targets: ['tier-0'] }],
  };
  const off = await elk.layout(structuredClone(graph), {
    layoutOptions: { 'elk.partitioning.activate': 'false' },
  });
  const on = await elk.layout(structuredClone(graph), {
    layoutOptions: { 'elk.partitioning.activate': 'true' },
  });
  const pos = (g, id) => g.children.find((n) => n.id === id).y;
  assert.ok(pos(off, 'tier-1') < pos(off, 'tier-0'));
  assert.ok(pos(on, 'tier-0') < pos(on, 'tier-1'));
  return {
    off: { tier0Y: pos(off, 'tier-0'), tier1Y: pos(off, 'tier-1') },
    on: { tier0Y: pos(on, 'tier-0'), tier1Y: pos(on, 'tier-1') },
  };
}

async function minimumSizeProbe() {
  const ports = Array.from({ length: 8 }, (_, index) => ({
    id: `p${index}`,
    width: 20,
    height: 10,
    layoutOptions: { 'elk.port.side': 'NORTH' },
  }));
  const plainGraph = {
    id: 'root',
    layoutOptions: base,
    children: [{ id: 'n', width: 10, height: 10 }],
  };
  const constrainedGraph = structuredClone(plainGraph);
  constrainedGraph.children[0].layoutOptions = {
    'elk.nodeSize.constraints': '[MINIMUM_SIZE, PORTS]',
    'elk.nodeSize.minimum': '[100, 50]',
    'elk.portConstraints': 'FIXED_SIDE',
  };
  constrainedGraph.children[0].ports = ports;
  const minimumOnlyGraph = structuredClone(constrainedGraph);
  minimumOnlyGraph.children[0].layoutOptions['elk.nodeSize.constraints'] = '[MINIMUM_SIZE]';
  const plain = await elk.layout(plainGraph);
  const minimumOnly = await elk.layout(minimumOnlyGraph);
  const constrained = await elk.layout(constrainedGraph);
  const p = plain.children[0];
  const m = minimumOnly.children[0];
  const c = constrained.children[0];
  assert.deepEqual([p.width, p.height], [10, 10]);
  assert.deepEqual([m.width, m.height], [100, 50]);
  assert.ok(c.width > m.width);
  assert.ok(c.height >= m.height);
  return {
    plain: [p.width, p.height],
    minimumOnly: [m.width, m.height],
    minimumAndPorts: [c.width, c.height],
  };
}

async function semiInteractiveProbe() {
  const graph = {
    id: 'root',
    layoutOptions: base,
    children: [
      node('source'),
      node('a', { 'elk.position': '[300, 100]' }),
      node('b', { 'elk.position': '[100, 100]' }),
      node('c', { 'elk.position': '[200, 100]' }),
      node('sink'),
    ],
    edges: [
      ...['a', 'b', 'c'].map((id) => ({ id: `s-${id}`, sources: ['source'], targets: [id] })),
      ...['a', 'b', 'c'].map((id) => ({ id: `${id}-t`, sources: [id], targets: ['sink'] })),
    ],
  };
  const layout = async (value) => elk.layout(structuredClone(graph), {
    layoutOptions: {
      'elk.layered.crossingMinimization.semiInteractive': value,
    },
  });
  const off = await layout('false');
  const on = await layout('true');
  const order = (g) => g.children
    .filter((n) => ['a', 'b', 'c'].includes(n.id))
    .sort((l, r) => l.x - r.x)
    .map((n) => n.id);
  assert.deepEqual(order(on), ['b', 'c', 'a']);
  assert.notDeepEqual(order(off), order(on));
  return { off: order(off), on: order(on) };
}

function findNode(graph, id) {
  if (graph.id === id) return graph;
  for (const child of graph.children || []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

async function shapeCoordsProbe() {
  const leaf = node('leaf', { 'elk.portConstraints': 'FIXED_SIDE' });
  leaf.ports = [{
    id: 'leaf-port',
    width: 4,
    height: 4,
    layoutOptions: { 'elk.port.side': 'EAST' },
  }];
  const graph = {
    id: 'root',
    layoutOptions: {
      ...base,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    },
    children: [
      {
        id: 'outer',
        children: [{ id: 'inner', children: [leaf] }],
      },
      node('peer'),
    ],
    edges: [{ id: 'cross-hierarchy', sources: ['leaf'], targets: ['peer'] }],
  };
  const layout = async (coords) => elk.layout(structuredClone(graph), {
    layoutOptions: { 'elk.json.shapeCoords': coords },
  });
  const parent = await layout('PARENT');
  const root = await layout('ROOT');
  const pOuter = findNode(parent, 'outer');
  const pInner = findNode(parent, 'inner');
  const pLeaf = findNode(parent, 'leaf');
  const rLeaf = findNode(root, 'leaf');
  const pPort = pLeaf.ports[0];
  const rPort = rLeaf.ports[0];
  const expectedRoot = [pOuter.x + pInner.x + pLeaf.x, pOuter.y + pInner.y + pLeaf.y];
  const expectedRootPort = [
    expectedRoot[0] + pPort.x,
    expectedRoot[1] + pPort.y,
  ];
  assert.deepEqual([rLeaf.x, rLeaf.y], expectedRoot);
  assert.deepEqual([rPort.x, rPort.y], expectedRootPort);
  assert.notDeepEqual([pLeaf.x, pLeaf.y], [rLeaf.x, rLeaf.y]);
  return {
    parentLeaf: [pLeaf.x, pLeaf.y],
    parentPort: [pPort.x, pPort.y],
    parentOffsets: { outer: [pOuter.x, pOuter.y], inner: [pInner.x, pInner.y] },
    rootLeaf: [rLeaf.x, rLeaf.y],
    rootPort: [rPort.x, rPort.y],
  };
}

async function edgeCoordsProbe() {
  const graph = { id: 'root', layoutOptions: { ...base, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' },
    children: [{ id: 'outer', children: [{ id: 'inner', children: [node('a'), node('b')],
      edges: [{ id: 'internal', sources: ['a'], targets: ['b'] }] }] }, node('peer')],
    edges: [{ id: 'cross', sources: ['b'], targets: ['peer'] }] };
  const parent = await elk.layout(structuredClone(graph), { layoutOptions: { 'elk.json.edgeCoords': 'CONTAINER' } });
  const root = await elk.layout(structuredClone(graph), { layoutOptions: { 'elk.json.edgeCoords': 'ROOT' } });
  const pOuter = findNode(parent, 'outer'), pInner = findNode(parent, 'inner');
  const pEdge = pInner.edges[0], rEdge = findNode(root, 'inner').edges[0];
  const offset = { x: pOuter.x + pInner.x, y: pOuter.y + pInner.y };
  for (const endpoint of ['startPoint', 'endPoint']) {
    assert.deepEqual(rEdge.sections[0][endpoint], { x: pEdge.sections[0][endpoint].x + offset.x,
      y: pEdge.sections[0][endpoint].y + offset.y });
  }
  assert.notDeepEqual(pEdge.sections, rEdge.sections);
  return { container: pEdge.sections, root: rEdge.sections, offset };
}
async function metadataProbe() {
  const expected = { algorithm: 'STRING', direction: 'ENUM', hierarchyHandling: 'ENUM',
    'partitioning.activate': 'BOOLEAN', 'partitioning.partition': 'INT', portConstraints: 'ENUM',
    'nodeSize.constraints': 'ENUMSET', 'nodeSize.minimum': 'OBJECT',
    'layered.crossingMinimization.semiInteractive': 'BOOLEAN', position: 'OBJECT',
    'json.shapeCoords': 'ENUM', 'json.edgeCoords': 'ENUM', randomSeed: 'INT',
    'layered.nodePlacement.strategy': 'ENUM' };
  const metadata = await elk.knownLayoutOptions();
  for (const [key, type] of Object.entries(expected)) {
    assert.equal(metadata.find(option => option.id === `org.eclipse.elk.${key}`)?.type, type, key);
  }
  return expected;
}

async function remainingOptionsProbe() {
  const graph = { id: 'root', children: [node('a'), node('b')],
    edges: [{ id: 'link', sources: ['a'], targets: ['b'] }] };
  const down = await elk.layout(structuredClone(graph), { layoutOptions: base });
  const right = await elk.layout(structuredClone(graph), { layoutOptions: { ...base, 'elk.direction': 'RIGHT' } });
  assert.ok(down.children[1].y > down.children[0].y);
  assert.ok(right.children[1].x > right.children[0].x);
  assert.notDeepEqual(down.children.map(n => [n.x, n.y]), right.children.map(n => [n.x, n.y]));
  const packed = await elk.layout(structuredClone(graph), { layoutOptions: { ...base, 'elk.algorithm': 'rectpacking' } });
  assert.notDeepEqual(down.children.map(n => [n.x, n.y]), packed.children.map(n => [n.x, n.y]));
  const nested = { id: 'root', children: [{ id: 'group', children: [node('a')] }, node('b')],
    edges: [{ id: 'cross', sources: ['a'], targets: ['b'] }] };
  const included = await elk.layout(structuredClone(nested), { layoutOptions: { ...base, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' } });
  const separate = await elk.layout(structuredClone(nested), { layoutOptions: { ...base, 'elk.hierarchyHandling': 'SEPARATE_CHILDREN' } });
  assert.ok(included.edges[0].sections?.length > 0);
  assert.equal(separate.edges[0].sections, undefined);
  const portGraph = { id: 'root', children: [{ ...node('a'), ports: [{ id: 'p', width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } }] }, node('b')],
    edges: [{ id: 'link', sources: ['p'], targets: ['b'] }] };
  const ports = async constraint => {
    const copy = structuredClone(portGraph); copy.children[0].layoutOptions = { 'elk.portConstraints': constraint };
    return (await elk.layout(copy, { layoutOptions: base })).children[0];
  };
  const free = await ports('FREE'), fixed = await ports('FIXED_SIDE');
  assert.equal(fixed.ports[0].x, fixed.width);
  assert.notDeepEqual([free.ports[0].x, free.ports[0].y], [fixed.ports[0].x, fixed.ports[0].y]);
  const diamond = { id: 'root', children: ['s', 'a', 'b', 'c', 't'].map(id => node(id)), edges: [
    ...['a', 'b', 'c'].map(id => ({ id: 's' + id, sources: ['s'], targets: [id] })),
    ...['a', 'b', 'c'].map(id => ({ id: id + 't', sources: [id], targets: ['t'] }))] };
  const seeded = async seed => (await elk.layout(structuredClone(diamond), { layoutOptions: { ...base, 'elk.randomSeed': seed } })).children.map(n => [n.id, n.x, n.y]);
  const one = await seeded('1'), again = await seeded('1'), two = await seeded('2');
  assert.deepEqual(one, again); assert.notDeepEqual(one, two);
  return { direction: { down: down.children.map(n => [n.x, n.y]), right: right.children.map(n => [n.x, n.y]) },
    algorithm: { layered: down.children.map(n => [n.x, n.y]), rectpacking: packed.children.map(n => [n.x, n.y]) },
    hierarchy: { includedSections: included.edges[0].sections.length, separateSections: 0 },
    portSide: { free: [free.ports[0].x, free.ports[0].y], fixed: [fixed.ports[0].x, fixed.ports[0].y] },
    seed: { one, two } };
}

(async () => {
  const version = require(path.join(elkRoot, 'package.json')).version;
  const results = {
    node: process.version,
    elkjs: version,
    partitioning: await partitionProbe(),
    nodeSize: await minimumSizeProbe(),
    semiInteractive: await semiInteractiveProbe(),
    shapeCoords: await shapeCoordsProbe(),
    edgeCoords: await edgeCoordsProbe(),
    metadata: await metadataProbe(),
    remaining: await remainingOptionsProbe(),
  };
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
