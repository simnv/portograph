import type { LayoutModel } from '../model/index.js';
import { orderedNodeIds } from '../model/index.js';
import { BOTTOM_CLASSES, TOP_CLASSES } from '../profiles/network/tiers.js';
import type { RankInput } from './ranks.js';

/**
 * The class rank of a node (docs/design/ranked-groups.md, section 1, step 2). The ends come from
 * the tier-inference table parse uses (`TOP_CLASSES`, `BOTTOM_CLASSES`): a top class is rank 0, a
 * bottom class the last. That table puts every other class in one middle tier; read alone it would
 * make a router and a switch equal, so each uplink between them a peer link and each group one
 * rank. The middle is therefore split by the rows below; a class no row names has no rank.
 */
export const MIDDLE_CLASS_ROWS: readonly (readonly string[])[] = [['router', 'tbr', 'rr'], ['switch'], ['server']];

export function classRankOf(nodeClass: string | undefined): number | undefined {
  if (nodeClass === undefined) return undefined;
  if (TOP_CLASSES.includes(nodeClass)) return 0;
  if (BOTTOM_CLASSES.includes(nodeClass)) return MIDDLE_CLASS_ROWS.length + 1;
  const index = MIDDLE_CLASS_ROWS.findIndex(row => row.includes(nodeClass));
  return index < 0 ? undefined : index + 1;
}

/**
 * Build the derivation input of one document group from a model resolved up to stage 1: its own
 * members, its routed links, the members that link to another tier, and the overlay partners.
 * `childGroups` are the child groups of `group`; their members and links count as the group's own.
 */
export function rankInputOf(model: LayoutModel, group: string, childGroups: string[] = []): RankInput {
  const own = new Set([group, ...childGroups]);
  const groupOf = (node: string): string => model.document.nodes[node]!.group;
  const nodes = orderedNodeIds(model.document);
  const members = nodes.filter(node => groupOf(node) === group);
  const tier = model.groups[group]!.tier!;
  const routedLinks: RankInput['routedLinks'] = [];
  const linksAbove = new Set<string>(), linksBelow = new Set<string>();
  const overlayPartners = new Map<string, string[]>();
  const sideOf = (ref: NonNullable<LayoutModel['links'][number]['attachments']>['from']) =>
    model.nodes[ref.node]!.ports.find(port => JSON.stringify(port.ref) === JSON.stringify(ref))?.side;
  for (const link of model.links) {
    const { from, to } = link.attachments!;
    const ends = [from.node, to.node];
    if (link.layer === 'overlay') {
      for (const [one, other] of [ends, [...ends].reverse()] as [string, string][]) {
        if (own.has(groupOf(one))) overlayPartners.set(one, [...(overlayPartners.get(one) ?? []), other]);
      }
      continue;
    }
    const inside = ends.map(node => own.has(groupOf(node)));
    if (inside[0] && inside[1]) {
      const fromSide = sideOf(from), toSide = sideOf(to);
      routedLinks.push({ from: from.node, to: to.node, ...(fromSide ? { fromSide } : {}), ...(toSide ? { toSide } : {}) });
    } else if (inside[0] || inside[1]) {
      const [mine, other] = inside[0] ? ends : [...ends].reverse();
      const otherTier = model.groups[groupOf(other!)]!.tier!;
      if (otherTier < tier) linksAbove.add(mine!); else if (otherTier > tier) linksBelow.add(mine!);
    }
  }
  const classRank = (node: string): number | undefined => classRankOf(model.document.nodes[node]!.class);
  return {
    group, members, routedLinks, linksAbove, linksBelow, overlayPartners, classRank,
    children: childGroups.map(child => ({ group: child, members: nodes.filter(node => groupOf(node) === child) })),
  };
}
