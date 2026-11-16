import { orderedNodeIds } from '../model/model.js';
import type { FanFamily, LayoutLink, LayoutModel } from '../model/layout.js';
import { faintLinkClass } from '../profiles/network/theme.js';
import { groupShape } from '../layout/grid.js';
import { portId } from '../layout/skeleton-graph.js';

/**
 * Ticket 83, the under-cap slice of ticket 81; dense-16x9 ticket 04 (slice 2). No maximal-biclique extraction: one cohort per hub cell, boundary
 * and class. A boundary is the adjacent rank of the same frame (one cell, a unit is a far node) or the facing rank of the adjacent document tier
 * (a unit is the outermost frame or the group of a far end); every link of a cohort joins two adjacent sub-tiers. The hubs are the whole hub cell (a rank cell of a ranked group, or the group),
 * and each hub reaches every far node, or, across two far units or more, every far unit (complete at the level of the far unit; different hubs
 * may reach different nodes of one far group). Each
 * far group is whole: every node of it is a far end. An incomplete cohort is no block, and keeps its links as they are.
 */
export function detectSolidBlocks(model: LayoutModel, excluded: ReadonlyMap<string, string> = new Map()): void {
  const shared = new Map<string, number>();
  for (const link of model.links) if (link.layer === 'routed' && link.attachments) {
    for (const ref of Object.values(link.attachments)) shared.set(portId(ref), (shared.get(portId(ref)) ?? 0) + 1);
  }
  const cohorts = new Map<string, { group: string; tier: number; inFrame?: string; klass: string; links: LayoutLink[]; skew?: true }>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.family !== 'routed' || !link.attachments) continue;
    const source = model.document.links[link.sourceIndex]!;
    if (faintLinkClass(source.class)) continue;
    const ends = [link.attachments.from.node, link.attachments.to.node];
    const groups = ends.map(node => model.document.nodes[node]!.group);
    const tiers = groups.map(id => model.document.groups[id]!.documentTier ?? model.document.groups[id]!.tier);
    if (groups[0] === groups[1] || tiers.some(tier => tier === undefined)) continue;
    // Two ranks of one frame on adjacent sub-tiers, or two groups on adjacent document tiers.
    const frames = groups.map(id => model.groups[id]?.frame), ranks = groups.map(id => model.groups[id]?.tier);
    const inFrame = tiers[0] === tiers[1] && frames[0] !== undefined && frames[0] === frames[1] && ranks.every(rank => rank !== undefined) && Math.abs(ranks[0]! - ranks[1]!) === 1;
    if (!inFrame && Math.abs(tiers[0]! - tiers[1]!) !== 1) continue;
    for (const [hub, far] of [[0, 1], [1, 0]] as const) {
      const key = JSON.stringify([groups[hub], inFrame ? groups[far] : tiers[far], source.class ?? '']);
      const cohort = cohorts.get(key) ?? { group: groups[hub]!, tier: tiers[far]!, ...(inFrame ? { inFrame: groups[far]! } : {}), klass: source.class ?? '', links: [] };
      cohort.links.push(link); cohorts.set(key, cohort);
      // A link that does not join two adjacent sub-tiers (a far node off the facing rank of a ranked frame, or a hub off its own facing rank)
      // makes the cohort no block: its chords would pass a rank between.
      if (ranks.some(rank => rank === undefined) || Math.abs(ranks[0]! - ranks[1]!) !== 1) cohort.skew = true;
    }
  }
  const declined = (links: LayoutLink[], reason: string): void => {
    model.diagnostics.push({ stage: 'model', severity: 'info', code: 'SOLID_BLOCK_DECLINED', message: `Solid block declines ${reason}.`, owners: links.map(link => link.owner) });
  };
  const candidates: FanFamily[] = [];
  for (const cohort of cohorts.values()) {
    const cell = model.groups[cohort.group]!.nodes;
    const hubOf = (link: LayoutLink): string => (cell.includes(link.attachments!.from.node) ? link.attachments!.from.node : link.attachments!.to.node);
    const farOf = (link: LayoutLink): string => (cell.includes(link.attachments!.from.node) ? link.attachments!.to.node : link.attachments!.from.node);
    const unitOf = (node: string): string => cohort.inFrame !== undefined ? node : model.groups[model.document.nodes[node]!.group]!.frame ?? model.document.nodes[node]!.group;
    const hubs = [...cell];
    const far = new Set(cohort.links.map(farOf));
    const farNodes = orderedNodeIds(model.document).filter(id => far.has(id));
    if (cohort.skew || hubs.length < 2 || farNodes.length < 2) continue;
    const pairs = new Set(cohort.links.map(link => [link.attachments!.from.node, link.attachments!.to.node].sort().join('\0')));
    const units = new Set(farNodes.map(unitOf));
    const reached = new Set(cohort.links.map(link => JSON.stringify([hubOf(link), unitOf(farOf(link))])));
    const groups = [...new Set([...hubs, ...farNodes].map(id => model.document.nodes[id]!.group))];
    // Each hub reaches every far node, or, across two far units or more, every far unit; one link a pair; each far group is whole.
    const complete = pairs.size === hubs.length * farNodes.length || (units.size >= 2 && reached.size === hubs.length * units.size);
    if (!complete || cohort.links.length !== pairs.size
      || groups.some(id => model.groups[id]!.nodes.some(node => !hubs.includes(node) && !far.has(node)))) {
      continue;
    }
    const reason = cohort.links.some(link => {
      const source = model.document.links[link.sourceIndex]!;
      return source.route !== undefined && source.route !== 'straight' || source.from.group !== undefined || source.to.group !== undefined;
    }) ? 'authored-route' : cohort.links.some(link => link.bundle !== undefined || link.meshBus !== undefined) ? 'bundle-or-bus'
      : cohort.links.some(link => model.document.links[link.sourceIndex]!.label !== undefined) ? 'labelled-member'
      : cohort.links.some(link => Object.values(link.attachments!).some(ref => (shared.get(portId(ref)) ?? 0) > 1)) ? 'shared-port'
      : groups.some(id => model.groups[id]!.flank !== undefined || groupShape(model, id) !== 'row') ? 'non-row'
      : groups.some(id => model.document.groups[id]!.parent !== undefined) ? 'nested-frame' : undefined;
    if (reason !== undefined) { declined(cohort.links, reason); continue; }
    const members = cohort.links.map(link => ({ link: link.id, hub: hubOf(link), unit: unitOf(farOf(link)) }))
      .sort((a, b) => a.hub.localeCompare(b.hub) || a.unit.localeCompare(b.unit) || a.link.localeCompare(b.link));
    candidates.push({ id: cohort.inFrame !== undefined ? `block:${cohort.group}:${cohort.inFrame}:${cohort.klass}` : `block:${cohort.group}:${cohort.tier}:${cohort.klass}`, kind: 'solid', group: cohort.group, class: cohort.klass,
      hubs, farNodes, units: [...new Set(members.map(member => member.unit))].sort(), members });
  }
  // Duplicate orientations have exactly the same members. Smaller hub side wins,
  // upper row on a tie, then the group id. Genuine overlaps decline together.
  candidates.sort((a, b) => a.hubs.length - b.hubs.length || model.groups[a.group]!.tier! - model.groups[b.group]!.tier! || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const orientations = candidates.filter(family => { const key = family.members.map(member => member.link).sort().join('\0'); if (seen.has(key)) return false; seen.add(key); return true; });
  // A reverse cohort of one far group is part of the complete relation, not another block.
  // Retain only inclusion-maximal whole cohorts before judging genuine overlaps.
  const unique = orientations.filter(a => !orientations.some(b => b.members.length > a.members.length
    && a.members.every(member => b.members.some(other => other.link === member.link))));
  // A reverse cohort that the blocks before it cover together (the far groups of two hub cells, each reaching both) is part of their complete
  // relations too, not another block (dense-16x9 ticket 04, slice 2): one owner per member, the first in the order above.
  const covered = unique.filter((a, index) => a.members.every(member => unique.slice(0, index).some(b => b.members.some(other => other.link === member.link))));
  const kept = unique.filter(family => !covered.includes(family));
  const overlaps = new Set(kept.filter(a => kept.some(b => a !== b && a.members.some(member => b.members.some(other => other.link === member.link)))).map(family => family.id));
  // Blocks that share a node, a face or a tier gap are kept together: placement reserves their pitch and gap jointly (by pair and by maximum).
  const accepted = kept.filter(family => {
    const reason = excluded.get(family.id);
    if (reason) {
      declined(model.links.filter(link => family.members.some(member => member.link === link.id)), reason);
      if (excluded.has(family.id)) (model.declinedSolidBlocks ??= []).push({ family: family.id, reason });
    }
    return reason === undefined && !overlaps.has(family.id);
  });
  for (const family of kept) if (overlaps.has(family.id)) declined(model.links.filter(link => family.members.some(member => member.link === link.id)), 'overlapping-blocks');
  const owned = new Set(accepted.flatMap(family => family.members.map(member => member.link)));
  if (!accepted.length) return;
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
