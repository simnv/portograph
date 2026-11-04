/**
 * The feed split (architecture-2 ticket 73, stage 5): the room two sibling groups need to stand under their feeds is made in the feeding
 * tiers, once, on final sides and sizes, before stage 6 seats the rows and 7a reserves the lanes.
 *
 * For two sibling groups of one sub-tier side by side whose feeds stand apart in x (every feed of the left group left of every feed of the
 * right one), both groups can stand under their feeds only when the two feeds next to each other stand at least the reach of the left group,
 * the band gap and the reach of the right group apart. The reach is the distance from the child port of the outer feed to the box edge (end
 * inset and group padding). Where the feeds stand closer, every body, box and transit lane of the feeding side (the sub-tiers from the
 * authority tier outward, away from the child) right of the split line moves right by the deficit. The child tier and the far side do not
 * move: the steps of 7c then centre each group under its feeds.
 *
 * The split never stretches a body. A body of the authority tier that the line crosses holds feeds of both groups (its ports cannot part),
 * so the split is declined. A body of a tier beyond the authority that the line crosses moves whole when its centre stands right of the line,
 * and stays otherwise: where stage 4 put that body is incidental (the order of the links moves it, R3), and 7c centres it again.
 * A group box that the line crosses keeps the part that holds no node: it grows only when nodes move and nodes stay, it moves whole when
 * all its nodes move, and it stays when none moves (a mirrored split above the anchor tier crosses the padding of a box; the box gives that
 * width back).
 *
 * `model.feedSplits` records the decision (R1): each split made, `[]` when stage 5 decided and made none. The freeze keeps a copy, the
 * stage-5 publication and its restore check that each recorded pair has its room (`feedPairRoom`, the one reader of the room), and no
 * later stage decides it again.
 */
import type { FeedSplit, LayoutGroup, LayoutModel } from '../model/index.js';
import { orderedNodeIds } from '../model/model.js';
import { centringFeeds, type Feed } from './read/feeds.js';
import { portId } from './skeleton-graph.js';
import { bandGap } from './skeleton-graph.js';
import { right, rebuildRegions } from './regions.js';
import { selectAnchorTier, validateLanes } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { shiftLane } from './close-up.js';
import { isGridGroup } from './grid.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** The least deficit that splits (px): a pair short by less stands under its feeds within the alignment tolerance of 7c. */
export const MIN_SPLIT = 0.5;
/**
 * The bound on the splits of one centring step (R4, per step). Each split gives the first short pair its room; the pairs left of the line
 * keep theirs. A step that is still short after this many splits gets `FEED_SPLIT_CAPPED`.
 */
export const MAX_SPLITS_PER_STEP = 8;

/** One fed group of a sub-tier: its first and last feed x, and the reach of its box past the child ports of those two feeds. */
interface FedGroup { id: string; low: number; high: number; reachLow: number; reachHigh: number }

/**
 * The groups of `tier` that a feed of the step reaches, in x order of their boxes (last key the group id, R3), each with its outer feeds.
 * Feeds at one x rank by the child port x, then by the child port id (the last key, R3), so the outer child port is the one farther out.
 */
function fedGroups(model: LayoutModel, list: readonly Feed[], tier: number): FedGroup[] {
  const byGroup = new Map<string, Feed[]>();
  for (const feed of list) {
    const group = model.document.nodes[feed.child.ref.node]!.group;
    if (model.groups[group]?.tier !== tier) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), feed]);
  }
  return [...byGroup].map(([id, feeds]) => {
    const box = model.groups[id]!.bounds!;
    const byX = [...feeds].sort((a, b) => a.x - b.x || a.child.anchor!.x - b.child.anchor!.x || portId(a.child.ref).localeCompare(portId(b.child.ref)));
    const first = byX[0]!, last = byX[byX.length - 1]!;
    return { id, low: first.x, high: last.x, reachLow: first.child.anchor!.x - box.x, reachHigh: right(box) - last.child.anchor!.x };
  }).sort((a, b) => model.groups[a.id]!.bounds!.x - model.groups[b.id]!.bounds!.x || (a.id < b.id ? -1 : 1));
}

/** The room of two fed groups side by side: what the pair needs between its two inner feeds, and what it has. */
function room(left: FedGroup, rightGroup: FedGroup, gap: number): { need: number; has: number } {
  return { need: left.reachHigh + gap + rightGroup.reachLow, has: rightGroup.low - left.high };
}

/**
 * The one reader of a pair's room (R1): the deficit of the pair `left`, `right` of `tier` fed from `authority`, or the reason the pair is no
 * fed pair (a group without a feed, the groups in the other x order, or feeds that are not apart). The decision and the validator call it.
 */
export function feedPairRoom(model: LayoutModel, tier: number, authority: number, left: string, rightId: string): number | string {
  const groups = fedGroups(model, centringFeeds(model, tier, authority), tier);
  const a = groups.findIndex(group => group.id === left), b = groups.findIndex(group => group.id === rightId);
  if (a < 0 || b < 0) return `${a < 0 ? left : rightId} has no feed from sub-tier ${authority}`;
  if (b !== a + 1) return `${left} and ${rightId} do not stand next to each other in sub-tier ${tier}`;
  if (groups[a]!.high >= groups[b]!.low) return `the feeds of ${left} and ${rightId} are not apart`;
  const { need, has } = room(groups[a]!, groups[b]!, bandGap(model));
  return need - has;
}

/** A group that cannot be the pair of a split: a rank cell (it has a frame), a frame, a flank or the host of one. */
function plainGroup(model: LayoutModel, id: string): boolean {
  const group = model.groups[id]!;
  return group.frame === undefined && group.flank === undefined && !Object.values(model.groups).some(other => other.frame === id || other.flank?.of === id);
}

/** The reason the feeding side right of `at` cannot move, or undefined when it can. */
function blockedSide(model: LayoutModel, side: readonly LayoutGroup[], at: number, pair: readonly [string, string], authority: number): string | undefined {
  if (!pair.every(id => plainGroup(model, id))) return 'a group of the pair is a rank cell, a frame or a flank';
  // A body of the authority tier across the line carries feeds of both groups: moved whole it opens no room, stretched it is a wide node
  // (Step 0's P2 stretched one by 147 px). Bodies of the tiers beyond move whole or stay (`moveSide`).
  const through = side.filter(group => group.tier === authority).flatMap(group => group.nodes).find(id => { const body = model.nodes[id]!.bounds!; return body.x < at && right(body) > at; });
  if (through !== undefined) return `the split would stretch ${through}`;
  const fixed = side.find(group => group.frame !== undefined || group.flank !== undefined || model.document.groups[group.id]?.canton !== undefined
    || model.document.groups[group.id]?.shape === 'bar' || isGridGroup(model, group.id) || Object.values(model.groups).some(other => other.frame === group.id || other.flank?.of === group.id));
  if (fixed !== undefined) return `${fixed.id} cannot move`;
  const lane = model.lanes.find(item => item.x > at && (item.kind ?? 'transit') !== 'transit');
  if (lane !== undefined) return `the lane ${lane.id} is no transit lane`;
  return undefined;
}

/** Moves every body, port, box and transit lane of the feeding side right of `at` by `width`. A box the line crosses keeps its empty part. */
function moveSide(model: LayoutModel, side: readonly LayoutGroup[], at: number, width: number, moving: (tier: number) => boolean): void {
  // A body moves when it stands right of the line, or when the line crosses it left of its centre (only a body of a tier beyond the
  // authority: `blockedSide` declines the split through one of the authority tier). The order of the bodies stays, and no gap closes.
  const moves = (body: { x: number; width: number }): boolean => body.x >= at || body.x + body.width / 2 > at;
  for (const group of side) {
    const box = group.bounds!, bodies = group.nodes.map(id => model.nodes[id]!.bounds!);
    if (box.x >= at) box.x += width;
    else if (bodies.some(moves)) {
      if (bodies.some(body => !moves(body))) box.width += width;
      else box.x += width;
    }
    for (const id of group.nodes) {
      const node = model.nodes[id]!;
      if (!moves(node.bounds!)) continue;
      node.bounds!.x += width;
      for (const port of node.ports) if (port.anchor !== undefined) port.anchor.x += width;
    }
  }
  for (const lane of model.lanes) if (lane.x > at && moving(lane.tier)) shiftLane(lane, width);
  model.lanes = [...model.lanes];
}

/** The tier bands are the union of their groups: derived again in x, their y kept. */
function refitBands(model: LayoutModel): void {
  for (const band of model.tierBands) {
    const boxes = band.groups.map(id => model.groups[id]?.bounds).filter((box): box is NonNullable<typeof box> => box !== undefined);
    if (!boxes.length || band.bounds === undefined) continue;
    const low = Math.min(band.bounds.x, ...boxes.map(box => box.x)), high = Math.max(right(band.bounds), ...boxes.map(box => right(box)));
    band.bounds = { ...band.bounds, x: low, width: high - low };
  }
}

/**
 * The centring steps from the anchor tier outward, the step next to the anchor first and the two sides in turn: each occupied sub-tier with
 * the adjacent one toward the anchor. A split moves the tiers its step is fed from, and those hold the children the next step outward reads.
 */
export function feedSplitSteps(model: LayoutModel, anchor: number): { tier: number; authority: number }[] {
  const tiers = [...new Set(Object.values(model.groups).flatMap(group => group.tier === undefined ? [] : [group.tier]))].sort((a, b) => a - b);
  const at = tiers.indexOf(anchor);
  if (at < 0) return [];
  const steps: { tier: number; authority: number }[] = [];
  for (let d = 1; at + d < tiers.length || at - d >= 0; d++) {
    if (at + d < tiers.length) steps.push({ tier: tiers[at + d]!, authority: tiers[at + d - 1]! });
    if (at - d >= 0) steps.push({ tier: tiers[at - d]!, authority: tiers[at - d + 1]! });
  }
  return steps;
}

/**
 * Decides and makes the feed splits of stage 5 and records them in `model.feedSplits` (`[]` when none is made). A declined pair gets
 * `FEED_SPLIT_DECLINED` and ends its step: the pairs right of it read feeds that the declined split would have moved.
 */
export function reserveFeedSplits(model: LayoutModel): void {
  const made: FeedSplit[] = [], gap = bandGap(model), anchor = selectAnchorTier(model);
  const note = (code: string, message: string, owners: readonly string[]): void => {
    model.diagnostics.push({ stage: 'placement', severity: 'info', code, message, owners: owners.map(id => ({ kind: 'group' as const, id })) });
  };
  for (const { tier, authority } of anchor === undefined ? [] : feedSplitSteps(model, anchor)) {
    const below = tier > authority, moving = (other: number): boolean => below ? other <= authority : other >= authority;
    for (let count = 0; ; count++) {
      const groups = fedGroups(model, centringFeeds(model, tier, authority), tier);
      let short: { pair: [string, string]; width: number; at: number } | undefined;
      for (let i = 0; i + 1 < groups.length && short === undefined; i++) {
        const a = groups[i]!, b = groups[i + 1]!;
        if (a.high >= b.low) continue;
        const { need, has } = room(a, b, gap);
        if (need - has > MIN_SPLIT) short = { pair: [a.id, b.id], width: need - has, at: (a.high + b.low) / 2 };
      }
      if (short === undefined) break;
      const { pair, width, at } = short, name = `${pair[0]}|${pair[1]} at x ${at.toFixed(1)} (${width.toFixed(1)} px)`;
      if (count === MAX_SPLITS_PER_STEP) {
        note('FEED_SPLIT_CAPPED', `Sub-tier ${tier} made ${MAX_SPLITS_PER_STEP} feed splits; the split ${name} is not tried.`, pair);
        break;
      }
      const side = Object.values(model.groups).filter(group => group.tier !== undefined && moving(group.tier) && group.bounds !== undefined && right(group.bounds) > at);
      const blocked = blockedSide(model, side, at, pair, authority);
      if (blocked !== undefined) { note('FEED_SPLIT_DECLINED', `The feed split ${name} is declined: ${blocked}.`, pair); break; }
      // The split works on the model and puts the saved state back when a rebuild or the lane check refuses it (R2: refuses whole).
      const saved = JSON.stringify(model);
      moveSide(model, side, at, width, moving);
      let refusal: string | undefined;
      try {
        rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
        if (model.regions.length) rebuildRegions(model);
        refitBands(model);
        if (model.lanes.length) validateLanes(model);
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
        refusal = error instanceof Error ? error.message : String(error);
      }
      if (refusal !== undefined) {
        const back = JSON.parse(saved) as Record<string, unknown>, target = model as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) if (!(key in back)) delete target[key];
        Object.assign(target, back);
        note('FEED_SPLIT_DECLINED', `The feed split ${name} is declined: ${refusal}.`, pair);
        break;
      }
      made.push({ tier, authority, pair, at, width });
    }
  }
  model.feedSplits = made;
}

/**
 * Publication and restore (R1, R5): the record names pairs of plain sibling groups of one sub-tier, fed from the adjacent sub-tier toward the
 * anchor, each split wider than `MIN_SPLIT`. On the stage-5 model each recorded pair has its room. Absent = not decided (no stage 5 of this
 * pipeline ran on the model): nothing is checked. Later stages move the feeding tiers again (7c, the close-up), so the room is read at stage 5 only;
 * after it, the freeze keeps the record unchanged.
 */
export function validateFeedSplits(model: LayoutModel): void {
  const record = model.feedSplits;
  if (record === undefined) return;
  if (!Array.isArray(record)) throw new Error('Feed splits are not a list');
  const tiers = new Set(Object.values(model.groups).flatMap(group => group.tier === undefined ? [] : [group.tier]));
  for (const split of record) {
    const { tier, authority, pair, at, width } = split;
    const name = Array.isArray(pair) ? pair.join('|') : String(pair);
    if (!tiers.has(tier) || !tiers.has(authority) || tier === authority || [...tiers].some(other => other > Math.min(tier, authority) && other < Math.max(tier, authority))) {
      throw new Error(`Feed split ${name} names sub-tiers ${tier} and ${authority}, which are not adjacent sub-tiers`);
    }
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] || pair.some(id => model.groups[id]?.tier !== tier || !plainGroup(model, id))) {
      throw new Error(`Feed split ${name} does not name two plain groups of sub-tier ${tier}`);
    }
    if (!Number.isFinite(at) || !Number.isFinite(width) || width <= MIN_SPLIT) throw new Error(`Feed split ${name} has no width`);
    if (model.stage !== 'sides-two') continue;
    const deficit = feedPairRoom(model, tier, authority, pair[0], pair[1]);
    if (typeof deficit === 'string') throw new Error(`Feed split ${name}: ${deficit}`);
    if (deficit > PLACEMENT_EPS) throw new Error(`Feed split ${name} lacks ${deficit.toFixed(2)} px of its room`);
  }
}
