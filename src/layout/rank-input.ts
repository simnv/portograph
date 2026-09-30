import type { LayoutModel } from '../model/index.js';
import { orderedNodeIds } from '../model/index.js';
import type { RankInput } from './ranks.js';

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
    { const port = model.nodes[ref.node]!.ports.find(item => JSON.stringify(item.ref) === JSON.stringify(ref)); return port === undefined ? undefined : port.naturalSide ?? port.side; };
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
  return {
    group, members, routedLinks, linksAbove, linksBelow, overlayPartners,
    children: childGroups.map(child => ({ group: child, members: nodes.filter(node => groupOf(node) === child) })),
  };
}
