import type { LayoutModel } from '../model/layout.js';
import { frameSubtreeCells, orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { EPS } from '../geometry/planar.js';
import { GROUP_EDGE_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { groupBoxes } from '../score/model.js';
import { findPort } from './row-paths.js';
import { moveGroup, rebuildBands } from './skeleton-geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';

import { SolidBlockRefusal } from './placement-refusal.js';
import { BLOCK_ANGLE, BLOCK_CAP } from './block-checks.js';
const radians = BLOCK_ANGLE * Math.PI / 180;

/** Ticket 83: capacity is owned before resizing, never by the chord consumer. */
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
export function seatBlockFollowers(model: LayoutModel, fitRegionGroup: (model: LayoutModel, group: LayoutModel['groups'][string]) => void): void {
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
      // Permute participating slots in the whole tier, retaining foreign slots and the minimum existing gap.
      // Packing only the block's units would temporarily occupy a foreign group's box.
      for (const tier of new Set(free.map(id => model.groups[id]!.tier))) {
        const tied = free.filter(id => model.groups[id]!.tier === tier);
        const row = Object.values(model.groups).filter(group => group.tier === tier && group.flank === undefined)
          .sort((a, b) => a.bounds!.x - b.bounds!.x || a.id.localeCompare(b.id));
        const gaps = row.slice(1).map((group, i) => group.bounds!.x - row[i]!.bounds!.x - row[i]!.bounds!.width);
        let x = row[0]!.bounds!.x, index = 0;
        const order = row.map(group => tied.includes(group.id) ? model.groups[tied[index++]!]! : group);
        for (const group of order) {
          moveGroup(model, group, x - group.bounds!.x, 0);
          x += group.bounds!.width + (gaps.length ? Math.min(...gaps) : 0);
        }
      }
    }
  }
  rebuildBands(model, false);
}

/** Final-x draft before the freeze. Replays after the freeze only read this record.
 * Angle and each facing-edge demand combine by max; shared gap demands also combine by max.
 * The initial draft and the mandatory-pack forecast each contribute one read and one y move; pitch already fixes x capacity.
 */
export function reserveBlockGaps(model: LayoutModel, moveBands: (model: LayoutModel, growth: Map<number, number>) => void, geometry = model): void {
  if (model.frozenChords !== undefined || (geometry === model && model.blockReservations !== undefined) || !model.fanFamilies?.some(family => family.kind === 'solid')) return;
  const grown = new Map<number, number>();
  const declined = new Map<string, string>();
  model.blockReservations = [];
  for (const family of model.fanFamilies) {
    if (family.kind !== 'solid') continue;
    const links = model.links.filter(link => link.fanFamily === family.id);
    if (links.some(link => {
      const ports = Object.values(link.attachments!).map(ref => findPort(geometry, ref)!).sort((a, b) => a.anchor!.y - b.anchor!.y);
      return ports[0]!.side !== 'bottom' || ports[1]!.side !== 'top';
    })) { declined.set(family.id, 'non-facing-ports'); continue; }
    let required = 0, above = Infinity, below = -Infinity, gap = 0;
    for (const link of links) {
      const ends = Object.values(link.attachments!).map(ref => ({ ref, port: findPort(geometry, ref)!, tier: model.groups[model.document.nodes[ref.node]!.group]!.tier! })).sort((a, b) => a.tier - b.tier);
      const upper = ends[0]!, lower = ends[1]!, a = upper.port.anchor!, b = lower.port.anchor!;
      above = upper.tier; below = lower.tier;
      const dx = Math.abs(b.x - a.x), dy = b.y - a.y;
      const top = geometry.tierBands.find(band => band.tier === above)!.bounds!;
      const bottom = geometry.tierBands.find(band => band.tier === below)!.bounds!;
      gap = bottom.y - top.y - top.height;
      let target = dx * Math.tan(radians);
      for (const box of groupBoxes(geometry)) {
        const cells = model.document.frames?.[box.id] ? frameSubtreeCells(model.document.frames, box.id) : [box.id];
        const ownsUpper = cells.includes(model.document.nodes[upper.ref.node]!.group);
        const ownsLower = cells.includes(model.document.nodes[lower.ref.node]!.group);
        if (ownsUpper === ownsLower) continue;
        const port = ownsUpper ? a : b;
        const offset = ownsUpper ? box.bounds.y + box.bounds.height - a.y : b.y - box.bounds.y;
        const towardRight = ownsUpper ? b.x > a.x : a.x > b.x;
        const room = towardRight ? box.bounds.x + box.bounds.width - GROUP_EDGE_LINK_CLEARANCE - port.x : port.x - box.bounds.x - GROUP_EDGE_LINK_CLEARANCE;
        if (offset > 0) target = Math.max(target, room > 0 ? offset * dx / room : Infinity);
      }
      // Each chord owes only the deficit beyond the height already inside its endpoint bands.
      required = Math.max(required, target - (dy - gap));
    }
    if (required > BLOCK_CAP + EPS) { declined.set(family.id, 'gap-cap: needs ' + required.toFixed(2) + ' px, cap ' + BLOCK_CAP + ' px'); continue; }
    const originalTop = model.tierBands.find(band => band.tier === above)!.bounds!;
    const originalBottom = model.tierBands.find(band => band.tier === below)!.bounds!;
    gap = originalBottom.y - originalTop.y - originalTop.height;
    const chosen = Math.max(gap, required);
    model.blockReservations.push({ family: family.id, above, below, target: required, cap: BLOCK_CAP, chosen,
      pitch: Math.ceil((10 + Math.max(...links.map(linkStrokeWidth))) / Math.sin(radians)) });
    grown.set(below, Math.max(grown.get(below) ?? 0, chosen - gap));
  }
  if (declined.size) throw new SolidBlockRefusal(declined);
  if ([...grown.values()].some(value => value > EPS)) moveBands(model, grown);
}


/** A conservative stage-5 cap bound: even zero inter-node gaps and optimal row translation
 * cannot place one hub face within 34 degrees of both ends of a wider complete row.
 * Endpoint band heights are credited in full, so this can only decline a provably over-cap block.
 */
export function declineOversizedBlocks(model: LayoutModel): void {
  const declined = new Map<string, string>();
  for (const family of model.fanFamilies ?? []) {
    if (family.kind !== 'solid') continue;
    const sides = [family.hubs, family.farNodes!];
    if (sides.some(ids => new Set(ids.map(id => model.groups[model.document.nodes[id]!.group]!.tier)).size !== 1)) continue;
    let span = 0;
    for (const [index, ids] of sides.entries()) {
      const widths = ids.map(id => model.nodes[id]!.size!.width).sort((a, b) => b - a);
      const interior = widths.slice(2).reduce((sum, width) => sum + width, 0);
      const face = Math.max(...sides[1 - index]!.map(id => model.nodes[id]!.size!.width));
      span = Math.max(span, (interior - face) / 2);
    }
    const tiers = sides.map(ids => model.groups[model.document.nodes[ids[0]!]!.group]!.tier!);
    const credit = tiers.reduce((sum, tier) => sum + model.tierBands.find(band => band.tier === tier)!.bounds!.height, 0);
    const floor = span * Math.tan(radians) - credit;
    if (floor > BLOCK_CAP + EPS) declined.set(family.id, `gap-cap: stage-5 lower bound ${floor.toFixed(2)} px, cap ${BLOCK_CAP} px`);
  }
  if (declined.size) throw new SolidBlockRefusal(declined);
}
