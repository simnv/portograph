import { chordBoxRefusal } from './chord-boxes.js';
import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { findPort } from './row-paths.js';
import { facePairPitches } from './pair-pitch.js';
import { portId } from './skeleton-graph.js';

export const BLOCK_ANGLE = 34;
export const BLOCK_CAP = 600;
const radians = BLOCK_ANGLE * Math.PI / 180;

/**
 * Every fault of the solid-block reservations on `model`, keyed by what it is about, in reading order: `''` for the record as a whole (then
 * nothing else is read), a follower's link id, a family id for an unreadable reservation (then its members are not read), and a member's
 * link id with its first fault. Empty before the freeze. Read the stored floor; do not choose a new cap or boundary mode at publication.
 */
export function blockReservationFaults(model: LayoutModel): Map<string, string> {
  const faults = new Map<string, string>();
  const families = model.fanFamilies?.filter(family => family.kind === 'solid') ?? [];
  if (!families.length || model.frozenChords === undefined) return faults;
  if (model.blockReservations?.length !== families.length) return faults.set('', 'solid block reservation is missing');
  if (model.blockFollowers !== undefined && model.frozenBlockFollowers === undefined) return faults.set('', 'solid block follower freeze is missing');
  for (const id of model.frozenBlockFollowers ?? []) {
    const fault = followerFault(model, id);
    if (fault !== undefined) faults.set(id, fault);
  }
  for (const family of families) {
    const record = model.blockReservations.find(item => item.family === family.id);
    if (!record || ![record.target, record.cap, record.chosen, record.pitch].every(Number.isFinite) || record.cap !== BLOCK_CAP
      || record.chosen + EPS < Math.min(record.target, record.cap) || record.target > record.cap + EPS) { faults.set(family.id, `${family.id} has an unreadable reservation`); continue; }
    for (const member of family.members) {
      const fault = memberFault(model, member.link, record);
      if (fault !== undefined && !faults.has(member.link)) faults.set(member.link, fault);
    }
  }
  return faults;
}

/** The first fault of the solid-block reservations on `model` (`blockReservationFaults`), or undefined when they hold. */
export function blockReservationsFault(model: LayoutModel): string | undefined {
  return blockReservationFaults(model).values().next().value;
}

/**
 * The one judge of a move after the freeze (dense-16x9 ticket 31, R1): the first block fault that `after` has and `before` (the faults read
 * where the move began, or the model it began on) did not, keyed by what it is about; undefined when the move leaves every reservation it found holding. A move that
 * touches no block member adds no fault, so it is never refused here.
 */
export function blockMoveRefusal(before: ReadonlyMap<string, string> | LayoutModel, after: LayoutModel): { key: string; fault: string } | undefined {
  const faults = blockReservationFaults(after);
  if (!faults.size) return undefined;
  // The model the move began on is read only when the result has a fault: most moves leave none.
  const found = before instanceof Map ? before : blockReservationFaults(before as LayoutModel);
  for (const [key, fault] of faults) if (!found.has(key)) return { key, fault };
  return undefined;
}

function followerFault(model: LayoutModel, id: string): string | undefined {
  if (!model.blockFollowers?.includes(id)) return `${id} has no follower seat`;
  const link = model.links.find(item => item.id === id);
  if (!link?.attachments) return `${id} lost its follower attachment`;
  const [a, b] = Object.values(link.attachments).map(ref => findPort(model, ref)?.anchor);
  if (!a || !b || Math.abs(a.x - b.x) > EPS) return `${id} lost its follower alignment`;
  return undefined;
}

function memberFault(model: LayoutModel, id: string, record: NonNullable<LayoutModel['blockReservations']>[number]): string | undefined {
  const link = model.links.find(item => item.id === id);
  if (!link?.attachments) return `${id} has no endpoints`;
  const ports = Object.values(link.attachments).map(ref => findPort(model, ref));
  if (ports.some(port => !port?.anchor)) return `${id} has no anchors`;
  const ordered = [...ports].sort((a, b) => a!.anchor!.y - b!.anchor!.y);
  if (ordered[0]!.side !== 'bottom' || ordered[1]!.side !== 'top') return `${id} lost its horizontal block faces`;
  // Each member port keeps the block pitch from both neighbours (dense-16x9 ticket 04): the stored pair pitch, never a pitch read again.
  for (const port of ordered) {
    const key = portId(port!.ref), node = model.nodes[port!.ref.node]!;
    if (!facePairPitches(node, port!.side!).some(entry => entry.rule === 'block' && entry.ports[0] === key && entry.min >= record.pitch)) return `${id} lost its block pitch`;
  }
  const [a, b] = ports.map(port => port!.anchor!);
  const entry = chordBoxRefusal(model, link, { from: a!, to: b!, owner: link.owner });
  if (entry) return `${id} lost its reserved box clearance (${entry})`;
  const upper = model.tierBands.find(band => band.tier === record.above)?.bounds;
  const lower = model.tierBands.find(band => band.tier === record.below)?.bounds;
  if (!upper || !lower || lower.y - upper.y - upper.height + EPS < record.chosen) return `${id} lost its reserved gap`;
  if (Math.abs(b!.y - a!.y) + EPS < Math.abs(b!.x - a!.x) * Math.tan(radians)) return `${id} lost its reserved angle`;
  return undefined;
}
