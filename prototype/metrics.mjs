import fs from 'node:fs';
import { absolutize } from './geom.mjs';
const EPS = 1e-6;
function segs(e) { const r = []; for (let i = 0; i < e.pts.length - 1; i++) r.push([e.pts[i], e.pts[i + 1]]); return r; }
function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
function properIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}
function overlap(a, b) { // collinear overlapping length for axis-aligned segments
  const hA = Math.abs(a[0].y - a[1].y) < EPS, hB = Math.abs(b[0].y - b[1].y) < EPS;
  if (hA && hB && Math.abs(a[0].y - b[0].y) < 0.5) { const l = Math.min(Math.max(a[0].x, a[1].x), Math.max(b[0].x, b[1].x)) - Math.max(Math.min(a[0].x, a[1].x), Math.min(b[0].x, b[1].x)); return l > 1 ? l : 0; }
  if (!hA && !hB && Math.abs(a[0].x - b[0].x) < 0.5) { const l = Math.min(Math.max(a[0].y, a[1].y), Math.max(b[0].y, b[1].y)) - Math.max(Math.min(a[0].y, a[1].y), Math.min(b[0].y, b[1].y)); return l > 1 ? l : 0; }
  return 0;
}
function segRect(a, b, r, pad = 0) { // segment intersects rect interior?
  const x1 = r.x + pad, y1 = r.y + pad, x2 = r.x + r.w - pad, y2 = r.y + r.h - pad;
  if (x2 <= x1 || y2 <= y1) return false;
  if (Math.abs(a.y - b.y) < EPS) return a.y > y1 && a.y < y2 && Math.max(a.x, b.x) > x1 && Math.min(a.x, b.x) < x2;
  if (Math.abs(a.x - b.x) < EPS) return a.x > x1 && a.x < x2 && Math.max(a.y, b.y) > y1 && Math.min(a.y, b.y) < y2;
  return false;
}
export function metrics(g) {
  const { nodes, ports, edges, width, height } = absolutize(g);
  let crossings = 0, overlaps = 0, xOut = 0;
  const bundleKeys = new Set((g._bundles || []).map(b => [...b].sort().join('|')));
  const pairKey = e => [ports.get(e.src).node, ports.get(e.tgt).node].sort().join('|');
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const shared = edges[i].src === edges[j].src || edges[i].tgt === edges[j].tgt || edges[i].src === edges[j].tgt || edges[i].tgt === edges[j].src;
    const inBundle = pairKey(edges[i]) === pairKey(edges[j]) && bundleKeys.has(pairKey(edges[i]));
    for (const a of segs(edges[i])) for (const b of segs(edges[j])) {
      if (properIntersect(a[0], a[1], b[0], b[1])) { crossings++; if (!inBundle) xOut++; }
      if (!shared && overlap(a, b)) overlaps++;
    }
  }
  const bends = edges.map(e => e.bends);
  const total = bends.reduce((a, b) => a + b, 0), max = Math.max(...bends);
  let nonPerp = 0, diag = 0;
  const perpOk = (side, a, b) => { const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y); return (side === 'NORTH' || side === 'SOUTH') ? dy > dx : dx > dy; };
  for (const e of edges) {
    const sp = ports.get(e.src), tp = ports.get(e.tgt), n = e.pts.length;
    if (!perpOk(sp.side, e.pts[0], e.pts[1])) nonPerp++;
    if (!perpOk(tp.side, e.pts[n - 2], e.pts[n - 1])) nonPerp++;
    for (const [a, b] of segs(e)) if (Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS) diag++;
  }
  let through = 0, barCross = 0; const throughList = [];
  for (const e of edges) {
    const sn = ports.get(e.src).node, tn = ports.get(e.tgt).node;
    for (const nd of nodes.values()) {
      if (nd.isLoc || nd.id === sn || nd.id === tn) continue;
      if (segs(e).some(([a, b]) => segRect(a, b, nd, 0.5))) { if (nd.bar) { barCross++; continue; } through++; throughList.push(`${e.id}:${sn}->${tn} via ${nd.id}`); break; }
    }
  }
  // group labels: given by the region passes (_labels) or derived from the legacy top-left placement
  const labels = g._labels ? Object.values(g._labels) : Object.entries(g._groups || {}).map(([id, grp]) => {
    const ms = grp.members.map(m => nodes.get(m)); const x0 = Math.min(...ms.map(n => n.x)) - 14, y0 = Math.min(...ms.map(n => n.y)) - 28;
    return { x: x0 + 8, y: y0 + 2, w: Math.ceil(grp.label.length * 12 * 0.58), h: 14 };
  });
  let labelHits = 0;
  for (const e of edges) for (const [a, b] of segs(e)) for (const l of labels) if (segRect(a, b, { x: l.x, y: l.y, w: l.w, h: l.h }, 0)) labelHits++;
  return { edges: edges.length, crossings, xOut, overlaps, barCross, totalBends: total, maxBends: max, nonPerp, diag, through, labelHits, throughList, aspect: +(width / height).toFixed(2), size: `${Math.round(width)}x${Math.round(height)}` };
}
if (process.argv[1].endsWith('metrics.mjs')) {
  const vs = process.argv.slice(2);
  const rows = vs.map(v => ({ variant: v, ...metrics(JSON.parse(fs.readFileSync(`/tmp/elk-proto/out-${v}.json`, 'utf8'))) }));
  const cols = ['variant', 'edges', 'crossings', 'xOut', 'overlaps', 'barCross', 'totalBends', 'maxBends', 'nonPerp', 'diag', 'through', 'labelHits', 'aspect', 'size'];
  console.log('| ' + cols.join(' | ') + ' |'); console.log('|' + cols.map(() => '---').join('|') + '|');
  for (const r of rows) console.log('| ' + cols.map(c => r[c]).join(' | ') + ' |');
  for (const r of rows) if (r.throughList.length) console.log(r.variant, 'through:', r.throughList.slice(0, 6).join('; '));
}
