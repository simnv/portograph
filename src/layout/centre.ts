import type { LayoutGroup, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { portAnchor } from '../geometry/index.js';
import { laneSidesHold, nodeTier, occupiedOverhang, selectAnchorTier } from './lanes.js';
import { findPort } from './row-paths.js';
import { portId, bandGap } from './skeleton-graph.js';
import { moveGroup } from './skeleton-geometry.js';
import { rowGap } from './sides-two.js';
import { alignmentAllowance } from './size.js';
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

/**
 * Keep compatible targets that fit between siblings and inside the node's own alignment allowance;
 * other ports retain their legal slots.
 *
 * A target is kept only when reaching it leaves the body no wider than `alignmentAllowance` — the
 * third bound on a widening, beside the siblings of the row and the reserved lane and flank window
 * of `reservedWindow`, and the one that says the node has to stay something a reader still reads as
 * this node (ticket 29). What gives way is the alignment: the port keeps its legal slot, the feed is
 * reported `CENTRE_ALIGNMENT_INFEASIBLE` like any other alignment the row cannot hold, and stage 8
 * routes the link instead of receiving it pinned. Two targets that each fit alone but not together —
 * one parent far to the left, one far to the right — decline the whole side, because widening to the
 * outer one is the same growth by another name.
 */
function alignSide(node: LayoutNode, side: Side, targets: Map<string, number>, limit: WideningLimit): Set<string> {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, kept: { index: number; x: number; key: string }[] = [];
  const box = node.bounds!, oldRight = right(box);
  if (box.x < limit.low - EPS || oldRight > limit.high + EPS) return new Set();
  const allowance = alignmentAllowance(node, side);
  /** The width the body ends with when the port at `index` is aligned to `x`. */
  const reach = (index: number, x: number): number =>
    Math.max(oldRight, x + (ports.length - 1 - index) * pitch + 10 + pitch / 2)
    - Math.min(box.x, x - index * pitch - 10 - pitch / 2);
  for (const [index, port] of ports.entries()) {
    const key = portId(port.ref), x = targets.get(key), last = kept[kept.length - 1];
    if (x !== undefined && (x - index * pitch - 10 - pitch / 2 < limit.low - EPS
      || x + (ports.length - 1 - index) * pitch + 10 + pitch / 2 > limit.high + EPS)) continue;
    if (x !== undefined && reach(index, x) > allowance + EPS) continue;
    if (x !== undefined && (!last || x - last.x >= (index - last.index) * pitch)) kept.push({ index, x, key });
  }
  if (!kept.length) return new Set();
  const first = kept[0]!, last = kept[kept.length - 1]!;
  if (Math.max(oldRight, last.x + (ports.length - 1 - last.index) * pitch + 10 + pitch / 2)
    - Math.min(box.x, first.x - first.index * pitch - 10 - pitch / 2) > allowance + EPS) return new Set();
  // The width the alignment needs is what each edge moved outward, added to the width the node
  // already has. `Math.max(oldRight, grown) - box.x` states the same thing through two absolute
  // edges, and a rectangle recovered through an edge it was not stored with does not come back:
  // `(box.x + box.width) - box.x` returns `box.width` only when `box.x + box.width` is itself
  // representable, and it loses up to half a ULP of the sum's binade when it is not — the coarse
  // widths this rule works in make a binade crossing the case that does it. A node that moved
  // neither edge then ended narrower than the width it kept. Both terms below are non-negative, so
  // centring widens the node or leaves it alone, in the arithmetic and not only in the intent the
  // guards in `mutation.ts` read. It can leave the right edge up to two ULP short of `grown`; no
  // consumer reads that edge, and the last kept port sits 10 + pitch / 2 inside it.
  const oldX = box.x, grown = last.x + (ports.length - 1 - last.index) * pitch + 10 + pitch / 2;
  box.x = Math.min(box.x, first.x - first.index * pitch - 10 - pitch / 2);
  box.width += (oldX - box.x) + Math.max(0, grown - oldRight);
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
interface CentreContext {
  steps: { tier: number; authority: number }[];
  winners: Map<string, string>;
  groupOrder: Map<number, string[]>;
  limits: Map<string, { low: number; high: number }>;
  /** The flank window of each tier, measured once: 7c never moves or resizes a flank. */
  flankLimits: Map<number, WideningLimit>;
}
/** Everything one centring pass reads but never writes: step order, winners, group order, lane windows. */
function centreContext(model: LayoutModel, anchor: number): CentreContext {
  const tiers = model.tierBands.map(band => band.tier), index = tiers.indexOf(anchor);
  const steps = [...tiers.slice(index + 1).map((tier, i) => ({ tier, authority: tiers[index + i]! })),
    ...tiers.slice(0, index).reverse().map((tier, i) => ({ tier, authority: tiers[index - i]! }))];
  const winners = new Map<string, string>();
  for (const step of steps) for (const feed of [...feeds(model, step.tier, step.authority)].sort((a, b) => model.nodes[a.child.ref.node]!.bounds!.x - model.nodes[b.child.ref.node]!.bounds!.x || portId(a.child.ref).localeCompare(portId(b.child.ref)))) {
    const key = `${step.tier}:${feed.key}`;
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
  const flankLimits = new Map<number, WideningLimit>(model.tierBands.map(band => [band.tier, { low: -Infinity, high: Infinity }]));
  for (const flank of Object.values(model.groups)) {
    const limit = flank.flank && flankLimits.get(flank.tier!);
    if (!limit) continue;
    if (flank.flank!.align === 'left') limit.low = Math.max(limit.low, right(flank.bounds!) + bandGap(model));
    else limit.high = Math.min(limit.high, flank.bounds!.x - bandGap(model));
  }
  return { steps, winners, groupOrder, limits, flankLimits };
}
/**
 * The window a group of `tier` may never leave. A fixed lane of 7a stays on the side that holds it,
 * and a flank beside the tier keeps its band gap. The window holds the box of the group and the
 * stroke-aware reach of its nodes and pills, which `validateLanes` measures as well.
 */
function reservedWindow(model: LayoutModel, context: CentreContext, tier: number, id: string): WideningLimit {
  const limit = context.limits.get(id)!, flank = context.flankLimits.get(tier) ?? { low: -Infinity, high: Infinity };
  const low = Math.max(limit.low, flank.low), high = Math.min(limit.high, flank.high);
  // An unbounded window needs no measurement, and measuring one costs a pass over the group.
  if (low === -Infinity && high === Infinity) return { low, high };
  const reach = occupiedOverhang(model, model.groups[id]!);
  return { low: low + reach.left, high: high - reach.right };
}

/**
 * The rightmost edge a group of `tier` may take before the groups after it have nowhere to go.
 * A widening makes them give way (`packClear`), but they never cross a reserved lane or a flank.
 * One backwards sweep packs them against their own windows and reserves the room that needs.
 * Space before use: a widening this room cannot hold is declined here. It is not discovered as an
 * overlap at stage 8.
 */
function tailReservation(model: LayoutModel, context: CentreContext, tier: number, order: string[]): Map<string, number> {
  const result = new Map<string, number>();
  let bound = Infinity;
  // The step of one group never moves or resizes the groups after it. One sweep therefore stays
  // exact for the whole tier step. It costs one pass over the groups of the tier.
  for (const id of [...order].reverse()) {
    result.set(id, bound);
    bound = Math.min(bound, reservedWindow(model, context, tier, id).high) - model.groups[id]!.bounds!.width - bandGap(model);
  }
  return result;
}

/**
 * Keep the tier packed left to right. Centring widens a group into the space of the groups after
 * it. Those groups must give way, also when this step does not centre them, and when their own
 * centring window is too narrow to hold them. Two overlapping group boxes are not a poor diagram.
 * They are an input stage 8 refuses, because a foreign group obstacle then contains an attachment
 * shape.
 */
function packClear(model: LayoutModel, context: CentreContext, tier: number, group: LayoutGroup, previous: LayoutGroup | undefined): void {
  if (!previous) return;
  const window = reservedWindow(model, context, tier, group.id);
  const low = Math.max(window.low, right(previous.bounds!) + bandGap(model));
  if (group.bounds!.x >= low - EPS) return;
  const bounds = { ...group.bounds!, x: low };
  if (low + group.bounds!.width > window.high + EPS || !laneSidesHold(model, [{ group, bounds }])) {
    placementWarning(model, 'CENTRE_TIER_PACK_INFEASIBLE',
      `${group.id} cannot clear ${previous.id} inside its reserved lane and flank window; the final gates judge the result.`,
      [group.id], 'group');
    return;
  }
  moveGroup(model, group, low - group.bounds!.x, 0);
}

/** The feeds of one group in one step, with the x each child port wants and the transits that yield. */
function groupFeeds(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, warn: boolean): { own: Feed[]; wanted: Map<string, number>; yielded: Set<Feed>; conflicts: Set<string> } {
  const own = list.filter(feed => model.document.nodes[feed.child.ref.node]!.group === id);
  // Adjacent feeds first: a transit yields to any other feed of the same child port instead of
  // contesting it, so a fan of lanes into one port cannot exhaust the shared budget.
  const wanted = new Map<string, number>(), yielded = new Set<Feed>(), conflicts = new Set<string>();
  for (const feed of [...own].sort((a, b) => Number(a.transit) - Number(b.transit))) {
    const child = portId(feed.child.ref);
    if (context.winners.get(`${tier}:${feed.key}`) !== child) {
      if (warn) placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares a parent port; the first child by x owns vertical alignment.`, [feed.link]);
      continue;
    }
    if (!wanted.has(child)) wanted.set(child, feed.x);
    else if (wanted.get(child) !== feed.x) {
      if (feed.transit) {
        yielded.add(feed);
        if (warn) placementWarning(model, 'CENTRE_FAN_REMAINDER', `${feed.link} shares its child port with a feed at another x; that feed owns vertical alignment.`, [feed.link]);
      } else conflicts.add(child);
    }
  }
  return { own, wanted, yielded, conflicts };
}
/**
 * One group's centring step: centre under its owning feeds, align the wanted ports, repack, fit,
 * clamp into the lane/flank/neighbour window. Reports exactly which child ports stay unresolved —
 * a conflict, an alignment the row cannot hold, a window the group cannot fit, or a clamp that
 * moved it off its feed — so a check can excuse those and no others. Shared by the producer pass and
 * by the publication/restore check, so both read one definition.
 */
function centreGroupStep(model: LayoutModel, context: CentreContext, tier: number, list: Feed[], id: string, previous: LayoutGroup | undefined, warn: boolean, tail: Map<string, number>): { unresolved: Set<string>; group: LayoutGroup } {
  const group = model.groups[id]!, order = context.groupOrder.get(tier)!;
  const { own, wanted, yielded, conflicts } = groupFeeds(model, context, tier, list, id, warn);
  const unresolved = new Set<string>(conflicts);
  const saved = JSON.parse(JSON.stringify({ group, nodes: group.nodes.map(node => model.nodes[node]!) })) as { group: LayoutGroup; nodes: LayoutNode[] };
  // Centre under the feeds that may own an alignment; a yielded transit would only pull the group
  // away from the x its child is then aligned to.
  const vertical = own.filter(feed => context.winners.get(`${tier}:${feed.key}`) === portId(feed.child.ref) && !yielded.has(feed));
  const chosen = vertical.length ? vertical : own;
  const distinctParents = new Map(chosen.map(feed => [feed.key, feed.x]));
  const distinctChildren = new Map(chosen.map(feed => [portId(feed.child.ref), feed.child.anchor!.x]));
  const mean = (values: Iterable<number>) => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
  /** How far each wanted port is from the x its feed asks for, in the model as it now stands. */
  const misses = (): Map<string, number> => new Map([...wanted].map(([key, want]) => {
    const port = group.nodes.flatMap(node => model.nodes[node]!.ports).find(port => portId(port.ref) === key);
    return [key, port?.anchor ? Math.abs(port.anchor.x - want) : 0];
  }));
  const total = (values: Map<string, number>): number => [...values.values()].reduce((sum, value) => sum + value, 0);
  const missBefore = total(misses());
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
      unresolved.add(key);
      if (warn) placementWarning(model, 'CENTRE_ALIGNMENT_INFEASIBLE', `${feed.link} cannot align within its child's available row span; routing completes it.`, [feed.link]);
    }
  }
  for (let i = 1; i < group.rowOrder!.length; i++) {
    const a = model.nodes[group.rowOrder![i - 1]!]!, b = model.nodes[group.rowOrder![i]!]!;
    const minimum = right(a.bounds!) + rowGap(model, a.id, b.id);
    if (b.bounds!.x < minimum) shiftNode(b, minimum - b.bounds!.x);
  }
  fitRegionGroup(model, group);
  // The window is the same one the push respects. A left flank bounds this group as a right flank
  // does, and the final clamp reads `low`. A bound that only moves the group first is undone.
  const window = reservedWindow(model, context, tier, id);
  const low = Math.max(window.low, previous ? right(previous.bounds!) + bandGap(model) : -Infinity);
  let high = Math.min(window.high, tail.get(id)!);
  const nextFixed = order.slice(order.indexOf(id) + 1).map(id => model.groups[id]!).find(other => !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === other.id));
  if (nextFixed) high = Math.min(high, nextFixed.bounds!.x - bandGap(model));
  if (group.bounds!.width > high - low) {
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    // The window cannot hold this group, but the group before it has already taken its space, so
    // the saved geometry alone would overlap. Decline the alignment and keep the tier packed.
    packClear(model, context, tier, saved.group, previous);
    return { unresolved: new Set(wanted.keys()), group: saved.group };
  }
  const x = Math.max(low, Math.min(group.bounds!.x, high - group.bounds!.width));
  moveGroup(model, group, x - group.bounds!.x, 0);
  for (const [key, want] of wanted) {
    const port = group.nodes.flatMap(id => model.nodes[id]!.ports).find(port => portId(port.ref) === key)!;
    if (Math.abs(port.anchor!.x - want) > 0.5) unresolved.add(key);
  }
  // A step that aligns nothing and brings no feed closer to its x moves nothing. The passes are an
  // iterative solver: the move puts the group under the mean of its feeds, the widenings below it
  // reach what the row and the allowance let them reach, and the next pass starts from where this
  // one left the group. A step that keeps no target, ends with every port off its feed and no
  // nearer it than it found them, has solved nothing and has only given the next pass a new place
  // to chase the mean from. That is the loop this ticket was filed for: `bar-fan` walked a 50 px
  // body to 3 014 px, 123.8 px a pass, through all eight, carrying its one port away from the feed
  // it started on every time (ticket 29).
  //
  // All three conditions are needed. A single feed is made vertical by the move alone, with nothing
  // for `alignSide` to keep, so the kept targets cannot be read on their own; a step that does not
  // converge here may still converge two passes later, so progress is measured rather than assumed;
  // and a transit feed asks for a **reserved lane x**, which the child has to reach and 7f's
  // corridor follows (`LANE_FOLLOWS_ITS_CHILD`) — putting that group back leaves the corridor
  // without the child it was moved for.
  const missAfter = total(misses());
  if (wanted.size && !aligned.size && !own.some(feed => feed.transit) && missAfter > 0.5 && missAfter >= missBefore - 0.5) {
    model.groups[id] = saved.group;
    for (const node of saved.nodes) model.nodes[node.id] = node;
    packClear(model, context, tier, saved.group, previous);
    // The ports are back where this step found them, so what is unresolved is measured again there:
    // a port the move had seated is not seated any more, and the publication check excuses exactly
    // the ports this producer really leaves off their feed.
    for (const [key, value] of misses()) if (value > 0.5) unresolved.add(key);
    return { unresolved, group: saved.group };
  }
  return { unresolved, group };
}
/** Reusable bounded producer. The caller shares one budget across all ordered placement replay. */
export function centreDraft(model: LayoutModel, budget: CentreBudget): void {
  if (!Number.isSafeInteger(budget.remaining) || !Number.isSafeInteger(budget.passes) || budget.remaining < 0
    || budget.passes < 0 || budget.remaining + budget.passes > 8) throw new Error('Centering requires one shared eight-pass budget');
  const anchor = selectAnchorTier(model);
  if (anchor === undefined) { delete model.anchorTier; return; }
  model.anchorTier = anchor;
  const context = centreContext(model, anchor);
  let unresolved = new Set<string>();
  while (budget.remaining > 0) {
    budget.remaining--; budget.passes++;
    const before = geometry(model); unresolved = new Set();
    for (const { tier, authority } of context.steps) {
      const list = feeds(model, tier, authority), order = context.groupOrder.get(tier)!;
      const tail = tailReservation(model, context, tier, order);
      let previous: LayoutGroup | undefined;
      for (const id of order) {
        const group = model.groups[id]!;
        // Bar shaping owns their source-derived slots and stacked spans; row centering cannot repack
        // them. A group this step does not centre still yields the space a widened neighbour took.
        if (model.document.groups[id]!.shape === 'bar' || !list.some(feed => model.document.nodes[feed.child.ref.node]!.group === id)) {
          packClear(model, context, tier, group, previous);
          previous = group; continue;
        }
        const result = centreGroupStep(model, context, tier, list, id, previous, true, tail);
        if (result.unresolved.size) unresolved.add(id);
        previous = result.group;
      }
    }
    rebuildRegions(model);
    const after = geometry(model);
    if (!unresolved.size && after.every((value, i) => Math.abs(value - before[i]!) <= 0.5)) return;
  }
  if (!model.diagnostics.some(d => d.stage === 'placement' && d.code === 'PLACEMENT_NON_CONVERGENCE')) placementWarning(model,
    'PLACEMENT_NON_CONVERGENCE', 'Centering exhausted the shared eight-pass budget; unresolved alignments remain for routing and final gates.', [...unresolved], 'group');
}
/**
 * The stage 7c invariant, readable at any later stage (ADR-0010): for every centred group, replaying
 * its own centring step on a copy either leaves each owning alignment where the model has it, or ends
 * unresolved by the producer's own rules for that port (infeasible alignment, conflicting feeds, a
 * window it cannot cross). The check is scoped per child port and reads no diagnostics: a serialized
 * diagnostic proves nothing, and one port's genuine blockage excuses no other port. Ports that later rules own — bar
 * drops and endpoints (7d), ports any bundle member uses (7e) — are not compared.
 */
export function centreViolations(model: LayoutModel): string[] {
  const anchor = model.anchorTier;
  if (anchor === undefined || !model.tierBands.some(band => band.tier === anchor)) return [];
  const context = centreContext(model, anchor);
  // Stage 7e re-anchors every port a bundle member uses. A child port it moved stays where 7e put it
  // from then on; a parent port it moved is a new feed x that 7f re-centres under, so a feed on such
  // a parent is excused only while the model sits exactly at the bundles stage.
  const bundled = new Set(model.links.filter(link => link.bundle && link.attachments).flatMap(link => [portId(link.attachments!.from), portId(link.attachments!.to)]));
  const afterBundles = ['bundles', 'bands', 'route', 'link-labels', 'validate', 'emit'].includes(model.stage);
  const atBundles = model.stage === 'bundles';
  const drops = new Set(model.barDrops.map(drop => drop.link));
  const isBar = (node: string): boolean => model.document.groups[model.document.nodes[node]!.group]!.shape === 'bar';
  const result: string[] = [];
  const byId = new Map(model.links.map(link => [link.id, link]));
  // The replay reads placement geometry alone; nothing it calls reads the freeze block, and on a
  // large model that block is more than a third of the JSON the per-group copy below would carry.
  const { freeze: _frozen, ...replayed } = model;
  void _frozen;
  for (const { tier, authority } of context.steps) {
    const list = feeds(model, tier, authority), order = context.groupOrder.get(tier)!;
    const tail = tailReservation(model, context, tier, order);
    let previous: LayoutGroup | undefined;
    for (const id of order) {
      const group = model.groups[id]!;
      const owned = groupFeeds(model, context, tier, list, id, false);
      if (model.document.groups[id]!.shape === 'bar' || !owned.own.length) { previous = group; continue; }
      const trial = JSON.parse(JSON.stringify(replayed)) as LayoutModel;
      const step = centreGroupStep(trial, centreContext(trial, anchor), tier, feeds(trial, tier, authority), id, previous && trial.groups[previous.id], false, tail);
      previous = group;
      // Both lookups below read one key per wanted child; keying them once keeps the scan of the
      // group's own feeds and ports out of the loop. First entry wins, as `find` did.
      const ownFeeds = new Map<string, Feed>();
      for (const item of owned.own) { const at = portId(item.child.ref); if (!ownFeeds.has(at)) ownFeeds.set(at, item); }
      const groupPorts = new Map<string, LayoutPort>();
      for (const nodeId of group.nodes) for (const item of model.nodes[nodeId]!.ports) {
        const at = portId(item.ref); if (!groupPorts.has(at)) groupPorts.set(at, item);
      }
      for (const [child, x] of owned.wanted) {
        // Only the ports the producer's own step could not resolve are excused, never their siblings.
        if (step.unresolved.has(child)) continue;
        const feed = ownFeeds.get(child)!;
        if (byId.get(feed.link)?.bundle || drops.has(feed.link)) continue;
        if ((afterBundles && bundled.has(child)) || (atBundles && bundled.has(portId(feed.parent.ref)))) continue;
        if (isBar(feed.child.ref.node) || isBar(feed.parent.ref.node)) continue;
        const port = groupPorts.get(child)!;
        if (Math.abs(port.anchor!.x - x) > 0.5) result.push(`${feed.link}: ${child} sits at x ${port.anchor!.x} instead of its feed x ${x}`);
      }
    }
  }
  return result;
}
export function centre(model: LayoutModel): LayoutModel { return withLayoutMutation(model, 'centre', draft => centreDraft(draft, createCentreBudget())); }
