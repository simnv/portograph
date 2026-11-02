import type { Rect, Side } from '../model/geometry.js';
import type { LayoutGroup, LayoutModel, LayoutNode } from '../model/layout.js';
import { groupShape } from './grid.js';
import { bandGap, compareId, portId, tierGapMin } from './skeleton-graph.js';
import { moveGroup, rebuildBands, union } from './skeleton-geometry.js';
import { groupInsets } from './regions.js';
import { holdColumnAxes, packBesideRows, separateFrameColumns } from './columns.js';
import { rowGap } from './sides-two.js';
import { withStageMutation } from './mutation.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { facingPair, type FacingPair } from './row-paths.js';
import { staggerOf } from './stagger.js';
import { columnOf } from './read/arrangement.js';
import { portEndInsets } from './port-insets.js';

const right = (rect: Rect): number => rect.x + rect.width;
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) && b.x < right(a) && a.y < b.y + b.height && b.y < a.y + a.height;

function moveNode(draft: LayoutModel, id: string, dx: number, dy: number): void {
  const node = draft.nodes[id]!;
  node.bounds!.x += dx; node.bounds!.y += dy;
  for (const port of node.ports) if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; }
}
function rowGroups(draft: LayoutModel, band: { groups: string[] }): LayoutGroup[] {
  return band.groups.map(id => draft.groups[id]!).filter(group => !group.flank && groupShape(draft, group.id) === 'row' && group.nodes.length > 0);
}
/** Keep the left edge and width; fit the vertical extent to the flattened nodes with standard padding. */
function fitGroupBox(draft: LayoutModel, group: LayoutGroup): void {
  const box = union(group.nodes.map(id => draft.nodes[id]!.bounds!)), old = group.bounds!, inset = groupInsets(draft, group);
  const x = Math.min(old.x, box.x - inset.left), y = Math.min(old.y, box.y - inset.top);
  group.bounds = { x, y, width: Math.max(right(old), right(box) + inset.right) - x, height: box.y + box.height + inset.bottom - y };
}

function flattenRows(draft: LayoutModel): void {
  for (const band of draft.tierBands) {
    const groups = rowGroups(draft, band);
    const ids = groups.filter(group => staggerOf(draft, group.id) === undefined && !columnOf(draft, group.id)).flatMap(group => group.nodes);
    if (!ids.length) continue;
    const top = Math.min(...ids.map(id => draft.nodes[id]!.bounds!.y));
    for (const id of ids) {
      const dy = top - draft.nodes[id]!.bounds!.y;
      if (dy) moveNode(draft, id, 0, dy);
    }
    for (const group of groups) fitGroupBox(draft, group);
  }
}

/**
 * Re-seat every band at the bottom of the band above plus the band gap (ranked-groups ticket 18).
 * `flattenRows` moves a tier's nodes to the top of the tier and leaves the freed height below them,
 * so a band that ELK layered deeper than its sub-tier needed keeps that height as gap. The gap
 * between two bands is one number: `tierGapMin`, which serves the boundary between the sub-tiers of one
 * document tier and the boundary between document tiers alike (architecture-2 ticket 57 split it from
 * `bandGap`, the horizontal spacing; both are 60 px today). Room a later stage allocates (tier-gap rows,
 * label bands) is added on top of this seating by stage 7. Whole bands move by one vertical shift, flanks, bars
 * and grids with them. The canvas is not touched: stage 9 refits it to what is drawn.
 */
function reseatBands(draft: LayoutModel): void {
  rebuildBands(draft);
  const gap = tierGapMin(draft);
  let y = draft.tierBands[0]?.bounds!.y ?? 0;
  for (const band of draft.tierBands) {
    const dy = y - band.bounds!.y;
    if (Math.abs(dy) > PLACEMENT_EPS) {
      for (const id of band.groups) moveGroup(draft, draft.groups[id]!, 0, dy);
    }
    y += band.bounds!.height + gap;
  }
  rebuildBands(draft);
}

/** Push overlapping row neighbours rightwards in row order, then push displaced row groups; flanks never move. */
export function repackOverlaps(draft: LayoutModel): void {
  const gap = bandGap(draft);
  // First every row group takes the width its nodes need; then the columns of the frames move apart as
  // wholes (ranked-groups ticket 12); only then does a sweep push what is left, a group with no frame.
  for (const band of draft.tierBands) {
    for (const group of rowGroups(draft, band)) {
      if (staggerOf(draft, group.id) !== undefined || columnOf(draft, group.id)) continue;
      const order = group.rowOrder ?? group.nodes;
      for (let i = 1; i < order.length; i++) {
        const prior = draft.nodes[order[i - 1]!]!.bounds!, node = draft.nodes[order[i]!]!;
        const minimum = right(prior) + rowGap(draft, order[i - 1]!, order[i]!);
        if (node.bounds!.x < minimum - PLACEMENT_EPS) moveNode(draft, order[i]!, minimum - node.bounds!.x, 0);
      }
      fitGroupBox(draft, group);
    }
  }
  // The fit above changed the widths the pack sweep read: the child columns stand against the parent cells again.
  packBesideRows(draft);
  separateFrameColumns(draft);
  // The sweep pushes a frame right and never back; the pass pulls each column toward its feed again (ticket 16).
  holdColumnAxes(draft);
  for (const band of draft.tierBands) {
    const groups = rowGroups(draft, band);
    if (!groups.length) continue;
    // Only row groups move here. Flanks belong to the flanks rule and bars to the bars rule.
    const core = [...groups].sort((a, b) => a.bounds!.x - b.bounds!.x || compareId(a.id, b.id));
    let end = -Infinity;
    for (const group of core) {
      if (group.bounds!.x < end - PLACEMENT_EPS) moveGroup(draft, group, end - group.bounds!.x, 0);
      end = right(group.bounds!) + gap;
    }
    for (const fixed of band.groups.map(id => draft.groups[id]!).filter(group => !groups.includes(group))) {
      for (const group of core) {
        if (overlaps(fixed.bounds!, group.bounds!)) throw new Error(`Row repack of ${group.id} collides with ${fixed.flank ? 'flank' : 'non-row group'} ${fixed.id}, which the rows rule cannot move`);
      }
    }
  }
  rebuildBands(draft);
}

interface SideTarget { port: string; y: number }
/**
 * Move the ports of one side to their targets where the measured pitch, capacity padding and
 * engine order allow it. Infeasible targets are skipped in engine order; the remaining ports keep
 * pitch spacing beside the levelled ports or spread evenly between two levelled ports.
 */
function levelSide(node: LayoutNode, side: Side, targets: SideTarget[]): void {
  const ports = node.ports.filter(port => port.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  const pitch = node.sidePitch![side]!, box = node.bounds!, count = ports.length;
  const inset = portEndInsets(node, side, pitch);
  const low = box.y + inset.low, high = box.y + box.height - inset.high;
  const wanted = new Map(targets.map(target => [target.port, target.y]));
  const kept: { index: number; y: number }[] = [];
  ports.forEach((port, index) => {
    const y = wanted.get(portId(port.ref));
    if (y === undefined) return;
    const last = kept[kept.length - 1];
    if (y < low + index * pitch - PLACEMENT_EPS || y > high - (count - 1 - index) * pitch + PLACEMENT_EPS) return;
    if (last && y - last.y < (index - last.index) * pitch - PLACEMENT_EPS) return;
    kept.push({ index, y });
  });
  if (!kept.length) return;
  const ys = new Array<number>(count);
  for (const { index, y } of kept) ys[index] = y;
  const first = kept[0]!, last = kept[kept.length - 1]!;
  for (let i = 0; i < first.index; i++) ys[i] = first.y - (first.index - i) * pitch;
  for (let k = 1; k < kept.length; k++) {
    const a = kept[k - 1]!, b = kept[k]!;
    for (let i = a.index + 1; i < b.index; i++) ys[i] = a.y + (i - a.index) * (b.y - a.y) / (b.index - a.index);
  }
  for (let i = last.index + 1; i < count; i++) ys[i] = last.y + (i - last.index) * pitch;
  ports.forEach((port, index) => { port.anchor = { x: port.anchor!.x, y: ys[index]! }; });
}

/**
 * Level facing east/west ports for every same-tier node pair. The node with fewer ports on the
 * facing side moves its ports; a tie moves the right-hand node. Pairs are processed left to right,
 * and each reads the peer's current anchors, so later pairs level against already-moved ports.
 */
function levelFacingPorts(draft: LayoutModel): void {
  const pairs = draft.links.map(link => facingPair(draft, link)).filter((pair): pair is FacingPair => pair !== undefined);
  const byNodes = new Map<string, FacingPair[]>();
  for (const pair of pairs) {
    const key = JSON.stringify([pair.left.node.id, pair.right.node.id]);
    const list = byNodes.get(key) ?? []; list.push(pair); byNodes.set(key, list);
  }
  const ordered = [...byNodes.values()].sort((a, b) => a[0]!.left.node.bounds!.x - b[0]!.left.node.bounds!.x
    || a[0]!.right.node.bounds!.x - b[0]!.right.node.bounds!.x
    || compareId(a[0]!.left.node.id, b[0]!.left.node.id) || compareId(a[0]!.right.node.id, b[0]!.right.node.id));
  for (const list of ordered) {
    const { left, right: rightEnd } = list[0]!;
    const leftCount = left.node.ports.filter(port => port.side === 'right').length;
    const rightCount = rightEnd.node.ports.filter(port => port.side === 'left').length;
    const moverIsLeft = leftCount < rightCount;
    const mover = moverIsLeft ? left.node : rightEnd.node, side: Side = moverIsLeft ? 'right' : 'left';
    const links = list.map(pair => moverIsLeft ? { own: pair.left.port, peer: pair.right.port } : { own: pair.right.port, peer: pair.left.port })
      .sort((a, b) => a.own.engineOrder! - b.own.engineOrder! || a.peer.engineOrder! - b.peer.engineOrder!);
    const targets: SideTarget[] = [];
    for (const { own, peer } of links) {
      const key = portId(own.ref);
      if (!targets.some(target => target.port === key)) targets.push({ port: key, y: peer.anchor!.y });
    }
    levelSide(mover, side, targets);
  }
}

/** Stage 6: one baseline per tier row, repack on overlap, level facing ports. The transaction pins eligible row paths. */
export function rows(model: LayoutModel): LayoutModel {
  return withStageMutation(model, 'rows', draft => {
    flattenRows(draft);
    reseatBands(draft);
    repackOverlaps(draft);
    levelFacingPorts(draft);
    // Levelling moves anchors, which can turn a straight crossing into a jog and so add a turning
    // leg (ADR-0015 rule 1). The gap is asked again on the levelled anchors, so no leg's room is
    // left for stage 8 to discover. Nodes move in x only, which cannot undo the levelling.
    repackOverlaps(draft);
  });
}
