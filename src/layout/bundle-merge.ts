import type { Bundle, LayoutModel, PathSegment, Point } from '../model/index.js';
import { DEFAULT_STROKE_WIDTHS, linkStrokeWidth } from '../theme/geometry.js';
import { clone, normal, type Member, clearOfGroupEdges, edgeMargin, groupDepthPairs } from './bundle-geometry.js';
import { BundleFeasibilityError, polyline, reverse } from './bundle-paths.js';
import { BUNDLE_ROW_SETTLE_EPS } from './tolerance.js';

/** Merge selected members through a comb of real trunk joins, retaining complete logical paths. */
export function mergeMembers(model: LayoutModel, bundle: Bundle, list: Member[], q: number): Bundle['mergeRuns'] {
  const selected = list.filter(m => m.link.technique === 'merge');
  if (selected.length < 2) {
    if (selected.length && !model.diagnostics.some(d => d.code === 'MERGE_SINGLE_MEMBER' && d.owners?.some(o => o.kind === 'link' && o.id === selected[0]!.link.id))) {
      model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'MERGE_SINGLE_MEMBER', owners: [selected[0]!.link.owner],
        message: `${selected[0]!.link.id} has no selected merge partner; draw its ordinary anchored member path without a multiplicity count.` });
    }
    return;
  }
  const selectedIds = new Set(selected.map(m => m.link.id));
  const shared = selected.some(m => m.link.path!.segments.some(s => s.owner.kind === 'shared-stem'));
  const constrained = shared || selected.some(m => model.lanes.some(l => l.owner.kind === 'link' && l.owner.id === m.link.id))
    || model.barDrops.some(d => selected.some(m => m.link.id === d.link));
  const n = normal(selected[0]!.a.side!), horizontal = n.x !== 0;
  const local = (p: Point): Point => ({ x: horizontal ? p.y : p.x, y: horizontal ? n.x * p.x : n.y * p.y });
  const world = (p: Point): Point => horizontal ? { x: n.x * p.y, y: p.x } : { x: p.x, y: n.y * p.y };
  const existing = new Map(selected.map(item => [item.link.id, item.reversed ? reverse(item.link.path!.segments) : clone(item.link.path!.segments)]));
  const endpoints = new Map(selected.map(item => {
    const run = shared ? existing.get(item.link.id)!.filter(s => s.owner.kind !== 'shared-stem' && !s.lane && !s.barCross
      && local(s.from).x === local(s.to).x && local(s.to).y > local(s.from).y)
      .sort((a, b) => local(b.to).y - local(b.from).y - local(a.to).y + local(a.from).y)[0] : undefined;
    if (shared && !run) throw new BundleFeasibilityError('BUNDLE_MERGE_APPROACH', bundle.id, 'No independent channel remains beyond the shared junction.');
    return [item.link.id, { from: local(run?.from ?? item.a.anchor!), to: local(run?.to ?? item.b.anchor!) }];
  }));
  const sourceOrder = [...selected].sort((a, b) => endpoints.get(a.link.id)!.from.x - endpoints.get(b.link.id)!.from.x);
  const targetOrder = [...selected].sort((a, b) => endpoints.get(a.link.id)!.to.x - endpoints.get(b.link.id)!.to.x);
  const trunk = Math.min(...[...endpoints.values()].flatMap(e => [e.from.x, e.to.x]));
  // Join and leave rows never run along a group edge (ADR-0013): the whole row set moves outward
  // until every row clears the edge depths of the two endpoint groups by the edge margin.
  const pairs = groupDepthPairs(model, bundle.nodes.map(id => model.document.nodes[id]!.group), p => local(p).y);
  const shiftRows = (first: number, step: number, direction: 1 | -1): number => {
    let value = first;
    for (let guard = 0; guard < 8; guard++) {
      const moved = selected.map((_, index) => clearOfGroupEdges(value + index * step, pairs, direction, edgeMargin(Math.max(...selected.map(m => linkStrokeWidth(m.link))))) - (value + index * step));
      const delta = direction > 0 ? Math.max(0, ...moved) : Math.min(0, ...moved);
      if (Math.abs(delta) < BUNDLE_ROW_SETTLE_EPS) return value;
      value += delta;
    }
    return value;
  };
  const start = shiftRows(Math.max(...[...endpoints.values()].map(e => e.from.y)) + 15, q, 1);
  let end = shiftRows(Math.min(...[...endpoints.values()].map(e => e.to.y)) - 15, -q, -1);
  if (constrained) {
    const entries = model.lanes.filter(l => l.owner.kind === 'link' && selectedIds.has(l.owner.id))
      .map(l => Math.min(local({ x: l.x, y: l.bounds.y }).y, local({ x: l.x, y: l.bounds.y + l.bounds.height }).y));
    for (const node of Object.values(model.nodes)) {
      if (bundle.nodes.includes(node.id)) continue;
      const entry = Math.min(local({ x: node.bounds!.x, y: node.bounds!.y }).y,
        local({ x: node.bounds!.x + node.bounds!.width, y: node.bounds!.y + node.bounds!.height }).y);
      if (entry > start) entries.push(entry);
    }
    end = Math.min(end, ...entries) - q;
  }
  if (end - start < (2 * selected.length - 1) * q) throw new BundleFeasibilityError('BUNDLE_MERGE_CAPACITY', bundle.id, `No free counted trunk interval before the fixed reservations (start ${start}, end ${end}, need ${(2 * selected.length - 1) * q}).`);
  for (const item of selected) {
    const { from, to } = endpoints.get(item.link.id)!;
    const join = start + sourceOrder.indexOf(item) * q, leave = end - targetOrder.indexOf(item) * q;
    if (constrained) {
      const original = existing.get(item.link.id)!, index = original.findIndex(s => local(s.from).x === from.x && local(s.to).x === from.x
        && local(s.from).y <= join && local(s.to).y >= leave);
      if (index < 0) throw new BundleFeasibilityError('BUNDLE_MERGE_APPROACH', bundle.id, 'The constrained member has no monotone approach for a shared trunk.');
      const run = original[index]!;
      const prefix = polyline([run.from, ...[{ x: from.x, y: join }, { x: trunk, y: join }, { x: trunk, y: leave }, { x: from.x, y: leave }].map(world)], bundle.owner);
      const tail = { ...run, from: world({ x: from.x, y: leave }) };
      const segments = [...original.slice(0, index), ...prefix, tail, ...original.slice(index + 1)];
      item.link.path!.segments = item.reversed ? reverse(segments) : segments;
      continue;
    }
    const segments = polyline([from, { x: from.x, y: join }, { x: trunk, y: join }, { x: trunk, y: leave }, { x: to.x, y: leave }, to].map(world), bundle.owner);
    item.link.path!.segments = item.reversed ? reverse(segments) : segments;
  }
  // Split the trunk at every membership change. Each count applies only to this exact run.
  const runs = selected.flatMap(item => item.link.path!.segments.filter(segment => {
    const a = local(segment.from), b = local(segment.to); return segment.owner.kind === 'bundle' && segment.owner.id === bundle.id && a.x === trunk && b.x === trunk;
  }).map(segment => ({ link: item.link.id, low: Math.min(local(segment.from).y, local(segment.to).y), high: Math.max(local(segment.from).y, local(segment.to).y) })));
  const cuts = [...new Set(runs.flatMap(run => [run.low, run.high]))].sort((a, b) => a - b);
  bundle.mergeRuns = [];
  for (let i = 1; i < cuts.length; i++) {
    const low = cuts[i - 1]!, high = cuts[i]!;
    const ids = [...new Set(runs.filter(run => run.low <= low && run.high >= high).map(run => run.link))].sort();
    if (ids.length < 2) continue;
    const segment: PathSegment = { from: world({ x: trunk, y: low }), to: world({ x: trunk, y: high }), owner: { ...bundle.owner } };
    // One trunk paints for every member of this run, so it carries the widest resolved member
    // width. A narrower trunk would draw a stroke no reservation and no gate ever measured.
    const width = Math.max(...ids.map(id => linkStrokeWidth(model.links.find(link => link.id === id)!)));
    bundle.mergeRuns.push({ id: `merge:${bundle.id}:${bundle.mergeRuns.length}`, members: ids, count: ids.length,
      path: { owner: { ...bundle.owner }, layer: 'routed', fixed: true,
        ...(width === DEFAULT_STROKE_WIDTHS.path ? {} : { strokeWidth: width }), segments: [segment] } });
  }
  return bundle.mergeRuns;
}
