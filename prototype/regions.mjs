// Region post-passes between ELK placement and libavoid routing.
// Usage: node regions.mjs <srcVariant> <dstVariant>   e.g. node regions.mjs tall2 tall4
// Reads out-<src>.json (ELK placed, flat), writes out-<dst>.json (re-placed) and out-<dst>-av.json (routed).
import fs from 'node:fs';
import { AvoidLib } from './node_modules/libavoid-js/dist/index-node.mjs';

const SRC = process.argv[2] || 'tall2', DST = process.argv[3] || 'tall4';
const g = JSON.parse(fs.readFileSync(`/tmp/elk-proto/out-${SRC}.json`, 'utf8'));
const TIER = { providers: 0, datacenter: 1, 'tbr-left': 1, 'tbr-right': 1, 'route-reflector': 2, backbone: 3 };
const FLANK = { 'tbr-left': 'EAST', 'tbr-right': 'WEST' };   // flank group -> side facing the tier
const BAR_GROUPS = new Set(['backbone']);                      // groups whose members render as full-width bars
const ANCHOR = 1;                                              // the densest row; groups below it follow their parents, groups above keep ELK placement over their children
const P = { groupPad: 14, lane: 16, margin: 10, portW: 30, portH: 14, barGap: 40, slot: 36, nodeGap: 40, labelH: 14, labelMargin: 6, fontPx: 12 };
const BAND = P.labelH + P.labelMargin;                         // label band height inside the group's top padding
const textW = s => Math.ceil(s.length * P.fontPx * 0.58);      // Helvetica estimate
const log = (...a) => console.log('[regions]', ...a);

const byId = new Map(g.children.map(n => [n.id, n]));
const groupOf = new Map(); for (const [gid, grp] of Object.entries(g._groups)) for (const m of grp.members) groupOf.set(m, gid);
const tierOf = id => TIER[groupOf.get(id)];
const isRowGroup = gid => !FLANK[gid] && !BAR_GROUPS.has(gid);
const allEdges = [...(g.edges || []), ...(g._dropped || [])];
const peerOf = new Map(); for (const e of allEdges) { peerOf.set(e.sources[0], e.targets[0]); peerOf.set(e.targets[0], e.sources[0]); }
const portNode = new Map(); for (const n of g.children) for (const p of n.ports || []) portNode.set(p.id, n.id);
const sideOfPort = (n, p) => { const cx = p.x + p.width / 2, cy = p.y + p.height / 2; return cy <= 1 ? 'NORTH' : cy >= n.height - 1 ? 'SOUTH' : cx <= 1 ? 'WEST' : 'EAST'; };
const sidePorts = (n, side) => n.ports.filter(p => sideOfPort(n, p) === side);
const groupBox = gid => { const ms = g._groups[gid].members.map(m => byId.get(m)); const pad = P.groupPad; return { x0: Math.min(...ms.map(m => m.x)) - pad, y0: Math.min(...ms.map(m => m.y)) - pad - BAND, x1: Math.max(...ms.map(m => m.x + m.width)) + pad, y1: Math.max(...ms.map(m => m.y + m.height)) + pad }; };
const portAbs = pid => { const n = byId.get(portNode.get(pid)); const p = n.ports.find(q => q.id === pid); return { x: n.x + p.x, y: n.y + p.y, w: p.width, h: p.height, cx: n.x + p.x + p.width / 2, cy: n.y + p.y + p.height / 2, side: sideOfPort(n, p), node: n.id, p, n }; };
const segRect = (a, b, r) => { // axis-aligned segment vs rect interior
  if (Math.abs(a.y - b.y) < 1e-6) return a.y > r.y && a.y < r.y + r.h && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;
  if (Math.abs(a.x - b.x) < 1e-6) return a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
  return false;
};

// hand-routed edges. Straight ones store only their pins and are resolved at emit time, so later node moves stay consistent.
const fixed = [];   // {e, pts} | {e, straight: true}
const routedIds = new Set();
const bundles = [];
const pinStraight = e => { fixed.push({ e, straight: true }); routedIds.add(e.id); };
const resolve = f => f.straight ? [portAbs(f.e.sources[0]), portAbs(f.e.targets[0])].map(q => ({ x: q.cx, y: q.cy })) : f.pts;

// ---- 0a. unused ports: move to the side with the fewest used ports, rendered last (centred if alone)
for (const n of g.children) {
  const unused = (n.ports || []).filter(p => !peerOf.has(p.id)); if (!unused.length) continue;
  const cnt = { SOUTH: 0, NORTH: 0, WEST: 0, EAST: 0 };
  for (const p of n.ports) if (peerOf.has(p.id)) cnt[sideOfPort(n, p)]++;
  const side = Object.keys(cnt).sort((a, b) => cnt[a] - cnt[b])[0];
  for (const p of unused) {
    const same = n.ports.filter(q => q !== p && sideOfPort(n, q) === side);
    if (side === 'SOUTH' || side === 'NORTH') { p.y = side === 'SOUTH' ? n.height : -p.height; p.x = same.length ? Math.max(...same.map(q => q.x)) + P.slot : (n.width - p.width) / 2; }
    else { p.x = side === 'WEST' ? -p.width : n.width; p.y = same.length ? Math.max(...same.map(q => q.y)) + 20 : (n.height - p.height) / 2; }
    log(`unused port ${p.id} -> ${side} (used per side N${cnt.NORTH} E${cnt.EAST} S${cnt.SOUTH} W${cnt.WEST})`);
  }
}

// ---- 0b. port reorder per side (same rule as avoid.mjs): point toward peer, nest bundles
function reorderPorts() {
  const pass = (wantHoriz) => {
    const centre = id => { const n = byId.get(id); return { x: n.x + n.width / 2, y: n.y + n.height / 2 }; };
    for (const n of g.children) {
      const nc = centre(n.id); const bySide = {};
      for (const p of n.ports || []) (bySide[sideOfPort(n, p)] ??= []).push(p);
      for (const [side, list] of Object.entries(bySide)) {
        const horiz = side === 'NORTH' || side === 'SOUTH';
        if (horiz !== wantHoriz) continue;
        const slots = list.map(p => ({ x: p.x, y: p.y })).sort((a, b) => horiz ? a.x - b.x : a.y - b.y);
        const key = p => {
          const peer = peerOf.get(p.id); if (!peer) return [9, 0]; // unused ports go last
          const pp = portAbs(peer), pc = centre(pp.node);
          const dx = pc.x - nc.x, dy = pc.y - nc.y, beside = Math.abs(dx) > Math.abs(dy);
          if (horiz) return beside ? [Math.sign(dx), dx > 0 ? -pp.y : pp.y] : [0, pp.cx];
          return beside ? [0, dx > 0 ? pp.x : -pp.x] : [Math.sign(dy), pp.cy];
        };
        const sorted = [...list].sort((p, q) => { const a = key(p), b = key(q); return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]; });
        sorted.forEach((p, i) => { p.x = slots[i].x; p.y = slots[i].y; });
      }
    }
  };
  pass(true); pass(false);
}
reorderPorts();

// ---- 0c. intra-tier row alignment: nodes of one tier in row groups (not flank, not bar) share one top y
{
  const rows = {};
  for (const n of g.children) { const gid = groupOf.get(n.id); if (!isRowGroup(gid)) continue; (rows[TIER[gid]] ??= []).push(n); }
  for (const [t, ns] of Object.entries(rows)) { const top = Math.min(...ns.map(n => n.y)); for (const n of ns) if (n.y !== top) { log(`row ${t}: ${n.id} y ${n.y.toFixed(0)} -> ${top.toFixed(0)}`); n.y = top; } }
}

// ---- 1. flank alignment -> straight links
for (const [gid, side] of Object.entries(FLANK)) {
  for (const fid of g._groups[gid].members) {
    const fn = byId.get(fid);
    const fports = fn.ports.filter(p => sideOfPort(fn, p) === side && peerOf.has(p.id)).sort((a, b) => a.y - b.y);
    const groups = {}; for (const p of fports) { const peer = portAbs(peerOf.get(p.id)); (groups[peer.node] ??= []).push({ p, peer }); }
    const opp = side === 'EAST' ? 'WEST' : 'EAST';
    const facing = Object.entries(groups).find(([, L]) => L.every(({ peer }) => peer.side === opp));
    if (!facing) { log(`no facing peer for ${fid}`); continue; }
    const [peerId, pairs] = facing;
    const pf = pairs.sort((a, b) => a.p.y - b.p.y);
    const peerYs = pf.map(({ peer }) => peer.cy).sort((a, b) => a - b);
    const dy0 = peerYs[0] - (fn.y + pf[0].p.y + pf[0].p.height / 2);
    fn.y += dy0;
    pf.forEach(({ p }, k) => { p.y = peerYs[k] - fn.y - p.height / 2; });
    log(`flank ${fid}: shifted by ${dy0.toFixed(1)} to align ${pf.length} ports with ${peerId}`);
    for (const { p } of pf) pinStraight(allEdges.find(e => e.sources[0] === p.id || e.targets[0] === p.id));
  }
}

// ---- 1b. reserve channel height between tier 1 and tier 2 (bundle rows + through-link channel + 1 router row)
{
  const bundleRows = Math.max(0, ...Object.values(
    allEdges.filter(e => tierOf(portNode.get(e.sources[0])) === 1 && tierOf(portNode.get(e.targets[0])) === 1 && !routedIds.has(e.id))
      .reduce((m, e) => { const k = [portNode.get(e.sources[0]), portNode.get(e.targets[0])].sort().join('|'); m[k] = (m[k] || 0) + 1; return m; }, {})));
  const need = bundleRows * P.lane + 3 * P.lane + 2 * P.margin;
  const t1 = Math.max(...g.children.filter(n => tierOf(n.id) === 1).map(n => n.y + n.height)) + P.groupPad;
  const t2 = Math.min(...g.children.filter(n => tierOf(n.id) === 2).map(n => n.y)) - P.groupPad - BAND; // group box top incl. label band
  const delta = Math.max(0, need - (t2 - t1));
  for (const n of g.children) if (tierOf(n.id) >= 2) n.y += delta;
  log(`tier gap: have ${(t2 - t1).toFixed(0)}, need ${need}, shifted tiers>=2 by ${delta.toFixed(0)}`);
}

// ---- 2. bars: members of BAR_GROUPS become stacked bars (x/width assigned after tier-1 placement is final)
const bars = [];
for (const gid of BAR_GROUPS) {
  const ms = g._groups[gid].members.map(m => byId.get(m)).sort((a, b) => a.x - b.x);
  let y = Math.min(...ms.map(m => m.y));
  for (const m of ms) { m.y = y; m.bar = true; y += m.height + P.barGap; bars.push(m); }
}

// ---- helpers for south-side port layout of a row node
function widen(n, d) { // grow node to the right; EAST ports follow; push same-row nodes (and flanks) right if they would collide
  n.width += d; for (const p of sidePorts(n, 'EAST')) p.x = n.width;
  const row = g.children.filter(m => m !== n && tierOf(m.id) === tierOf(n.id) && m.x > n.x).sort((a, b) => a.x - b.x);
  const next = row[0]; if (!next) return;
  const push = n.x + n.width + P.nodeGap - next.x;
  if (push > 0) { for (const m of row) m.x += push; log(`widen ${n.id} +${d.toFixed(0)}: pushed ${row.map(m => m.id).join(',')} right by ${push.toFixed(0)}`); }
  else log(`widen ${n.id} +${d.toFixed(0)} -> ${n.width.toFixed(0)}`);
}
function shiftSouthFrom(n, fromCx, dx) { // shift SOUTH ports whose centre >= fromCx by dx, widening the node when they overflow
  for (const p of sidePorts(n, 'SOUTH')) if (n.x + p.x + p.width / 2 >= fromCx - 0.5) p.x += dx;
  const over = Math.max(...sidePorts(n, 'SOUTH').map(p => p.x + p.width)) + 4 - n.width;
  if (over > 0) widen(n, over);
}

// ---- 3. through-links: reserve lanes on the outer south slots of the source, outside the intermediate group
function intermediateGroups(aId, bId) { const [lo, hi] = [tierOf(aId), tierOf(bId)].sort((a, b) => a - b); return Object.keys(g._groups).filter(gid => TIER[gid] > lo && TIER[gid] < hi); }
const barLinks = allEdges.filter(e => bars.some(b => b.id === portNode.get(e.sources[0]) || b.id === portNode.get(e.targets[0])));
const bySource = {};
for (const e of barLinks) {
  const barEnd = bars.some(b => b.id === portNode.get(e.sources[0])) ? 'sources' : 'targets';
  const srcPid = e[barEnd === 'sources' ? 'targets' : 'sources'][0], barPid = e[barEnd][0];
  (bySource[portNode.get(srcPid)] ??= []).push({ e, srcPid, barPid, bar: byId.get(portNode.get(barPid)) });
}
const reserved = {}; // srcId -> { group, left, laneEdge }
const LS = Math.max(P.lane, P.portW + 4);
for (const [srcId, L] of Object.entries(bySource)) {
  const sn = byId.get(srcId);
  const inter = intermediateGroups(srcId, L[0].bar.id).filter(gid => !BAR_GROUPS.has(gid));
  L.sort((a, b) => b.bar.y - a.bar.y); // farthest bar first -> outermost lane
  if (!inter.length) continue;
  const box = groupBox(inter[0]); const left = sn.x + sn.width / 2 < (box.x0 + box.x1) / 2;
  L.forEach((l, i) => {
    l.lane = left ? sn.x + 4 + P.portW / 2 + i * LS : sn.x + sn.width - 4 - P.portW / 2 - i * LS; l.vertical = true;
    sn.ports.find(q => q.id === l.srcPid).x = l.lane - sn.x - P.portW / 2;
  });
  const lanes = L.map(l => l.lane);
  reserved[srcId] = { group: inter[0], left, laneEdge: left ? Math.max(...lanes) + P.portW / 2 + P.margin : Math.min(...lanes) - P.portW / 2 - P.margin, laneSet: new Set(L.map(l => l.srcPid)) };
  // remaining south ports: pack them beside the lanes at slot pitch, keeping their reorder sequence
  const rest = sidePorts(sn, 'SOUTH').filter(p => !reserved[srcId].laneSet.has(p.id)).sort((a, b) => a.x - b.x);
  const start = left ? 4 + L.length * LS : 4;
  rest.forEach((p, i) => { p.x = start + i * P.slot; });
  const over = Math.max(...sidePorts(sn, 'SOUTH').map(p => p.x + p.width)) + 4 - sn.width; if (over > 0) widen(sn, over);
  log(`through ${srcId}: lanes ${L.map(l => `${l.bar.id}@${l.lane.toFixed(0)}`).join(', ')} on the ${left ? 'left' : 'right'} of ${inter[0]}`);
}

// ---- 3a. child under parents: a row group fed from the tier above sits under the barycentre of the feeding parent ports;
//          parent port x == child port x so every feed link is a straight vertical. Lane width was reserved first (pass 3).
for (const gid of Object.keys(g._groups)) {
  if (!isRowGroup(gid) || TIER[gid] <= ANCHOR) continue;
  const kids = g._groups[gid].members.map(m => byId.get(m));
  const feeds = [];
  for (const e of allEdges) {
    if (routedIds.has(e.id)) continue;
    const a = portAbs(e.sources[0]), b = portAbs(e.targets[0]);
    const [pp, kp] = kids.includes(b.n) && !kids.includes(a.n) ? [a, b] : kids.includes(a.n) && !kids.includes(b.n) ? [b, a] : [null, null];
    if (!pp || tierOf(pp.node) !== TIER[gid] - 1 || pp.side !== 'SOUTH' || kp.side !== 'NORTH') continue;
    feeds.push({ e, pp: pp.p.id, kp: kp.p.id, parent: pp.n, kid: kp.n });
  }
  if (!feeds.length) continue;
  const placeKids = () => { // each kid centred under its feeding ports, north ports matched to parent port x
    for (const k of kids) {
      const f = feeds.filter(q => q.kid === k).map(q => ({ ...q, x: portAbs(q.pp).cx })).sort((a, b) => a.x - b.x);
      if (!f.length) continue;
      k.x = (f[0].x + f[f.length - 1].x) / 2 - k.width / 2;
      const nps = sidePorts(k, 'NORTH').filter(p => f.some(q => q.kp === p.id)).sort((a, b) => a.x - b.x);
      nps.forEach((p, i) => { p.x = f[i].x - k.x - p.width / 2; });
    }
  };
  placeKids();
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    // (a) lane clearance: the group box must stay outside the reserved lanes of every feeding parent
    for (const [srcId, r] of Object.entries(reserved)) {
      if (r.group !== gid) continue;
      const sn = byId.get(srcId), box = groupBox(gid);
      const myFeeds = feeds.filter(q => q.parent === sn).map(q => portAbs(q.pp).cx);
      if (!myFeeds.length) continue;
      const deficit = r.left ? r.laneEdge - box.x0 : box.x1 - r.laneEdge;
      if (deficit > 0.5) { shiftSouthFrom(sn, r.left ? Math.min(...myFeeds) : -Infinity, r.left ? deficit : -deficit); log(`lanes ${srcId}: feed ports shifted ${r.left ? '+' : '-'}${deficit.toFixed(0)} to clear lanes`); moved = true; }
    }
    if (moved) placeKids();
    // (b) sibling overlap inside the group: push the right kid (and its parent's feed ports) right
    const sorted = [...kids].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i]; // gap measured between port badges that hang outside the bodies
      const push = a.x + a.width + (sidePorts(a, 'EAST').length ? P.portW : 0) + P.nodeGap - (b.x - (sidePorts(b, 'WEST').length ? P.portW : 0));
      if (push <= 0.5) continue;
      const bf = feeds.filter(q => q.kid === b);
      if (!bf.length) { b.x += push; continue; }
      for (const pn of new Set(bf.map(q => q.parent))) shiftSouthFrom(pn, Math.min(...bf.filter(q => q.parent === pn).map(q => portAbs(q.pp).cx)), push);
      log(`siblings ${a.id}|${b.id}: pushed ${b.id} right by ${push.toFixed(0)} via parent ports`); moved = true;
    }
    if (moved) placeKids(); else break;
  }
  const box = groupBox(gid), bary = feeds.map(q => portAbs(q.pp).cx).reduce((s, x) => s + x, 0) / feeds.length;
  log(`child-under-parents ${gid}: box [${box.x0.toFixed(0)}..${box.x1.toFixed(0)}] centre ${((box.x0 + box.x1) / 2).toFixed(0)}, feed barycentre ${bary.toFixed(0)}, ${feeds.length} straight drops`);
  for (const q of feeds) pinStraight(q.e);
}

// ---- 3a'. parent over children: a row node above the anchor tier whose links all go down is centred over the child ports it feeds
for (const n of g.children) {
  const gid = groupOf.get(n.id); if (!isRowGroup(gid) || TIER[gid] >= ANCHOR) continue;
  const sp = sidePorts(n, 'SOUTH').filter(p => peerOf.has(p.id) && !routedIds.has(allEdges.find(e => e.sources[0] === p.id || e.targets[0] === p.id).id)).sort((a, b) => a.x - b.x);
  if (!sp.length) continue;
  const kids = sp.map(p => portAbs(peerOf.get(p.id))).filter(k => k.side === 'NORTH' && tierOf(k.node) === TIER[gid] + 1);
  if (kids.length !== sp.length) continue;
  const kx = kids.map(k => k.cx).sort((a, b) => a - b), dx = (kx[0] + kx[kx.length - 1]) / 2 - (portAbs(sp[0].id).cx + portAbs(sp[sp.length - 1].id).cx) / 2;
  if (Math.abs(dx) > 0.5) { n.x += dx; log(`parent-over-children ${n.id}: x ${dx > 0 ? '+' : ''}${dx.toFixed(0)}`); }
  sp.forEach((p, i) => { p.x = kx[i] - n.x - p.width / 2; });
  for (const p of sp) pinStraight(allEdges.find(e => e.sources[0] === p.id || e.targets[0] === p.id));
}

// ---- 2b. bars: span of the attached drops (+barPad each side), min = own label + 2*barPad; bars whose spans overlap > 50 % share the union
{
  const barPad = 30;
  const spans = new Map();
  for (const b of bars) {
    const xs = Object.values(bySource).flat().filter(l => l.bar === b).map(l => l.lane ?? portAbs(l.srcPid).cx);
    const minW = textW(b.id) + 2 * barPad;
    let x0 = xs.length ? Math.min(...xs) - barPad : b.x, x1 = xs.length ? Math.max(...xs) + barPad : b.x + b.width;
    if (x1 - x0 < minW) { const c = (x0 + x1) / 2; x0 = c - minW / 2; x1 = c + minW / 2; }
    spans.set(b, { x0, x1, drops: xs });
  }
  for (const a of bars) for (const b of bars) {
    if (a === b) continue; const A = spans.get(a), B = spans.get(b);
    const ov = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), ratio = ov / Math.min(A.x1 - A.x0, B.x1 - B.x0);
    if (ratio > 0.5) { const u = { x0: Math.min(A.x0, B.x0), x1: Math.max(A.x1, B.x1) }; A.x0 = B.x0 = u.x0; A.x1 = B.x1 = u.x1; }
  }
  for (const b of bars) { const s = spans.get(b); b.x = s.x0; b.width = s.x1 - s.x0; log(`bar ${b.id}: drops ${Math.min(...s.drops).toFixed(0)}..${Math.max(...s.drops).toFixed(0)} -> span ${s.x0.toFixed(0)}..${s.x1.toFixed(0)} (w ${(s.x1 - s.x0).toFixed(0)})`); }
}

// ---- 3b. level siblings: same-row nodes joined by facing EAST<->WEST ports -> straight horizontal
for (const e of allEdges) {
  if (routedIds.has(e.id)) continue;
  const a = portAbs(e.sources[0]), b = portAbs(e.targets[0]);
  if (a.n === b.n || tierOf(a.node) !== tierOf(b.node) || !isRowGroup(groupOf.get(a.node)) || !isRowGroup(groupOf.get(b.node))) continue;
  if (!((a.side === 'EAST' && b.side === 'WEST' && a.cx < b.cx) || (a.side === 'WEST' && b.side === 'EAST' && b.cx < a.cx))) continue;
  if (Math.abs(a.cy - b.cy) > 0.5) { // level the port on the node with fewer ports on that side
    const [m, o] = sidePorts(a.n, a.side).length <= sidePorts(b.n, b.side).length ? [a, b] : [b, a];
    const ny = o.cy - m.n.y - m.p.height / 2;
    if (ny < 0 || ny + m.p.height > m.n.height) { log(`sibling ${e.id}: cannot level ${m.node} port`); continue; }
    m.p.y = ny;
  }
  const A = portAbs(e.sources[0]), B = portAbs(e.targets[0]), x0 = Math.min(A.cx, B.cx), x1 = Math.max(A.cx, B.cx);
  if (g.children.some(n => n !== a.n && n !== b.n && n.x < x1 && n.x + n.width > x0 && n.y < A.cy && n.y + n.height > A.cy)) { log(`sibling ${e.id}: node in between, left to libavoid`); continue; }
  pinStraight(e); log(`sibling ${a.node}<->${b.node} ${e.id}: straight at y=${A.cy.toFixed(0)}`);
}

// ---- 3c. route bar links: vertical drop onto the bar top; bar port at lane x
let barCrossUpper = 0;
const chanY = Math.min(...g.children.filter(n => tierOf(n.id) === 2).map(n => n.y)) - P.groupPad - BAND - P.margin - P.lane / 2;
for (const [srcId, L] of Object.entries(bySource)) {
  for (const l of L) {
    const sp = portAbs(l.srcPid);
    if (!reserved[srcId]) { l.lane = sp.cx; l.vertical = true; }
    const bp = l.bar.ports.find(q => q.id === l.barPid); bp.x = l.lane - P.portW / 2 - l.bar.x; bp.y = -P.portH;
    const end = { x: l.lane, y: l.bar.y - P.portH / 2 };
    const pts = l.vertical ? [{ x: sp.cx, y: sp.cy }, end] : [{ x: sp.cx, y: sp.cy }, { x: sp.cx, y: chanY }, { x: l.lane, y: chanY }, end];
    if (l.e.sources[0] === l.barPid) pts.reverse();
    fixed.push({ e: l.e, pts }); routedIds.add(l.e.id);
    for (const b of bars) if (b !== l.bar && b.y < l.bar.y && b.y + b.height > pts[0].y) barCrossUpper++;
  }
}
log(`bar drops crossing an upper bar: ${barCrossUpper}`);

// ---- 4. bundles: >=2 links between the same node pair (not already fixed): nested fan, one channel
{
  const groups = {};
  for (const e of allEdges) { if (routedIds.has(e.id)) continue; const k = [portNode.get(e.sources[0]), portNode.get(e.targets[0])].sort().join('|'); (groups[k] ??= []).push(e); }
  for (const [k, L] of Object.entries(groups)) {
    if (L.length < 2) continue;
    const [a, b] = k.split('|');
    const flankId = [a, b].find(id => FLANK[groupOf.get(id)]);
    if (!flankId) { log(`bundle ${k}: no flank end, left to libavoid`); continue; }
    const otherId = flankId === a ? b : a;
    const fn = byId.get(flankId), on = byId.get(otherId);
    bundles.push([a, b]);
    const members = L.map(e => { const fp = [e.sources[0], e.targets[0]].find(p => portNode.get(p) === flankId); const op = peerOf.get(fp); return { e, fp, op, ox: portAbs(op).cx }; });
    const rowY0 = Math.max(...g.children.filter(n => tierOf(n.id) === 1 && n.id !== flankId).map(n => n.y + n.height + P.portH)) + P.groupPad + P.margin;
    const left = on.x < fn.x;
    members.sort((p, q) => left ? q.ox - p.ox : p.ox - q.ox);
    members.forEach((m, i) => {
      const y = rowY0 + i * P.lane;
      const p = fn.ports.find(q => q.id === m.fp); p.y = y - fn.y - p.height / 2;
      const op = portAbs(m.op);
      const pts = [{ x: op.cx, y: op.cy }, { x: op.cx, y }, { x: portAbs(m.fp).cx, y }];
      if (m.e.sources[0] === m.fp) pts.reverse();
      fixed.push({ e: m.e, pts }); routedIds.add(m.e.id);
    });
    const need = rowY0 + (members.length - 1) * P.lane + P.portH + P.margin - fn.y;
    if (need > fn.height) fn.height = need;
    log(`bundle ${k}: ${L.length} links as nested fan, rows from y=${rowY0.toFixed(0)}, ${flankId} height -> ${fn.height.toFixed(0)}`);
  }
}

// ---- 5. group boxes + label bands: label left-aligned (x0 + labelPad); if a fixed link crosses its bbox, slide right to the leftmost
//          link-free gap in the band that fits it; band centre is the last resort. Band stays reserved, bbox becomes an obstacle.
const fixedSegs = () => fixed.flatMap(f => { const p = resolve(f); return p.slice(1).map((b, i) => [p[i], b]); });
const gboxes = {}, labels = {}, labelPlacement = {};
const labelPad = 8;
for (const gid of Object.keys(g._groups)) {
  const b = groupBox(gid); gboxes[gid] = b;
  const w = textW(g._groups[gid].label), h = P.labelH, y = b.y0 + P.labelMargin / 2;
  const hits = r => fixedSegs().filter(([p, q]) => segRect(p, q, r)).length;
  let x = b.x0 + labelPad, how = 'left';
  if (hits({ x, y, w, h })) {
    const xs = [b.x0 + labelPad - P.margin, ...fixedSegs().filter(([p, q]) => Math.abs(p.x - q.x) < 1e-6 && Math.max(p.y, q.y) > y && Math.min(p.y, q.y) < y + h && p.x > b.x0 && p.x < b.x1).map(([p]) => p.x), b.x1 - labelPad + P.margin].sort((p, q) => p - q);
    let placed = false;
    for (let i = 1; i < xs.length && !placed; i++) {
      const gx = xs[i - 1] + P.margin, gap = xs[i] - xs[i - 1] - 2 * P.margin;
      if (gap >= w && !hits({ x: gx, y, w, h })) { x = gx; how = 'slid-to-gap'; placed = true; }
    }
    if (!placed) { x = (b.x0 + b.x1) / 2 - w / 2; how = 'centred'; }
  }
  labelPlacement[gid] = how;
  log(`label ${gid}: ${how} at x=${x.toFixed(0)}${how === 'centred' && hits({ x, y, w, h }) ? ' (still hit)' : ''}`);
  labels[gid] = { x, y, w, h, text: g._groups[gid].label };
}

// ---- route the rest with libavoid; hand-routed segments and group labels become thin obstacles
await AvoidLib.load('/tmp/elk-proto/node_modules/libavoid-js/dist/libavoid.wasm');
const Avoid = AvoidLib.getInstance();
const DIR = { NORTH: 1, SOUTH: 2, WEST: 4, EAST: 8 };
const router = new Avoid.Router(2);
router.setRoutingParameter(Avoid.RoutingParameter.shapeBufferDistance, 10);
router.setRoutingParameter(Avoid.RoutingParameter.idealNudgingDistance, 10);
router.setRoutingParameter(Avoid.RoutingParameter.segmentPenalty, 50);
router.setRoutingParameter(Avoid.RoutingParameter.crossingPenalty, 200);
router.setRoutingOption(Avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, true);
router.setRoutingOption(Avoid.RoutingOption.nudgeSharedPathsWithCommonEndPoint, true);
router.setRoutingOption(Avoid.RoutingOption.performUnifyingNudgingPreprocessingStep, true);
const shapes = new Map(); let classId = 1; const pinClass = new Map(); const PH = 16;
for (const n of g.children) {
  const rect = new Avoid.Rectangle(new Avoid.Point(n.x - PH, n.y - PH), new Avoid.Point(n.x + n.width + PH, n.y + n.height + PH));
  shapes.set(n.id, { sh: new Avoid.ShapeRef(router, rect), x: n.x - PH, y: n.y - PH });
  for (const p of n.ports || []) {
    const s = shapes.get(n.id), id = classId++;
    const pin = new Avoid.ShapeConnectionPin(s.sh, id, n.x + p.x + p.width / 2 - s.x, n.y + p.y + p.height / 2 - s.y, false, 0, DIR[sideOfPort(n, p)] ?? 15);
    pin.setExclusive(true); pinClass.set(p.id, id);
  }
}
let obst = 0;
for (const [a, b] of fixedSegs()) {
  const T = 18; // trim ends so obstacles do not cover the pins
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const r = x1 - x0 > y1 - y0 ? [x0 + T, y0 - 1, x1 - T, y1 + 1] : [x0 - 1, y0 + T, x1 + 1, y1 - T];
  if (r[2] - r[0] <= 0 || r[3] - r[1] <= 0) continue;
  new Avoid.ShapeRef(router, new Avoid.Rectangle(new Avoid.Point(r[0], r[1]), new Avoid.Point(r[2], r[3]))); obst++;
}
for (const l of Object.values(labels)) { new Avoid.ShapeRef(router, new Avoid.Rectangle(new Avoid.Point(l.x, l.y), new Avoid.Point(l.x + l.w, l.y + l.h))); obst++; }
const conns = allEdges.filter(e => !routedIds.has(e.id)).map(e => ({ e, c: new Avoid.ConnRef(router, new Avoid.ConnEnd(shapes.get(portNode.get(e.sources[0])).sh, pinClass.get(e.sources[0])), new Avoid.ConnEnd(shapes.get(portNode.get(e.targets[0])).sh, pinClass.get(e.targets[0]))) }));
const t0 = performance.now(); router.processTransaction(); const dt = performance.now() - t0;
const toEdge = (e, pts) => ({ id: e.id, sources: e.sources, targets: e.targets, cls: e.cls, container: 'root', sections: [{ startPoint: pts[0], endPoint: pts[pts.length - 1], bendPoints: pts.slice(1, -1) }] });
const routed = conns.map(({ e, c }) => { const pl = c.displayRoute(), pts = []; for (let i = 0; i < pl.size(); i++) { const p = pl.at(i); pts.push({ x: p.x, y: p.y }); } return toEdge(e, pts); });
const fixedEdges = fixed.map(f => ({ ...toEdge(f.e, resolve(f)), fixed: true }));
const W = Math.max(...g.children.map(n => n.x + n.width)) + 40, H = Math.max(...g.children.map(n => n.y + n.height)) + 40;
const placed = { ...g, width: W, height: H, edges: allEdges.map(e => ({ ...e })), _bundles: bundles, _groupBoxes: gboxes, _labels: labels, _labelPlacement: labelPlacement }; delete placed._dropped;
fs.writeFileSync(`/tmp/elk-proto/out-${DST}.json`, JSON.stringify(placed, null, 1));
const out = { ...placed, edges: [...fixedEdges, ...routed] };
fs.writeFileSync(`/tmp/elk-proto/out-${DST}-av.json`, JSON.stringify(out, null, 1));
log(`${DST}-av: ${fixedEdges.length} hand-routed, ${routed.length} libavoid-routed (${dt.toFixed(0)} ms, ${obst} obstacles)`);
