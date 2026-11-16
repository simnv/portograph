/**
 * The neighbour-pair pitch of a face (dense-16x9 ticket 04, slice 1). A face keeps its scalar `sidePitch` between every two ports that stand
 * side by side, and more between the pairs `LayoutNode.pairPitch` names: a pair the fan round measured (`fan`), or a member port of a complete
 * solid block with both its neighbours (`block`). The capacity of the face is the sum of its pair pitches, never the largest pair pitch times
 * the gaps. Every installer, alignment rule, trim and check reads the pitch of a pair through `neighbourPitch` and the room of a face through
 * `pairExcess` (R1: one predicate, one function).
 */
import type { PortRef, Side } from '../model/index.js';
import type { LayoutNode, LayoutPort, PairPitch } from '../model/layout.js';
import { portId } from './skeleton-graph.js';

/** The entries of one face; only the top and bottom faces carry pair pitches. */
export function facePairPitches(node: LayoutNode, side: Side): readonly PairPitch[] {
  return side === 'top' || side === 'bottom' ? node.pairPitch?.[side] ?? [] : [];
}

/** Whether `entry` binds the pair of the port keys `one` and `two` when they stand side by side. */
const binds = (entry: PairPitch, one: string, two: string): boolean => entry.rule === 'fan'
  ? (entry.ports[0] === one && entry.ports[1] === two) || (entry.ports[0] === two && entry.ports[1] === one)
  : entry.ports.includes(one) || entry.ports.includes(two);

/** The pitch two ports keep when they stand side by side on `side`: the face pitch, or the largest entry that binds them. */
export function neighbourPitch(node: LayoutNode, side: Side, a: PortRef, b: PortRef, pitch = node.sidePitch![side]!): number {
  const entries = facePairPitches(node, side);
  if (!entries.length) return pitch;
  const one = portId(a), two = portId(b);
  return entries.reduce((most, entry) => binds(entry, one, two) ? Math.max(most, entry.min) : most, pitch);
}

/**
 * The pitch of each step of a run of ports of one face, in the order given (a bundle's member ports at one end): the neighbour pitch of two
 * consecutive ports, or `pitch` where a port repeats (members that share a port). Only the pairs of the run are read, so a pair pitch of a member
 * with a port outside the run, or with a port that has left the face, reserves nothing here (dense-16x9 ticket 04, review 2).
 */
export function runPitches(node: LayoutNode, side: Side, refs: readonly PortRef[], pitch = node.sidePitch![side]!): number[] {
  return refs.slice(1).map((ref, index) => portId(ref) === portId(refs[index]!) ? pitch : neighbourPitch(node, side, refs[index]!, ref, pitch));
}

/**
 * The pitch the two end ports of a face keep to its ends, doubled (`portEndInsets` adds half of it to the padding): the face pitch, or the
 * largest block pitch of a member port on the face. A body end is a neighbour of the member port beside it, and the order of the face is not
 * known to sizing, so every end keeps it. A fan pair binds no end.
 */
export function endPitch(node: LayoutNode, side: Side, pitch = node.sidePitch![side]!): number {
  const entries = facePairPitches(node, side);
  if (!entries.length) return pitch;
  const onFace = new Set(node.ports.filter(port => (port.side ?? port.sizingSide) === side).map(port => portId(port.ref)));
  return entries.reduce((most, entry) => entry.ports.every(key => onFace.has(key)) ? Math.max(most, entry.min) : most, pitch);
}

/**
 * The running excess of each port of a face over `index * pitch`, for the ports in the order given: what the pair pitches before it add.
 * All zero on a face no pair pitch binds, so a reader that adds it to its `index * pitch` arithmetic keeps that arithmetic exact there.
 */
export function faceExcess(node: LayoutNode, side: Side, ports: readonly LayoutPort[], pitch = node.sidePitch![side]!): number[] {
  let excess = 0;
  return ports.map((port, index) => {
    if (index > 0) excess += neighbourPitch(node, side, ports[index - 1]!.ref, port.ref, pitch) - pitch;
    return excess;
  });
}

/** The offset of each port of a face from the first one, for the ports in the order given: the running sum of the neighbour pitches. */
export function faceOffsets(node: LayoutNode, side: Side, ports: readonly LayoutPort[], pitch = node.sidePitch![side]!): number[] {
  // `index * pitch` plus the running excess, so that a face no pair pitch binds keeps the exact offsets of the scalar pitch.
  return faceExcess(node, side, ports, pitch).map((excess, index) => index * pitch + excess);
}

/**
 * What the pair pitches of a face add to `count - 1` gaps at `pitch`, at most, in any order of its ports: sizing, the alignment allowance,
 * the trim and the publication check read it, so a body holds its face whatever order a later rule gives it. A fan pair stands side by side
 * in one gap at most, and a block port in two. Exact on a face whose entries are fan pairs of one order, or block ports on every port.
 */
export function pairExcess(node: LayoutNode, side: Side, count: number, pitch = node.sidePitch![side]!): number {
  const entries = facePairPitches(node, side);
  if (count < 2 || !entries.length) return 0;
  const onFace = new Set(node.ports.filter(port => (port.side ?? port.sizingSide) === side).map(port => portId(port.ref)));
  const fans = new Map<string, number>(), blocks = new Map<string, number>();
  for (const entry of entries) {
    const excess = entry.min - pitch;
    if (excess <= 0 || !entry.ports.every(key => onFace.has(key))) continue;
    if (entry.rule === 'fan') {
      const key = [...entry.ports].sort().join('|');
      fans.set(key, Math.max(fans.get(key) ?? 0, excess));
    } else blocks.set(entry.ports[0]!, Math.max(blocks.get(entry.ports[0]!) ?? 0, excess));
  }
  const largest = Math.max(0, ...fans.values(), ...blocks.values());
  const fanSum = [...fans.values()].reduce((sum, value) => sum + value, 0);
  // Each block port is the larger end of two gaps at most: the count - 1 largest of the doubled values bound their share.
  const blockSum = [...blocks.values(), ...blocks.values()].sort((a, b) => b - a).slice(0, count - 1).reduce((sum, value) => sum + value, 0);
  return Math.min((count - 1) * largest, fanSum + blockSum);
}

/**
 * Why the pair pitches of a node cannot be read, or undefined (R6): every entry names ports of the node, by rule, with a positive finite pitch,
 * and a face holds one entry for each rule and pair (the fan ports sorted). Validation and every restore ask it.
 */
export function pairPitchFault(node: LayoutNode): string | undefined {
  if (node.pairPitch === undefined) return undefined;
  const keys = new Set(node.ports.map(port => portId(port.ref)));
  for (const [side, entries] of Object.entries(node.pairPitch)) {
    if ((side !== 'top' && side !== 'bottom') || !Array.isArray(entries)) return `${node.id} has pair pitches on ${side}`;
    const seen = new Set<string>();
    for (const entry of entries) {
      const size = entry.rule === 'fan' ? 2 : entry.rule === 'block' ? 1 : 0;
      if (!size || !Array.isArray(entry.ports) || entry.ports.length !== size || new Set(entry.ports).size !== size
        || !entry.ports.every(key => keys.has(key)) || !Number.isFinite(entry.min) || entry.min <= 0) return `${node.id} has an unreadable pair pitch on ${side}`;
      // One entry for each rule and pair, with the ports of a fan pair sorted, as `addPairPitches` writes it: the readers read the first entry of
      // a pair (`fanEntry` keeps its place), so a record with two entries for one pair has no one reading (dense-16x9 ticket 04, review 3).
      const pair = `${entry.rule}\u0000${entry.ports.join('|')}`;
      if ((entry.rule === 'fan' && entry.ports[0]! > entry.ports[1]!) || seen.has(pair)) return `${node.id} has two pair pitches for one pair on ${side}`;
      seen.add(pair);
    }
  }
  return undefined;
}

/** Add `entry` to a face of `node`; an entry of the same rule and ports keeps the larger pitch. */
export function addPairPitch(node: LayoutNode, side: 'top' | 'bottom', entry: PairPitch): void {
  addPairPitches(node, side, [entry]);
}

/**
 * Add `entries` to a face of `node` in one merge (the one merge rule, R1): an entry of the same rule and ports keeps the larger pitch, and the
 * face is sorted once. Adding them one at a time gives the same record, but copies and sorts the face per entry: about quartic in the ports
 * of a face whose fan writes every pair (2.1 s at 100 ports, review 2 of ticket 04); in one merge it is the sort of the C(n, 2) entries.
 */
export function addPairPitches(node: LayoutNode, side: 'top' | 'bottom', entries: readonly PairPitch[]): void {
  const list = [...(node.pairPitch?.[side] ?? [])];
  const at = new Map(list.map((item, index) => [`${item.rule}\u0000${item.ports.join('|')}`, index]));
  for (const entry of entries) {
    const ports = entry.rule === 'fan' ? [...entry.ports].sort() : [...entry.ports];
    const key = `${entry.rule}\u0000${ports.join('|')}`, index = at.get(key);
    if (index !== undefined) list[index] = { ...list[index]!, min: Math.max(list[index]!.min, entry.min) };
    else { at.set(key, list.length); list.push({ rule: entry.rule, ports, min: entry.min }); }
  }
  // A content order, never the order the entries were added in (R3): the rule, then the port keys.
  list.sort((a, b) => a.rule.localeCompare(b.rule) || a.ports.join('|').localeCompare(b.ports.join('|')));
  node.pairPitch = { ...node.pairPitch, [side]: list };
}
