import type { LayoutLabel, LayoutLink, LayoutModel, MeshBus } from '../model/layout.js';

/** The full text of a drawn label that shows a shortened form: its `tooltip`, when that differs from what it draws. */
export const shortenedText = (label: LayoutLabel): string | undefined =>
  label.tooltip !== undefined && label.tooltip !== label.text ? label.tooltip : undefined;

/**
 * Text a link carries but does not draw: the full text of each omitted label it owns, and the
 * membership of an M1 group-link fallback. One reader for the SVG `<title>` and the draw.io
 * `tooltip` attribute (R1), so neither renderer loses what the other keeps.
 */
export function linkTooltipLines(layout: LayoutModel, link: LayoutLink): string[] {
  const lines = layout.labels.filter(label => label.role === 'link' && label.omitted
    && label.tooltip !== undefined && label.owner.kind === 'link' && label.owner.id === link.id)
    .map(label => label.tooltip!);
  const group = link.groupLink === undefined ? undefined : layout.groupLinks.find(item => item.id === link.groupLink);
  if (group) lines.push(`${group.groups[0]} – ${group.groups[1]}: ${group.members.length} links`);
  return lines;
}

/** The tooltip of one mesh bus: its class, members, joins, the authored label of each member link, and the text of a bus label with no room. */
export function busTooltip(layout: LayoutModel, bus: MeshBus): string {
  const label = layout.labels.find(item => item.id === bus.label);
  const memberOf = (id: string): LayoutLink | undefined => layout.links.find(link => link.id === id);
  const authoredLabels = [...bus.members, ...(bus.cross ?? [])].flatMap(id => {
    const link = memberOf(id), text = link === undefined ? undefined : layout.document.links[link.sourceIndex]?.label;
    return text ? [`${id}: ${text}`] : [];
  });
  const partner = bus.joined === undefined ? undefined : (layout.meshBuses ?? []).find(item => item.id === bus.joined);
  const upper = bus.cross !== undefined ? bus : partner;
  const joinLines = partner === undefined ? [] : [`joined with: ${partner.id} (${bus.meshNodes ?? bus.nodes.length} nodes in all)`,
    `mesh: ${[...bus.nodes, ...partner.nodes].join(', ')}`, `cross links: ${(upper?.cross ?? []).join(', ')}`];
  const meshBuses = bus.mesh === undefined ? [] : (layout.meshBuses ?? []).filter(item => item.mesh === bus.mesh);
  const trunkLines = bus.mesh === undefined ? [] : [`joined by trunk: ${meshBuses.map(item => item.id).join(', ')} (${bus.meshNodes ?? bus.nodes.length} nodes in all)`,
    ...(bus.trunk === undefined ? [] : [`mesh: ${meshBuses.flatMap(item => item.nodes).join(', ')}`, `cross links: ${(bus.cross ?? []).join(', ')}`])];
  return [`${bus.class ?? 'unclassed'} mesh: ${bus.nodes.join(', ')}`, `links: ${bus.members.join(', ')}`, ...joinLines, ...trunkLines,
    ...(bus.dissolved.length ? [`group-links: ${bus.dissolved.join(', ')}`] : []), ...authoredLabels, ...(label?.omitted && label.tooltip !== undefined ? [label.tooltip] : [])].join('\n');
}
