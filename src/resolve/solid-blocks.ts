import { orderedNodeIds } from '../model/model.js';
import type { FanFamily, LayoutLink, LayoutModel } from '../model/layout.js';
import { faintLinkClass } from '../profiles/network/theme.js';
import { groupShape } from '../layout/grid.js';
import { portId } from '../layout/skeleton-graph.js';

// Ticket 83, the under-cap slice of ticket 81. No maximal-biclique extraction: a whole group and
// the whole adjacent boundary/class cohort must form one complete node relation.
export function detectSolidBlocks(model: LayoutModel, excluded: ReadonlyMap<string, string> = new Map()): void {
  const shared = new Map<string, number>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments) {
    for (const ref of Object.values(link.attachments)) shared.set(portId(ref), (shared.get(portId(ref)) ?? 0) + 1);
  }
  const cohorts = new Map<string, { group: string; tier: number; klass: string; links: LayoutLink[] }>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.family !== 'routed' || !link.attachments) continue;
    const source = model.document.links[link.sourceIndex]!;
    if (faintLinkClass(source.class)) continue;
    const ends = [link.attachments.from.node, link.attachments.to.node];
    const groups = ends.map(node => model.document.nodes[node]!.group);
    const tiers = groups.map(id => model.document.groups[id]!.documentTier ?? model.document.groups[id]!.tier);
    if (groups[0] === groups[1] || tiers.some(tier => tier === undefined) || Math.abs(tiers[0]! - tiers[1]!) !== 1) continue;
    for (const [hub, far] of [[0, 1], [1, 0]] as const) {
      const key = JSON.stringify([groups[hub], tiers[far], source.class ?? '']);
      const cohort = cohorts.get(key) ?? { group: groups[hub]!, tier: tiers[far]!, klass: source.class ?? '', links: [] };
      cohort.links.push(link); cohorts.set(key, cohort);
    }
  }
  const candidates: FanFamily[] = [];
  const declined = (links: LayoutLink[], reason: string): void => {
    model.diagnostics.push({ stage: 'model', severity: 'info', code: 'SOLID_BLOCK_DECLINED', message: `Solid block declines ${reason}.`, owners: links.map(link => link.owner) });
  };
  for (const cohort of cohorts.values()) {
    const hubs = [...model.groups[cohort.group]!.nodes];
    const farOf = (link: LayoutLink): string => {
      const ends = link.attachments!;
      return hubs.includes(ends.from.node) ? ends.to.node : ends.from.node;
    };
    const far = new Set(cohort.links.map(farOf));
    const farNodes = orderedNodeIds(model.document).filter(id => far.has(id));
    if (hubs.length < 2 || farNodes.length < 2) continue;
    const pairs = new Set(cohort.links.map(link => [link.attachments!.from.node, link.attachments!.to.node].sort().join('\0')));
    if (pairs.size !== hubs.length * farNodes.length || cohort.links.length !== pairs.size) continue;
    const groups = [...new Set([...hubs, ...farNodes].map(id => model.document.nodes[id]!.group))];
    if (groups.some(id => model.groups[id]!.nodes.some(node => !hubs.includes(node) && !far.has(node)))) continue;
    const reason = cohort.links.some(link => {
      const source = model.document.links[link.sourceIndex]!;
      return source.route !== undefined && source.route !== 'straight' || source.from.group !== undefined || source.to.group !== undefined;
    }) ? 'authored-route' : cohort.links.some(link => link.bundle !== undefined || link.meshBus !== undefined) ? 'bundle-or-bus'
      : cohort.links.some(link => model.document.links[link.sourceIndex]!.label !== undefined) ? 'labelled-member'
      : cohort.links.some(link => Object.values(link.attachments!).some(ref => (shared.get(portId(ref)) ?? 0) > 1)) ? 'shared-port'
      : groups.some(id => model.groups[id]!.flank !== undefined || groupShape(model, id) !== 'row') ? 'non-row'
      : groups.some(id => model.document.groups[id]!.parent !== undefined) ? 'nested-frame' : undefined;
    if (reason !== undefined) { declined(cohort.links, reason); continue; }
    const members = cohort.links.map(link => ({ link: link.id, hub: hubs.includes(link.attachments!.from.node) ? link.attachments!.from.node : link.attachments!.to.node,
      unit: model.groups[model.document.nodes[farOf(link)]!.group]!.frame ?? model.document.nodes[farOf(link)]!.group }))
      .sort((a, b) => a.hub.localeCompare(b.hub) || a.unit.localeCompare(b.unit) || a.link.localeCompare(b.link));
    candidates.push({ id: `block:${cohort.group}:${cohort.tier}:${cohort.klass}`, kind: 'solid', group: cohort.group, class: cohort.klass,
      hubs, farNodes, units: [...new Set(members.map(member => member.unit))].sort(), members });
  }
  // Duplicate orientations have exactly the same members. Smaller hub side wins,
  // upper row on a tie, then the group id. Genuine overlaps decline together.
  candidates.sort((a, b) => a.hubs.length - b.hubs.length || model.groups[a.group]!.tier! - model.groups[b.group]!.tier! || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const unique = candidates.filter(family => { const key = family.members.map(member => member.link).sort().join('\0'); if (seen.has(key)) return false; seen.add(key); return true; });
  const overlaps = new Set(unique.filter(a => unique.some(b => a !== b && a.members.some(member => b.members.some(other => other.link === member.link)))).map(family => family.id));
  // Shared nodes couple face order and both adjacent gaps. Ticket 84 owns that component decision.
  const interacting = new Set(unique.filter(a => unique.some(b => a !== b && [...a.hubs, ...a.farNodes!].some(node => [...b.hubs, ...b.farNodes!].includes(node)))).map(family => family.id));
  const accepted = unique.filter(family => {
    const reason = excluded.get(family.id) ?? excluded.get('*') ?? (interacting.has(family.id) ? 'interacting-blocks' : undefined);
    if (reason) {
      declined(model.links.filter(link => family.members.some(member => member.link === link.id)), reason);
      if (excluded.has(family.id) || excluded.has('*')) (model.declinedSolidBlocks ??= []).push({ family: family.id, reason });
    }
    return reason === undefined && !overlaps.has(family.id);
  });
  for (const family of unique) if (overlaps.has(family.id)) declined(model.links.filter(link => family.members.some(member => member.link === link.id)), 'overlapping-blocks');
  if (!accepted.length) return;
  const owned = new Set(accepted.flatMap(family => family.members.map(member => member.link)));
  const dissolved = new Set(model.groupLinks.filter(group => group.members.every(id => owned.has(id))).map(group => group.id));
  model.groupLinks = model.groupLinks.filter(group => !dissolved.has(group.id));
  model.diagnostics = model.diagnostics.filter(note => !(note.code === 'ROUTE_UNSUPPORTED' && note.owners?.length && note.owners.every(owner => owner.kind === 'link' && owned.has(owner.id))));
  for (const family of accepted) for (const member of family.members) {
    const link = model.links.find(item => item.id === member.link)!;
    if (link.groupLink !== undefined && dissolved.has(link.groupLink)) delete link.groupLink;
    link.fanFamily = family.id; link.solidBlock = true;
  }
  model.fanFamilies = [...(model.fanFamilies ?? []), ...accepted].sort((a, b) => a.id.localeCompare(b.id));
}
