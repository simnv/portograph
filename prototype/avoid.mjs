// Re-route edges of an ELK-placed flat graph with libavoid. Usage: node avoid.mjs <variant> [all|dropped]
import fs from 'node:fs';
import { AvoidLib } from './node_modules/libavoid-js/dist/index-node.mjs';
import { absolutize } from './geom.mjs';
const V = process.argv[2], MODE = process.argv[3] || 'all';
const g = JSON.parse(fs.readFileSync(`/tmp/elk-proto/out-${V}.json`, 'utf8'));
await AvoidLib.load('/tmp/elk-proto/node_modules/libavoid-js/dist/libavoid.wasm');
const Avoid = AvoidLib.getInstance();
// ---- post-step: reorder ports per side so routes point toward their peer and bundles nest
if (process.argv[4] !== 'noreorder') {
  const peerOf = new Map();
  for (const e of [...(g.edges || []), ...(g._dropped || [])]) { peerOf.set(e.sources[0], e.targets[0]); peerOf.set(e.targets[0], e.sources[0]); }
  const pass = (wantHoriz) => {
    const pre = absolutize(g);
    const centre = id => { const n = pre.nodes.get(id); return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; };
    for (const n of g.children) {
      const nc = centre(n.id); const bySide = {};
      for (const p of n.ports || []) (bySide[pre.ports.get(p.id).side] ??= []).push(p);
      for (const [side, list] of Object.entries(bySide)) {
        const horiz = side === 'NORTH' || side === 'SOUTH';
        if (horiz !== wantHoriz) continue;
        const slots = list.map(p => ({ x: p.x, y: p.y })).sort((a, b) => horiz ? a.x - b.x : a.y - b.y);
        const key = p => {
          const peer = peerOf.get(p.id); if (!peer) return [0, 0];
          const pp = pre.ports.get(peer), pc = centre(pp.node);
          const dx = pc.x - nc.x, dy = pc.y - nc.y;
          if (horiz) { // along x: [peers beside-left] [peers above/below, by their port x] [peers beside-right]
            const beside = Math.abs(dx) > Math.abs(dy);
            return beside ? [Math.sign(dx), beside && dx > 0 ? -pp.y : pp.y] : [0, pp.x + pp.w / 2];
          } else {     // along y: [peers above] [peers beside, nearest peer port first] [peers below]
            const beside = Math.abs(dx) > Math.abs(dy);
            return beside ? [0, dx > 0 ? pp.x : -pp.x] : [Math.sign(dy), pp.y + pp.h / 2];
          }
        };
        const sorted = [...list].sort((p, q) => { const a = key(p), b = key(q); return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]; });
        sorted.forEach((p, i) => { p.x = slots[i].x; p.y = slots[i].y; });
      }
    }
  };
  pass(true); pass(false);
}
const { nodes, ports } = absolutize(g);
const DIR = { NORTH: 1, SOUTH: 2, WEST: 4, EAST: 8 }; // ConnDirUp/Down/Left/Right

const router = new Avoid.Router(2 /* OrthogonalRouting */);
router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 10);
router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 10);
router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 50);
router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 200);
router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true);
router.setRoutingOption(Avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);
router.setRoutingOption(Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep, true);

const shapes = new Map(); let classId = 1; const pinClass = new Map();
for (const n of nodes.values()) {
  if (n.isLoc) continue;
  // shape rect including ports (ports hang outside the node by port height)
  const PH = 16;
  const rect = new Avoid.Rectangle(new Avoid.Point(n.x - PH, n.y - PH), new Avoid.Point(n.x + n.w + PH, n.y + n.h + PH));
  const sh = new Avoid.ShapeRef(router, rect);
  shapes.set(n.id, { sh, x: n.x - PH, y: n.y - PH });
}
for (const p of ports.values()) {
  const s = shapes.get(p.node);
  const cx = p.x + p.w / 2 - s.x, cy = p.y + p.h / 2 - s.y;
  const id = classId++;
  const pin = new Avoid.ShapeConnectionPin(s.sh, id, cx, cy, false, 0, DIR[p.side] ?? 15);
  pin.setExclusive(true);
  pinClass.set(p.id, id);
}
const all = [...(g.edges || []), ...(g._dropped || [])];
const toRoute = MODE === 'all' ? all : (g._dropped || []);
const conns = toRoute.map(e => {
  const src = new Avoid.ConnEnd(shapes.get(ports.get(e.sources[0]).node).sh, pinClass.get(e.sources[0]));
  const dst = new Avoid.ConnEnd(shapes.get(ports.get(e.targets[0]).node).sh, pinClass.get(e.targets[0]));
  return { e, c: new Avoid.ConnRef(router, src, dst) };
});
const t0 = performance.now();
router.processTransaction();
const dt = performance.now() - t0;
const routed = conns.map(({ e, c }) => {
  const pl = c.displayRoute(); const pts = [];
  for (let i = 0; i < pl.size(); i++) { const p = pl.at(i); pts.push({ x: p.x, y: p.y }); }
  return { id: e.id, sources: e.sources, targets: e.targets, cls: e.cls, container: 'root',
    sections: [{ startPoint: pts[0], endPoint: pts[pts.length - 1], bendPoints: pts.slice(1, -1) }] };
});
const keep = MODE === 'all' ? [] : g.edges.map(e => ({ ...e }));
const out = { ...g, edges: [...keep, ...routed] }; delete out._dropped;
fs.writeFileSync(`/tmp/elk-proto/out-${V}-av.json`, JSON.stringify(out, null, 1));
console.log(`${V}-av: libavoid routed ${routed.length} edges in ${dt.toFixed(0)} ms`);
