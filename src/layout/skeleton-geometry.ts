import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { Rect } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel } from '../model/layout.js';
import { orderedGroupIds } from '../model/model.js';
import { bandGap, tierGapMin, compareId, greatestPeers, groupId, nodeGap, nodeId, portId, SKELETON_SPACING as spacing } from './skeleton-graph.js';
import { isGridGroup, packGrid } from './grid.js';
import { deriveFrames, rebuildFrames } from './frames.js';
import { seatLifts } from './lift.js';
import { packFrameColumns, type Column } from './columns.js';
import { GROUP_PADDING } from './regions.js';
import { bottom, contains as rectContains, EPS, rectOverlap, right } from '../geometry/planar.js';

/**
 * The same comparators the published gates use, at the same tolerance. `gates.ts:107` has always
 * answered "is this group inside its tier band?" with the tolerant `contains` (G1
 * `group-containment`, G8 `group-tier`), and `gates.ts:113` "do these two groups overlap?" with
 * `rectOverlap`. This file used to answer both questions with exact local copies, so stage 4 refused
 * geometry the published gate accepts. Stress ticket 13 removed that divergence rather than
 * loosening a rule.
 *
 * It mattered because a band kept `x` and `width = max(right) - x`: reading its right edge back as
 * `x + width` lost up to one ULP — 4.547473508864641e-13 at the 3 271.71 px right edge of
 * `goldens/synthetic/a-band-holds-the-group-that-set-its-edge.yaml` — so an exact `contains` refused
 * the very group the band was built from. `span` below removes that residue at the producer, so the
 * band this file emits now contains its own rightmost group with no tolerance spent (stress ticket
 * 14). The tolerance here stays: `fitRegionGroup`, `fitGroupBox` and `bars` still recover a group
 * width from an absolute edge, and this comparator does not own them.
 *
 * What the tolerance costs the two guards here: 1e-7 px is seven orders of magnitude under the
 * smallest distance any placement rule names (1 px, `goldens/synthetic/one-px-sources.yaml`). A node
 * ELK really placed outside its group, or two groups that really overlap, do so by a placement
 * distance, so neither guard can now pass what it used to refuse — only residues no rule could have
 * produced. (`validateGeometry` in `mutation.ts` is a weaker precedent than the gates: it allows 1e-6 on the right and
 * bottom edges only and still compares left and top exactly.)
 */
const contains = rectContains, overlaps = rectOverlap;
const validRect = (r: Rect | undefined): r is Rect => r !== undefined && Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0;
const bits = new DataView(new ArrayBuffer(8));
/** The next double above `value`; `value` itself when there is none (zero and the infinities). */
function nextUp(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
/**
 * The width a box at `x` needs to reach `edge`. `edge - x` is not always it: a rectangle kept as
 * `x` and `width` is read back through `x + width`, and the difference of two absolute edges can
 * round down, leaving the box one ULP short of the box it was built from. The residue grows with
 * the coordinate and the span. One step up is the smallest width that really reaches `edge`
 * (stress ticket 14; ticket 13 measured the same residue through `contains`).
 */
export const span = (x: number, edge: number): number => {
  const width = edge - x;
  return x + width < edge ? nextUp(width) : width;
};
export function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 2 * spacing.padding, height: 2 * spacing.padding };
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: span(x, Math.max(...rects.map(right))), height: span(y, Math.max(...rects.map(bottom))) };
}
function elkRect(node: ElkNode): Rect {
  const rect = { x: node.x!, y: node.y!, width: node.width!, height: node.height! };
  if (!validRect(rect)) throw new Error(`ELK omitted finite positive bounds for ${node.id}`);
  return rect;
}

/** ROOT ports are already absolute. Do not add the node or compound offsets a second time. */
export function readSkeleton(model: LayoutModel, result: ElkNode, tier?: number): void {
  const groups = new Map(result.children?.map(group => [group.id, group]));
  for (const group of Object.values(model.groups)) {
    if (group.flank || (tier !== undefined && group.tier !== tier)) continue;
    const placed = groups.get(groupId(group.id));
    if (!placed) throw new Error(`ELK omitted group ${group.id}`);
    group.bounds = elkRect(placed);
    const children = new Map(placed.children?.map(node => [node.id, node]));
    for (const id of group.nodes) {
      const node = model.nodes[id]!, child = children.get(nodeId(id));
      if (!child) throw new Error(`ELK omitted node ${id}`);
      const rect = elkRect(child);
      if (rect.width < node.size!.width || rect.height < node.size!.height) throw new Error(`ELK shrank measured node ${id}`);
      if (!contains(group.bounds, rect)) throw new Error(`ELK placed node ${id} outside group ${group.id}`);
      node.bounds = rect;
      node.size = { width: rect.width, height: rect.height };
      const ports = new Map(child.ports?.map(port => [port.id, port]));
      for (const port of node.ports) {
        const placedPort = ports.get(portId(port.ref));
        if (placedPort && Number.isFinite(placedPort.x) && Number.isFinite(placedPort.y)) {
          port.anchor = { x: placedPort.x! + (placedPort.width ?? 0) / 2, y: placedPort.y! + (placedPort.height ?? 0) / 2 };
        }
      }
    }
    group.rowOrder = [...group.nodes].sort((a, b) => model.nodes[a]!.bounds!.x - model.nodes[b]!.bounds!.x || compareId(a, b));
  }
}
export function rebuildBands(model: LayoutModel, includeFlanks = true): void {
  const groups = Object.values(model.groups).filter(group => includeFlanks || !group.flank);
  const tiers = [...new Set(groups.map(group => group.tier!))].sort((a, b) => a - b);
  model.tierBands = tiers.map(tier => {
    const members = groups.filter(group => group.tier === tier);
    return { tier, groups: members.map(group => group.id), bounds: union(members.map(group => group.bounds!)) };
  });
  // Frames derive from the same boxes; every caller that rebuilds bands after moving one rebuilds them too.
  rebuildFrames(model);
}

/** Stage-4 counterpart of G8, usable before paths and final port geometry exist. */
export function validateSkeletonBands(model: LayoutModel, includeFlanks = true, onlyTier?: number): string[] {
  const errors: string[] = [];
  const groups = Object.values(model.groups).filter(group => (includeFlanks || !group.flank) && (onlyTier === undefined || group.tier === onlyTier));
  for (const [i, group] of groups.entries()) {
    const band = model.tierBands.find(band => band.tier === group.tier);
    if (!validRect(group.bounds) || !validRect(band?.bounds) || !band!.groups.includes(group.id) || !contains(band!.bounds!, group.bounds!)) errors.push(`Group ${group.id} is outside its tier band`);
    for (const other of groups.slice(i + 1)) if (validRect(group.bounds) && validRect(other.bounds) && overlaps(group.bounds, other.bounds)) errors.push(`Groups ${group.id} and ${other.id} overlap`);
  }
  const bands = model.tierBands.filter(band => onlyTier === undefined || band.tier === onlyTier).sort((a, b) => a.tier - b.tier);
  for (const [i, band] of bands.entries()) {
    if (!validRect(band.bounds)) errors.push(`Tier ${band.tier} has invalid bounds`);
    const previous = bands[i - 1];
    // `bottom()` here is derived from the same union, so it carries the same residue. `gates.ts:119`
    // asks this question with `+ EPS`; so does this, for the same reason the two above do.
    if (previous && validRect(previous.bounds) && validRect(band.bounds)
      && (previous.tier === band.tier || bottom(previous.bounds) > band.bounds.y + EPS)) errors.push(`Tier ${band.tier} precedes or overlaps the previous band`);
  }
  return errors;
}
/** Test only (the side probe, ticket 134): called after each `moveGroup`. Unset in production, so it costs one comparison. */
export const moveTrace: { hook?: (model: LayoutModel, group: LayoutGroup, dx: number, dy: number) => void } = {};
export function moveGroup(model: LayoutModel, group: LayoutGroup, dx: number, dy: number): void {
  group.bounds!.x += dx; group.bounds!.y += dy;
  for (const id of group.nodes) {
    const node = model.nodes[id]!;
    node.bounds!.x += dx; node.bounds!.y += dy;
    for (const port of node.ports) if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; }
  }
  moveTrace.hook?.(model, group, dx, dy);
}
function packRow(model: LayoutModel, group: LayoutGroup, order: string[]): void {
  const original = group.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
  let x = original.x + spacing.padding;
  const y = original.y + spacing.padding;
  for (const [i, id] of order.entries()) {
    const node = model.nodes[id]!;
    if (i) x += nodeGap(model, order[i - 1]!, id);
    const old = node.bounds;
    if (old) for (const port of node.ports) if (port.anchor) {
      port.anchor.x += x - old.x; port.anchor.y += y - old.y;
    }
    node.bounds = { x, y, ...node.size! };
    x += node.size!.width;
  }
  group.rowOrder = order;
  group.bounds = { x: original.x, y: original.y,
    width: Math.max(2 * spacing.padding, x - original.x + spacing.padding),
    height: Math.max(0, ...order.map(id => model.nodes[id]!.size!.height)) + 2 * spacing.padding };
}
/** The shape the group declares decides how a rule that repacks it lays its nodes out. */
function packGroup(model: LayoutModel, group: LayoutGroup, order: string[]): void {
  if (isGridGroup(model, group.id)) packGrid(model, group, order); else packRow(model, group, order);
}

/**
 * Stage 4 hands ELK one row per group, because ELK's layered pass is what orders the nodes. A grid
 * group then takes that order and packs it into columns and rows (`grid.ts`), which makes the box
 * narrower and taller than the one ELK measured. Two consequences are settled here rather than left
 * for a later stage to discover: the tier is re-packed left to right, so the width a grid gave back
 * is width the canvas gives back too, and the caller re-stacks the bands, because a taller box no
 * longer fits the band ELK sized for a ribbon.
 *
 * Returns whether anything moved, so an input with no grid group keeps ELK's geometry exactly.
 */
export function packGridGroups(model: LayoutModel, tier?: number): boolean {
  const groups = orderedGroupIds(model.document).map(id => model.groups[id]!)
    .filter(group => !group.flank && (tier === undefined || group.tier === tier));
  const grids = groups.filter(group => isGridGroup(model, group.id) && group.nodes.length > 0);
  if (!grids.length) return false;
  for (const group of grids) packGrid(model, group, group.rowOrder ?? [...group.nodes]);
  const gap = bandGap(model);
  for (const band of new Set(groups.map(group => group.tier))) {
    const members = groups.filter(group => group.tier === band).sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    let x = Math.min(...members.map(group => group.bounds!.x));
    for (const group of members) {
      moveGroup(model, group, x - group.bounds!.x, 0);
      x = right(group.bounds!) + gap;
    }
  }
  return true;
}

/** Select all primary peers from the same ELK result before any repack changes distances. */
export function placeFlanksAndPeers(model: LayoutModel, orderColumns?: (columns: Map<string, Column>) => void): void {
  const gap = bandGap(model);
  const flanks = orderedGroupIds(model.document).map(id => model.groups[id]!).filter(group => group.flank !== undefined);
  for (const group of flanks) {
    const flank = group.flank!, peerGroup = model.groups[flank.of]!;
    const distance = (id: string): number => flank.align === 'left'
      ? model.nodes[id]!.bounds!.x - peerGroup.bounds!.x
      : right(peerGroup.bounds!) - right(model.nodes[id]!.bounds!);
    const candidates = greatestPeers(model, group).sort((a, b) => distance(a) - distance(b) || compareId(a, b));
    if (candidates[0] !== undefined) flank.primaryPeer = candidates[0];
  }
  for (const peerGroup of Object.values(model.groups).filter(group => !group.flank)) {
    const attached = flanks.filter(group => group.flank!.of === peerGroup.id && group.flank!.primaryPeer !== undefined);
    if (!attached.length) continue;
    let order = [...peerGroup.rowOrder!];
    const outerOwners = new Map<string, LayoutGroup>();
    for (const group of attached) {
      const peer = group.flank!.primaryPeer!;
      const first = outerOwners.get(peer);
      if (order.length > 1 && first && first.flank!.align !== group.flank!.align) {
        model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'FLANK_PRIMARY_CONFLICT',
          message: `Flanks ${first.id} and ${group.id} share primary peer ${peer}; ${first.id} keeps its ${first.flank!.align} outer position. Obstructed flank links require routing.`,
          owners: [first.owner, group.owner, { kind: 'node', id: peer }],
        });
        continue;
      }
      outerOwners.set(peer, group);
      order = order.filter(id => id !== peer);
      if (group.flank!.align === 'left') order.unshift(peer); else order.push(peer);
    }
    // The `unshift`/`push` above is the row's answer, and it is **not** the grid's: reading order
    // packs a ragged row against the left, so pushing a right flank's peer last would leave it in
    // column 0 of a partial last row, and the lateral link would run the width of the group box to
    // reach it. `packGrid` does not consume this end position — `seatFlankPeers` reads the stored
    // peer and its alignment itself, and seats it at the outer end of whichever row its exit rank
    // put it in (stress ticket 26 finding B2).
    packGroup(model, peerGroup, order);
  }
  // Repacked rows can grow. A frame is a column: the frames and one-rank groups of a tier take their
  // columns first (`packFrameColumns`), and the sweep below then only moves what is not in a frame.
  const columns = packFrameColumns(model);
  // The columns are packed, so their widths are known: the caller may re-order the frames (ticket 06b) and re-pack the tiers it changes.
  orderColumns?.(columns);
  // D-Q5: a lifted component moves as a whole beside the units of the bands it now shares, a band gap from them.
  seatLifts(model, (group, dx) => {
    moveGroup(model, group, dx, 0);
    const column = columns.get(group.id);
    if (column !== undefined) columns.set(group.id, { ...column, x: column.x + dx });
  }, () => deriveFrames(model));
  for (const tier of new Set(Object.values(model.groups).map(group => group.tier))) {
    const groups = Object.values(model.groups).filter(group => !group.flank && group.tier === tier).sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    let end = -Infinity;
    for (const group of groups) {
      if (group.bounds!.x < end) moveGroup(model, group, end - group.bounds!.x, 0);
      end = right(group.bounds!) + gap;
    }
    // A flank stands beside the columns of its sub-tier, not beside the narrower cell that column holds.
    const core = union(groups.map(group => { const column = columns.get(group.id); return column === undefined ? group.bounds! : { ...group.bounds!, x: column.x, width: column.width }; }));
    let left = core.x - gap, rightX = right(core) + gap;
    for (const flank of flanks.filter(group => group.tier === tier)) {
      packGroup(model, flank, [...flank.nodes]);
      const x = flank.flank!.align === 'left' ? left - flank.bounds!.width : rightX;
      moveGroup(model, flank, x - flank.bounds!.x, core.y - flank.bounds!.y);
      if (flank.flank!.align === 'left') left = x - gap;
      else rightX = x + flank.bounds!.width + gap;
    }
  }
  stackBands(model, true);
}

/** Stack complete band geometry. Preserve each band's valid ELK positions and internal gaps. */
export function stackBands(model: LayoutModel, includeFlanks: boolean): void {
  const gap = tierGapMin(model);
  rebuildBands(model, includeFlanks);
  let y = spacing.padding;
  for (const band of model.tierBands) {
    const dy = y - band.bounds!.y;
    for (const id of band.groups) moveGroup(model, model.groups[id]!, 0, dy);
    band.bounds!.y = y;
    y += band.bounds!.height + gap;
  }
  const all = Object.values(model.groups).filter(group => includeFlanks || !group.flank);
  // A rank cell holds no side margin: its frame draws 20 px beyond it on each side, and the canvas
  // margin is measured from the frame.
  const drawn = (group: LayoutGroup): Rect => group.frame === undefined ? group.bounds!
    : { ...group.bounds!, x: group.bounds!.x - GROUP_PADDING, width: group.bounds!.width + 2 * GROUP_PADDING };
  // A parent frame stands 20 px outside its child frame, which no cell box shows, so frames are read too.
  const bounds = union([...all.map(drawn), ...(model.frames ?? []).map(frame => frame.box)]);
  const dx = spacing.padding - bounds.x;
  for (const group of all) moveGroup(model, group, dx, 0);
  rebuildBands(model, includeFlanks);
  model.canvas = { x: 0, y: 0, width: bounds.width + 2 * spacing.padding, height: Math.max(bounds.height + 2 * spacing.padding, y - gap + spacing.padding) };
}
