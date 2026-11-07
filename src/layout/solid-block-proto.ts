import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { EPS, segmentDistance } from '../geometry/planar.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes, groupConsumers } from '../score/model.js';
import { findPort } from './row-paths.js';
import { moveBands } from './gap-room.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { fitRegionGroup } from './regions.js';
import { rebuildNodeGeometry } from './node-geometry.js';

export const BLOCK_ANGLE = 34;
export const BLOCK_CAP = 600;
const radians = BLOCK_ANGLE * Math.PI / 180;

/** PROTOTYPE: capacity is owned before resizing, never by the chord consumer. */
export function reserveBlockPitch(model: LayoutModel): void {
  for (const family of model.fanFamilies ?? []) {
    if (family.kind !== 'solid') continue;
    const links = model.links.filter(link => link.fanFamily === family.id);
    const pitch = Math.ceil((10 + Math.max(...links.map(linkStrokeWidth))) / Math.sin(radians));
    for (const link of links) for (const ref of Object.values(link.attachments!)) {
      const port = findPort(model, ref)!, node = model.nodes[ref.node]!;
      node.sidePitch![port.side!] = Math.max(node.sidePitch![port.side!]!, pitch);
    }
  }
}

/** A row of terminal one-link followers needs the newly widened block's spacing.
 * Seat that row before lanes, rather than asking 7c to stretch small hosts across it.
 * A mixed row, overlapping target, flank, or frame keeps its existing owner.
 */
export function seatBlockFollowers(model: LayoutModel): void {
  const far = new Set((model.fanFamilies ?? []).filter(family => family.kind === 'solid').flatMap(family => family.farNodes ?? []));
  if (!far.size) return;
  model.blockFollowers = [];
  for (const group of Object.values(model.groups)) {
    if (group.frame !== undefined || group.flank !== undefined || !group.nodes.length) continue;
    const plans = group.nodes.map(id => {
      const links = model.links.filter(link => link.attachments && Object.values(link.attachments).some(ref => ref.node === id));
      if (links.length !== 1) return undefined;
      const link = links[0]!;
      if (link.layer !== 'routed' || link.bundle !== undefined) return undefined;
      const refs = Object.values(link.attachments!), own = refs.find(ref => ref.node === id)!, parent = refs.find(ref => ref.node !== id);
      if (!parent || !far.has(parent.node)) return undefined;
      const a = findPort(model, parent)!, b = findPort(model, own)!;
      if (a.side !== 'bottom' || b.side !== 'top') return undefined;
      return { id, link: link.id, dx: a.anchor!.x - b.anchor!.x };
    });
    if (plans.some(plan => plan === undefined)) continue;
    const known = plans.filter(plan => plan !== undefined).sort((a, b) => model.nodes[a.id]!.bounds!.x + a.dx - model.nodes[b.id]!.bounds!.x - b.dx || a.id.localeCompare(b.id));
    if (known.some((plan, index) => index > 0 && model.nodes[plan.id]!.bounds!.x + plan.dx < model.nodes[known[index - 1]!.id]!.bounds!.x + known[index - 1]!.dx + model.nodes[known[index - 1]!.id]!.bounds!.width + 22)) continue;
    for (const plan of known) {
      const node = model.nodes[plan.id]!;
      node.bounds!.x += plan.dx;
      for (const port of node.ports) if (port.anchor) port.anchor.x += plan.dx;
      model.blockFollowers.push(plan.link);
    }
    fitRegionGroup(model, group);
  }
  rebuildNodeGeometry(model, Object.keys(model.nodes), 'current');
  rebuildBands(model);
}

/** Complete incidence ties use document order before the corridor/host orders. */
export function seatBlockOrder(model: LayoutModel): void {
  for (const family of model.fanFamilies ?? []) {
    if (family.kind !== 'solid') continue;
    const nodes = new Set([...family.hubs, ...family.farNodes!]);
    const groups = orderedGroupIds(model.document).filter(id => model.groups[id]?.nodes.some(node => nodes.has(node)));
    for (const id of groups) {
      const group = model.groups[id]!, order = orderedNodeIds(model.document).filter(node => group.nodes.includes(node));
      const old = [...group.nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x);
      const gap = old.length > 1 ? Math.min(...old.slice(1).map((node, i) => model.nodes[node]!.bounds!.x - model.nodes[old[i]!]!.bounds!.x - model.nodes[old[i]!]!.bounds!.width)) : 0;
      let x = Math.min(...old.map(node => model.nodes[node]!.bounds!.x));
      for (const node of order) {
        const item = model.nodes[node]!, dx = x - item.bounds!.x;
        item.bounds!.x = x;
        for (const port of item.ports) if (port.anchor) port.anchor.x += dx;
        x += item.bounds!.width + gap;
      }
      group.rowOrder = order;
    }
    const free = groups.filter(id => model.groups[id]!.frame === undefined && id !== family.group);
    if (free.length > 1) {
      const sorted = [...free].sort((a, b) => model.groups[a]!.bounds!.x - model.groups[b]!.bounds!.x);
      const gap = Math.min(...sorted.slice(1).map((id, i) => model.groups[id]!.bounds!.x - model.groups[sorted[i]!]!.bounds!.x - model.groups[sorted[i]!]!.bounds!.width));
      let x = model.groups[sorted[0]!]!.bounds!.x;
      for (const id of free) { const group = model.groups[id]!; moveGroup(model, group, x - group.bounds!.x, 0); x += group.bounds!.width + gap; }
    }
  }
  rebuildBands(model, false);
}

/** Final-x draft before the freeze. Replays after the freeze only read this record.
 * Angle and each facing-edge demand combine by max; shared gap demands also combine by max.
 * One read and one y move per draft; pitch has already fixed the x capacity.
 */
export function reserveBlockGaps(model: LayoutModel): void {
  if (model.frozenChords !== undefined || !model.fanFamilies?.some(family => family.kind === 'solid')) return;
  const grown = new Map<number, number>();
  model.blockReservations = [];
  for (const family of model.fanFamilies) {
    if (family.kind !== 'solid') continue;
    const links = model.links.filter(link => link.fanFamily === family.id);
    let target = 0, current = Infinity, above = Infinity, below = -Infinity;
    for (const link of links) {
      const ends = Object.values(link.attachments!).map(ref => ({ ref, port: findPort(model, ref)!, tier: model.groups[model.document.nodes[ref.node]!.group]!.tier! })).sort((a, b) => a.tier - b.tier);
      const upper = ends[0]!, lower = ends[1]!, a = upper.port.anchor!, b = lower.port.anchor!;
      above = upper.tier; below = lower.tier;
      const dx = Math.abs(b.x - a.x), dy = b.y - a.y;
      current = Math.min(current, dy); target = Math.max(target, dx * Math.tan(radians));
      for (const box of groupBoxes(model)) {
        const ownsUpper = groupConsumers(model, box.id).includes(link.id) && box.bounds.y <= a.y && box.bounds.y + box.bounds.height >= a.y;
        const ownsLower = groupConsumers(model, box.id).includes(link.id) && box.bounds.y <= b.y && box.bounds.y + box.bounds.height >= b.y;
        if (ownsUpper === ownsLower) continue;
        const port = ownsUpper ? a : b;
        const offset = ownsUpper ? box.bounds.y + box.bounds.height - a.y : b.y - box.bounds.y;
        const towardRight = ownsUpper ? b.x > a.x : a.x > b.x;
        const room = towardRight ? box.bounds.x + box.bounds.width - 10 - port.x : port.x - box.bounds.x - 10;
        if (offset > 0 && room > 0) target = Math.max(target, offset * dx / room);
      }
    }
    const chosen = Math.max(current, Math.min(target, BLOCK_CAP));
    model.blockReservations.push({ family: family.id, above, below, target, cap: BLOCK_CAP, chosen, capped: target > BLOCK_CAP + EPS,
      pitch: Math.ceil((10 + Math.max(...links.map(linkStrokeWidth))) / Math.sin(radians)) });
    grown.set(below, Math.max(grown.get(below) ?? 0, chosen - current));
  }
  if ([...grown.values()].some(value => value > EPS)) moveBands(model, grown);
}

/** Capped sheaves excuse only a local prefix at their shared node. The rest of
 * both chords still owes 10 px. Non-members and pairs without a shared node owe all of it.
 * The local zone is one shared body width from its face, fixed by placement capacity.
 */
export function blockSheafApart(model: LayoutModel, a: LayoutLink, b: LayoutLink, sa: PathSegment, sb: PathSegment): boolean {
  if (!a.solidBlock || !b.solidBlock || a.fanFamily !== b.fanFamily || !model.blockReservations?.some(item => item.family === a.fanFamily && item.capped)) return false;
  const family = model.fanFamilies?.find(item => item.id === a.fanFamily && item.kind === 'solid');
  if (!family || ![a, b].every(link => family.members.some(member => member.link === link.id))) return false;
  if (model.frozenChords !== undefined && ![a, b].every(link => model.fanAdmissions?.some(item => item.link === link.id && item.mode === 'straight') && link.path?.segments.length === 1)) return false;
  const shared = Object.values(a.attachments!).find(ref => Object.values(b.attachments!).some(other => other.node === ref.node));
  if (!shared) return false;
  const radius = Math.max(model.nodes[shared.node]!.bounds!.width, model.nodes[shared.node]!.bounds!.height);
  const trim = (link: LayoutLink, segment: PathSegment): PathSegment => {
    const near = link.attachments!.from.node === shared.node ? segment.from : segment.to;
    const far = near === segment.from ? segment.to : segment.from;
    const length = Math.hypot(far.x - near.x, far.y - near.y), t = Math.min(0.5, radius / length);
    return { ...segment, from: { x: near.x + t * (far.x - near.x), y: near.y + t * (far.y - near.y) }, to: far };
  };
  return segmentDistance(trim(a, sa), trim(b, sb)) - (linkStrokeWidth(a) + linkStrokeWidth(b)) / 2 >= 10 - EPS;
}

/** Read the stored floor; do not choose a new cap or boundary mode at publication. */
export function blockReservationsFault(model: LayoutModel): string | undefined {
  const families = model.fanFamilies?.filter(family => family.kind === 'solid') ?? [];
  if (!families.length || model.frozenChords === undefined) return undefined;
  if (model.blockReservations?.length !== families.length) return 'solid block reservation is missing';
  for (const id of model.blockFollowers ?? []) {
    const link = model.links.find(item => item.id === id);
    if (!link?.attachments) return `${id} lost its follower attachment`;
    const [a, b] = Object.values(link.attachments).map(ref => findPort(model, ref)?.anchor);
    if (!a || !b || Math.abs(a.x - b.x) > EPS) return `${id} lost its follower alignment`;
  }
  for (const family of families) {
    const record = model.blockReservations.find(item => item.family === family.id);
    if (!record || ![record.target, record.cap, record.chosen, record.pitch].every(Number.isFinite) || record.cap !== BLOCK_CAP
      || record.chosen + EPS < Math.min(record.target, record.cap) || record.capped !== (record.target > record.cap + EPS)) return `${family.id} has an unreadable reservation`;
    for (const member of family.members) {
      const link = model.links.find(item => item.id === member.link);
      if (!link?.attachments) return `${member.link} has no endpoints`;
      const ports = Object.values(link.attachments).map(ref => findPort(model, ref));
      if (ports.some(port => !port?.anchor)) return `${member.link} has no anchors`;
      const [a, b] = ports.map(port => port!.anchor!);
      if (Math.abs(b!.y - a!.y) + EPS < record.chosen) return `${member.link} lost its reserved gap`;
      if (!record.capped && Math.abs(b!.y - a!.y) + EPS < Math.abs(b!.x - a!.x) * Math.tan(radians)) return `${member.link} lost its reserved angle`;
    }
  }
  return undefined;
}
