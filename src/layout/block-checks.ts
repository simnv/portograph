import { chordBoxRefusal } from './chord-boxes.js';
import type { LayoutModel } from '../model/layout.js';
import { EPS } from '../geometry/planar.js';
import { findPort } from './row-paths.js';

export const BLOCK_ANGLE = 34;
export const BLOCK_CAP = 600;
const radians = BLOCK_ANGLE * Math.PI / 180;

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
    if (!record || ![record.target, record.cap, record.chosen, record.pitch].every(Number.isFinite) || record.cap !== BLOCK_CAP
      || record.chosen + EPS < Math.min(record.target, record.cap) || record.target > record.cap + EPS) return `${family.id} has an unreadable reservation`;
    for (const member of family.members) {
      const link = model.links.find(item => item.id === member.link);
      if (!link?.attachments) return `${member.link} has no endpoints`;
      const ports = Object.values(link.attachments).map(ref => findPort(model, ref));
      if (ports.some(port => !port?.anchor)) return `${member.link} has no anchors`;
      const ordered = [...ports].sort((a, b) => a!.anchor!.y - b!.anchor!.y);
      if (ordered[0]!.side !== 'bottom' || ordered[1]!.side !== 'top') return `${member.link} lost its horizontal block faces`;
      const [a, b] = ports.map(port => port!.anchor!);
      const entry = chordBoxRefusal(model, link, { from: a!, to: b!, owner: link.owner });
      if (entry) return `${member.link} lost its reserved box clearance (${entry})`;
      const upper = model.tierBands.find(band => band.tier === record.above)?.bounds;
      const lower = model.tierBands.find(band => band.tier === record.below)?.bounds;
      if (!upper || !lower || lower.y - upper.y - upper.height + EPS < record.chosen) return `${member.link} lost its reserved gap`;
      if (Math.abs(b!.y - a!.y) + EPS < Math.abs(b!.x - a!.x) * Math.tan(radians)) return `${member.link} lost its reserved angle`;
    }
  }
  return undefined;
}
