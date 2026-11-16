import type { LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { effectiveLayer } from '../score/model.js';
import { measurePortPill, measureText } from '../text/index.js';
import { LINK_LABEL_GEOMETRY } from './link-label-geometry.js';
import { describedLink, overlayLabelsSuppressed } from './run-label-box.js';
import { expectedRowPath, findPort } from './row-paths.js';
import { stemReach } from './bands.js';
import { PLACEMENT_EPS } from './tolerance.js';

/** Metadata is available before stage 5 builds pills. Anonymous ports have no pill. */
export function labelPillReach(port: LayoutPort): number {
  return port.ref.anonymous === true ? 0 : measurePortPill(port.ref.name!).width / 2;
}

/** Where same-tier facing label room grows: midway between the two pill faces, including anonymous body faces. */
export function rowLabelSplit(model: LayoutModel, link: LayoutLink): number | undefined {
  if (link.attachments === undefined) return undefined;
  const a = findPort(model, link.attachments.from), b = findPort(model, link.attachments.to);
  if (a?.anchor === undefined || b?.anchor === undefined) return undefined;
  const [left, right] = a.anchor.x <= b.anchor.x ? [a, b] : [b, a];
  if (left.side !== 'right' || right.side !== 'left') return undefined;
  const leftBox = model.nodes[left.ref.node]?.bounds, rightBox = model.nodes[right.ref.node]?.bounds;
  if (leftBox === undefined || rightBox === undefined) return undefined;
  return (Math.max(leftBox.x + leftBox.width, left.anchor!.x + labelPillReach(left))
    + Math.min(rightBox.x, right.anchor!.x - labelPillReach(right))) / 2;
}

/** The one body-gap floor read by row placement and 7f, in px (ADR-0014). */
export function rowLabelNeed(model: LayoutModel, link: LayoutLink, left: LayoutPort, right: LayoutPort, detour: boolean): { gap: number; wanted: number } {
  const text = model.document.links[link.sourceIndex]!.label!;
  const required = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width
    + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
  const a = labelPillReach(left), b = labelPillReach(right);
  const allowance = effectiveLayer(link) === 'overlay' ? a + b : 2 * Math.max(a, b);
  const wanted = required + (detour ? stemReach(model, model.nodes[left.ref.node]!) + stemReach(model, model.nodes[right.ref.node]!) + allowance : 0);
  return { gap: wanted + allowance, wanted };
}

/**
 * A same-row facing pair, read by topology before anchors and pills exist. Stage 5 asks for the straight floor;
 * after levelling stage 6 asks for detour stems too. Non-adjacent spans ask even for a level detour around a member.
 * Node positions carry the reservation, so every later row-gap reader keeps it (R1, R2).
 */
export function rowLabelGap(model: LayoutModel, a: string, b: string, detours: boolean): number {
  if (a === b || model.document.nodes[a]!.group !== model.document.nodes[b]!.group) return 0;
  const group = model.groups[model.document.nodes[a]!.group]!, order = group.rowOrder ?? group.nodes;
  const nonAdjacent = Math.abs(order.indexOf(a) - order.indexOf(b)) > 1;
  let gap = 0;
  const suppressed = overlayLabelsSuppressed(model);
  for (const link of model.links) {
    if (!describedLink(model, link, suppressed)) continue;
    const { from, to } = link.attachments!;
    if (!(from.node === a && to.node === b || from.node === b && to.node === a)) continue;
    const left = findPort(model, from.node === a ? from : to), right = findPort(model, from.node === b ? from : to);
    if (left?.side !== 'right' || right?.side !== 'left') continue;
    const jogs = left.anchor !== undefined && right.anchor !== undefined && Math.abs(left.anchor.y - right.anchor.y) > PLACEMENT_EPS;
    const detour = detours && effectiveLayer(link) === 'routed' && (jogs || nonAdjacent) && expectedRowPath(model, link) === undefined;
    gap = Math.max(gap, rowLabelNeed(model, link, left, right, detour).gap);
  }
  return gap;
}
