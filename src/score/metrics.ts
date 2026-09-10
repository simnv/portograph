import type { LayoutModel, Rect } from '../model/index.js';
import { boundingBox, bounds, EPS, intersection, length, near, samePoint, vertical } from './geometry.js';
import { bundlePair, endpoints, junctionFan } from './model.js';
import type { Segment } from './model.js';
import type { ScoreAdvisory, ScoreMetrics } from './types.js';

export const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const mean = (ns: number[], empty = 1): number => ns.length ? ns.reduce((sum, n) => sum + n / ns.length, 0) : empty;
const compactness = (rects: Rect[]): number => {
  const box = boundingBox(rects);
  return !box ? 1 : box.width > 0 && box.height > 0 ? clamp(rects.reduce((sum, r) => sum + (r.width / box.width) * (r.height / box.height), 0)) : 0;
};

export function metrics(model: LayoutModel, routed: Segment[]): ScoreMetrics {
  const links = [...new Set(routed.map(s => s.link))], nodes = Object.values(model.nodes);
  const crossings = new Set<string>();
  for (let i = 0; i < routed.length; i++) for (const b of routed.slice(i + 1)) {
    const a = routed[i]!;
    if (a.link === b.link) continue;
    const p = intersection(a.segment, b.segment);
    if (!p) continue;
    const atEnd = (s: Segment): boolean => [s.link.path!.segments[0]!.from, s.link.path!.segments.at(-1)!.to].some(q => samePoint(p, q));
    if (atEnd(a) && atEnd(b) || junctionFan(model, a, b)) continue;
    const extent = { from: p, to: p, owner: a.segment.owner };
    if (bundlePair(model, a, b, extent)) continue;
    crossings.add(JSON.stringify([[a.link.id, b.link.id].sort(), p.x, p.y]));
  }
  const bendCounts: number[] = [];
  let eligible = 0, alternating = 0;
  for (const link of links) {
    const path = link.path!.segments, turns: number[] = [];
    let uTurn = false;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y, bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
      const cross = ax * by - ay * bx;
      if (near(cross, 0)) { if (ax * bx + ay * by < -EPS) { uTurn = true; turns.push(0); } }
      else turns.push(Math.sign(cross));
    }
    bendCounts.push(turns.length);
    if (path.length >= 2) { eligible++; if (!uTurn && turns.every((turn, i) => i === 0 || turn !== turns[i - 1])) alternating++; }
  }
  const meanBends = mean(bendCounts, 0);
  const global = compactness(nodes.map(n => n.bounds!));
  const groups = Object.fromEntries(Object.values(model.groups).map(g => [g.id, compactness(g.nodes.flatMap(id => model.nodes[id]?.bounds ? [model.nodes[id]!.bounds!] : []))]));
  const aligned = nodes.filter(n => nodes.filter(other => other !== n && Math.abs(n.bounds!.x - other.bounds!.x) <= 1 + EPS).length >= 2 || nodes.filter(other => other !== n && Math.abs(n.bounds!.y - other.bounds!.y) <= 1 + EPS).length >= 2).length;
  let flowEligible = 0, downward = 0;
  const tier = (node: string): number | undefined => { const owner = model.nodes[node]?.owner; return owner?.kind === 'group' ? model.groups[owner.id]?.tier : undefined; };
  for (const s of routed) {
    const ends = endpoints(s.link), source = tier(ends.from.node), target = tier(ends.to.node);
    if (source === undefined || target === undefined || target <= source || !vertical(s.segment) || length(s.segment) <= EPS) continue;
    flowEligible++;
    if (s.segment.to.y > s.segment.from.y) downward++;
  }
  const lengths = routed.map(s => length(s.segment)), average = mean(lengths, 0), longest = lengths.length ? Math.max(...lengths) : 0;
  const std = longest ? longest * Math.sqrt(mean(lengths.map(n => (n / longest - average / longest) ** 2), 0)) : 0;
  const nodeBox = boundingBox(nodes.map(n => n.bounds!));
  // Canvas padding is not diagram geometry. Paths and visible labels still enlarge its bbox.
  const box = boundingBox([...nodes.map(n => n.bounds!), ...model.links.flatMap(l => l.path?.segments.map(bounds) ?? []), ...model.labels.flatMap(l => !l.omitted && l.bounds ? [l.bounds] : [])]);
  const axis = nodeBox ? nodeBox.x + nodeBox.width / 2 : 0;
  const mirrored = nodes.filter(n => nodes.some(other => other !== n && Math.abs(other.bounds!.x + other.bounds!.width / 2 - (2 * axis - n.bounds!.x - n.bounds!.width / 2)) <= 4 + EPS
    && Math.abs(other.bounds!.y + other.bounds!.height / 2 - n.bounds!.y - n.bounds!.height / 2) <= 4 + EPS
    && Math.abs(other.bounds!.width - n.bounds!.width) <= 4 + EPS && Math.abs(other.bounds!.height - n.bounds!.height) <= 4 + EPS)).length;
  return {
    crossings: { value: links.length ? 1 - Math.min(1, crossings.size / links.length) : 1, count: crossings.size, routedLinks: links.length, ratio: links.length ? crossings.size / links.length : 0 },
    bends: { value: 1 - Math.min(1, meanBends / 3), mean: meanBends, max: bendCounts.length ? Math.max(...bendCounts) : 0, total: bendCounts.reduce((sum, n) => sum + n, 0) },
    continuity: { value: eligible ? alternating / eligible : 1, eligible, alternating },
    compactness: { value: mean([global, ...Object.values(groups)]), global, groups },
    gridAlignment: nodes.length ? aligned / nodes.length : 1,
    flow: { value: flowEligible ? downward / flowEligible : 1, downward, eligible: flowEligible },
    aspectRatio: !box ? 1 : Math.max(box.width, box.height) > 0 ? Math.min(box.width, box.height) / Math.max(box.width, box.height) : 0,
    segmentUniformity: { value: !lengths.length ? 1 : average > 0 ? clamp(1 - std / average) : 0, mean: average, std, count: lengths.length },
    symmetry: nodes.length ? mirrored / nodes.length : 1,
  };
}

export function weightedScore(m: ScoreMetrics): number {
  return clamp((0.30 * clamp(m.crossings.value) + 0.15 * clamp(m.bends.value) + 0.10 * clamp(m.continuity.value)
    + 0.10 * clamp(m.compactness.value) + 0.10 * clamp(m.gridAlignment) + 0.10 * clamp(m.flow.value)
    + 0.05 * clamp(m.aspectRatio) + 0.05 * clamp(m.segmentUniformity.value)) / 0.95);
}

export function advisories(m: ScoreMetrics, nodeCount: number): ScoreAdvisory[] {
  if (nodeCount > 100) return [];
  const small = nodeCount <= 30;
  const checks: ScoreAdvisory[] = [
    { metric: 'crossings', actual: m.crossings.ratio, target: small ? 0.05 : 0.15, relation: '<=' },
    { metric: 'mean bends', actual: m.bends.mean, target: small ? 1 : 1.5, relation: '<=' },
    { metric: 'continuity', actual: m.continuity.value, target: small ? 0.7 : 0.6, relation: '>=' },
    { metric: 'compactness', actual: m.compactness.value, target: small ? 0.25 : 0.2, relation: '>=' },
    { metric: 'grid alignment', actual: m.gridAlignment, target: small ? 0.6 : 0.5, relation: '>=' },
    { metric: 'flow', actual: m.flow.value, target: small ? 0.8 : 0.7, relation: '>=' },
    { metric: 'aspect', actual: m.aspectRatio, target: small ? 0.5 : 0.4, relation: '>=' },
  ];
  if (small) checks.push({ metric: 'max bends', actual: m.bends.max, target: 3, relation: '<=' });
  return checks.filter(c => c.relation === '<=' ? c.actual > c.target + EPS : c.actual < c.target - EPS);
}
