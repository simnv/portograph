import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import type { Side } from '../model/geometry.js';
import { findPort } from './row-paths.js';
import { portId } from './skeleton-graph.js';
import { selectAnchorTier } from './lanes.js';
import { nodeTierIfAny } from './read/tier.js';
import { allPeers } from './peers.js';

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
 * overlay links between one pair can still cross, and nothing owns their order yet. The caller guards the ports of a set. `sideOf` reads a port's side: the
 * final side by default; the stage-4 prediction of the face order passes the sizing side it reads every other face with (`facingPairs`, R1).
 */
export function parallelSets(model: LayoutModel, sideOf: (ref: PortRef) => Side | undefined = ref => findPort(model, ref)?.side): ParallelSet[] {
  const sets: ParallelSet[] = [];
  for (const bundle of model.bundles) {
    if (bundle.nodes[0] === bundle.nodes[1]) continue;
    sets.push({ nodes: bundle.nodes, links: bundle.members.map(member => model.links.find(link => link.id === member)!), kind: 'bundle' });
  }
  const groups = new Map<string, { nodes: [string, string]; links: LayoutLink[] }>();
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || ends.from.node === ends.to.node) continue;
    const from = sideOf(ends.from), to = sideOf(ends.to);
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
 * A facing pair (decision review ticket 17): two or more routed links between one node pair whose ends leave facing faces (top with bottom, left with right),
 * each end on a port with one peer (`allPeers`, the peers stage 5 sorts a face by), with no link of a parallel set (a set orders itself; read with the same
 * `sideOf`). `held` is the node whose tier is nearer the anchor tier (`selectAnchorTier`); on a tie, the node whose face of the pair is `top` or `left`
 * (the lower or the right node). Where the distances differ this is the end `laneSource` aligns to; on a tie `laneSource` keeps each link's authored
 * source, so the two can differ, and the pair reads only `held`. Content only (R3): no link order and no authored direction decides it. `sideOf` reads a
 * port's side: the final side at stage 5, in 7a and in the turn passes, the sizing estimate in the stage-4 prediction (`overlay-order.ts`). Stage 5 and the
 * turn passes order both faces of a pair by one key per link (`pairedFaceKey`); 7a nests the pair's transit lanes in that order (decision review ticket 23,
 * `allocateLanes`).
 */
export interface FacingPair { links: readonly LayoutLink[]; held: string }
export function facingPairs(model: LayoutModel, sideOf: (ref: PortRef) => Side | undefined): FacingPair[] {
  const inSet = new Set(parallelSets(model, sideOf).flatMap(set => set.links.map(link => link.id)));
  const peers = allPeers(model), peerCount = (ref: PortRef): number => (peers.get(portId(ref)) ?? []).length;
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
  const anchor = selectAnchorTier(model);
  const distance = (node: string): number => {
    const tier = nodeTierIfAny(model, node);
    return anchor === undefined || tier === undefined ? Infinity : Math.abs(tier - anchor);
  };
  return [...groups.values()].filter(links => links.length >= 2).map(links => {
    const { from, to } = links[0]!.attachments!;
    const near = distance(from.node) !== distance(to.node) ? (distance(from.node) < distance(to.node) ? from : to)
      : (sideOf(from) === 'top' || sideOf(from) === 'left' ? from : to);
    return { links, held: near.node };
  });
}

/**
 * The key a port of `side` is sorted by in a face order (decision review ticket 17): the port's facing-pair key where it has one, else `far`, the stage's own
 * far-end reader. Stage 5 sorts a face by the far ends' provisional anchors, so the two faces of a pair read each other's draft slots: where the stage-4 draft
 * crosses two links of the pair, both faces flip and disagree whatever lane order follows (G5 fails on one face). So the pair is ordered once, from both
 * ends: every port of the pair, on both faces, takes the coordinate of its link's end at the held node (`far` read from the other end), and the other ports
 * of each face sort against that. Both faces read one key per link, so the pair keeps one order at both ends; equal keys keep the sort's own tie order.
 * The one reader of that rule: stage 5 and its stage-4 prediction (`faceSortKey`), and the turn passes of 7a and of the turn round (`laneFaceOrder`,
 * `measureTurnOrder`), so a turn pass never sorts a pair against the order stage 5 gave it (R1). The pair keys are read once, when it is called, before
 * any face is sorted (stage 5 sorts face after face on moving anchors); the other ports read `far` on every lookup.
 */
export function pairedFaceKey(model: LayoutModel, far: (ref: PortRef, side: Side) => number, sideOf: (ref: PortRef) => Side | undefined): (ref: PortRef, side: Side) => number {
  const keys = new Map<string, number>();
  for (const { links, held } of facingPairs(model, sideOf)) {
    for (const link of links) {
      const ends = link.attachments!, other = ends.from.node === held ? ends.to : ends.from;
      const at = far(other, sideOf(other)!);
      keys.set(portId(ends.from), at); keys.set(portId(ends.to), at);
    }
  }
  return (ref, side) => keys.get(portId(ref)) ?? far(ref, side);
}
