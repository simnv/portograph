import type { PortRef } from '../model/document.js';
import type { Side } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel, LayoutPort } from '../model/layout.js';
import { orderedGroupIds, orderedNodeIds } from '../model/model.js';

/** Complete tie priority for direction votes and unused-port allocation. */
export const SIDE_TIE_ORDER: readonly Side[] = ['bottom', 'right', 'top', 'left'];
type Votes = Record<Side, number>;
const emptyVotes = (): Votes => ({ bottom: 0, right: 0, top: 0, left: 0 });
const portKey = (ref: PortRef): string => JSON.stringify([ref.node, ref.anonymous === true, ref.name, ref.ordinal]);

function winner(votes: Votes, fewest = false): Side {
  return SIDE_TIE_ORDER.reduce((best, side) =>
    (fewest ? votes[side] < votes[best] : votes[side] > votes[best]) ? side : best, 'bottom');
}

function tierSide(source: LayoutGroup, peer: LayoutGroup): Side | undefined {
  if (source.tier === undefined || peer.tier === undefined) throw new Error('Phase-one sides require resolved tiers');
  if (peer.tier > source.tier) return 'bottom';
  if (peer.tier < source.tier) return 'top';
  if (peer.flank !== undefined && source.flank === undefined) return peer.flank.align;
  if (source.flank !== undefined && peer.flank === undefined) return source.flank.align === 'left' ? 'right' : 'left';
  return undefined;
}

/** Assign semantic sides in place. Same-tier estimates affect capacity, never final topology. */
export function sidesOne(model: LayoutModel): LayoutModel {
  if (model.stage !== 'resolve') throw new Error('Phase-one sides require the resolve stage');
  const ports = new Map<string, { port: LayoutPort; known: Votes; predicted: Votes; unresolved: number; links: number }>();
  const rank = new Map<string, number>();
  for (const groupId of orderedGroupIds(model.document)) {
    for (const id of model.groups[groupId]!.nodes) rank.set(id, rank.size);
  }
  for (const id of orderedNodeIds(model.document)) {
    for (const port of model.nodes[id]!.ports) {
      ports.set(portKey(port.ref), { port, known: emptyVotes(), predicted: emptyVotes(), unresolved: 0, links: 0 });
    }
  }
  const count = (from: PortRef, to: PortRef): void => {
    const entry = ports.get(portKey(from));
    if (entry === undefined) throw new Error(`Missing resolved port on ${from.node}`);
    const source = model.groups[model.document.nodes[from.node]!.group]!;
    const peer = model.groups[model.document.nodes[to.node]!.group]!;
    const side = tierSide(source, peer);
    entry.links++;
    if (side !== undefined) {
      entry.known[side]++;
      entry.predicted[side]++;
    } else {
      entry.unresolved++;
      const predicted = rank.get(to.node)! < rank.get(from.node)! ? 'left' : 'right';
      entry.predicted[predicted]++;
    }
  };
  for (const link of model.links) {
    const from = link.attachments?.from ?? (link.from.node !== undefined ? link.from : undefined);
    const to = link.attachments?.to ?? (link.to.node !== undefined ? link.to : undefined);
    if (from === undefined || to === undefined) throw new Error('Phase-one sides require concrete link attachments');
    count(from, to);
    if (portKey(from) !== portKey(to)) count(to, from);
  }
  for (const id of orderedNodeIds(model.document)) {
    const node = model.nodes[id]!;
    const capacity = emptyVotes();
    const unused: LayoutPort[] = [];
    for (const port of node.ports) {
      const entry = ports.get(portKey(port.ref))!;
      if (entry.links === 0) port.unused = true;
      if (port.side !== undefined) {
        capacity[port.side]++;
      } else if (entry.links === 0) {
        unused.push(port);
      } else {
        const selected = winner(entry.known);
        // A known winner is safe only if either possible lateral total cannot displace it.
        const safe = entry.known[selected] > 0 && (['left', 'right'] as const).every(side =>
          winner({ ...entry.known, [side]: entry.known[side] + entry.unresolved }) === selected);
        if (safe) port.side = selected;
        else port.sizingSide = winner(entry.predicted);
        capacity[port.side ?? port.sizingSide!]++;
      }
    }
    for (const port of unused) {
      port.side = winner(capacity, true);
      capacity[port.side]++;
    }
  }
  model.stage = 'sides-one';
  return model;
}
