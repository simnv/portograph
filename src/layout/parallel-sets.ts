import type { LayoutLink, LayoutModel } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { findPort } from './row-paths.js';

/** Two or more links between one pair of nodes whose ends share one face at each node: one set, one side order at both ends. */
export interface ParallelSet { nodes: readonly [string, string]; links: readonly LayoutLink[] }

const FACING: Readonly<Record<Side, Side>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * The parallel sets of a model with final sides (stage 5, architecture-2 ticket 80). Every bundle is a set, whatever its faces. Every other group of two or
 * more links of any family (routed, overlay, signal) between one node pair is a set too when its links leave one face of each node and the two faces
 * face each other (top with bottom, left with right). The order is the same at both ends, so the authored direction of a link, and the family it is in,
 * decide nothing (R3). A group that holds exactly the members of a bundle is that bundle, listed once. The caller guards the ports of a set.
 */
export function parallelSets(model: LayoutModel): ParallelSet[] {
  const sets: ParallelSet[] = [], bundled = new Set<string>();
  for (const bundle of model.bundles) {
    if (bundle.nodes[0] === bundle.nodes[1]) continue;
    sets.push({ nodes: bundle.nodes, links: bundle.members.map(member => model.links.find(link => link.id === member)!) });
    bundled.add([...bundle.members].sort().join('\n'));
  }
  const groups = new Map<string, { nodes: [string, string]; links: LayoutLink[] }>();
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || ends.from.node === ends.to.node) continue;
    const from = findPort(model, ends.from)?.side, to = findPort(model, ends.to)?.side;
    if (from === undefined || to === undefined || FACING[from] !== to) continue;
    // The pair is written upper-key first, so a link written either way meets its partners in one group.
    const forward = ends.from.node < ends.to.node;
    const nodes: [string, string] = forward ? [ends.from.node, ends.to.node] : [ends.to.node, ends.from.node];
    const id = JSON.stringify([nodes, forward ? [from, to] : [to, from]]);
    const group = groups.get(id) ?? { nodes, links: [] };
    group.links.push(link); groups.set(id, group);
  }
  for (const group of groups.values()) {
    if (group.links.length < 2 || bundled.has(group.links.map(link => link.id).sort().join('\n'))) continue;
    sets.push(group);
  }
  return sets;
}
