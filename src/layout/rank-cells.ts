import type { LayoutModel, NormalisedDocument, NormalisedFrame, NormalisedGroup } from '../model/index.js';
import { orderedGroupIds, orderedNodeIds } from '../model/index.js';
import { rankInputOf } from './rank-input.js';
import { deriveRanks } from './ranks.js';

/** How one document tier group is laid out: one row, or a frame of `k` rank cells. */
interface Plan {
  id: string;
  /** Cell ids by rank, for a group that is replaced by cells. */
  cells: { id: string; frame: string; members: string[]; rank: number }[];
  /** How many sub-tiers the group takes; 1 for a group that is not replaced. */
  k: number;
  anchoredFrom: 'above' | 'below' | 'none';
  children: string[];
  expands: boolean;
}

const cellId = (group: string, rank: number): string => `${group}#${rank}`;

/**
 * Stage 1, second half (docs/design/ranked-groups.md, section 2, *Expansion*): read the ranks of
 * every `ranked` group off a model resolved up to the links, and return the document the rest of the
 * pipeline runs on, or `undefined` when no group has more than one rank (the document is then
 * already final).
 *
 * - A `ranked` group with one rank keeps its id and its `ranked` shape, which `groupShape` reads as
 *   `row`; a child group of such a group stays an ordinary group at the parent's sub-tier.
 * - A group with more ranks is replaced by rank cells `G#0..G#k-1`, each a
 *   `row` group with `frame: G`, and gets a `frames` entry. Child cells are `child#r` with the same
 *   rank number as in the parent, `frame: child`, and `frames[child].parent === G`.
 * - Document tier `t` takes `R(t)` sub-tiers, the largest rank count among its groups. Cell `r` of a
 *   group anchored from above (or from nowhere) stands at `offset(t) + r`; of a group anchored only
 *   from below, at `offset(t) + R(t) - k + r`. Sub-tiers are dense from 0.
 * - A `row`, `bar` or `grid` group, and a flank, is copied with its tier moved to the sub-tier grid.
 *   A flank whose target was replaced points at the target's first cell.
 *
 * Links keep their node endpoints. A link that ends at a group (`{ group: G }`) still names `G`;
 * `groupNodeIds` reads it through `frames`.
 */
export function expandRankedGroups(model: LayoutModel): NormalisedDocument | undefined {
  const source = model.document;
  // An expanded document is final. Its sub-tier numbers would give a neighbour an anchor it did not
  // have, so ranks are read once, from the authored document, and never from the result.
  if (source.frames !== undefined) return undefined;
  const ids = orderedGroupIds(source);
  if (!ids.some(id => source.groups[id]!.shape === 'ranked')) return undefined;
  const nodes = orderedNodeIds(source);
  const tierGroups = ids.filter(id => source.groups[id]!.align === undefined && source.groups[id]!.parent === undefined);

  const plans = new Map<string, Plan>();
  for (const id of tierGroups) {
    const group = source.groups[id]!;
    const children = group.shape === 'ranked' ? ids.filter(child => source.groups[child]!.parent === id) : [];
    const input = rankInputOf(model, id, children);
    if (group.shape !== 'ranked') {
      const anchoredFrom = [...input.linksAbove].length ? 'above' : [...input.linksBelow].length ? 'below' : 'none';
      plans.set(id, { id, cells: [], k: 1, anchoredFrom, children, expands: false });
      continue;
    }
    const { ranks, rankCount, anchoredFrom } = deriveRanks(input);
    const expands = rankCount > 1;
    const cells: Plan['cells'] = [];
    // One cell per owner and rank: a leaf child stands beside the parent members of its ranks (ticket 28),
    // so sub-tier `r` may hold `G#r` and `child#r`, and two leaf children may share one too.
    if (expands) for (let rank = 0; rank < rankCount; rank += 1) for (const owner of [id, ...children]) {
      const members = nodes.filter(node => source.nodes[node]!.group === owner && ranks.get(node) === rank);
      if (members.length) cells.push({ id: cellId(owner, rank), frame: owner, members, rank });
    }
    plans.set(id, { id, cells, k: expands ? rankCount : 1, anchoredFrom, children, expands });
  }

  // With no group replaced, the document is final: `ranked` stays in it and reads as `row`.
  if (![...plans.values()].some(plan => plan.expands)) return undefined;

  // Sub-tier grid: R(t) per document tier, offsets in tier order.
  const tiers = [...new Set(tierGroups.map(id => source.groups[id]!.tier!))].sort((a, b) => a - b);
  const height = new Map(tiers.map(tier => [tier, Math.max(1, ...tierGroups.filter(id => source.groups[id]!.tier === tier).map(id => plans.get(id)!.k))]));
  const offset = new Map<number, number>();
  tiers.reduce((sum, tier) => { offset.set(tier, sum); return sum + height.get(tier)!; }, 0);
  const base = (id: string): number => {
    const tier = source.groups[id]!.tier!, plan = plans.get(id)!;
    return offset.get(tier)! + (plan.anchoredFrom === 'below' ? height.get(tier)! - plan.k : 0);
  };

  const expanded: NormalisedDocument = JSON.parse(JSON.stringify(source));
  const groups: Record<string, NormalisedGroup> = {};
  const frames: Record<string, NormalisedFrame> = {};
  const order: string[] = [];
  const put = (id: string, group: NormalisedGroup): void => { groups[id] = group; order.push(id); };
  const firstCell = (id: string): string => plans.get(id)?.expands ? plans.get(id)!.cells.find(cell => cell.frame === id)?.id ?? id : id;
  for (const id of ids) {
    const group = source.groups[id]!;
    const plan = plans.get(id);
    if (group.parent !== undefined) {
      // A child of a group that is not replaced stays an ordinary group on its parent's sub-tier.
      if (!plans.get(group.parent)!.expands) put(id, { ...group, tier: base(group.parent) } as NormalisedGroup);
      continue;
    }
    if (plan === undefined) {
      // A flank: it has no tier of its own and follows its target.
      put(id, { ...group, ...(group.of !== undefined ? { of: firstCell(group.of) } : {}) } as NormalisedGroup);
      continue;
    }
    if (!plan.expands) {
      put(id, { ...group, tier: base(id) } as NormalisedGroup);
      continue;
    }
    const withStyle = (owner: string) => {
      const item = source.groups[owner]!;
      return { label: item.label, shape: 'row' as const, ...(item.class !== undefined ? { class: item.class } : {}), ...(item.layout !== undefined ? { layout: item.layout } : {}) };
    };
    for (const owner of [id, ...plan.children]) {
      const item = source.groups[owner]!;
      frames[owner] = { label: item.label, ...(item.class !== undefined ? { class: item.class } : {}), ...(owner !== id ? { parent: id } : {}), cells: [] };
    }
    for (const cell of plan.cells) {
      put(cell.id, { ...withStyle(cell.frame), tier: base(id) + cell.rank, frame: cell.frame } as NormalisedGroup);
      frames[cell.frame]!.cells.push(cell.id);
      for (const node of cell.members) expanded.nodes[node]!.group = cell.id;
    }
  }
  // A group with a parent that is not ranked is a parse error, so no other child group remains.
  expanded.groups = groups;
  if (JSON.stringify(order) !== JSON.stringify(Object.keys(groups))) expanded.groupOrder = order; else delete expanded.groupOrder;
  if (Object.keys(frames).length) expanded.frames = frames; else delete expanded.frames;
  return expanded;
}
