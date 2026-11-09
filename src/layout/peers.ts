import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
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

const routedAtCache = new WeakMap<LayoutModel['links'], Map<string, LayoutLink[]>>();
/**
 * The routed links of each port key in link order (a link from a port to itself counts once), cached against the link array like `unreservedPeers`: the layer, the
 * technique and the attachments of a link are fixed in stage 1. The lists are shared and read only.
 */
export function routedLinksAt(model: LayoutModel): Map<string, LayoutLink[]> {
  const cached = routedAtCache.get(model.links);
  if (cached) return cached;
  const index = new Map<string, LayoutLink[]>();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    const from = key(link.attachments.from), to = key(link.attachments.to);
    for (const end of from === to ? [from] : [from, to]) { const list = index.get(end); if (list) list.push(link); else index.set(end, [link]); }
  }
  routedAtCache.set(model.links, index);
  return index;
}

const allPeerCache = new WeakMap<LayoutModel['links'], Map<string, PortRef[]>>();
/** Every peer of every port over all links, as stage 5 reads them (a link from a port to itself counts once). */
export function allPeers(model: LayoutModel): Map<string, PortRef[]> {
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
 * with no peer. The far-end key of the turn round and of the 7a turn pass: they read it through `pairedFaceKey` (`parallel-sets.ts`), as stage 5 reads its own
 * far coordinate, so a port of a facing pair sorts by the pair's shared key there too.
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
