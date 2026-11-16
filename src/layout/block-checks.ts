import { chordBoxRefusal } from './chord-boxes.js';
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
const radians = BLOCK_ANGLE * Math.PI / 180, floorRadians = BLOCK_FLOOR_ANGLE * Math.PI / 180;

/**
 * The per-member checks of a flat block (dense-16x9 ticket 04, slice 3): past the cap a member stands only when its chord leaves each endpoint box
 * through the facing edge or the side edge it runs toward (`chordBoxRefusal` with `sideExit`: the reserved gap holds the floor angle, not every
 * box entry) and is no flatter than
 * `BLOCK_FLOOR_ANGLE`. A member that fails falls back alone; the block stays. Undefined for a member of an under-cap block, whose reservation holds both.
 */
/** Whether `link` is a member of a flat solid block: it may leave its own box by a side edge (`chordBoxRefusal` with `sideExit`). */
export const flatMember = (model: LayoutModel, link: LayoutLink): boolean =>
  link.solidBlock === true && model.blockReservations?.find(item => item.family === link.fanFamily)?.mode === 'flat';

export function flatMemberRefusal(model: LayoutModel, link: LayoutLink): 'edge' | 'frame' | 'floor' | undefined {
  if (!flatMember(model, link)) return undefined;
  // The chord as it is drawn, face point to face point (`memberChord`), as the floor reservation measured it (`reserveBlockGaps`; R1).
  const chord = memberChord(model, link);
  if (chord === undefined) return 'edge';
  const { from: a, to: b } = chord;
  if (Math.abs(b.y - a.y) + EPS < Math.abs(b.x - a.x) * Math.tan(floorRadians)) return 'floor';
  return chordBoxRefusal(model, link, { from: a, to: b, owner: link.owner }, 0, true);
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

/** Read the stored floor; do not choose a new cap or boundary mode at publication. */
export function blockReservationsFault(model: LayoutModel): string | undefined {
  const families = model.fanFamilies?.filter(family => family.kind === 'solid') ?? [];
  if (!families.length || model.frozenChords === undefined) return undefined;
  if (model.blockReservations?.length !== families.length) return 'solid block reservation is missing';
  if (model.blockFollowers !== undefined && model.frozenBlockFollowers === undefined) return 'solid block follower freeze is missing';
  for (const id of model.frozenBlockFollowers ?? []) {
    if (!model.blockFollowers?.includes(id)) return `${id} has no follower seat`;
    const link = model.links.find(item => item.id === id);
    if (!link?.attachments) return `${id} lost its follower attachment`;
    const [a, b] = Object.values(link.attachments).map(ref => findPort(model, ref)?.anchor);
    if (!a || !b || Math.abs(a.x - b.x) > EPS) return `${id} lost its follower alignment`;
  }
  for (const family of families) {
    const record = model.blockReservations.find(item => item.family === family.id);
    if (!record || ![record.target, record.cap, record.chosen, record.pitch].every(Number.isFinite) || record.cap !== BLOCK_CAP) return `${family.id} has an unreadable reservation`;
    // Under the cap the gap holds the 34 degree demand; past it (flat) the gap holds the floor, which never passes the 34 degree demand.
    if (record.mode === undefined ? record.floor !== undefined || record.chosen + EPS < record.target || record.target > record.cap + EPS
      : record.mode !== 'flat' || record.floor === undefined || !Number.isFinite(record.floor) || record.target <= record.cap + EPS
        || record.floor > record.target + EPS || record.chosen + EPS < record.floor) return `${family.id} has an unreadable reservation`;
    const frozen = new Set(model.frozenChords);
    for (const member of family.members) {
      const link = model.links.find(item => item.id === member.link);
      if (!link?.attachments) return `${member.link} has no endpoints`;
      const ports = Object.values(link.attachments).map(ref => findPort(model, ref));
      if (ports.some(port => !port?.anchor)) return `${member.link} has no anchors`;
      const ordered = [...ports].sort((a, b) => a!.anchor!.y - b!.anchor!.y);
      if (ordered[0]!.side !== 'bottom' || ordered[1]!.side !== 'top') return `${member.link} lost its horizontal block faces`;
      // Each member port keeps the block pitch from both neighbours (dense-16x9 ticket 04): the stored pair pitch, never a pitch read again.
      for (const port of ordered) {
        const key = portId(port!.ref), node = model.nodes[port!.ref.node]!;
        if (!facePairPitches(node, port!.side!).some(entry => entry.rule === 'block' && entry.ports[0] === key && entry.min >= record.pitch)) {
          return `${member.link} lost its block pitch`;
        }
      }
      const [a, b] = ports.map(port => port!.anchor!);
      // A flat block holds box clearance and the floor angle on its straight members only (`flatMemberRefusal`, the admission's own check): a
      // member that fell back owes neither.
      if (record.mode === 'flat') {
        const refusal = frozen.has(member.link) ? flatMemberRefusal(model, link) : undefined;
        if (refusal === 'floor') return `${member.link} lost its reserved angle`;
        if (refusal) return `${member.link} lost its reserved box clearance (${refusal})`;
      } else {
        const entry = chordBoxRefusal(model, link, { from: a!, to: b!, owner: link.owner });
        if (entry) return `${member.link} lost its reserved box clearance (${entry})`;
      }
      const upper = model.tierBands.find(band => band.tier === record.above)?.bounds;
      const lower = model.tierBands.find(band => band.tier === record.below)?.bounds;
      if (!upper || !lower || lower.y - upper.y - upper.height + EPS < record.chosen) return `${member.link} lost its reserved gap`;
      if (record.mode === undefined && Math.abs(b!.y - a!.y) + EPS < Math.abs(b!.x - a!.x) * Math.tan(radians)) return `${member.link} lost its reserved angle`;
    }
  }
  return undefined;
}
