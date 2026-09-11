import type { LayoutGroup, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { portAnchor } from '../geometry/index.js';
import { nodeTier, selectAnchorTier } from './lanes.js';
import { findPort } from './row-paths.js';
import { portId, bandGap } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';
import { rowGap } from './sides-two.js';
import { withLayoutMutation } from './mutation.js';
import { fitRegionGroup, placementWarning, rebuildRegions, right } from './regions.js';
import { EPS } from '../score/geometry.js';

export interface CentreBudget { remaining: number; passes: number }
export function createCentreBudget(): CentreBudget { return { remaining: 8, passes: 0 }; }
export { selectAnchorTier };
/**
 * `x` is the authoritative feed x: the parent anchor, or the owned lane x in the adjacent tier for a
 * transit. `key` is the parent port either way: a parent port feeding several children is vertical
 * to one of them (the first by x), and the rest fan — lanes packed at lane width cannot seat two
 * default-width children side by side, so a per-lane winner would only manufacture infeasible pins.
 */
interface Feed { parent: LayoutPort; child: LayoutPort; link: string; x: number; key: string; transit: boolean }
function feeds(model: LayoutModel, tier: number, authority: number): Feed[] {
  const result: Feed[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const [parentRef, childRef] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
      if (!parentRef || !childRef || nodeTier(model, childRef.node) !== tier) continue;
      // The parent is in the adjacent authority tier, or beyond it for a link that transits the
      // adjacent tier through an owned lane (7a). Both fix the x the child must sit under.
      const parentTier = nodeTier(model, parentRef.node);
      if (parentTier === undefined || (tier > authority ? parentTier > authority : parentTier < authority)) continue;
      if ([parentRef.node, childRef.node].some(id => model.groups[model.document.nodes[id]!.group]!.flank)) continue;
      const parent = findPort(model, parentRef)!, child = findPort(model, childRef)!;
      if (parent.side !== (tier > authority ? 'bottom' : 'top') || child.side !== (tier > authority ? 'top' : 'bottom')) continue;
      // A bundle member carries its lane only until 7e, which owns member geometry; only a
      // non-bundle transit with an owned lane in the authority tier fixes its child's x here.
      const lane = parentTier === authority ? undefined
        : model.lanes.find(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && lane.tier === authority);
      if (parentTier !== authority && (!lane || link.bundle)) continue;
      result.push({ parent, child, link: link.id, x: lane ? lane.x : parent.anchor!.x,
        key: portId(parent.ref), transit: Boolean(lane) });
    }
  }
  return result;
}
function shiftNode(node: LayoutNode, dx: number): void {
  node.bounds!.x += dx;
  for (const port of node.ports) port.anchor!.x += dx;
}
interface WideningLimit { low: number; high: number }

/** Widen into free row space only; stacked siblings do not constrain horizontal growth. */
function siblingLimit(model: LayoutModel, group: LayoutGroup, node: LayoutNode): WideningLimit {
  const limit = { low: -Infinity, high: Infinity }, box = node.bounds!, order = group.rowOrder!;
  const index = order.indexOf(node.id);
  for (const [otherIndex, id] of order.entries()) {
    if (id === node.id) continue;
    const other = model.nodes[id]!.bounds!;
    if (Math.min(box.y + box.height, other.y + other.height) <= Math.max(box.y, other.y) + EPS) continue;
    if (otherIndex < index) limit.low = Math.max(limit.low, right(other) + rowGap(model, id, node.id));
    else limit.high = Math.min(limit.high, other.x - rowGap(model, node.id, id));
  }
  return limit;
}

/** Keep compatible targets that fit between siblings; other ports retain their legal slots. */
function alignSide(node: LayoutNode, side: Side, targets: Map<string, number>, limit: WideningLimit): Set<string> {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, kept: { index: number; x: number; key: string }[] = [];
  const box = node.bounds!, oldRight = right(box);
  if (box.x < limit.low - EPS || oldRight > limit.high + EPS) return new Set();
  for (const [index, port] of ports.entries()) {
    const key = portId(port.ref), x = targets.get(key), last = kept[kept.length - 1];
    if (x !== undefined && (x - index * pitch - 10 - pitch / 2 < limit.low - EPS
      || x + (ports.length - 1 - index) * pitch + 10 + pitch / 2 > limit.high + EPS)) continue;
    if (x !== undefined && (!last || x - last.x >= (index - last.index) * pitch)) kept.push({ index, x, key });
  }
  if (!kept.length) return new Set();
  const first = kept[0]!, last = kept[kept.length - 1]!;
  box.x = Math.min(box.x, first.x - first.index * pitch - 10 - pitch / 2);
  box.width = Math.max(oldRight, last.x + (ports.length - 1 - last.index) * pitch + 10 + pitch / 2) - box.x;
  node.size!.width = box.width;
  for (const port of node.ports) {
    if (port.side === 'left') port.anchor!.x = box.x;
    if (port.side === 'right') port.anchor!.x = right(box);
  }
  ports.forEach((port, index) => {
    const before = [...kept].reverse().find(target => target.index <= index), after = kept.find(target => target.index >= index);
    const x = before && after && before.index !== after.index ? before.x + (index - before.index) * (after.x - before.x) / (after.index - before.index)
      : before ? before.x + (index - before.index) * pitch : first.x - (first.index - index) * pitch;
    port.anchor = portAnchor(box, side, x - box.x);
  });
  return new Set(kept.map(target => target.key));
}
function geometry(model: LayoutModel): number[] {
  return Object.values(model.nodes).flatMap(node => [node.bounds!.x, node.bounds!.width, ...node.ports.map(port => port.anchor!.x)]);
}
/** Reusable bounded producer. The caller shares one budget across all ordered placement replay. */
export function centreDraft(model: LayoutModel, budget: CentreBudget): void {
  if (!Number.isSafeInteger(budget.remaining) || !Number.isSafeInteger(budget.passes) || budget.remaining < 0
    || budget.passes < 0 || budget.remaining + budget.passes > 8) throw new Error('Centering requires one shared eight-pass budget');
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) { delete model.anchorTier; return; }
  model.anchorTier = anchor;
  const tiers = model.tierBands.map(band => band.tier), index = tiers.indexOf(anchor);
  const steps = [...tiers.slice(index + 1).map((tier, i) => ({ tier, authority: tiers[index + i]! })),
    ...tiers.slice(0, index).reverse().map((tier, i) => ({ tier, authority: tiers[index - i]! }))];
  const allFeeds = new Map(steps.map(step => [step.tier, feeds(model, step.tier, step.authority)]));
  const winners = new Map<string, string>();
  for (const [tier, list] of allFeeds) for (const feed of [...list].sort((a, b) => model.nodes[a.child.ref.node]!.bounds!.x - model.nodes[b.child.ref.node]!.bounds!.x || portId(a.child.ref).localeCompare(portId(b.child.ref)))) {
    const key = `${tier}:${feed.key}`;
    if (!winners.has(key)) winners.set(key, portId(feed.child.ref));
  }
  const groupOrder = new Map(steps.map(step => [step.tier, Object.values(model.groups).filter(group => group.tier === step.tier && !group.flank)
    .sort((a, b) => a.bounds!.x - b.bounds!.x).map(group => group.id)]));
  // Preserve which side of each fixed lane contains each group.
  const limits = new Map<string, { low: number; high: number }>();
  for (const group of Object.values(model.groups)) {
    let low = -Infinity, high = Infinity;
    for (const lane of model.lanes.filter(lane => lane.tier === group.tier)) {
      if (group.bounds!.x >= lane.x) low = Math.max(low, right(lane.bounds)); else high = Math.min(high, lane.bounds.x);
    }
    limits.set(group.id, { low, high });
  }
  let unresolved = new Set<string>();
  while (budget.remaining > 0) {
    budget.remaining--; budget.passes++;
    const before = geometry(model); unresolved = new Set();
    for (const { tier, authority } of steps) {
      const list = feeds(model, tier, authority), order = groupOrder.get(tier)!;
      let previous: LayoutGroup | undefined;
      for (const id of order) {
        const group = model.groups[id]!, own = list.filter(feed => model.document.nodes[feed.child.ref.node]!.group === id);
        // Bar shaping owns their source-derived slots and stacked spans; row centering cannot repack them.
        if (model.document.groups[id]!.shape === 'bar') { previous = group; continue; }
        if (!own.length) { previous = group; continue; }
        const saved = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
        // Adjacent feeds first: a transit yields to any other feed of the same child port instead
        // of contesting it, so a fan of lanes into one port cannot exhaust the shared budget.
        const wanted = new Map<string, number>(), yielded = new Set<Feed>();
        for (const feed of [...own].sort((a, b) => Number(a.transit) - Number(b.transit))) {
          const child = portId(feed.child.ref);
          if (winners.get(`${tier}:${feed.key}`) !== child) {
            placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares a parent port; the first child by x owns vertical alignment.`, [feed.link]); continue;
          }
          if (!wanted.has(child)) wanted.set(child, feed.x);
          else if (wanted.get(child) !== feed.x) {
            if (feed.transit) {
              yielded.add(feed);
              placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares its child port with a feed at another x; that feed owns vertical alignment.`, [feed.link]);
            } else unresolved.add(id);
          }
        }
        // Centre under the feeds that may own an alignment; a yielded transit would only pull the
        // group away from the x its child is then aligned to.
        const vertical = own.filter(feed => winners.get(`${tier}:${feed.key}`) === portId(feed.child.ref) && !yielded.has(feed));
        const chosen = vertical.length ? vertical : own;
        const distinctParents = new Map(chosen.map(feed => [feed.key, feed.x]));
        const distinctChildren = new Map(chosen.map(feed => [portId(feed.child.ref), feed.child.anchor!.x]));
        const mean = (values: Iterable<number>) => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
        moveGroup(model, group, mean(distinctParents.values()) - mean(distinctChildren.values()), 0);
        const aligned = new Set<string>();
        for (const nodeId of group.rowOrder!) {
          const node = model.nodes[nodeId]!;
          for (const side of ['top', 'bottom'] as const) {
            for (const key of alignSide(node, side, wanted, siblingLimit(model, group, node))) aligned.add(key);
          }
        }
        for (const feed of own) {
          const key = portId(feed.child.ref);
          if (wanted.has(key) && !aligned.has(key)) {
            unresolved.add(id);
            placementWarning(model, 'CENTRE_ALIGNMENT_INFEASIBLE',
              `${feed.link} cannot align within its child's available row span; routing completes it.`, [feed.link]);
          }
        }
        for (let i = 1; i < group.rowOrder!.length; i++) {
          const a = model.nodes[group.rowOrder![i - 1]!]!, b = model.nodes[group.rowOrder![i]!]!;
          const minimum = right(a.bounds!) + rowGap(model, a.id, b.id);
          if (b.bounds!.x < minimum) shiftNode(b, minimum - b.bounds!.x);
        }
        fitRegionGroup(model, group);
        const limit = limits.get(id)!, low = Math.max(limit.low, previous ? right(previous.bounds!) + bandGap(model) : -Infinity);
        let high = limit.high;
        const nextFixed = order.slice(order.indexOf(id) + 1).map(id => model.groups[id]!).find(other => !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === other.id));
        if (nextFixed) high = Math.min(high, nextFixed.bounds!.x - bandGap(model));
        for (const flank of Object.values(model.groups).filter(group => group.flank && group.tier === tier)) {
          if (flank.flank!.align === 'left') {
            if (group.bounds!.x < right(flank.bounds!) + bandGap(model)) moveGroup(model, group, right(flank.bounds!) + bandGap(model) - group.bounds!.x, 0);
          } else high = Math.min(high, flank.bounds!.x - bandGap(model));
        }
        if (group.bounds!.width > high - low) {
          model.groups[id] = saved.group;
          for (const node of saved.nodes) model.nodes[node.id] = node;
          unresolved.add(id); previous = saved.group; continue;
        }
        const x = Math.max(low, Math.min(group.bounds!.x, high - group.bounds!.width));
        moveGroup(model, group, x - group.bounds!.x, 0);
        for (const [key, x] of wanted) {
          const port = group.nodes.flatMap(id => model.nodes[id]!.ports).find(port => portId(port.ref) === key)!;
          if (Math.abs(port.anchor!.x - x) > 0.5) unresolved.add(id);
        }
        previous = group;
      }
    }
    rebuildRegions(model);
    const after = geometry(model);
    if (!unresolved.size && after.every((value, i) => Math.abs(value - before[i]!) <= 0.5)) return;
  }
  if (!model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE')) placementWarning(model,
    'PLACEMENT_NON_CONVERGENCE', 'Centering exhausted the shared eight-pass budget; unresolved alignments remain for routing and final gates.', [...unresolved], 'group');
}
export function centre(model: LayoutModel): LayoutModel { return withLayoutMutation(model, 'centre', draft => centreDraft(draft, createCentreBudget())); }
