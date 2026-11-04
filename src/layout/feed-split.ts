/**
 * t73 Step 0 prototype P2 (the feed split): the room a group needs to stand under its feeds is made in the feeding tiers, once, at the centre
 * stage 7a's input (before any lane is allocated). Below the anchor tier, for two sibling groups of one sub-tier side by side whose feeds stand apart in x (every feed of the left
 * group left of every feed of the right one), the two groups can both stand under their feeds only when the feeds of the pair stand at least
 * the reach of the left group right of its feed, the band gap and the reach of the right group left of its feed apart. Where they stand closer,
 * every body, box and transit lane of the feeding side (the sub-tiers from the authority tier outward, away from the child) right of the split
 * moves right by the deficit; a body that the split line crosses grows by it. Mirrored above the anchor tier. The child tier and the far side
 * do not move: the steps of 7c then centre the groups under the feeds.
 *
 * Prototype only: no record beyond the diagnostic; declined (with a diagnostic) where a lane other than a transit lane, a frame cell, a canton
 * member, a flank, a grid or a bar stands on the moving side, or where a lane or a reservation would break.
 */
import type { LayoutGroup, LayoutModel } from '../model/index.js';
import { orderedNodeIds } from '../model/model.js';
import { centringFeeds, type Feed } from './read/feeds.js';
import { bandGap } from './skeleton-graph.js';
import { right } from './regions.js';
import { validateLanes } from './lanes.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildRegions } from './regions.js';
import { shiftLane } from './close-up.js';
import { isGridGroup } from './grid.js';

const MIN_SPLIT = 0.5;

/** The x order of the groups of `tier` that a feed of the step reaches, each with its feeds and the reach of its box past the outer feed ports. */
function fedGroups(model: LayoutModel, list: Feed[], tier: number): { id: string; low: number; high: number; reachLow: number; reachHigh: number }[] {
  const byGroup = new Map<string, Feed[]>();
  for (const feed of list) {
    const group = model.document.nodes[feed.child.ref.node]!.group;
    if (model.groups[group]?.tier !== tier) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), feed]);
  }
  return [...byGroup].map(([id, feeds]) => {
    const box = model.groups[id]!.bounds!;
    const byX = [...feeds].sort((a, b) => a.x - b.x);
    const first = byX[0]!, last = byX[byX.length - 1]!;
    // The reach of the box past the child port of the outer feed: its end inset and the group padding, at the stage-3 size of the body.
    return { id, low: first.x, high: last.x, reachLow: first.child.anchor!.x - box.x, reachHigh: right(box) - last.child.anchor!.x };
  }).sort((a, b) => model.groups[a.id]!.bounds!.x - model.groups[b.id]!.bounds!.x || (a.id < b.id ? -1 : 1));
}

export interface FeedSplit { tier: number; at: number; width: number }

/** Decides and makes the splits; returns the splits made. */
export function reserveFeedSplits(model: LayoutModel, steps: readonly { tier: number; authority: number }[]): FeedSplit[] {
  const made: FeedSplit[] = [], gap = bandGap(model);
  const p3 = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PG_T73_P3);
  const note = (message: string): void => { model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'FEED_SPLIT', message }); };
  // The steps nearest the anchor first: a split moves the tiers it is fed from, and those hold the children the next step outward reads.
  for (const { tier, authority } of steps) {
    const below = tier > authority;
    for (let guard = 0; guard < 8; guard++) {
      const list = centringFeeds(model, tier, authority);
      const groups = fedGroups(model, list, tier);
      let split: { at: number; width: number; pair: string } | undefined;
      for (let i = 0; i + 1 < groups.length; i++) {
        const a = groups[i]!, b = groups[i + 1]!;
        if (a.high >= b.low) continue;
        const need = a.reachHigh + gap + b.reachLow, has = b.low - a.high;
        if (need - has > MIN_SPLIT) { split = { at: (a.high + b.low) / 2, width: need - has, pair: `${a.id}|${b.id}` }; break; }
      }
      if (split === undefined) break;
      const moving = (group: LayoutGroup): boolean => group.tier !== undefined && (below ? group.tier <= authority : group.tier >= authority);
      const side = Object.values(model.groups).filter(group => moving(group) && group.bounds !== undefined && right(group.bounds) > split.at);
      const blocked = side.find(group => group.frame !== undefined || group.flank !== undefined || model.document.groups[group.id]?.canton !== undefined
        || model.document.groups[group.id]?.shape === 'bar' || isGridGroup(model, group.id) || Object.values(model.groups).some(other => other.frame === group.id || other.flank?.of === group.id));
      const laneBlock = model.lanes.find(lane => lane.x > split.at && (lane.kind ?? 'transit') !== 'transit');
      // P3 guards (behind PG_T73_P3): the split line crosses no body of the feeding side (a body never stretches for it), and the two groups
      // are plain top-level groups (no rank cell, no frame, no flank).
      if (p3) {
        const [left, rightId] = split.pair.split('|') as [string, string];
        const plain = (id: string): boolean => { const group = model.groups[id]!; return group.frame === undefined && group.flank === undefined
          && !Object.values(model.groups).some(other => other.frame === id || other.flank?.of === id); };
        const through = side.flatMap(group => group.nodes).find(id => { const body = model.nodes[id]!.bounds!; return body.x < split.at && right(body) > split.at; });
        if (!plain(left) || !plain(rightId) || through !== undefined) {
          note(`The feed split ${split.pair} at x ${split.at.toFixed(1)} (${split.width.toFixed(1)} px) is declined: ${through !== undefined ? `the split would stretch ${through}` : 'a group of the pair is a rank cell, a frame or a flank'}.`);
          break;
        }
      }
      if (blocked !== undefined || laneBlock !== undefined) {
        note(`The feed split ${split.pair} at x ${split.at.toFixed(1)} (${split.width.toFixed(1)} px) is declined: ${blocked ? `${blocked.id} cannot move` : `the lane ${laneBlock!.id} is no transit lane`}.`);
        break;
      }
      const saved = JSON.stringify(model);
      for (const group of side) {
        const box = group.bounds!;
        if (box.x >= split.at) {
          box.x += split.width;
        } else box.width += split.width;
        for (const id of group.nodes) {
          const node = model.nodes[id]!, body = node.bounds!;
          if (body.x >= split.at) body.x += split.width;
          else if (right(body) > split.at) { body.width += split.width; node.size = { width: body.width, height: body.height }; }
          for (const port of node.ports) if (port.anchor !== undefined && port.anchor.x > split.at) port.anchor.x += split.width;
        }
      }
      for (const lane of model.lanes) if (lane.x > split.at && (below ? lane.tier <= authority : lane.tier >= authority)) shiftLane(lane, split.width);
      model.lanes = [...model.lanes];
      let refusal: string | undefined;
      try {
        rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
        if (model.regions.length) rebuildRegions(model);
        // The tier bands are the union of their groups: derived again in x, their y kept.
        for (const band of model.tierBands) {
          const boxes = band.groups.map(id => model.groups[id]?.bounds).filter((box): box is NonNullable<typeof box> => box !== undefined);
          if (!boxes.length || band.bounds === undefined) continue;
          const low = Math.min(band.bounds.x, ...boxes.map(box => box.x)), high = Math.max(right(band.bounds), ...boxes.map(box => right(box)));
          band.bounds = { ...band.bounds, x: low, width: high - low };
        }
        if (model.lanes.length) validateLanes(model);
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
        refusal = error instanceof Error ? error.message : String(error);
      }
      if (refusal !== undefined) {
        const back = JSON.parse(saved) as Record<string, unknown>, target = model as unknown as Record<string, unknown>;
        for (const key of Object.keys(target)) if (!(key in back)) delete target[key];
        Object.assign(target, back);
        note(`The feed split ${split.pair} at x ${split.at.toFixed(1)} (${split.width.toFixed(1)} px) is declined: ${refusal}.`);
        break;
      }
      made.push({ tier, at: split.at, width: split.width });
      note(`The feed split ${split.pair}: the feeding side right of x ${split.at.toFixed(1)} moves ${split.width.toFixed(1)} px right.`);
    }
  }
  return made;
}

/** The centring steps as 7c will run them, from the anchor tier outward: each occupied sub-tier with the adjacent one toward the anchor. */
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
