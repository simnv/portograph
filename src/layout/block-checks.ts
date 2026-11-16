import { chordBoxFaults } from './chord-boxes.js';
import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { findPort } from './row-paths.js';
import { facePairPitches } from './pair-pitch.js';
import { portId } from './skeleton-graph.js';

export const BLOCK_ANGLE = 34;
export const BLOCK_CAP = 600;
const radians = BLOCK_ANGLE * Math.PI / 180;

/**
 * One fault of a solid-block reservation: what it breaks (`constraint`, one per fault of a key: the record, a follower's seat, attachment or
 * alignment, a member's faces, the pitch of each port, each box it does not clear, its gap or its angle), its message, and how far it is short
 * of the reservation (px, or degrees for the angle; 0 for a fault with no measure, Infinity for one that cannot be measured).
 */
export interface BlockFault { readonly constraint: string; readonly fault: string; readonly short: number }

/** The faults of the solid-block reservations on a model (`blockReservationFaults`), keyed by what they are about. */
export type BlockReading = ReadonlyMap<string, readonly BlockFault[]>;

/**
 * Every fault of the solid-block reservations on `model`, keyed by what it is about, in reading order: `''` for the record as a whole (then
 * nothing else is read), a follower's link id, a family id for an unreadable reservation (then its members are not read), and a member's
 * link id with all its faults, the first first. Empty before the freeze. Read the stored floor; do not choose a new cap or boundary mode at
 * publication.
 */
export function blockReservationFaults(model: LayoutModel): Map<string, BlockFault[]> {
  const faults = new Map<string, BlockFault[]>();
  const families = model.fanFamilies?.filter(family => family.kind === 'solid') ?? [];
  if (!families.length || model.frozenChords === undefined) return faults;
  if (model.blockReservations?.length !== families.length) return faults.set('', [record('solid block reservation is missing')]);
  if (model.blockFollowers !== undefined && model.frozenBlockFollowers === undefined) return faults.set('', [record('solid block follower freeze is missing')]);
  for (const id of model.frozenBlockFollowers ?? []) {
    const fault = followerFault(model, id);
    if (fault !== undefined) faults.set(id, [fault]);
  }
  for (const family of families) {
    const entry = model.blockReservations.find(item => item.family === family.id);
    if (!entry || ![entry.target, entry.cap, entry.chosen, entry.pitch].every(Number.isFinite) || entry.cap !== BLOCK_CAP
      || entry.chosen + EPS < Math.min(entry.target, entry.cap) || entry.target > entry.cap + EPS) { faults.set(family.id, [record(`${family.id} has an unreadable reservation`)]); continue; }
    for (const member of family.members) {
      const found = memberFaults(model, member.link, entry);
      if (found.length && !faults.has(member.link)) faults.set(member.link, found);
    }
  }
  return faults;
}

/** The first fault of the solid-block reservations on `model` (`blockReservationFaults`), or undefined when they hold. */
export function blockReservationsFault(model: LayoutModel): string | undefined {
  return blockReservationFaults(model).values().next().value?.[0]?.fault;
}

/**
 * The one judge of a move after the freeze (dense-16x9 ticket 31, R1): the first block fault that `after` has and `before` (the faults read
 * where the move began, or the model it began on) did not have, or had and was less short of; undefined when the move breaks no reservation
 * and takes no broken one further from what it reserved. The faults are compared per key and constraint: a fault that stood when the move
 * began may stay or heal, never grow, and its key gains no other fault. A move that touches no block member adds no fault, so it is never
 * refused here.
 * With `step` set the move is one step of a mover whose whole result is judged again (a translation that `chordsHold` reads inside a centring
 * pass): a fault that stood may grow there, since one step moves one row of a block and the next the other; a new fault is still refused.
 */
export function blockMoveRefusal(before: BlockReading | LayoutModel, after: LayoutModel, step = false): { key: string; fault: string } | undefined {
  const faults = blockReservationFaults(after);
  if (!faults.size) return undefined;
  // The model the move began on is read only when the result has a fault: most moves leave none.
  const found = before instanceof Map ? before as BlockReading : blockReservationFaults(before as LayoutModel);
  for (const [key, list] of faults) {
    const stood = found.get(key);
    for (const fault of list) {
      const was = stood?.find(item => item.constraint === fault.constraint);
      if (was === undefined) return { key, fault: fault.fault };
      if (!step && fault.short > was.short + EPS) return { key, fault: `${fault.fault}, further than before the move` };
    }
  }
  return undefined;
}

const record = (fault: string): BlockFault => ({ constraint: 'record', fault, short: 0 });

function followerFault(model: LayoutModel, id: string): BlockFault | undefined {
  if (!model.blockFollowers?.includes(id)) return { constraint: 'seat', fault: `${id} has no follower seat`, short: 0 };
  const link = model.links.find(item => item.id === id);
  if (!link?.attachments) return { constraint: 'attachment', fault: `${id} lost its follower attachment`, short: 0 };
  const [a, b] = Object.values(link.attachments).map(ref => findPort(model, ref)?.anchor);
  if (!a || !b) return { constraint: 'alignment', fault: `${id} lost its follower alignment`, short: Infinity };
  if (Math.abs(a.x - b.x) > EPS) return { constraint: 'alignment', fault: `${id} lost its follower alignment`, short: Math.abs(a.x - b.x) };
  return undefined;
}

function memberFaults(model: LayoutModel, id: string, entry: NonNullable<LayoutModel['blockReservations']>[number]): BlockFault[] {
  const link = model.links.find(item => item.id === id);
  if (!link?.attachments) return [{ constraint: 'endpoints', fault: `${id} has no endpoints`, short: 0 }];
  const ports = Object.values(link.attachments).map(ref => findPort(model, ref));
  if (ports.some(port => !port?.anchor)) return [{ constraint: 'anchors', fault: `${id} has no anchors`, short: 0 }];
  const faults: BlockFault[] = [];
  const ordered = [...ports].sort((a, b) => a!.anchor!.y - b!.anchor!.y);
  if (ordered[0]!.side !== 'bottom' || ordered[1]!.side !== 'top') faults.push({ constraint: 'faces', fault: `${id} lost its horizontal block faces`, short: 0 });
  // Each member port keeps the block pitch from both neighbours (dense-16x9 ticket 04): the stored pair pitch, never a pitch read again.
  for (const port of ordered) {
    const key = portId(port!.ref), node = model.nodes[port!.ref.node]!;
    const held = facePairPitches(node, port!.side!).filter(pair => pair.rule === 'block' && pair.ports[0] === key).map(pair => pair.min);
    const pitch = held.length ? Math.max(...held) : -Infinity;
    if (!(pitch >= entry.pitch)) faults.push({ constraint: `pitch:${key}`, fault: `${id} lost its block pitch`, short: Number.isFinite(pitch) ? entry.pitch - pitch : Infinity });
  }
  const [a, b] = ports.map(port => port!.anchor!);
  for (const box of chordBoxFaults(model, link, { from: a!, to: b!, owner: link.owner })) {
    faults.push({ constraint: `box:${box.constraint}`, fault: `${id} lost its reserved box clearance (${box.entry})`, short: box.short });
  }
  const upper = model.tierBands.find(band => band.tier === entry.above)?.bounds;
  const lower = model.tierBands.find(band => band.tier === entry.below)?.bounds;
  const gap = upper && lower ? lower.y - upper.y - upper.height : -Infinity;
  if (gap + EPS < entry.chosen) faults.push({ constraint: 'gap', fault: `${id} lost its reserved gap`, short: Number.isFinite(gap) ? entry.chosen - gap : Infinity });
  const dx = Math.abs(b!.x - a!.x), dy = Math.abs(b!.y - a!.y);
  if (dy + EPS < dx * Math.tan(radians)) faults.push({ constraint: 'angle', fault: `${id} lost its reserved angle`, short: BLOCK_ANGLE - Math.atan2(dy, dx) * 180 / Math.PI });
  return faults;
}
