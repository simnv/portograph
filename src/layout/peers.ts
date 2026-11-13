import type { PortRef } from '../model/document.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { readCache } from '../model/read-cache.js';
import { portId } from './skeleton-graph.js';
const key = portId;

const linkByIdReads = new WeakMap<readonly LayoutLink[], { count: number; index: ReadonlyMap<string, LayoutLink> }>();
const linkByIdCache = readCache('linkById');

function computeLinkById(links: readonly LayoutLink[]): ReadonlyMap<string, LayoutLink> {
  const index = new Map<string, LayoutLink>();
  for (const link of links) {
    if (!index.has(link.id)) index.set(link.id, link);
  }
  return index;
}

/**
 * The links of the model indexed by id, preserving first-match semantics on duplicate ids.
 * Cached against the `model.links` array identity and length, and checked under `LayoutOptions.checkCaches`.
 */
export function linkById(model: LayoutModel): ReadonlyMap<string, LayoutLink> {
  const known = linkByIdReads.get(model.links);
  if (known !== undefined && known.count === model.links.length) {
    return linkByIdCache.hit(model, known.index, () => computeLinkById(model.links));
  }
  linkByIdCache.miss();
  const index = computeLinkById(model.links);
  linkByIdReads.set(model.links, { count: model.links.length, index });
  return index;
}

const linkByEndsReads = new WeakMap<readonly LayoutLink[], { count: number; index: ReadonlyMap<string, LayoutLink> }>();
const linkByEndsCache = readCache('linkByEnds');

function computeLinkByEnds(links: readonly LayoutLink[]): ReadonlyMap<string, LayoutLink> {
  const index = new Map<string, LayoutLink>();
  for (const link of links) {
    if (!link.attachments) continue;
    const from = key(link.attachments.from), to = key(link.attachments.to);
    const pair = from < to ? `${from}\0${to}` : `${to}\0${from}`;
    if (!index.has(pair)) index.set(pair, link);
  }
  return index;
}

/**
 * The first link connecting each unordered pair of port keys (`a\0b` with `a <= b`).
 * Cached against the `model.links` array identity and length, and checked under `LayoutOptions.checkCaches`.
 */
export function linkByEnds(model: LayoutModel): ReadonlyMap<string, LayoutLink> {
  const known = linkByEndsReads.get(model.links);
  if (known !== undefined && known.count === model.links.length) {
    return linkByEndsCache.hit(model, known.index, () => computeLinkByEnds(model.links));
  }
  linkByEndsCache.miss();
  const index = computeLinkByEnds(model.links);
  linkByEndsReads.set(model.links, { count: model.links.length, index });
  return index;
}

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
const unreservedPeersCache = readCache('unreservedPeers');

function computeUnreservedPeers(links: LayoutModel['links']): Map<string, Peer[]> {
  const index = new Map<string, Peer[]>();
  for (const link of links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || link.bundle !== undefined || !link.attachments) continue;
    const { from, to } = link.attachments;
    for (const [near, far] of [[from, to], [to, from]] as const) {
      const list = index.get(key(near)) ?? [];
      list.push({ peer: far, link: link.id });
      index.set(key(near), list);
    }
  }
  return index;
}

export function unreservedPeers(model: LayoutModel): Map<string, Peer[]> {
  const cached = peerCache.get(model.links);
  if (cached !== undefined) return unreservedPeersCache.hit(model, cached, () => computeUnreservedPeers(model.links));
  unreservedPeersCache.miss();
  const index = computeUnreservedPeers(model.links);
  peerCache.set(model.links, index);
  return index;
}

const routedAtCache = new WeakMap<LayoutModel['links'], Map<string, LayoutLink[]>>();
const routedLinksAtCache = readCache('routedLinksAt');

function computeRoutedLinksAt(links: LayoutModel['links']): Map<string, LayoutLink[]> {
  const index = new Map<string, LayoutLink[]>();
  for (const link of links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    const from = key(link.attachments.from), to = key(link.attachments.to);
    for (const end of from === to ? [from] : [from, to]) { const list = index.get(end); if (list) list.push(link); else index.set(end, [link]); }
  }
  return index;
}

/**
 * The routed links of each port key in link order (a link from a port to itself counts once), cached against the link array like `unreservedPeers`: the layer, the
 * technique and the attachments of a link are fixed in stage 1. The lists are shared and read only.
 */
export function routedLinksAt(model: LayoutModel): Map<string, LayoutLink[]> {
  const cached = routedAtCache.get(model.links);
  if (cached !== undefined) return routedLinksAtCache.hit(model, cached, () => computeRoutedLinksAt(model.links));
  routedLinksAtCache.miss();
  const index = computeRoutedLinksAt(model.links);
  routedAtCache.set(model.links, index);
  return index;
}

const allPeerCache = new WeakMap<LayoutModel['links'], Map<string, PortRef[]>>();
const allPeersCache = readCache('allPeers');

function computeAllPeers(links: LayoutModel['links']): Map<string, PortRef[]> {
  const index = new Map<string, PortRef[]>();
  for (const link of links) {
    const { from, to } = link.attachments!;
    for (const [a, b] of key(from) === key(to) ? [[from, to]] : [[from, to], [to, from]]) {
      const list = index.get(key(a!)) ?? []; list.push(b!); index.set(key(a!), list);
    }
  }
  return index;
}

/** Every peer of every port over all links, as stage 5 reads them (a link from a port to itself counts once). */
export function allPeers(model: LayoutModel): Map<string, PortRef[]> {
  const cached = allPeerCache.get(model.links);
  if (cached !== undefined) return allPeersCache.hit(model, cached, () => computeAllPeers(model.links));
  allPeersCache.miss();
  const index = computeAllPeers(model.links);
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
