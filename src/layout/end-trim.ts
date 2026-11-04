import type { LayoutModel, Rect } from '../model/index.js';
import { contentBox, rebuildRegions, right } from './regions.js';
import { portEndInsets } from './port-insets.js';
import { measureNodeContent } from './size.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { alignLinkedGroupGrid, placeGroupTitles, syncLabelBandsOnly } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { placementSnapshotOf, restoreLayoutModel } from './mutation.js';
import { orderedNodeIds } from '../model/model.js';

/**
 * Experiment `scratch/end-trim` (user 2026-11-04): after the last x move of 7f and before stage 8, each node body is trimmed to the span of its
 * top and bottom ports with their end insets, never narrower than its stage-3 floor (`sizeFloor`, the measured content). Ports keep their x; a
 * face with lateral ports keeps its x. No node moves, no link geometry changes. Each group box shrinks to its trimmed content; frames, label
 * bands and tier bands are derived again, and the group titles are placed again on the narrower bands.
 * Returns a trimmed copy; the input is not changed. Off with `PG_END_TRIM=0`.
 */
export function trimBodies(input: LayoutModel): LayoutModel {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  if (host.process?.env?.PG_END_TRIM === '0') return input;
  const model = JSON.parse(JSON.stringify(input)) as LayoutModel;
  const bars = new Set(Object.entries(model.document.groups ?? {}).filter(([, group]) => group.shape === 'bar').map(([id]) => id));
  const trimmed: string[] = [];
  for (const [id, node] of Object.entries(model.nodes)) {
    const box = node.bounds;
    if (box === undefined || node.contentInsets === undefined || bars.has(model.document.nodes[id]!.group)) continue;
    const floor = Math.max(node.sizeFloor?.width ?? 0, node.contentSize?.width ?? 0,
      measureNodeContent(model.document.nodes[id]!, model.document, node.contentInsets).width);
    // The span the horizontal faces need: the outer ports with the stored end insets.
    let low = Infinity, high = -Infinity;
    for (const side of ['top', 'bottom'] as const) {
      const ports = node.ports.filter(port => port.side === side && port.anchor !== undefined);
      if (!ports.length) continue;
      const inset = portEndInsets(node, side), xs = ports.map(port => port.anchor!.x);
      low = Math.min(low, Math.min(...xs) - inset.low);
      high = Math.max(high, Math.max(...xs) + inset.high);
    }
    // A lateral face keeps its x: its ports stand on it.
    const left = node.ports.some(port => port.side === 'left'), rightFace = node.ports.some(port => port.side === 'right');
    if (left) low = Math.min(low, box.x);
    if (rightFace) high = Math.max(high, right(box));
    const width = Math.max(floor, Number.isFinite(low) ? high - low : 0);
    if (width >= box.width - PLACEMENT_EPS) continue;
    // Centred on the port span (on the body when it has none), inside the old body, holding the span and the lateral faces.
    const centre = Number.isFinite(low) ? (low + high) / 2 : box.x + box.width / 2;
    let x = Math.max(box.x, Math.min(centre - width / 2, right(box) - width));
    if (Number.isFinite(low)) x = Math.min(x, low);
    if (Number.isFinite(high)) x = Math.max(x, high - width);
    if (left) x = box.x;
    if (rightFace) x = right(box) - width;
    const next: Rect = { x, y: box.y, width, height: box.height };
    if (next.x < box.x - PLACEMENT_EPS || right(next) > right(box) + PLACEMENT_EPS) continue;
    node.bounds = next;
    node.size = { width, height: box.height };
    trimmed.push(id);
  }
  if (!trimmed.length) return input;
  // Every node, in document order: the publication check compares the node labels in that order.
  rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  for (const group of Object.values(model.groups)) {
    if (!group.nodes.length || group.bounds === undefined || group.nodes.some(node => bars.has(model.document.nodes[node]!.group))) continue;
    const content = contentBox(model, group), old = group.bounds;
    const x = Math.max(old.x, content.x), r = Math.min(right(old), right(content));
    if (r - x < old.width - PLACEMENT_EPS) group.bounds = { x, y: old.y, width: r - x, height: old.height };
  }
  // The linked-group grid (ADR-0012) again on the trimmed boxes: it only grows a box back to the union of its linked partners.
  alignLinkedGroupGrid(model, new Set(model.gridRefusals ?? []));
  rebuildRegions(model);
  syncLabelBandsOnly(model);
  rebuildRegions(model);
  placeGroupTitles(model);
  // The trim is the last placement change: the final placement freeze is taken again on it.
  if (model.freeze?.placement) model.freeze.placement = JSON.parse(JSON.stringify(placementSnapshotOf(model))) as typeof model.freeze.placement;
  // The trimmed copy is published again through the restore API: every publication check of 7f reads it.
  // A trim the publication checks refuse is not made (experiment): the untrimmed model is routed, and stderr names the refusal.
  try {
    return restoreLayoutModel(JSON.stringify(model));
  } catch (error) {
    (globalThis as unknown as { console: { error(line: string): void } }).console.error(`END_TRIM_REFUSED ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return input;
  }
}
