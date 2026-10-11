import type { PortRef } from '../model/document.js';
import type { LayoutModel } from '../model/layout.js';
import { portId } from './skeleton-graph.js';
const key = portId;

/**
 * Peer ports of every routed attachment that no rule has already promised geometry to, keyed by
 * port. A bundle member is left out: stage 7e reserves its envelope, its pitch and its path, so it
 * never asks stage 8 for a stem. Everything else may still reach stage 8, which always gives it one.
 *
 * The index is derived from the link array and cached against it. Membership and attachments are
 * fixed in stage 1, and every checked transaction clones the array, so a new array is a new index.
 */
export interface Peer { peer: PortRef; link: string }
const peerCache = new WeakMap<LayoutModel['links'], Map<string, Peer[]>>();
export function unreservedPeers(model: LayoutModel): Map<string, Peer[]> {
  const cached = peerCache.get(model.links);
  if (cached) return cached;
  const index = new Map<string, Peer[]>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || link.bundle !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    for (const [near, far] of [[from, to], [to, from]] as const) {
      const list = index.get(key(near)) ?? [];
      list.push({ peer: far, link: link.id });
      index.set(key(near), list);
    }
  }
  peerCache.set(model.links, index);
  return index;
}

const allPeerCache = new WeakMap<LayoutModel['links'], Map<string, PortRef[]>>();
/** Every peer of every port over all links, as stage 5 reads them (a link from a port to itself counts once). */
function allPeers(model: LayoutModel): Map<string, PortRef[]> {
  const cached = allPeerCache.get(model.links);
  if (cached) return cached;
  const index = new Map<string, PortRef[]>();
  for (const link of model.links) {
    const { from, to } = link.attachments!;
    for (const [a, b] of key(from) === key(to) ? [[from, to]] : [[from, to], [to, from]]) {
      const list = index.get(key(a!)) ?? []; list.push(b!); index.set(key(a!), list);
    }
  }
  allPeerCache.set(model.links, index);
  return index;
}

/**
 * The coordinate along `side` that a port's run goes to: the mean of its peers' ports over all links (x on a horizontal face, y on a lateral one), or `Infinity`
 * with no peer. The key of the far-end order of stage 5, read again by the turn round and by the 7a pass.
 */
export function farCoordinate(model: LayoutModel, ref: PortRef, side: 'top' | 'right' | 'bottom' | 'left'): number {
  const horizontal = side === 'top' || side === 'bottom';
  const list = allPeers(model).get(key(ref)) ?? [];
  const at = (peer: PortRef): number => {
    const node = model.nodes[peer.node]!, box = node.bounds!, point = node.ports.find(port => key(port.ref) === key(peer))?.anchor;
    return horizontal ? (point?.x ?? box.x + box.width / 2) : (point?.y ?? box.y + box.height / 2);
  };
  return list.length ? list.reduce((sum, peer) => sum + at(peer), 0) / list.length : Infinity;
}
