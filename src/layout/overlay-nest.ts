import type { LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { measurePortPill } from '../text/index.js';
import { busOfPort } from './bus.js';
import { overlayCourse } from './courses.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { overlayBasePath, publishedOverlayPath, sharedBlockers } from './overlay-paths.js';
import { sharedTrackPairs } from './overlay-tracks.js';
import { drawn, overlayCrossingPoints, portKey } from './read/crossings.js';
import { portId } from './skeleton-graph.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { orderedNodeIds } from '../model/model.js';

/**
 * Overlay ports nest (architecture-2 ticket 23, user 2026-10-23): on one face, the ports of overlay detours that arrive by parallel
 * tracks stand so that the tracks nest instead of crossing. The outer track takes the port nearer the side the tracks come from: on a
 * lateral face, the lower track the lower port when both come from below, and the mirror for above, left and right.
 *
 * Decided in 7f, where the separated tracks first exist. Stage 5 orders a face before any overlay detour is derived: the side a detour
 * goes round and the track it takes depend on the geometry 7f settles and on the whole layer (the joint separation), so neither is
 * known there. The measure is the separation itself (`publishedOverlayPath`, the paths stage 8 draws and the scorer reads): one
 * derivation, no second predicate (R1). A trade is kept only when the layer is better by the user's order: no more shared tracks, then
 * no more bent links and turns (bends first), then fewer crossing points.
 *
 * Only a free port moves (R3): no authored `order:`, no routed link and no other link on it, no mesh bus, no course, a detour (the
 * per-link rule bends it), and a pill of the same size as the port it trades with. Two such ports trade their slots (anchor and
 * `engineOrder`), so no size and no spacing changes, as 7e bundles reorder their own ports. Faces in node order (`orderedNodeIds`),
 * sides in `SIDE_TIE_ORDER`, pairs in engine order; at most `NEST_PASSES` passes (R4).
 */
export function nestOverlayPorts(model: LayoutModel): string[] {
  const links = model.links.filter(link => (link.layer ?? link.family) === 'overlay' && link.technique !== 'stub' && link.removed !== true
    && link.meshBus === undefined && link.attachments !== undefined);
  if (links.length < 2) return [];
  const count = new Map<string, number>();
  for (const link of model.links) for (const end of link.attachments ? [link.attachments.from, link.attachments.to] : []) count.set(portId(end), (count.get(portId(end)) ?? 0) + 1);
  const linkAt = new Map<string, LayoutLink>();
  for (const link of links) for (const end of [link.attachments!.from, link.attachments!.to]) linkAt.set(portId(end), link);
  const blockers = sharedBlockers(model);
  const free = (port: LayoutPort): boolean => {
    const key = portId(port.ref), link = linkAt.get(key);
    return link !== undefined && count.get(key) === 1 && port.anchor !== undefined && port.side !== undefined && port.authorOrder === undefined
      && port.courseHint !== true && busOfPort(model, port.ref) === undefined && !overlayCourse(model, link)
      && link.attachments!.from.node !== link.attachments!.to.node && overlayBasePath(model, link, blockers).segments.length > 2;
  };
  const faces: { node: string; ports: LayoutPort[] }[] = [];
  for (const id of orderedNodeIds(model.document)) for (const side of SIDE_TIE_ORDER) {
    const ports = (model.nodes[id]?.ports ?? []).filter(port => port.side === side && free(port)).sort((a, b) => a.engineOrder! - b.engineOrder!);
    if (ports.length > 1) faces.push({ node: id, ports });
  }
  if (!faces.length) return [];
  const measure = (): number[] => {
    const shapes = sharedBlockers(model);
    const points = links.map(link => {
      const segments = publishedOverlayPath(model, link, shapes).segments;
      return segments.length ? [segments[0]!.from, ...segments.map(segment => segment.to)] : [];
    });
    const shares = sharedTrackPairs(links.map((link, index) => ({ points: points[index]!, strokeWidth: linkStrokeWidth(link) }))).length;
    const bent = points.filter(item => item.length > 2).length, turns = points.reduce((sum, item) => sum + Math.max(0, item.length - 2), 0);
    const crossings = overlayCrossingPoints(links.map((link, index) => drawn(points[index]!, [portKey(link.attachments!.from), portKey(link.attachments!.to)])));
    return [shares, bent, turns, crossings];
  };
  const trade = (node: string, one: LayoutPort, two: LayoutPort): void => {
    // Both are free ports, so both have an anchor and an engine order (`free`).
    const anchor = one.anchor!, order = one.engineOrder!;
    one.anchor = two.anchor!; one.engineOrder = two.engineOrder!;
    two.anchor = anchor; two.engineOrder = order;
    rebuildNodeGeometry(model, [node], 'current');
  };
  const sameSize = (one: LayoutPort, two: LayoutPort): boolean => {
    if (one.ref.anonymous === true || two.ref.anonymous === true) return one.ref.anonymous === two.ref.anonymous;
    const a = measurePortPill(one.ref.name), b = measurePortPill(two.ref.name);
    return a.width === b.width && a.height === b.height;
  };
  const moved = new Set<string>();
  let current = measure();
  for (let pass = 0; pass < NEST_PASSES; pass++) {
    let any = false;
    for (const face of faces) for (let i = 0; i < face.ports.length; i++) for (let j = i + 1; j < face.ports.length; j++) {
      const one = face.ports[i]!, two = face.ports[j]!;
      if (!sameSize(one, two)) continue;
      trade(face.node, one, two);
      const next = measure();
      if (better(next, current)) { current = next; any = true; moved.add(portId(one.ref)).add(portId(two.ref)); }
      else trade(face.node, one, two);
    }
    if (!any) break;
  }
  return [...moved].sort();
}

/** The passes over the faces (R4: bounded by count); a trade only lowers the measure, so a pass that trades nothing ends it. */
const NEST_PASSES = 2;

/** No key worse and the last strictly better, or an earlier key strictly better: the first key that differs decides. */
function better(next: readonly number[], current: readonly number[]): boolean {
  for (let at = 0; at < next.length; at++) if (next[at] !== current[at]) return next[at]! < current[at]!;
  return false;
}
