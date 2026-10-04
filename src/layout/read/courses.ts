import type { PortRef } from '../../model/document.js';
import type { Point, Rect, Side } from '../../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort } from '../../model/layout.js';
import { groupShape } from '../grid.js';
import { transitTiers } from '../lanes.js';
import { findPort } from '../row-paths.js';
import { nodeTier } from './tier.js';

/**
 * Shared readers for the course plan (architecture ticket 15, phase 2). They state the order facts of Section 1 of the design: the units of each band
 * from left to right, whether an end stands at the edge of its row and its unit at the edge of its band, whether its group is the first or the last
 * rank of its frame, which units stand between the two ends of a link, and which of the four detours T1 to T4 a link has. They read orders and the
 * boxes that stage 5 has; they never read a lane, a route or a route attempt, and they write nothing.
 */

/** A unit of a band: a group (a rank cell is a group), with its box. */
export interface Unit { id: string; tier: number; box: Rect }

/** The units of every sub-tier, left to right by the x of their box. Groups without a box or without a tier (a model before tiers) are left out. */
export function bandUnits(model: LayoutModel): Map<number, Unit[]> {
  const bands = new Map<number, Unit[]>();
  for (const group of Object.values(model.groups)) {
    if (group.bounds === undefined || group.tier === undefined || group.nodes.length === 0) continue;
    const list = bands.get(group.tier) ?? [];
    list.push({ id: group.id, tier: group.tier, box: group.bounds });
    bands.set(group.tier, list);
  }
  for (const list of bands.values()) list.sort((a, b) => a.box.x - b.box.x || a.id.localeCompare(b.id));
  return bands;
}

/** What one end of a link stands on. `edge` says whether nothing stands beyond the node on that side in its row, and `unitEdge` whether nothing stands beyond its unit in its band. */
export interface EndFacts {
  ref: PortRef;
  port: LayoutPort;
  node: string;
  group: string;
  tier: number;
  side: Side;
  anchor: Point;
  box: Rect;
  edge: { left: boolean; right: boolean };
  unitEdge: { left: boolean; right: boolean };
  /** The group is the first rank of its frame (its top edge faces out), or the last (its bottom edge). A group of one rank is both. */
  firstRank: boolean;
  lastRank: boolean;
}

const isGrid = (model: LayoutModel, group: string): boolean => groupShape(model, group) === 'grid';

export function endFacts(model: LayoutModel, ref: PortRef, units: ReadonlyMap<number, readonly Unit[]>): EndFacts | undefined {
  const port = findPort(model, ref), node = model.nodes[ref.node], document = model.document.nodes[ref.node];
  if (port?.side === undefined || port.anchor === undefined || node?.bounds === undefined || document === undefined) return undefined;
  const group = model.groups[document.group];
  if (group === undefined || group.tier === undefined) return undefined;
  const order = group.rowOrder ?? group.nodes, at = order.indexOf(ref.node);
  const grid = isGrid(model, group.id);
  const band = units.get(group.tier) ?? [];
  const index = band.findIndex(unit => unit.id === group.id);
  const frame = group.frame === undefined ? undefined : Object.values(model.groups).filter(item => item.frame === group.frame && item.tier !== undefined).map(item => item.tier!);
  return {
    ref, port, node: ref.node, group: group.id, tier: group.tier, side: port.side, anchor: port.anchor, box: node.bounds,
    // A grid has no row order: the node box against its group box says whether it stands at the edge.
    edge: grid || at < 0 ? { left: false, right: false } : { left: at === 0, right: at === order.length - 1 },
    unitEdge: { left: index === 0, right: index >= 0 && index === band.length - 1 },
    firstRank: frame === undefined || group.tier === Math.min(...frame),
    lastRank: frame === undefined || group.tier === Math.max(...frame),
  };
}

/** The four detours of the design, Section 1: transit, U-turn, skirt, shared port. A link with none keeps its natural course. */
export type Trigger = 'T1' | 'T2' | 'T3' | 'T4';

/** What a link has between its ends and at its ends. */
export interface LinkFacts {
  link: LayoutLink;
  from: EndFacts;
  to: EndFacts;
  /** The sub-tiers strictly between the two ends (the bands the link crosses without ending in them). */
  crossed: number[];
  /** The units that stand across the corridor between the two anchors: in each crossed band, and in the band of both ends when they share it. */
  between: Unit[];
  /** Whether a unit of a crossed band stands over the x of the source anchor, so that a transit lane cannot stand under the source. */
  sourceCovered: boolean;
  /** Both ends stand in one row and a node of that row stands between them. */
  rowBetween: boolean;
  triggers: Trigger[];
}

const overlaps = (box: Rect, lo: number, hi: number): boolean => box.x < hi && box.x + box.width > lo;

/** The directions in which the peers of a port stand: `up`, `down` by sub-tier, `left`, `right` by x within one sub-tier. */
function peerDirections(model: LayoutModel, ref: PortRef, peers: readonly PortRef[]): Set<string> {
  const here = findPort(model, ref)?.anchor;
  const tier = nodeTier(model, ref.node);
  const found = new Set<string>();
  for (const peer of peers) {
    const there = findPort(model, peer)?.anchor, other = nodeTier(model, peer.node);
    if (there === undefined || here === undefined) continue;
    found.add(other > tier ? 'down' : other < tier ? 'up' : there.x < here.x ? 'left' : 'right');
  }
  return found;
}

/** The peers of every port that more than one link end uses, by port key. */
function sharedPorts(model: LayoutModel): Map<string, { ref: PortRef; peers: PortRef[] }> {
  const key = (ref: PortRef): string => `${ref.node}|${ref.ordinal}|${ref.name ?? ''}|${ref.anonymous === true ? 'a' : 'n'}`;
  const all = new Map<string, { ref: PortRef; peers: PortRef[] }>();
  for (const link of model.links) {
    if (!link.attachments || link.layer !== 'routed') continue;
    const { from, to } = link.attachments;
    for (const [a, b] of [[from, to], [to, from]] as const) {
      const entry = all.get(key(a)) ?? { ref: a, peers: [] };
      entry.peers.push(b); all.set(key(a), entry);
    }
  }
  for (const [name, entry] of all) if (entry.peers.length < 2 || entry.ref.anonymous === true || entry.ref.name === undefined) all.delete(name);
  return all;
}

/**
 * The facts of every attached routed link that a course could concern, by link id. A bundle member, a mesh-bus leg, a stub, a link to a bar and a
 * link to itself are the hard limits of the design (Section 4) and have no facts. The reader is one pass over the links and one over the groups.
 */
export function linkFacts(model: LayoutModel): Map<string, LinkFacts> {
  const units = bandUnits(model), facts = new Map<string, LinkFacts>();
  const shared = sharedPorts(model);
  const sharedKey = (ref: PortRef): string => `${ref.node}|${ref.ordinal}|${ref.name ?? ''}|${ref.anonymous === true ? 'a' : 'n'}`;
  for (const link of model.links) {
    if (link.layer !== 'routed' || !link.attachments || link.bundle !== undefined || link.meshBus !== undefined || link.technique === 'stub' || link.removed === true) continue;
    const { from: fromRef, to: toRef } = link.attachments;
    if (fromRef.node === toRef.node) continue;
    const from = endFacts(model, fromRef, units), to = endFacts(model, toRef, units);
    if (from === undefined || to === undefined) continue;
    if ([from.group, to.group].some(group => groupShape(model, group) === 'bar')) continue;
    const lo = Math.min(from.anchor.x, to.anchor.x), hi = Math.max(from.anchor.x, to.anchor.x);
    const crossed = transitTiers(model, link);
    const between: Unit[] = [];
    let sourceCovered = false;
    for (const tier of crossed) for (const unit of units.get(tier) ?? []) {
      if (overlaps(unit.box, lo, hi) || overlaps(unit.box, from.anchor.x, from.anchor.x + 1e-6)) between.push(unit);
      if (overlaps(unit.box, from.anchor.x - 1e-6, from.anchor.x + 1e-6)) sourceCovered = true;
    }
    if (from.tier === to.tier) for (const unit of units.get(from.tier) ?? []) {
      if (unit.id !== from.group && unit.id !== to.group && unit.box.x >= lo - 1e-6 && unit.box.x + unit.box.width <= hi + 1e-6) between.push(unit);
    }
    const row = from.group === to.group && !isGrid(model, from.group) ? model.groups[from.group]!.rowOrder ?? model.groups[from.group]!.nodes : [];
    const rowBetween = row.length > 0 && Math.abs(row.indexOf(from.node) - row.indexOf(to.node)) > 1;
    const triggers: Trigger[] = [];
    if (crossed.length > 0 && between.length > 0) triggers.push('T1');
    if (from.side === to.side && (from.side === 'top' || from.side === 'bottom') && Math.abs(from.tier - to.tier) <= 1) triggers.push('T2');
    if (from.tier === to.tier && (between.length > 0 || rowBetween)) triggers.push('T3');
    for (const ref of [fromRef, toRef]) {
      const entry = shared.get(sharedKey(ref));
      if (entry !== undefined && peerDirections(model, ref, entry.peers).size > 1) { triggers.push('T4'); break; }
    }
    facts.set(link.id, { link, from, to, crossed, between, sourceCovered, rowBetween, triggers });
  }
  return facts;
}
