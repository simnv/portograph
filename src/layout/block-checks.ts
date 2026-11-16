import { chordBoxFaults, chordBoxRefusal } from './chord-boxes.js';
import { chordEnds } from './overlay-paths.js';
import type { Point } from '../model/geometry.js';
import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { findPort } from './row-paths.js';
import { facePairPitches } from './pair-pitch.js';
import { portId } from './skeleton-graph.js';

export const BLOCK_ANGLE = 34;
export const BLOCK_CAP = 600;
/** Past the cap a block stays straight and flatter, never flatter than this (owner ruling 2026-11-15). */
export const BLOCK_FLOOR_ANGLE = 15;

/** Whether `link` is a member of a flat solid block: it may leave its own box by a side edge (`chordBoxRefusal` with `sideExit`). */
export const flatMember = (model: LayoutModel, link: LayoutLink): boolean =>
  link.solidBlock === true && model.blockReservations?.find(item => item.family === link.fanFamily)?.mode === 'flat';

/**
 * The geometric tolerance of a solid-block reservation, in px (dense-16x9 ticket 31, review 1 ruling): how far a member may stand short of its
 * angle (read in px of height), its floor, or its box clearance and still hold it. The publication validator, the judge of a move
 * (`blockMoveRefusal`) and the judge of a step (`chordsHold`) read this one constant (R1); `EPS` stays a float compare. Why 0.01 px: the
 * block is reserved at exactly its demand, and the 7c passes that run after the freeze are an iterative solve, whose residue moves one end of
 * a member by 0.001 to 0.004 px. On the ticket 31 synthetic that left the chord 1.5e-4 to 2.4e-3 px of height short of 34 degrees, so a
 * drawn constraint cannot be held tighter than that. 0.01 px is about 4 times the largest dip measured, and invisible in the drawing.
 */
export const BLOCK_TOLERANCE = 0.01;

/** The height, in px, that a chord from `a` to `b` lacks to stand at `angle`: negative when it stands steeper (the one angle reading of a block member). */
export const angleShortfall = (a: Point, b: Point, angle: number): number =>
  Math.abs(b.x - a.x) * Math.tan(angle * Math.PI / 180) - Math.abs(b.y - a.y);

/**
 * The per-member checks of a flat block (dense-16x9 ticket 04, slice 3): past the cap a member stands only when its chord leaves each endpoint box
 * through the facing edge or the side edge it runs toward (`chordBoxRefusal` with `sideExit`: the reserved gap holds the floor angle, not every
 * box entry) and is no flatter than `BLOCK_FLOOR_ANGLE`. A member that fails falls back alone; the block stays. Undefined for a member of an
 * under-cap block, whose reservation holds both.
 */
export function flatMemberRefusal(model: LayoutModel, link: LayoutLink): 'edge' | 'frame' | 'floor' | undefined {
  if (!flatMember(model, link)) return undefined;
  // The chord as it is drawn, face point to face point (`memberChord`), as the floor reservation measured it (`reserveBlockGaps`; R1).
  const chord = memberChord(model, link);
  if (chord === undefined) return 'edge';
  // The admission decides with the float compare; the validator after it allows `BLOCK_TOLERANCE`, so what is admitted stays held.
  if (angleShortfall(chord.from, chord.to, BLOCK_FLOOR_ANGLE) > EPS) return 'floor';
  return chordBoxRefusal(model, link, { from: chord.from, to: chord.to, owner: link.owner }, 0, true);
}

/**
 * The chord a flat block member is drawn as: from the face point of one port to the face point of the other (`chordEnds`, the one end reader of
 * a placement chord and of a routed straight path; the anchor, or the outer edge of a named port's pill). The floor reservation, the admission
 * and the restore read this one segment (dense-16x9 ticket 04 slice 3, review 1, finding 1). Undefined where an end states no face.
 */
export function memberChord(model: LayoutModel, link: LayoutLink): { from: Point; to: Point } | undefined {
  const ends = chordEnds(model, link);
  return ends === undefined ? undefined : { from: { ...ends.head.face }, to: { ...ends.tail.face } };
}

/**
 * One fault of a solid-block reservation: what it breaks (`constraint`, one per fault of a key: the record, a follower's seat, attachment or
 * alignment, a member's faces, the pitch of each port, each box it does not clear, its gap or its angle), its message, and how far it is short
 * of the reservation (px; for an angle, the height the chord lacks; 0 for a fault with no measure, Infinity for one that cannot be measured).
 * A shortfall of the angle, the floor or the box clearance counts only past `BLOCK_TOLERANCE`.
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
    // Under the cap the gap holds the 34 degree demand; past it (flat) the gap holds the floor, which never passes the 34 degree demand.
    if (!entry || ![entry.target, entry.cap, entry.chosen, entry.pitch].every(Number.isFinite) || entry.cap !== BLOCK_CAP
      || (entry.mode === undefined ? entry.floor !== undefined || entry.chosen + EPS < entry.target || entry.target > entry.cap + EPS
        : entry.mode !== 'flat' || entry.floor === undefined || !Number.isFinite(entry.floor) || entry.target <= entry.cap + EPS
          || entry.floor > entry.target + EPS || entry.chosen + EPS < entry.floor)) { faults.set(family.id, [record(`${family.id} has an unreadable reservation`)]); continue; }
    const frozen = new Set(model.frozenChords);
    for (const member of family.members) {
      const found = memberFaults(model, member.link, entry, frozen.has(member.link));
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
 * The one judge of a move or a step after the freeze (dense-16x9 ticket 31, R1): the first block fault that `after` has and `before` (the
 * faults read where the move began, or the model it began on) did not have, or had and was less short of; undefined when the move breaks no
 * reservation and takes no broken one further from what it reserved. It is the validator after every judged move: each member stands within
 * `BLOCK_TOLERANCE` of its reservation after it, or, where a fault stood beyond the tolerance, that fault is no larger than before (a float
 * compare) and its key gains no other fault. So a residue inside the tolerance passes and no drift can add up past it. A move that touches
 * no block member adds no fault, so it is never refused here.
 */
export function blockMoveRefusal(before: BlockReading | LayoutModel, after: LayoutModel): { key: string; fault: string } | undefined {
  const faults = blockReservationFaults(after);
  if (!faults.size) return undefined;
  // The model the move began on is read only when the result has a fault: most moves leave none.
  const found = before instanceof Map ? before as BlockReading : blockReservationFaults(before as LayoutModel);
  for (const [key, list] of faults) {
    const stood = found.get(key);
    for (const fault of list) {
      const was = stood?.find(item => item.constraint === fault.constraint);
      if (was === undefined) return { key, fault: fault.fault };
      if (fault.short > was.short + EPS) return { key, fault: `${fault.fault}, further than before the move` };
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

function memberFaults(model: LayoutModel, id: string, entry: NonNullable<LayoutModel['blockReservations']>[number], straight: boolean): BlockFault[] {
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
  const boxes = (from: Point, to: Point, sideExit: boolean): void => {
    for (const box of chordBoxFaults(model, link, { from, to, owner: link.owner }, 0, sideExit)) {
      // A box clearance short by the tolerance or less holds; an edge the chord leaves by a face with no edge has no measure, and is a fault.
      if (box.short > BLOCK_TOLERANCE || box.constraint.endsWith(':face')) faults.push({ constraint: `box:${box.constraint}`, fault: `${id} lost its reserved box clearance (${box.entry})`, short: box.short });
    }
  };
  if (entry.mode === 'flat') {
    // A flat block holds the floor angle and box clearance on its straight members only, on the chord as drawn (`flatMemberRefusal`, the
    // admission's own check): a member that fell back owes neither.
    const chord = straight ? memberChord(model, link) : undefined;
    if (straight && chord === undefined) faults.push({ constraint: 'box:chord', fault: `${id} lost its reserved box clearance (edge)`, short: 0 });
    if (chord !== undefined) {
      const floor = angleShortfall(chord.from, chord.to, BLOCK_FLOOR_ANGLE);
      if (floor > BLOCK_TOLERANCE) faults.push({ constraint: 'angle', fault: `${id} lost its reserved angle`, short: floor });
      boxes(chord.from, chord.to, true);
    }
  } else boxes(a!, b!, false);
  const upper = model.tierBands.find(band => band.tier === entry.above)?.bounds;
  const lower = model.tierBands.find(band => band.tier === entry.below)?.bounds;
  const gap = upper && lower ? lower.y - upper.y - upper.height : -Infinity;
  if (gap + EPS < entry.chosen) faults.push({ constraint: 'gap', fault: `${id} lost its reserved gap`, short: Number.isFinite(gap) ? entry.chosen - gap : Infinity });
  const angle = entry.mode === undefined ? angleShortfall(a!, b!, BLOCK_ANGLE) : 0;
  if (angle > BLOCK_TOLERANCE) faults.push({ constraint: 'angle', fault: `${id} lost its reserved angle`, short: angle });
  return faults;
}
