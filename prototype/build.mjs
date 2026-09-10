// YAML -> ELK JSON -> layout -> JSON on disk. Usage: node build.mjs <variant>
import fs from 'node:fs';
import { createRequire } from 'node:module'; const yaml = createRequire(import.meta.url)('js-yaml');
import ELK from 'elkjs/lib/elk.bundled.js';

const VARIANT = process.argv[2] || 'free';
const SRC = '~/Projects/d3-fd/demo/public/diagram.yaml';
const doc = yaml.load(fs.readFileSync(SRC, 'utf8')).diagram;

const TIER = { providers: 0, datacenter: 1, 'tbr-left': 1, 'tbr-right': 1, 'route-reflector': 2, backbone: 3 };
const PORT_W = 30, PORT_H = 14;

// ---- resolve links to concrete interface indices (consume in declaration order)
const nodes = new Map(doc.nodes.map(n => [n.id, n]));
const used = new Map(); // nodeId -> next free index per iface name
function takeIface(ref) {
  const [id, name] = ref.split(/\s+/);
  const n = nodes.get(id);
  const key = id + '|' + name;
  let start = used.get(key) ?? 0;
  const idx = n.interfaces.findIndex((it, i) => i >= start && it.name === name);
  if (idx < 0) throw new Error('no free iface for ' + ref);
  used.set(key, idx + 1);
  return { node: id, port: `${id}.p${idx}`, name, idx };
}
const links = doc.links.map((l, i) => {
  const s = takeIface(l.source), t = takeIface(l.target);
  return { id: `e${i}`, s, t, cls: l.class || '' };
});

// ---- decide port side (only used for FIXED_SIDE / FIXED_ORDER variants)
const order = doc.nodes.map(n => n.id);
const TALL = VARIANT.startsWith('tall');
function sideFor(dev, other) {
  const dl = nodes.get(dev).location, ol = nodes.get(other).location;
  if (dl === 'tbr-left') return 'EAST';
  if (dl === 'tbr-right') return 'WEST';
  if (TALL && dev.startsWith('EAC') && ol === 'tbr-left') return 'WEST';
  if (TALL && dev.startsWith('EAC') && ol === 'tbr-right') return 'EAST';
  if (dl === ol && TIER[dl] === TIER[ol]) return order.indexOf(dev) < order.indexOf(other) ? 'EAST' : 'WEST';
  if (TIER[ol] < TIER[dl]) return 'NORTH';
  return 'SOUTH';
}
const portSide = new Map();
for (const l of links) {
  portSide.set(l.s.port, sideFor(l.s.node, l.t.node));
  portSide.set(l.t.port, sideFor(l.t.node, l.s.node));
}

// ---- variant options
const V = {
  free:   { pc: 'FREE',       partition: false, layerConstraint: false, modelOrder: false },
  part:   { pc: 'FREE',       partition: true,  layerConstraint: false, modelOrder: false },
  side:   { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: false },
  sideMO: { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: true },
  order:  { pc: 'FIXED_ORDER',partition: true,  layerConstraint: false, modelOrder: true },
  lc:     { pc: 'FIXED_SIDE', partition: false, layerConstraint: true,  modelOrder: true },
  lcc:    { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: true, lcc: true },
  lccFree:{ pc: 'FREE',       partition: true,  layerConstraint: false, modelOrder: true, lcc: true },
  flat:   { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: true, lcc: true, flat: true },
  flatFree:{ pc: 'FREE',      partition: true,  layerConstraint: false, modelOrder: true, lcc: true, flat: true },
  flatOrd:{ pc: 'FIXED_ORDER',partition: true,  layerConstraint: false, modelOrder: true, lcc: true, flat: true },
  hybrid: { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: true, lcc: false, flat: true, dropInTier: true },
  hybridFree:{ pc: 'FREE',    partition: true,  layerConstraint: false, modelOrder: true, lcc: false, flat: true, dropInTier: true },
  tall:   { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: true, lcc: false, flat: true, dropInTier: true, sizeFromSides: true },
  tall2:  { pc: 'FIXED_SIDE', partition: true,  layerConstraint: false, modelOrder: true, lcc: false, flat: true, dropInTier: true, sizeFromSides: true, spacing: { nodeNode: '60', edgeNode: '30', edgeEdge: '16' } },
}[VARIANT];
if (!V) throw new Error('unknown variant ' + VARIANT);

// ---- build ELK graph
const locChildren = {};
for (const n of doc.nodes) {
  const ports = n.interfaces.map((it, i) => ({
    id: `${n.id}.p${i}`, width: PORT_W, height: PORT_H,
    labels: [{ text: it.name, width: 22, height: 9 }],
    layoutOptions: V.pc !== 'FREE' && portSide.has(`${n.id}.p${i}`) ? { 'elk.port.side': portSide.get(`${n.id}.p${i}`) } : {},
  }));
  // ports order on a side: for FIXED_ORDER ELK uses clockwise order of the list; sort by side to be safe
  const sideRank = { NORTH: 0, EAST: 1, SOUTH: 2, WEST: 3 };
  ports.sort((a, b) => (sideRank[a.layoutOptions['elk.port.side']] ?? 9) - (sideRank[b.layoutOptions['elk.port.side']] ?? 9));
  let minW = 90, minH = 50;
  if (V.sizeFromSides) {
    const cnt = { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 };
    for (const p of ports) { const sd = p.layoutOptions['elk.port.side']; if (sd) cnt[sd]++; }
    minH = Math.max(35, Math.max(cnt.WEST, cnt.EAST) * 12 + 20);
    minW = Math.max(60, Math.max(cnt.NORTH, cnt.SOUTH) * 12 + 20);
  }
  const child = {
    id: n.id, width: minW, height: minH,
    labels: [{ text: n.id, width: 60, height: 12 }],
    ports,
    layoutOptions: {
      'elk.portConstraints': V.pc,
      'elk.nodeSize.constraints': 'PORTS PORT_LABELS NODE_LABELS MINIMUM_SIZE',
      'elk.nodeSize.minimum': `(${minW},${minH})`,
      'elk.portLabels.placement': 'INSIDE',
      'elk.nodeLabels.placement': 'INSIDE V_TOP H_LEFT',
    },
  };
  if (V.lcc) child.layoutOptions['elk.layered.layering.layerChoiceConstraint'] = String(TIER[n.location]);
  if (V.flat) {
    if (V.partition) child.layoutOptions['elk.partitioning.partition'] = String(TIER[n.location]);
    // model-order hint: left-to-right by location order, then declaration order
    const lo = ['tbr-left','datacenter','tbr-right'];
    child.layoutOptions['elk.position'] = `(${(lo.indexOf(n.location) + 1) * 1000 + order.indexOf(n.id) * 10},${TIER[n.location] * 200})`;
  }
  (locChildren[n.location] ??= []).push(child);
}
// desired left-to-right order in tier 1
const locOrder = ['providers', 'tbr-left', 'datacenter', 'tbr-right', 'route-reflector', 'backbone'];
const children = locOrder.filter(id => locChildren[id]).map((id, i) => {
  const loc = doc.locations.find(l => l.id === id);
  const lo = {
    'elk.padding': '[top=28,left=12,bottom=12,right=12]',
    'elk.nodeLabels.placement': 'INSIDE V_TOP H_LEFT',
  };
  if (V.partition) lo['elk.partitioning.partition'] = String(TIER[id]);
  if (V.layerConstraint) {
    if (id === 'providers') lo['elk.layered.layering.layerConstraint'] = 'FIRST';
    if (id === 'backbone') lo['elk.layered.layering.layerConstraint'] = 'LAST';
  }
  if (V.modelOrder) lo['elk.position'] = `(${i * 100},0)`;
  return { id, labels: [{ text: loc.label, width: 160, height: 14 }], children: locChildren[id], layoutOptions: lo };
});

// orient edges by tier so they flow DOWN
const dropped = [];
const edges = links.filter(l => {
  const same = TIER[nodes.get(l.s.node).location] === TIER[nodes.get(l.t.node).location];
  if (V.dropInTier && same) { dropped.push({ id: l.id, sources: [l.s.port], targets: [l.t.port], cls: l.cls }); return false; }
  return true;
}).map(l => {
  const flip = TIER[nodes.get(l.s.node).location] > TIER[nodes.get(l.t.node).location];
  const [a, b] = flip ? [l.t, l.s] : [l.s, l.t];
  return { id: l.id, sources: [a.port], targets: [b.port], cls: l.cls };
});

const rootLO = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.layered.spacing.edgeNodeBetweenLayers': '30',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '20',
  'elk.spacing.edgeEdge': '12',
  'elk.spacing.portPort': '6',
  'elk.spacing.componentComponent': '40',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.thoroughness': '30',
  'elk.separateConnectedComponents': 'false',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
};
if (V.partition) rootLO['elk.partitioning.activate'] = 'true';
if (V.spacing) { rootLO['elk.spacing.nodeNode'] = V.spacing.nodeNode; rootLO['elk.spacing.edgeNode'] = V.spacing.edgeNode; rootLO['elk.spacing.edgeEdge'] = V.spacing.edgeEdge; rootLO['elk.layered.spacing.edgeEdgeBetweenLayers'] = V.spacing.edgeEdge; }
if (V.modelOrder) {
  rootLO['elk.layered.considerModelOrder.strategy'] = 'NODES_AND_EDGES';
  rootLO['elk.layered.crossingMinimization.semiInteractive'] = 'true';
  rootLO['elk.layered.crossingMinimization.forceNodeModelOrder'] = 'true';
}
let graph = { id: 'root', layoutOptions: rootLO, children, edges };
if (V.flat) {
  // sort by desired left-to-right order so model order matches target
  const flatChildren = ['providers','tbr-left','datacenter','tbr-right','route-reflector','backbone'].flatMap(id => locChildren[id] || []);
  graph = { id: 'root', layoutOptions: { ...rootLO, 'elk.hierarchyHandling': 'SEPARATE_CHILDREN' }, children: flatChildren, edges, _groups: Object.fromEntries(doc.locations.map(l => [l.id, { label: l.label, members: doc.nodes.filter(n => n.location === l.id).map(n => n.id) }])) };
}

const elk = new ELK();
const t0 = performance.now();
const out = await elk.layout(graph);
const dt = performance.now() - t0;
if (graph._groups) out._groups = graph._groups;
if (dropped.length) out._dropped = dropped;
fs.writeFileSync(`/tmp/elk-proto/out-${VARIANT}.json`, JSON.stringify(out, null, 1));
console.log(`${VARIANT}: layout in ${dt.toFixed(0)} ms, size ${out.width.toFixed(0)}x${out.height.toFixed(0)}`);
