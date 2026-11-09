import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { selectAnchorTier } from './lanes.js';
import { nodeTierIfAny } from './read/tier.js';

/** Two or more links between one pair of nodes whose ends share one face at each node: one set, one side order at both ends. */
export interface ParallelSet {
  nodes: readonly [string, string]; links: readonly LayoutLink[];
  /** `bundle`: a bundle (its own owner since ticket 08). `mixed`: a routed link and an overlay link between one pair (ticket 80). */
  kind: 'bundle' | 'mixed';
}

const FACING: Readonly<Record<Side, Side>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * The parallel sets of a model with final sides (stage 5, architecture-2 ticket 80). Every bundle is a set, whatever its faces. Every other group of two or
 * more links between one node pair is a set too when it holds a routed link and an overlay link (technique `overlay`; two layers, any family class), its links
 * leave one face of each node and the two faces face each other (top with bottom, left with right). Two links of one layer without a bundle are no set: two
 * overlay links between one pair can still cross, and nothing owns their order yet. The caller guards the ports of a set.
 */
export function parallelSets(model: LayoutModel): ParallelSet[] {
  const sets: ParallelSet[] = [];
  for (const bundle of model.bundles) {
    if (bundle.nodes[0] === bundle.nodes[1]) continue;
    sets.push({ nodes: bundle.nodes, links: bundle.members.map(member => model.links.find(link => link.id === member)!), kind: 'bundle' });
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
    if (group.links.length < 2) continue;
    // Two layers on one pair: no bundle holds a routed link with an overlay link. The limit to two layers is a scope limit, not an owner: as sets, groups of one layer changed
    // 8 older sheets and made 2 worse (the gate, ticket 80), and the six-sync-links sheet still crosses. A pair of two `route: orthogonal` links is the author's own route override.
    const overlay = group.links.filter(link => link.technique === 'overlay').length;
    if (overlay === 0 || overlay === group.links.length || group.links.some(link => link.meshBus !== undefined)) continue;
    sets.push({ ...group, kind: 'mixed' });
  }
  return sets;
}

/**
 * The visit order of stage 5's face sort: `base` with every mixed set's lead end before its follower end (a stable topological order: the earliest node of `base` whose
 * leads are all visited comes next). The lead is the end with an authored `order:` (`authored`), else the end in the upper tier, else the smaller node id: content, so
 * that reversing `nodes` or `links` changes nothing (R3; the document order of a node is no key, and the node id is the last one). A cycle of leads (authored ends that
 * disagree) keeps `base` for the nodes that are left.
 */
export function visitOrder(model: LayoutModel, base: readonly string[], sets: readonly ParallelSet[], authored: ReadonlySet<string>): string[] {
  const tier = (id: string): number => model.groups[model.document.nodes[id]!.group]?.tier ?? 0;
  const before = new Map<string, Set<string>>();
  for (const set of sets) {
    const [a, b] = set.nodes;
    const lead = authored.has(a) !== authored.has(b) ? (authored.has(a) ? a : b)
      : tier(a) !== tier(b) ? (tier(a) < tier(b) ? a : b) : (a < b ? a : b);
    const follower = lead === a ? b : a;
    const list = before.get(follower) ?? new Set<string>();
    list.add(lead); before.set(follower, list);
  }
  const done = new Set<string>(), result: string[] = [];
  while (result.length < base.length) {
    const next = base.find(id => !done.has(id) && [...(before.get(id) ?? [])].every(lead => done.has(lead))) ?? base.find(id => !done.has(id))!;
    done.add(next); result.push(next);
  }
  return result;
}

/**
 * The shared sort key of the links of a facing pair (decision review ticket 17). A facing pair is two or more routed links between one node pair whose ends
 * leave facing faces (top with bottom, left with right), each end on a port with one peer, with no link of a parallel set (`inSet`: a set orders itself).
 * Stage 5 sorts a face by the far ends' provisional anchors, so the two faces of a pair read each other's draft slots: where the stage-4 draft crosses two
 * links of the pair, both faces flip, and the two faces disagree whatever lane order follows (G5 fails on one face). So the pair is ordered once, from
 * both ends: every port of the pair, on both faces, takes the coordinate of its link's end at the held node (`far`, the face sort's own reader, read
 * from the other end), and the other ports of each face sort against that. The held node is the end 7c keeps where it stands: the end nearer the anchor
 * tier (`laneSource`'s rule); on a tie, the node whose face of the pair is `top` or `left` (the lower or the right node). Content only (R3): no link
 * order and no authored direction decides it. Both faces read one key per link, so the pair keeps one order at both ends; equal keys keep the face
 * sort's own tie order. `sideOf` reads a port's side: the final side at stage 5, the sizing estimate in the stage-4 prediction (`overlay-order.ts`).
 */
export function facingPairKeys(model: LayoutModel, far: (ref: PortRef, side: Side) => number, peerCount: (ref: PortRef) => number,
  inSet: ReadonlySet<string>, sideOf: (ref: PortRef) => Side | undefined): Map<string, number> {
  const groups = new Map<string, LayoutLink[]>();
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || ends.from.node === ends.to.node || inSet.has(link.id) || link.technique === 'overlay' || link.meshBus !== undefined) continue;
    const from = sideOf(ends.from), to = sideOf(ends.to);
    if (from === undefined || to === undefined || FACING[from] !== to || peerCount(ends.from) !== 1 || peerCount(ends.to) !== 1) continue;
    const forward = ends.from.node < ends.to.node;
    const id = JSON.stringify([forward ? [ends.from.node, ends.to.node] : [ends.to.node, ends.from.node], forward ? from : to]);
    const group = groups.get(id) ?? [];
    group.push(link); groups.set(id, group);
  }
  const keys = new Map<string, number>(), anchor = selectAnchorTier(model);
  const distance = (node: string): number => {
    const tier = nodeTierIfAny(model, node);
    return anchor === undefined || tier === undefined ? Infinity : Math.abs(tier - anchor);
  };
  for (const links of groups.values()) {
    if (links.length < 2) continue;
    const { from, to } = links[0]!.attachments!;
    const near = distance(from.node) !== distance(to.node) ? (distance(from.node) < distance(to.node) ? from : to)
      : (sideOf(from) === 'top' || sideOf(from) === 'left' ? from : to);
    const held = near.node;
    for (const link of links) {
      const ends = link.attachments!, other = ends.from.node === held ? ends.to : ends.from;
      const at = far(other, sideOf(other)!);
      keys.set(portId(ends.from), at); keys.set(portId(ends.to), at);
    }
  }
  return keys;
}
