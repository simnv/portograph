import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { frameSubtreeCells, orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { EPS } from '../geometry/planar.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes } from '../score/model.js';
import { findPort } from './row-paths.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { addPairPitch } from './pair-pitch.js';
import { portId } from './skeleton-graph.js';

import { gatherPairs } from './bundle-ends.js';
import { bundleNeighboursOf } from './reservations.js';
import { SolidBlockRefusal } from './placement-refusal.js';
import { BLOCK_ANGLE, BLOCK_CAP, BLOCK_FLOOR_ANGLE, memberChord } from './block-checks.js';
const radians = BLOCK_ANGLE * Math.PI / 180, floorRadians = BLOCK_FLOOR_ANGLE * Math.PI / 180;

/**
 * Ticket 83: capacity is owned before resizing, never by the chord consumer. Dense-16x9 ticket 04 (slice 1): the pitch is a neighbour-pair
 * pitch of each member port (`block` in `LayoutNode.pairPitch`), kept from both its neighbours, not the pitch of the whole face, so the face
 * holds the sum of its pairs. A member port that does not stand on a top or bottom face raises the face pitch as before; the block declines it
 * (`non-facing-ports`).
 */
export function reserveBlockPitch(model: LayoutModel): void {
  for (const family of model.fanFamilies ?? []) {
    if (family.kind !== 'solid') continue;
    const links = model.links.filter(link => link.fanFamily === family.id);
    const pitch = blockPitch(links);
    for (const link of links) for (const ref of Object.values(link.attachments!)) {
      const port = findPort(model, ref)!, node = model.nodes[ref.node]!, side = port.side!;
      if (side === 'top' || side === 'bottom') addPairPitch(node, side, { rule: 'block', ports: [portId(ref)], min: pitch });
      else node.sidePitch![side] = Math.max(node.sidePitch![side]!, pitch);
    }
  }
}

/** The face pitch of a block (ticket 83): two neighbouring chords at the block angle keep the 10 px chord clearance and the widest stroke. */
export function blockPitch(links: readonly LayoutModel['links'][number][]): number {
  return Math.ceil((10 + Math.max(...links.map(linkStrokeWidth))) / Math.sin(radians));
}

/** A row of terminal one-link followers needs the newly widened block's spacing.
 * Seat that row before lanes, rather than asking 7c to stretch small hosts across it.
 * A mixed row, flank, or frame keeps its existing owner. Proposed rows are fitted together on a
 * draft; conflicting seats all decline before publication, including conflicts with unseated siblings.
 */
export function seatBlockFollowers(
  model: LayoutModel,
  fitRegionGroup: (model: LayoutModel, group: LayoutModel['groups'][string]) => void,
  conflicts: (before: LayoutModel, after: LayoutModel) => { owners: string[]; reason: string }[],
): void {
  const far = new Set((model.fanFamilies ?? []).filter(family => family.kind === 'solid').flatMap(family => family.farNodes ?? []));
  if (!far.size) return;
  model.blockFollowers = [];
  const draft = JSON.parse(JSON.stringify(model)) as LayoutModel;
  const seats = new Map<string, { id: string; link: string; dx: number }[]>();
  const decline = (id: string, reason: string): void => {
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'BLOCK_FOLLOWER_SEAT_DECLINED',
      message: `Follower seat for ${id} keeps its previous owner: ${reason}`, owners: [{ kind: 'group', id }] });
  };
  for (const { group, links } of terminalFollowerRows(model, far)) {
    const plans = links.map(({ id, link, own, parent }) => {
      const a = findPort(model, parent)!, b = findPort(model, own)!;
      return a.side === 'bottom' && b.side === 'top' ? { id, link, dx: a.anchor!.x - b.anchor!.x } : undefined;
    });
    if (plans.some(plan => plan === undefined)) continue;
    const known = plans.filter(plan => plan !== undefined).sort((a, b) => model.nodes[a.id]!.bounds!.x + a.dx - model.nodes[b.id]!.bounds!.x - b.dx || a.id.localeCompare(b.id));
    // Final tie-break: node id, after the proposed x coordinate.
    if (known.some((plan, index) => index > 0 && model.nodes[plan.id]!.bounds!.x + plan.dx < model.nodes[known[index - 1]!.id]!.bounds!.x + known[index - 1]!.dx + model.nodes[known[index - 1]!.id]!.bounds!.width + 22)) {
      decline(group.id, 'node-spacing');
      continue;
    }
    seats.set(group.id, known);
    for (const plan of known) {
      const node = draft.nodes[plan.id]!;
      node.bounds!.x += plan.dx;
      for (const port of node.ports) if (port.anchor) port.anchor.x += plan.dx;
    }
    rebuildNodeGeometry(draft, group.nodes, 'current');
    fitRegionGroup(draft, draft.groups[group.id]!);
  }
  // Joint refusal, never first-wins. Each round removes at least one seat; at most seats.size rounds.
  // Reverting a refused seat can obstruct a remaining one, so check the resulting set again.
  while (seats.size) {
    const broken = conflicts(model, draft);
    const refused = [...seats.keys()].filter(id => broken.some(item => item.owners.includes(`group:${id}`)));
    if (!refused.length) break;
    for (const id of refused) {
      const reasons = broken.filter(item => item.owners.includes(`group:${id}`)).map(item => item.reason).sort();
      decline(id, `sibling-spacing: ${reasons.join(', ')}`);
      seats.delete(id);
      draft.groups[id] = model.groups[id]!;
      for (const node of model.groups[id]!.nodes) draft.nodes[node] = model.nodes[node]!;
    }
  }
  for (const [id, plans] of seats) {
    model.groups[id]!.bounds = draft.groups[id]!.bounds!;
    for (const plan of plans) {
      const node = model.nodes[plan.id]!;
      node.bounds!.x += plan.dx;
      for (const port of node.ports) if (port.anchor) port.anchor.x += plan.dx;
      model.blockFollowers.push(plan.link);
    }
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
      // The declaration order breaks a tie of a complete block, and a bundle's two ends are no tie: a row that stage 4 recorded neighbours for keeps
      // them side by side (`bundleNeighbours`, R2). The record is read, never decided again (R1); the same gather the writer used seats them.
      const group = model.groups[id]!, kept = bundleNeighboursOf(model.reservations, id);
      const order = gatherPairs(orderedNodeIds(model.document).filter(node => group.nodes.includes(node)), kept);
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
    permuteGroupSlots(model, free);
    // Every free row that takes its order from the reordered groups follows in this step (dense-16x9 ticket 04, slice 3), tier by tier down.
    orderFedGroups(model, free);
  }
  rebuildBands(model, false);
}

/**
 * The free groups that take their order from groups this step reordered (`moved`): on the sub-tier directly below each moved group, every free
 * group (no frame, no flank) with a link of any layer, bundle or kind to a node of a moved group. Its feed key is the mean centre x of the
 * far ends of all its links into the sub-tier above, read on the group (not `orderByFeeds`' key, which reads the row positions of the routed feeds of frame cells); the fed groups take their tier's
 * slots in key order (group id breaks a tie) and foreign slots stay. The groups it turns are moved in their turn, so a row fed from them
 * follows too: one pass per sub-tier, at most the sub-tier count (R4). Frame cells and child frames follow through `orderByFeeds`, which
 * runs after this step; a canton keeps its author order (D1).
 */
function orderFedGroups(model: LayoutModel, moved: readonly string[]): void {
  let from = new Set(moved);
  for (let pass = 0, tiers = new Set(Object.values(model.groups).map(group => group.tier)).size; from.size && pass < tiers; pass++) {
    const nodes = new Set([...from].flatMap(id => model.groups[id]!.nodes));
    const above = new Set([...from].map(id => model.groups[id]!.tier!));
    const keys = new Map<string, number[]>();
    for (const link of model.links) {
      const ends = link.attachments ? [link.attachments.from.node, link.attachments.to.node] : [link.from.node, link.to.node];
      if (ends.some(end => end === undefined)) continue;
      for (const [own, far] of [[ends[0]!, ends[1]!], [ends[1]!, ends[0]!]] as const) {
        const group = model.groups[model.document.nodes[own]!.group]!, parent = model.groups[model.document.nodes[far]!.group]!;
        if (group.frame !== undefined || group.flank !== undefined || from.has(group.id) || !above.has(group.tier! - 1) || parent.tier !== group.tier! - 1) continue;
        const box = model.nodes[far]!.bounds!;
        (keys.get(group.id) ?? keys.set(group.id, []).get(group.id)!).push(box.x + box.width / 2);
      }
    }
    // A group with no link into a moved group keeps its slot.
    const fed = [...keys].filter(([id]) => model.links.some(link => {
      const ends = link.attachments ? [link.attachments.from.node, link.attachments.to.node] : [link.from.node, link.to.node];
      return ends.some(end => end !== undefined && model.document.nodes[end]!.group === id) && ends.some(end => end !== undefined && nodes.has(end));
    })).map(([id, xs]) => ({ id, key: xs.reduce((sum, x) => sum + x, 0) / xs.length }))
      .sort((a, b) => a.key - b.key || a.id.localeCompare(b.id)); // Final tie-break: group id.
    permuteGroupSlots(model, fed.map(item => item.id));
    from = new Set(fed.map(item => item.id));
  }
}

/** The same terminal rows are eligible for parent order at stage 4 and a facing-port seat at stage 5. */
function terminalFollowerRows(model: LayoutModel, far: ReadonlySet<string>) {
  return Object.values(model.groups).flatMap(group => {
    if (group.frame !== undefined || group.flank !== undefined || !group.nodes.length) return [];
    const links = group.nodes.map(id => {
      const attached = model.links.filter(link => link.attachments && Object.values(link.attachments).some(ref => ref.node === id));
      if (attached.length !== 1) return undefined;
      const link = attached[0]!;
      if (link.layer !== 'routed' || link.bundle !== undefined) return undefined;
      const refs = Object.values(link.attachments!), own = refs.find(ref => ref.node === id)!, parent = refs.find(ref => ref.node !== id);
      if (!parent || !far.has(parent.node) || group.tier! <= model.groups[model.document.nodes[parent.node]!.group]!.tier!) return undefined;
      return { id, link: link.id, own, parent };
    });
    return links.some(link => link === undefined) ? [] : [{ group, links: links.filter(link => link !== undefined) }];
  });
}

/** Permute participating slots in the whole tier, retaining foreign slots and its minimum gap. */
function permuteGroupSlots(model: LayoutModel, ids: readonly string[]): void {
  for (const tier of new Set(ids.map(id => model.groups[id]!.tier))) {
    const tied = ids.filter(id => model.groups[id]!.tier === tier);
    if (tied.length < 2) continue;
    const row = Object.values(model.groups).filter(group => group.tier === tier && group.flank === undefined)
      .sort((a, b) => a.bounds!.x - b.bounds!.x || a.id.localeCompare(b.id)); // Final tie-break: group id.
    const gaps = row.slice(1).map((group, i) => group.bounds!.x - row[i]!.bounds!.x - row[i]!.bounds!.width);
    let x = row[0]!.bounds!.x, index = 0;
    const order: LayoutGroup[] = row.map(group => tied.includes(group.id) ? model.groups[tied[index++]!]! : group);
    for (const group of order) {
      moveGroup(model, group, x - group.bounds!.x, 0);
      x += group.bounds!.width + Math.min(...gaps);
    }
  }
}

/**
 * The gap each solid block owes before the freeze. Replays after the freeze only read this record.
 * Angle and each facing-edge demand combine by max; shared gap demands also combine by max.
 * The initial draft and the mandatory-pack forecast each contribute one read and one y move; pitch already fixes x capacity.
 *
 * Past the cap (dense-16x9 ticket 04, slice 3): a block whose 34 degree demand passes `BLOCK_CAP` stays straight and flatter (`mode: 'flat'`). Its
 * floor is the demand that holds its flattest member at `BLOCK_FLOOR_ANGLE`. The gap stands at the floor, or at the gap the aspect choice of the
 * complete placement gave it (`flatBlockGaps`, chosen by `chooseFlatGaps` on a placement with every flat gap at its floor), clamped to the floor and
 * the 34 degree demand. Under-cap blocks that share a gap with a flat block keep their own floor (by max).
 */
export function reserveBlockGaps(model: LayoutModel, moveBands: (model: LayoutModel, growth: Map<number, number>) => void, geometry = model): void {
  if (model.frozenChords !== undefined || (geometry === model && model.blockReservations !== undefined) || !model.fanFamilies?.some(family => family.kind === 'solid')) return;
  const declined = new Map<string, string>();
  const demands: { family: string; above: number; below: number; steep: number; floor: number; gap: number; pitch: number }[] = [];
  model.blockReservations = [];
  for (const family of model.fanFamilies) {
    if (family.kind !== 'solid') continue;
    const links = model.links.filter(link => link.fanFamily === family.id);
    if (links.some(link => {
      const ports = Object.values(link.attachments!).map(ref => findPort(geometry, ref)!).sort((a, b) => a.anchor!.y - b.anchor!.y);
      return ports[0]!.side !== 'bottom' || ports[1]!.side !== 'top';
    })) { declined.set(family.id, 'non-facing-ports'); continue; }
    let steep = 0, floor = 0, above = Infinity, below = -Infinity;
    for (const link of links) {
      const ends = Object.values(link.attachments!).map(ref => ({ ref, port: findPort(geometry, ref)!, tier: model.groups[model.document.nodes[ref.node]!.group]!.tier! })).sort((a, b) => a.tier - b.tier);
      const upper = ends[0]!, lower = ends[1]!, a = upper.port.anchor!, b = lower.port.anchor!;
      above = upper.tier; below = lower.tier;
      const dx = Math.abs(b.x - a.x), dy = b.y - a.y;
      // The drawn chord runs face point to face point (`memberChord`; a named port's pill shortens its rise): the floor is read on it (R1).
      const drawn = memberChord(geometry, link), faceDy = drawn === undefined ? dy : Math.abs(drawn.to.y - drawn.from.y);
      const top = geometry.tierBands.find(band => band.tier === above)!.bounds!;
      const bottom = geometry.tierBands.find(band => band.tier === below)!.bounds!;
      const gap = bottom.y - top.y - top.height;
      // The endpoint boxes: a chord that leaves a box through its facing edge, not its side, owes this rise whatever its angle.
      let entry = 0;
      for (const box of groupBoxes(geometry)) {
        const cells = model.document.frames?.[box.id] ? frameSubtreeCells(model.document.frames, box.id) : [box.id];
        const ownsUpper = cells.includes(model.document.nodes[upper.ref.node]!.group);
        const ownsLower = cells.includes(model.document.nodes[lower.ref.node]!.group);
        if (ownsUpper === ownsLower) continue;
        const port = ownsUpper ? a : b;
        const offset = ownsUpper ? box.bounds.y + box.bounds.height - a.y : b.y - box.bounds.y;
        const towardRight = ownsUpper ? b.x > a.x : a.x > b.x;
        const room = towardRight ? box.bounds.x + box.bounds.width - GROUP_EDGE_LINK_CLEARANCE - port.x : port.x - box.bounds.x - GROUP_EDGE_LINK_CLEARANCE;
        if (offset > 0) entry = Math.max(entry, room > 0 ? offset * dx / room : Infinity);
      }
      // Each chord owes only the deficit beyond the height already inside its endpoint bands.
      // A member that no gap lets leave its box through the facing edge (an infinite entry) owes the angle only, and falls back alone (`chordBoxRefusal`).
      steep = Math.max(steep, Math.max(dx * Math.tan(radians), Number.isFinite(entry) ? entry : 0) - (dy - gap));
      // The floor is the angle alone: a member whose box entry asks more than the chosen gap falls back alone (`chordBoxRefusal`).
      floor = Math.max(floor, dx * Math.tan(floorRadians) - (faceDy - gap));
    }
    const originalTop = model.tierBands.find(band => band.tier === above)!.bounds!;
    const originalBottom = model.tierBands.find(band => band.tier === below)!.bounds!;
    demands.push({ family: family.id, above, below, steep, floor, gap: originalBottom.y - originalTop.y - originalTop.height, pitch: blockPitch(links) });
  }
  if (declined.size) throw new SolidBlockRefusal(declined);
  const flat = (item: typeof demands[number]): boolean => item.steep > BLOCK_CAP + EPS;
  // The mandatory gap of each tier gap: every under-cap block's 34 degree demand and every flat block's floor, by max.
  const mandatory = new Map<number, number>(), room = new Map<number, number>();
  for (const item of demands) mandatory.set(item.below, Math.max(mandatory.get(item.below) ?? item.gap, item.gap, flat(item) ? item.floor : item.steep));
  // The room of a flat gap: up to its 34 degree demand, box entries included.
  for (const item of demands) if (flat(item)) room.set(item.below, Math.max(room.get(item.below) ?? 0, item.steep - mandatory.get(item.below)!));
  // A flat gap stands at its floor, or at the gap the aspect choice of the complete placement gave it (`flatBlockGaps`, `chooseFlatGaps`),
  // never below the floor nor past the 34 degree demand of the gap.
  const gapOf = new Map(mandatory);
  for (const [below, value] of room) {
    const asked = Math.max(-Infinity, ...demands.filter(item => item.below === below && flat(item))
      .map(item => model.flatBlockGaps?.find(entry => entry.family === item.family)?.gap ?? -Infinity));
    if (Number.isFinite(asked)) gapOf.set(below, Math.min(mandatory.get(below)! + value, Math.max(mandatory.get(below)!, asked)));
  }
  const growth = new Map<number, number>();
  for (const item of demands) {
    const chosen = gapOf.get(item.below)!;
    model.blockReservations.push({ family: item.family, above: item.above, below: item.below, target: item.steep, cap: BLOCK_CAP, chosen, pitch: item.pitch,
      ...(flat(item) ? { mode: 'flat' as const, floor: item.floor } : {}) });
    growth.set(item.below, chosen - item.gap);
  }
  if ([...growth.values()].some(value => value > EPS)) moveBands(model, growth);
}
