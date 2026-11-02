import type { Point, Rect, Side } from '../model/geometry.js';
import { stemCache, stemDepth, stemDepthsFault } from './sides-two.js';
import type { PortRef } from '../model/document.js';
import type { LabelBand, LabelPaddingEntry, LayoutGroup, LayoutLabel, LayoutLink, LayoutModel, LayoutNode, LayoutPort, Owner, PathSegment } from '../model/layout.js';
import { equal } from '../model/json-equality.js';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
import { frameSubtreeCells, orderedGroupIds, orderedNodeIds } from '../model/model.js';
import { measureText } from '../text/index.js';
import { sidePillTextReach } from './pill-reach.js';
import { frameHost, frameTitleSide, GROUP_LABEL_GEOMETRY, LABEL_CLEARANCE_STEP, measureTitle } from './title-room.js';
import { DEFAULT_STROKE_WIDTHS, GROUP_LABEL_LINK_CLEARANCE, linkStrokeWidth } from '../theme/geometry.js';
import { createCentreBudget, type CentreBudget } from './centre.js';
import { isSideLane, rebuildLaneExtents, riserKeepOutBreaches } from './lanes.js';
import { PlacementRefusal } from './placement-refusal.js';
import { holdsMove } from './move-reservations.js';
import { gapsHoldGrowth, growthHolds } from './growth-guard.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { rebuildRegionGeometry } from './region-rebuild.js';
import { findPort, straightCorridorClear } from './row-paths.js';
import { bandGap, portId } from './skeleton-graph.js';
import { moveGroup, rebuildBands, union } from './skeleton-geometry.js';
import { allBut, copyWithShared } from './trial-copy.js';
import { closeCantons, columnShifts, keepOutShifts, holdColumnAxes, packBesideRows } from './columns.js';
import { deriveFrames } from './frames.js';
import { bandHeldBy, bottom, fitRegionGroup, GROUP_PADDING, groupPadding, placementWarning, rebuildRegions, right } from './regions.js';
import { withLayoutMutation } from './mutation.js';
import { effectiveLayer } from '../score/model.js';
import { LINK_LABEL_GEOMETRY, besideRunLabelBox, describedLink, labelBorders, linkLabelSize, haloSize, isDiagonalRun, labelWindowDeficit, labelYieldsFault, longestRun, overlayLabelsSuppressed, recordLabelYields, reservedLinkRuns, tierGapSplit } from './link-labels.js';
import { overlayBasePath, overlayPath, overlayTrackRuns, straightChord } from './overlay-paths.js';
import { paddingOf, trackLabelHeight, trackLabelRoom, trackRoomNeed } from './overlay-tracks.js';
import { chordKind, crossingRect, isRoutedChord } from './frame-paths.js';
import { diagonalMayCross, GROUP_TITLE } from './diagonal-text.js';
import { directFamiliesFault } from './direct-families.js';
import { fanAdmissionsFault } from './fan-admission.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { busRoom } from './bus-room.js';
import { busGeometry, expectedBusBands, riserEnds, syncBusGeometry, trunkJoins } from './bus.js';
import { reportTrunkCrossings } from './trunk.js';
import { derivedShortfalls, separationsBrokenBy, worseSeparations } from './constraints/separation.js';
import { attemptCounters } from './attempt-counters.js';
import type { AttemptTraceEvent } from './placement-attempt.js';
import { isCantonFrame } from './read/canton.js';
import { frameTitleEdge, groupTitleEdge } from './read/title-edge.js';
import { straightOverlaysAsDrawn as straightOverlays } from './read/overlay-straight.js';
import { straightFell, tapVerdict } from './objective.js';

export { GROUP_LABEL_GEOMETRY } from './title-room.js';
const OUTWARD: Record<Side, Point> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** A point stage 8 must reach outside every obstacle to honour this placement. */
export interface RouterEntryPoint {
  link: string;
  end: 'from' | 'to';
  node: string;
  port: PortRef;
  side: Side;
  kind: 'stem' | 'shared';
  point: Point;
  /** Distance of `point` from the anchor along the port's outward normal. */
  outward: number;
}

const measurement = measureTitle;

/** One title: a group's own, or a frame's, held by the one rank cell `host` (ranked-groups spec, section 2). */
interface Title { id: string; host: string; frame?: string; label: string; side: 'top' | 'bottom' }
/** A canton's title: held by the sub-tier, so it names no host cell (canton-groups spec, section 3). */
interface CantonTitle { id: string; label: string; side: 'top' | 'bottom' }

/**
 * The title edge of a frame (ADR-0011, read across all its cells): the horizontal edge with fewer
 * routed link ports on links that cross the frame's boundary. A link between two cells of one frame
 * is inside the frame and asks nothing of the title; ties keep the top.
 *
 * The title lives in one of the frame's OWN cells, never in a cell of a child frame, so an edge is
 * allowed only where an own cell is the frame's extreme cell. When the preferred edge has none, the
 * other edge is taken; a frame with an own cell on neither edge has no title edge (`undefined`).
 */
export function frameSide(model: LayoutModel, frame: string): 'top' | 'bottom' | undefined {
  return rawFrameSide(model, frame);
}

/** ADR-0011's edge (`frameTitleSide`, `title-room.ts`): the mesh bus reads this one, since a bus side is fixed at stage 5. */
export function rawFrameSide(model: LayoutModel, frame: string): 'top' | 'bottom' | undefined {
  return frameTitleSide(model, frame);
}

/** The text a band's title reads: its frame's or canton's label, or its group's own. */
function titleText(model: LayoutModel, band: LabelBand): string {
  return band.host !== undefined || isCantonFrame(model, band.group) ? model.document.frames![band.group]!.label : model.document.groups[band.group]!.label;
}

/** Whether `side` of this group's box carries a title: its own, or the frame title its cell hosts. */
export function carriesTitle(model: LayoutModel, group: LayoutGroup, side: 'top' | 'bottom'): boolean {
  if (group.frame === undefined) return bandSide(model, group) === side;
  return frameSide(model, group.frame) === side && frameHost(model, group.frame, side) === group.id;
}

/**
 * The canton titles, one per canton frame, on the edge ADR-0011 picks for the whole canton (`frameTitleEdge`
 * reads every node of the members). Empty while a cell has no box: the band is measured from the members.
 */
function cantonTitles(model: LayoutModel): CantonTitle[] {
  const frames = model.document.frames ?? {};
  return Object.keys(frames).filter(id => isCantonFrame(model, id)).map(id => ({ id, label: frames[id]!.label, side: frameTitleEdge(model, id) }));
}

/** The canton frames as their members stand, before the title band is added to them. */
function cantonBoxes(model: LayoutModel): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  for (const frame of deriveFrames(model, false) ?? []) if (frame.kind === 'canton') boxes.set(frame.id, frame.box);
  return boxes;
}

/** The first and the last sub-tier a canton spans. */
export function cantonTiers(model: LayoutModel, id: string): { first: number; last: number } {
  const tiers = frameSubtreeCells(model.document.frames ?? {}, id).map(cell => model.groups[cell]!.tier!);
  return { first: Math.min(...tiers), last: Math.max(...tiers) };
}

/**
 * Every title in the diagram, in group order: one per group that is not a rank cell, and one per
 * frame that has a title edge, at the own cell that holds it. A cell owns no title of its own.
 */
function titles(model: LayoutModel): Title[] {
  const frames = model.document.frames ?? {}, hosted = new Map<string, Title>();
  for (const id of Object.keys(frames)) {
    const side = frameSide(model, id);
    if (side === undefined) continue;
    const host = frameHost(model, id, side)!;
    hosted.set(host, { id, host, frame: id, label: frames[id]!.label, side });
  }
  return orderedGroupIds(model.document).flatMap((id): Title[] => {
    const group = model.groups[id]!;
    if (group.frame === undefined) return [{ id, host: id, label: model.document.groups[id]!.label, side: bandSide(model, group) }];
    const title = hosted.get(id);
    return title === undefined ? [] : [title];
  });
}

/**
 * Widest routed stroke this placement must keep clear; stage 8 may not exceed it.
 *
 * Memoised on the link array for the same reason as `routedStrokeWidth`, and under the same rule:
 * every reservation that is stroke-aware asks for this number, many of them inside per-port or
 * per-pair loops, and `layer` and `strokeWidth` are written in stage 1 alone, so one array
 * identity has one answer.
 */
const widestRoutedStroke = new WeakMap<readonly LayoutModel['links'][number][], number>();
export function routedStroke(model: LayoutModel): number {
  const memo = widestRoutedStroke.get(model.links);
  if (memo !== undefined) return memo;
  let widest: number = DEFAULT_STROKE_WIDTHS.path;
  for (const link of model.links) {
    if (link.layer !== 'routed') continue;
    const width = linkStrokeWidth(link);
    if (width > widest) widest = width;
  }
  widestRoutedStroke.set(model.links, widest);
  return widest;
}
function strokeAllowance(model: LayoutModel): number { return routedStroke(model) / 2; }

/**
 * How far a node's routing obstacle reaches beyond its drawn rectangle. This is the one definition
 * of that distance; `route/obstacles` builds the rectangle itself from the same constants, and
 * placement reserves against it before any path exists.
 */
export function nodeObstacleReach(model: LayoutModel, node: LayoutModel['nodes'][string],
  stroke = routedStroke(model)): number {
  return GROUP_LABEL_GEOMETRY.nodeClearance + ((node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) + stroke) / 2;
}

/**
 * How far apart the router nudges two routes that run side by side, and so the least room a
 * reservation must leave beside anything another link still has to reach: at less than this the
 * router refuses the corridor rather than narrowing it. `routeParameters` hands this exact figure to
 * libavoid as `idealNudgingDistance`, and placement measures against the same one, so a reservation
 * cannot leave a gap stage 8 will not use.
 */
export function nudgingDistance(model: LayoutModel): number {
  return GROUP_LABEL_GEOMETRY.nodeClearance + routedStroke(model);
}

/**
 * Outward distance of the ordinary checkpoint at a node. It is the 15 px stem, unless that node's
 * stroke-expanded routing obstacle already reaches further; then it clears that obstacle instead.
 */
export function stemReach(model: LayoutModel, node: LayoutModel['nodes'][string]): number {
  return Math.max(GROUP_LABEL_GEOMETRY.routerStem, nodeObstacleReach(model, node) + GROUP_LABEL_GEOMETRY.entryTolerance);
}

/**
 * Outward distance of the ordinary checkpoint on one node side: the node's `stemReach`, or beyond the text of every pill of
 * that side where that reaches further (`sidePillTextReach`, ticket 156). A run that starts or turns at a tip under pill text
 * crosses it (G3). Ordinary stems and their row-gap room read this text depth. Fan peel rows and their nested base instead
 * reserve `sidePillBodyReach`, beyond the pill bodies and strokes.
 */
export function sideStemReach(model: LayoutModel, node: LayoutNode, side: Side): number {
  return Math.max(stemReach(model, node), sidePillTextReach(model, node, side));
}

/** `sideStemReach` at one port's side; a port with no side yet keeps the node's `stemReach`. */
export function portStemReach(model: LayoutModel, port: LayoutPort): number {
  const node = model.nodes[port.ref.node]!;
  return port.side === undefined ? stemReach(model, node) : sideStemReach(model, node, port.side);
}

/**
 * Every outward point stage 8 must consume: the outward checkpoint of each routed attachment and
 * each vertex of its mandatory shared prefix. Neither input depends on whether the link already
 * carries a path, so completing a remainder in stage 8 cannot retire the reservation.
 *
 * The checkpoint is the one `stemCheckpoint` really asks for, not a flat 15 px: the ordinary stem,
 * unless the node's expanded obstacle or the pill text of the port's side reaches further (`portStemReach`), deeper still where a row gap gave the leg a
 * slot (ADR-0015 rule 1) or where a node side nested its stems (its twelfth amendment). Reading it
 * from one place is what keeps the figure `clearanceFor` reserves and the figure stage 8 receives
 * the same one. A nested side's depth is measurably inert here today — a side that carries its
 * group's title never nests, and `clearanceFor` reads only the entries on the band's own side, so
 * over 1 103 corpus inputs no band moves for one — and it is read all the same, so the two figures
 * cannot drift apart later.
 */
export function routerEntryPoints(model: LayoutModel): RouterEntryPoint[] {
  const result: RouterEntryPoint[] = [];
  // One gap plan per row gap for this pass; nothing moves while it runs.
  const gaps = stemCache();
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    // A straight link inside one frame asks the router for no stem, so it reserves no room (ticket 34).
    if (isRoutedChord(model, link)) continue;
    for (const end of ['from', 'to'] as const) {
      const ref = link.attachments[end], port = findPort(model, ref);
      if (!port?.anchor || !port.side) continue;
      const anchor = port.anchor, delta = OUTWARD[port.side];
      const common = { link: link.id, end, node: ref.node, port: { ...port.ref }, side: port.side };
      // The same figure `stemCheckpoint` gives stage 8, a leg's reserved slot included.
      const stem = stemDepth(model, port, gaps);
      result.push({ ...common, kind: 'stem', outward: stem,
        point: { x: anchor.x + stem * delta.x, y: anchor.y + stem * delta.y } });
      for (const segment of link.sharedRuns?.[end] ?? []) for (const point of [segment.from, segment.to]) {
        result.push({ ...common, kind: 'shared', point: { ...point },
          outward: (point.x - anchor.x) * delta.x + (point.y - anchor.y) * delta.y });
      }
    }
  }
  return result;
}

/** Keep required entry points below the band, reserving clearance for any valid label position. */
export function bandEntryConflicts(model: LayoutModel, entries = routerEntryPoints(model)): { band: LabelBand; entry: RouterEntryPoint }[] {
  const allowance = strokeAllowance(model), result: { band: LabelBand; entry: RouterEntryPoint }[] = [];
  for (const entry of entries) for (const band of model.labelBands) {
    const box = band.bounds;
    if (entry.point.x >= box.x - allowance - PLACEMENT_EPS && entry.point.x <= right(box) + allowance + PLACEMENT_EPS
      && entry.point.y >= box.y - allowance - PLACEMENT_EPS && entry.point.y <= bottom(box) + allowance + PLACEMENT_EPS) result.push({ band, entry });
  }
  return result;
}

/**
 * The edge a group's title occupies: the horizontal edge with fewer incident routed link ports, so
 * the title sits opposite the links that enter the group and nothing has to route around it. Ties,
 * including groups linked only through left/right ports, keep the top. Reads frozen port topology
 * only, so placement, publication and restore agree.
 */
export function bandSide(model: LayoutModel, group: LayoutGroup): 'top' | 'bottom' {
  return rawBandSide(model, group);
}

/** ADR-0011's edge (`groupTitleEdge`). */
export function rawBandSide(model: LayoutModel, group: LayoutGroup): 'top' | 'bottom' {
  return groupTitleEdge(model, group);
}

/** Reserved gap beside the band; entry points of this group's own ports on that side must clear it. */
function clearanceFor(model: LayoutModel, group: LayoutGroup, entries: RouterEntryPoint[], side: 'top' | 'bottom'): number {
  const members = new Set(group.nodes);
  const reach = Math.max(0, ...entries.filter(entry => entry.side === side && members.has(entry.node)).map(entry => entry.outward));
  const room = detourLabelRoom(model, group);
  // An in-frame bus on the title edge lies between the bodies and the title: the clearance grows by the bus band.
  const bus = busRoom(model, group)[side];
  if (reach <= 0) return Math.max(groupPadding(model, group)[side], room) + bus;
  return Math.max(groupPadding(model, group)[side], room, reach + strokeAllowance(model) + GROUP_LABEL_GEOMETRY.entryTolerance) + bus;
}

type SameTierEnds = { leftPort: LayoutPort; leftNode: LayoutNode; rightPort: LayoutPort; rightNode: LayoutNode };
/**
 * The one reading of which same-tier described links have a run to lengthen (ADR-0014): both ports
 * on a left or right side, and facing each other across the gap — a right port on the left end, a
 * left port on the right end. Ports on the same side, or facing away, wrap around their nodes and
 * the router places the wrapping leg where it likes, so no anchor distance bounds that run. The
 * reservation and the title-band clearance both ask here, so neither moves anything for a link the
 * other diagnoses.
 */
function sameTierEnds(from: LayoutPort, fromNode: LayoutNode, to: LayoutPort, toNode: LayoutNode): SameTierEnds | { unreservable: string } {
  if (!['left', 'right'].includes(from.side!) || !['left', 'right'].includes(to.side!)) return { unreservable: 'joins two nodes of one tier through top or bottom ports' };
  const [leftPort, leftNode, rightPort, rightNode] = from.anchor!.x <= to.anchor!.x ? [from, fromNode, to, toNode] : [to, toNode, from, fromNode];
  if (leftPort.side !== 'right' || rightPort.side !== 'left') return { unreservable: 'does not face its peer across the gap' };
  return { leftPort, leftNode, rightPort, rightNode };
}

/**
 * A described link between two nodes of one row that has a third node between them will detour
 * around that node, hugging it at node clearance, and its label then follows that run (ADR-0014).
 * The band under the title reserves the room that label needs: the title's link margin, the label
 * height, its normal gap and stroke, and the node clearance the run keeps. Without it the run sits
 * between the title margin and the node with no side free, and the longest segment goes unused.
 */
function detourLabelRoom(model: LayoutModel, group: LayoutGroup): number {
  let room = 0;
  for (const link of model.links) {
    const text = model.document.links[link.sourceIndex]?.label;
    if (!text || link.layer !== 'routed' || link.technique === 'stub' || link.bundle || !link.attachments) continue;
    if (effectiveLayer(link) === 'overlay') continue;
    const fromTier = model.groups[model.document.nodes[link.attachments.from.node]!.group]!.tier;
    if (fromTier !== group.tier || model.groups[model.document.nodes[link.attachments.to.node]!.group]!.tier !== group.tier) continue;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    if (!from?.anchor || !to?.anchor || link.attachments.from.node === link.attachments.to.node) continue;
    const ends = sameTierEnds(from, model.nodes[link.attachments.from.node]!, to, model.nodes[link.attachments.to.node]!);
    if ('unreservable' in ends) continue;
    const low = ends.leftPort.anchor!.x, high = ends.rightPort.anchor!.x;
    // The detour runs over this group's nodes when one of them lies between the two ends of the link.
    const between = group.nodes.some(id => id !== link.attachments!.from.node && id !== link.attachments!.to.node
      && model.nodes[id]!.bounds!.x < high && right(model.nodes[id]!.bounds!) > low);
    if (!between) continue;
    const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
    const nodeStroke = Math.max(DEFAULT_STROKE_WIDTHS.node, ...group.nodes.map(id => model.nodes[id]!.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node));
    room = Math.max(room, GROUP_LABEL_LINK_CLEARANCE + measured.height + LINK_LABEL_GEOMETRY.normalGap + linkStrokeWidth(link)
      + GROUP_LABEL_GEOMETRY.nodeClearance + (nodeStroke + linkStrokeWidth(link)) / 2 + GROUP_LABEL_GEOMETRY.entryTolerance);
  }
  return room;
}

/** The band of a canton's title: as wide as the members' box, on the edge outside it. */
function cantonBandFor(title: CantonTitle, box: Rect): LabelBand {
  const height = measurement(title.label).height + GROUP_LABEL_GEOMETRY.bandExtra;
  return { id: `label-band:${title.id}`, group: title.id, owner: { kind: 'group', id: title.id }, layer: 'routed', side: title.side,
    bounds: { x: box.x, y: title.side === 'top' ? box.y - height : bottom(box), width: box.width, height },
    // The margin between the band and the member frames, already inside `box`.
    clearance: GROUP_PADDING };
}

function bandFor(model: LayoutModel, title: Title, entries: RouterEntryPoint[]): LabelBand {
  const group = model.groups[title.host]!, measured = measurement(title.label), side = title.side;
  const height = measured.height + GROUP_LABEL_GEOMETRY.bandExtra;
  return { id: `label-band:${title.id}`, group: title.id, ...(title.frame !== undefined ? { host: title.host } : {}),
    owner: { ...group.owner }, layer: 'routed', side,
    bounds: { x: group.bounds!.x, y: side === 'top' ? group.bounds!.y : bottom(group.bounds!) - height,
      width: group.bounds!.width, height },
    clearance: clearanceFor(model, group, entries, side) };
}


/** Every band the current geometry calls for: the titles of groups and cells, then the canton titles. */
function expectedBands(model: LayoutModel, entries: RouterEntryPoint[]): LabelBand[] {
  const cantons = cantonTitles(model), boxes = cantons.length ? cantonBoxes(model) : new Map<string, Rect>();
  return [...titles(model).map(title => bandFor(model, title, entries)),
    ...cantons.filter(title => boxes.has(title.id)).map(title => cantonBandFor(title, boxes.get(title.id)!))];
}

/**
 * Rebuild every band from current group geometry; reports a changed reservation for replay.
 * Reserved link geometry is rebuilt only by the ordered replay, so a caller that has just moved
 * boxes must supply the entry points it measured while the two agreed.
 */
function syncBands(model: LayoutModel, entries = routerEntryPoints(model)): boolean {
  const before = new Map(model.labelBands.map(band => [band.group, band.clearance]));
  model.labelBands = expectedBands(model, entries);
  const busBands = expectedBusBands(model);
  if (busBands.length) model.busBands = busBands; else delete model.busBands;
  syncBusGeometry(model);
  return model.labelBands.some(band => before.has(band.group) && Math.abs(before.get(band.group)! - band.clearance) > PLACEMENT_EPS);
}

function intersectsY(rect: Rect, y: number, height: number): boolean {
  return rect.y <= y + height + PLACEMENT_EPS && bottom(rect) >= y - PLACEMENT_EPS;
}

/** Identity of one owned rectangle, taken from semantic fields so key order cannot change it. */
function ownedRectKey(bounds: Rect, owner: Owner): string {
  const fields = owner.kind === 'barCross' ? [owner.node, owner.link] : [owner.id];
  // An array keeps the field order fixed, and string escaping keeps an authored ID unambiguous.
  return JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height, owner.kind, ...fields]);
}

function segmentRect(segment: PathSegment, stroke: number): Rect {
  const x = Math.min(segment.from.x, segment.to.x) - stroke, y = Math.min(segment.from.y, segment.to.y) - stroke;
  return { x, y, width: Math.abs(segment.to.x - segment.from.x) + 2 * stroke,
    height: Math.abs(segment.to.y - segment.from.y) + 2 * stroke };
}

/**
 * Reserved link geometry in one stable order: the complete path, partially fixed lane runs, then
 * the mandatory outward shared runs of both ends. A complete bundle path repeats the runs it
 * consumed, so identical stroke-aware rectangles with identical ownership collapse to one entry.
 */
function linkRects(model: LayoutModel, link: LayoutModel['links'][number]): ForbiddenRect[] {
  const stroke = linkStrokeWidth(link) / 2;
  // A stage-8 remainder (`fixed: false`) is routed around this placement, so only the runs a rule
  // reserved count here; re-deriving a label against a later route would let routing move it.
  let reserved = link.path?.fixed === false ? [] : link.path?.segments ?? [];
  // A cross-frame chord reserves the part of its run inside each title band it crosses, not the box of the whole run: it crosses the band of its
  // own end beside the title (ticket 100, docs/design/routed-chords.md Section 6). A diagonal segment, a chord's or a straight member's,
  // reserves nothing from a title (ticket 162); an orthogonal one keeps its box.
  const crossings = chordCrossings(model, link);
  if (crossings) reserved = [];
  const sources: [string, PathSegment[]][] = [['path', reserved],
    ['fixed', link.fixedSegments ?? []], ['shared:from', link.sharedRuns?.from ?? []],
    ['shared:to', link.sharedRuns?.to ?? []]];
  const seen = new Set<string>(), result: ForbiddenRect[] = [];
  for (const [kind, segments] of sources) for (const [index, segment] of segments.entries()) {
    // A diagonal may cross a title (ticket 162, ADR-0023): the title stands over it, and its halo keeps it readable.
    if (diagonalMayCross(segment, GROUP_TITLE)) continue;
    const bounds = segmentRect(segment, stroke), key = ownedRectKey(bounds, segment.owner);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `${link.id}:${kind}:${index}`, bounds, clearance: GROUP_LABEL_LINK_CLEARANCE, links: [link.id] });
  }
  // The margin is in the rectangle (it is wider on a slanted chord), so no clearance is added.
  for (const { band, bounds } of crossings ?? []) result.push({ id: `${link.id}:chord:${band.group}`, bounds, links: [link.id] });
  return result;
}

/** The label bands a held cross-frame chord crosses, with its crossing rectangle in each: its run between the band's top and bottom y, grown by half the stroke. */
function chordCrossings(model: LayoutModel, link: LayoutModel['links'][number]): { band: LabelBand; bounds: Rect }[] | undefined {
  if (link.technique !== 'straight' || !isRoutedChord(model, link) || chordKind(model, link) !== 'cross') return undefined;
  const segment = link.path!.segments[0]!, half = linkStrokeWidth(link) / 2, result: { band: LabelBand; bounds: Rect }[] = [];
  // A diagonal chord may cross a title (ticket 162, ADR-0023): it takes no room in any band. A vertical one keeps its crossings.
  if (diagonalMayCross(segment, GROUP_TITLE)) return result;
  for (const band of model.labelBands) {
    const bounds = crossingRect(segment, band.bounds.y, bottom(band.bounds), half);
    if (bounds && bounds.x <= right(band.bounds) && right(bounds) >= band.bounds.x) result.push({ band, bounds });
  }
  return result;
}

/**
 * A reserved rectangle a label must avoid; `clearance` is the title's link-free margin for link geometry. `links` names the links of link
 * geometry (a title the rectangle crosses records them, `crossedBy`); `hard` marks text and bodies, which a title never stands on.
 */
export interface ForbiddenRect { id: string; bounds: Rect; clearance?: number; links?: readonly string[]; hard?: true }

/** Every reserved rectangle a group label must avoid, with stable semantic IDs. */
export function groupLabelObstacles(model: LayoutModel, placed: LayoutLabel[] = []): ForbiddenRect[] {
  return forbiddenRects(model, placed);
}

function forbiddenRects(model: LayoutModel, placed: LayoutLabel[]): ForbiddenRect[] {
  const result: ForbiddenRect[] = [];
  for (const node of Object.values(model.nodes)) {
    const half = (node.strokeWidth ?? DEFAULT_STROKE_WIDTHS.node) / 2;
    result.push({ id: `node:${node.id}`, bounds: { x: node.bounds!.x - half, y: node.bounds!.y - half,
      width: node.bounds!.width + 2 * half, height: node.bounds!.height + 2 * half }, hard: true });
    for (const port of node.ports) if (port.pill) {
      const p = port.pill.bounds, gap = DEFAULT_STROKE_WIDTHS.pill / 2;
      result.push({ id: `pill:${portId(port.ref)}`, bounds: {
        x: p.x - gap, y: p.y - gap, width: p.width + 2 * gap, height: p.height + 2 * gap,
      }, hard: true });
    }
  }
  // Stage 9 labels are placed around this band, so re-deriving the band around them would let a
  // later label move an earlier frozen one. That covers the generated legend below the diagram as
  // well. The titles placed so far join through `placed`.
  const stageNine = (role: string | undefined): boolean => role === 'link' || role === 'legend';
  for (const label of [...model.labels.filter(item => item.role !== 'group' && !stageNine(item.role)), ...placed]) {
    if (!label.omitted && label.layer !== 'overlay' && label.bounds) result.push({ id: label.id, bounds: label.bounds, hard: true });
  }
  const margin = GROUP_LABEL_LINK_CLEARANCE;
  const ownedLinks = (owner: Owner): string[] => owner.kind === 'link' ? [owner.id]
    : owner.kind === 'bundle' ? [...model.bundles.find(bundle => bundle.id === owner.id)?.members ?? []] : [];
  for (const lane of model.lanes) if (lane.layer !== 'overlay') result.push({ id: lane.id, bounds: lane.bounds, clearance: margin, links: ownedLinks(lane.owner) });
  for (const bundle of model.bundles) {
    for (const [index, bounds] of (bundle.envelopeParts?.length ? bundle.envelopeParts : bundle.envelope ? [bundle.envelope] : [] as Rect[]).entries()) {
      result.push({ id: `${bundle.id}:envelope:${index}`, bounds, clearance: margin, links: [...bundle.members] });
    }
  }
  for (const obstacle of model.obstacles) if (obstacle.layer !== 'overlay') result.push({ id: obstacle.id, bounds: obstacle.bounds, clearance: margin, links: ownedLinks(obstacle.owner) });
  for (const link of model.links) result.push(...linkRects(model, link), ...feedCorridorRects(model, link));
  return result;
}

/**
 * A top/bottom feed whose two anchors already share an x, and whose straight corridor is clear of
 * everything placement has fixed, will be routed as that straight line in stage 8. The corridor is
 * therefore reserved here, so a label is never placed where the route then has to detour around it
 * — the pipeline's load-bearing rule. The check ignores group labels (this stage places them) and
 * stage-9 labels, so planning and restore see the same corridor.
 */
function feedCorridorRects(model: LayoutModel, link: LayoutModel['links'][number]): ForbiddenRect[] {
  if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments || link.bundle) return [];
  if (link.path && link.path.fixed !== false) return [];
  const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
  if (!from?.anchor || !to?.anchor || !from.side || !to.side) return [];
  const vertical = (from.side === 'bottom' && to.side === 'top') || (from.side === 'top' && to.side === 'bottom');
  if (!vertical || Math.abs(from.anchor.x - to.anchor.x) > PLACEMENT_EPS) return [];
  const segment: PathSegment = { from: { ...from.anchor }, to: { ...to.anchor }, owner: { kind: 'link', id: link.id } };
  const stageNine = (role: string | undefined): boolean => role === 'link' || role === 'legend';
  const view: LayoutModel = { ...model, labels: model.labels.filter(label => label.role !== 'group' && !stageNine(label.role)) };
  if (!straightCorridorClear(view, link, segment)) return [];
  return [{ id: `${link.id}:feed-corridor`, bounds: segmentRect(segment, linkStrokeWidth(link) / 2), clearance: GROUP_LABEL_LINK_CLEARANCE, links: [link.id] }];
}

/**
 * The leg every routed port on a title band's own edge must draw through that band (ticket 62): a vertical rectangle from the
 * port to the far side of the band, with the title's link-free margin. A title slides off these where a span is free; where none
 * is, it stands across them with its halo and records their links (`placeGroupTitles`, architecture-2 ticket 54).
 */
function legRects(model: LayoutModel): ForbiddenRect[] {
  const frames = model.document.frames ?? {};
  // A canton band stands under its last sub-tier (over its first): only the members of that edge tier draw a leg through it.
  const membersOf = (band: LabelBand): Set<string> => {
    if (!isCantonFrame(model, band.group)) return new Set(model.groups[band.host ?? band.group]?.nodes ?? []);
    const tiers = cantonTiers(model, band.group), edge = band.side === 'top' ? tiers.first : tiers.last;
    return new Set(frameSubtreeCells(frames, band.group).filter(cell => model.groups[cell]?.tier === edge).flatMap(cell => model.groups[cell]!.nodes));
  };
  return legRectsFor(model, model.labelBands.map(band => ({ id: band.group, bounds: band.bounds, side: band.side, members: membersOf(band) })));
}

/** A title band, or the strip that stands for it before 7f: where it is, on which edge, and the nodes whose ports on that edge draw a leg through it. */
export interface LegBand { id?: string; bounds: Rect; side: 'top' | 'bottom'; members: ReadonlySet<string> }

/**
 * `legRects` for the given bands; `skip` leaves out the legs of one link.
 */
export function legRectsFor(model: LayoutModel, owned: readonly LegBand[], skip?: string): ForbiddenRect[] {
  const result: ForbiddenRect[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments || link.bundle) continue;
    if (isRoutedChord(model, link) || link.id === skip) continue;
    const stroke = routedStroke(model);
    for (const end of ['from', 'to'] as const) {
      const ref = link.attachments[end], port = findPort(model, ref);
      if (!port?.anchor || (port.side !== 'top' && port.side !== 'bottom')) continue;
      const anchor = port.anchor;
      for (const { side, bounds: box, members } of owned) {
        if (side !== port.side || !members.has(ref.node)) continue;
        if (anchor.x < box.x - PLACEMENT_EPS || anchor.x > right(box) + PLACEMENT_EPS) continue;
        const y = Math.min(anchor.y, box.y), far = Math.max(anchor.y, bottom(box));
        result.push({ id: `${link.id}:leg:${end}`, bounds: { x: anchor.x - stroke / 2, y, width: stroke, height: far - y }, clearance: GROUP_LABEL_LINK_CLEARANCE, links: [link.id] });
      }
    }
  }
  // A stub of an across-frames bus leaves its port through the padding and the label band of the member's frame on the bus side: a leg
  // of the band's ports, so the title stands clear of it as of a routed leg (mesh-bus.md, section 4, *A stub through a title band*).
  for (const bus of model.meshBuses ?? []) {
    if (bus.placement !== 'across-frames' || bus.side === undefined) continue;
    for (const ref of bus.ports) {
      const port = findPort(model, ref);
      if (!port?.anchor) continue;
      for (const { side, bounds: box, members } of owned) {
        if (side !== bus.side || !members.has(ref.node)) continue;
        const stroke = routedStroke(model);
        if (port.anchor.x < box.x - PLACEMENT_EPS || port.anchor.x > right(box) + PLACEMENT_EPS) continue;
        const y = Math.min(port.anchor.y, box.y), far = Math.max(port.anchor.y, bottom(box));
        result.push({ id: `${bus.id}:stub:${ref.node}`, bounds: { x: port.anchor.x - stroke / 2, y, width: stroke, height: far - y }, clearance: GROUP_LABEL_LINK_CLEARANCE });
      }
    }
  }
  // The riser of a join crosses each title band it passes through as a leg: the title stands clear of it (mesh-bus.md, section 11.5). Its x is fixed
  // in 7a, so 7f places the title against a known x. It runs from the upper row to the lower row, so a band strictly between them is crossed.
  for (const bus of model.meshBuses ?? []) {
    if (bus.riser === undefined || bus.cross === undefined) continue;
    const lower = model.meshBuses!.find(item => item.id === bus.joined);
    if (lower === undefined) continue;
    const stroke = routedStroke(model), tiers = model.tierBands;
    const top = tiers.find(item => item.tier === bus.row)?.bounds, bottomBand = tiers.find(item => item.tier === lower.row)?.bounds;
    if (top === undefined || bottomBand === undefined) continue;
    for (const { id, bounds: box } of owned) {
      if (bus.riser.x < box.x - PLACEMENT_EPS || bus.riser.x > right(box) + PLACEMENT_EPS) continue;
      if (bottom(box) <= bottom(top) - PLACEMENT_EPS || box.y >= bottomBand.y + PLACEMENT_EPS) continue;
      result.push({ id: `${bus.id}:riser:${id}`, bounds: { x: bus.riser.x - stroke / 2, y: box.y, width: stroke, height: box.height }, clearance: GROUP_LABEL_LINK_CLEARANCE });
    }
  }
  return result;
}

/** Whether a blocker meets a title's rectangle: their boxes overlap or touch once the blocker carries its clearance (the title's link-free margin). */
function meets(item: ForbiddenRect, label: Rect): boolean {
  const margin = item.clearance ?? 0;
  return intersectsY(item.bounds, label.y - margin, label.height + 2 * margin)
    && label.x <= right(item.bounds) + margin + PLACEMENT_EPS && right(label) >= item.bounds.x - margin - PLACEMENT_EPS;
}

/**
 * What a group title yields to and what it may not stand on (architecture-2 ticket 54): the reserved rectangles of `groupLabelObstacles`
 * and the legs of every title band's ports with their bus stubs and risers (`legRects`). `placed` are the titles already placed.
 * Text (a node, a pill, a label, a placed title) is `hard`; the rest is link geometry, which names its routed links. One reader
 * for the placement (`placeGroupTitles`) and for the validator (R1).
 */
function titleBlockers(model: LayoutModel, placed: LayoutLabel[]): ForbiddenRect[] {
  return [...forbiddenRects(model, placed), ...legRects(model)];
}

/**
 * The routed links a title at `label` crosses: the links of every blocker that meets it, in id order. A diagonal reserves nothing from a
 * title (ticket 162), so it is never here; an overlay link is never here (it is gate-exempt and draws under the title).
 */
function crossings(model: LayoutModel, blockers: readonly ForbiddenRect[], label: Rect): string[] {
  const routed = new Set(model.links.filter(link => effectiveLayer(link) === 'routed').map(link => link.id));
  return [...new Set(blockers.filter(item => meets(item, label)).flatMap(item => item.links ?? []).filter(id => routed.has(id)))].sort();
}

/** The warning of a group title that no x of its band keeps clear of text (`placeGroupTitles`); the validator reads it. */
const TITLE_ON_TEXT = 'GROUP_TITLE_ON_TEXT';

/** One title to place: its label id, text, the band it stands in, and the x range its left edge may take (the band less the insets). */
interface TitleSlot { id: string; owner: Owner; text: string; band: LabelBand; start: number; limit: number; centre: number; gap: number }

/** The title of each band, ordered by the tier gap its edge faces (the bottom edge of tier t and the top edge of tier t + 1 face gap t), then id (R3). */
function titleSlots(model: LayoutModel): TitleSlot[] {
  const slots = model.labelBands.map((band): TitleSlot => {
    const canton = isCantonFrame(model, band.group), text = titleText(model, band), width = measurement(text).width;
    const holder = canton ? band.bounds : model.groups[band.host ?? band.group]!.bounds!;
    const tiers = canton ? cantonTiers(model, band.group) : undefined, tier = tiers ? (band.side === 'top' ? tiers.first : tiers.last) : model.groups[band.host ?? band.group]!.tier!;
    const start = holder.x + GROUP_LABEL_GEOMETRY.horizontalInset;
    return { id: `label:group:${band.host ?? band.group}`, owner: canton ? { ...band.owner } : { ...model.groups[band.host ?? band.group]!.owner },
      text, band, start, limit: right(holder) - GROUP_LABEL_GEOMETRY.horizontalInset - width,
      centre: holder.x + (holder.width - width) / 2, gap: band.side === 'bottom' ? tier : tier - 1 };
  });
  // Last key: the label id, unique per band.
  return slots.sort((a, b) => a.gap - b.gap || a.id.localeCompare(b.id));
}

/** The x a title's left edge may take, nearest the centre first and then the left one: the centre, the band ends and both sides of every blocker. */
function titleCandidates(slot: TitleSlot, blockers: readonly ForbiddenRect[], width: number): number[] {
  return [slot.centre, slot.start, slot.limit, ...blockers.flatMap(item => [
    item.bounds.x - (item.clearance ?? 0) - width - LABEL_CLEARANCE_STEP, right(item.bounds) + (item.clearance ?? 0) + LABEL_CLEARANCE_STEP])]
    .filter(x => x >= slot.start - PLACEMENT_EPS && x <= slot.limit + PLACEMENT_EPS)
    .sort((a, b) => Math.abs(a - slot.centre) - Math.abs(b - slot.centre) || a - b);
}

/** The title label at left edge `x`, with the crossing record. */
function titleLabel(slot: TitleSlot, x: number, crossedBy: string[], halo: boolean): LayoutLabel {
  const measured = measurement(slot.text);
  return { id: slot.id, owner: slot.owner, layer: 'routed', role: 'group', text: slot.text, fontFamily: GROUP_LABEL_GEOMETRY.fontFamily,
    fontSize: GROUP_LABEL_GEOMETRY.fontSize, fontWeight: GROUP_LABEL_GEOMETRY.fontWeight, lineHeight: measured.lineHeight, lines: measured.lines,
    textRotation: 0, bounds: { x, y: slot.band.bounds.y + GROUP_LABEL_GEOMETRY.verticalInset, width: measured.width, height: measured.height },
    crossedBy, ...(halo ? { yield: 'halo' as const } : {}) };
}

/**
 * Place every group title once, at the end of 7f (architecture-2 ticket 54, "titles last"): a title yields to every link. Per band, in gap
 * order then id order (R3), the left edge nearest the centre of its holder (the host cell's box, or the canton band) where no blocker meets
 * it (`titleBlockers`: legs, lanes, stubs, risers, reserved runs, pills, other text and the titles placed before it); a tie goes left. With
 * no such span the title stands at the centre, or at the free x nearest it where the centre stands on text (text against text stays
 * hard), and takes the halo: `yield: 'halo'`, and `crossedBy` names the routed links that cross it. A slid title records `crossedBy: []`.
 * Absent `crossedBy` means the title is not placed (R1). It moves nothing, grows nothing and retries nothing; the validator reads the record.
 */
export function placeGroupTitles(model: LayoutModel): void {
  model.labels = model.labels.filter(label => label.role !== 'group');
  const placed: LayoutLabel[] = [];
  for (const slot of titleSlots(model)) {
    const blockers = titleBlockers(model, placed), measured = measurement(slot.text);
    const y = slot.band.bounds.y + GROUP_LABEL_GEOMETRY.verticalInset;
    const box = (x: number): Rect => ({ x, y, width: measured.width, height: measured.height });
    const candidates = titleCandidates(slot, blockers, measured.width);
    const free = candidates.find(x => !blockers.some(item => meets(item, box(x))));
    const hard = blockers.filter(item => item.hard === true);
    // A title wider than its band less the insets (a box no floor holds: a group with no nodes, a box the lanes hold) stands at the left inset.
    const x = free ?? candidates.find(at => !hard.some(item => meets(item, box(at)))) ?? Math.max(slot.start, Math.min(slot.limit, slot.centre));
    if (slot.limit < slot.start - PLACEMENT_EPS) placementWarning(model, 'GROUP_LABEL_GAP_INFEASIBLE', `The title of ${slot.band.group} is wider than its band; it stands at the left inset and the final gates decide.`, [slot.band.group], 'group');
    // No x of the band is clear of text: the title stands on it, named, and G3 judges it (R6). The validator proves that no x was clear.
    if (hard.some(item => rectOverlap(item.bounds, box(x)))) placementWarning(model, TITLE_ON_TEXT, `The title of ${slot.band.group} finds no place in its band clear of text; it stands on text and G3 judges it.`, [slot.band.group], 'group');
    const label = titleLabel(slot, x, free === undefined ? crossings(model, blockers, box(x)) : [], free === undefined);
    placed.push(label);
  }
  model.labels.push(...placed);
}

/**
 * The group titles read from their record (R1, R5; architecture-2 ticket 54): one per band, inside its band less the insets (a title wider
 * than that stands at the left inset), clear of
 * every node, pill and other text, and `crossedBy` equal to the routed links that cross it on the geometry (`crossings`). A slid title
 * (`yield` absent) meets no blocker. A missing record, a forged `crossedBy` or a label outside its band throws; nothing is placed again.
 */
function groupTitlesFault(model: LayoutModel): string | undefined {
  const titles = model.labels.filter(label => label.role === 'group'), slots = titleSlots(model);
  if (titles.length !== slots.length) return `${titles.length} group titles stand for ${slots.length} label bands`;
  for (const slot of slots) {
    const label = titles.find(item => item.id === slot.id);
    if (label === undefined || label.bounds === undefined) return `the title of ${slot.band.group} is missing`;
    if (label.crossedBy === undefined) return `${slot.id} carries no crossing record`;
    if (label.yield !== undefined && label.yield !== 'halo') return `${slot.id} names an unknown yield`;
    const bounds = label.bounds, y = slot.band.bounds.y + GROUP_LABEL_GEOMETRY.verticalInset;
    if (Math.abs(bounds.y - y) > PLACEMENT_EPS || bounds.x < slot.start - PLACEMENT_EPS || bounds.x > Math.max(slot.start, slot.limit) + PLACEMENT_EPS) {
      return `${slot.id} at x ${bounds.x}, y ${bounds.y} stands outside its band (x ${slot.start} to ${slot.limit}, y ${y})`;
    }
    const blockers = titleBlockers(model, titles.filter(item => item !== label));
    const text = blockers.find(item => item.hard === true && rectOverlap(item.bounds, bounds));
    // A title may stand on text only where no candidate x of its band is clear of it (a feasibility proof, not a choice: the validator's
    // blockers hold every placed title, a superset of the placement's, so it finds a clear x only where the placement found one).
    const hard = blockers.filter(item => item.hard === true), at = (x: number): Rect => ({ ...bounds, x });
    const clear = text === undefined ? undefined : titleCandidates(slot, blockers, bounds.width).find(x => !hard.some(item => meets(item, at(x))));
    if (text !== undefined && clear !== undefined) return `${slot.id} stands on ${text.id} where x ${clear} is clear of text`;
    if (label.yield === undefined && blockers.some(item => meets(item, bounds))) return `${slot.id} records no yield and meets ${blockers.find(item => meets(item, bounds))!.id}`;
    const expected = label.yield === undefined ? [] : crossings(model, blockers, bounds);
    if (!equal(label.crossedBy, expected)) return `${slot.id} records crossedBy [${label.crossedBy.join(', ')}] and is crossed by [${expected.join(', ')}]`;
  }
  return undefined;
}

/**
 * The columns hold their feed axis after a frame move (ranked-groups ticket 17). The push above moves a frame as a
 * whole and the label widening grows a cell to the right, so a frame that stood under its feed at stage 6 can
 * stand beside it after 7f, and the feed link jogs by the whole push. `holdColumnAxes` (ticket 16) pulls the
 * columns back under the same refusals (a pinned lane, an overlay partner that stays, a band gap). The slack is
 * 0: centring has spent it, the frames stand a band gap apart and `frameColumns` leaves a cell no room beyond
 * its box, so a pass that kept the stage 6 spacing (a band gap and the slack on both sides) would push every
 * pair of frames apart by the slack, and one that let a cell slide into it would leave a jog centring cannot
 * remove. The pass is idempotent, and 7f replays (`resyncLabelBands`), so a replay finds nothing to move.
 * Before the pull, the beside rows are packed against the frames again (ranked-groups ticket 61): the push moves a follower by the
 * whole growth of a cell that widened for its title, the frame grows by less, and the gap of 40 px would stay open. Flanks keep
 * their place; the anchor tier does not, unlike in centring.
 */
function holdColumnsAfterPush(model: LayoutModel): boolean {
  if (model.document.frames === undefined) return false;
  const before = new Map(Object.values(model.groups).map(group => [group, group.bounds!.x]));
  // The push above moves the cells after a widened cell by its whole growth, and a frame is derived off the bodies, so a title that
  // widens a member inside its frame grows the frame by less (ticket 61). The beside rows are packed against the frames again, the way
  // centring packs them: a gap of 40 px stays 40 px. Only the flanks keep their place: an anchor-tier member pushed by a neighbour's title is packed back too.
  packBesideRows(model, cell => !model.groups[cell]!.flank);
  holdColumnAxes(model, 0);
  // `moveGroup` leaves pill bounds behind, and the next reservation measures them.
  const moved = [...before].filter(([group, x]) => group.bounds!.x !== x);
  rebuildNodeGeometry(model, moved.flatMap(([group]) => group.nodes), 'current');
  return moved.length > 0;
}

/** The groups the beside rows would move on a copy of the model with the proposed boxes in place: the rows the grid must not open, judged one by one. */
function packOpens(model: LayoutModel, proposed: readonly { group: LayoutGroup; bounds: Rect }[]): Set<string> {
  // The pack writes group boxes, node boxes and port anchors (`moveGroup`) and nothing else, so only those two parts are copied.
  const trial = copyWithShared(model, allBut(model, ['groups', 'nodes']));
  for (const item of proposed) trial.groups[item.group.id]!.bounds = { ...item.bounds };
  const before = new Map(Object.values(trial.groups).map(group => [group.id, group.bounds!.x]));
  packBesideRows(trial, cell => !trial.groups[cell]!.flank);
  return new Set(Object.values(trial.groups).filter(group => Math.abs(group.bounds!.x - before.get(group.id)!) > PLACEMENT_EPS).map(group => group.id));
}
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every(id => b.has(id));

/** The beside rows are packed against the frames the grid widened; true when a group moved. The columns are not pulled here: the pull answers a push, and this move is the pack's alone. */
function packRowsAfterGrid(model: LayoutModel): boolean {
  if (model.document.frames === undefined) return false;
  const before = new Map(Object.values(model.groups).map(group => [group, group.bounds!.x]));
  packBesideRows(model, cell => !model.groups[cell]!.flank);
  const moved = [...before].filter(([group, x]) => group.bounds!.x !== x);
  rebuildNodeGeometry(model, moved.flatMap(([group]) => group.nodes), 'current');
  return moved.length > 0;
}

/**
 * The linked-group grid, then the rows it disturbed (ticket 136). The grid widens a box in place, which widens the derived frame, and a beside row
 * stood packed against the narrower one. The grid gives way to the pack: it refuses a widening that changes which groups the pack would move (`packOpens`,
 * named by `GROUP_GRID_YIELDS_TO_PACK`), so on a packed row it leaves the row packed. A row that stood open before the grid is packed once after it, the region
 * producers are replayed as any move asks, and the grid is read once more. At most `GRID_PACK_ROUNDS` rounds; when the grid still widens after them, the model is
 * left with the grid aligned and `GROUP_GRID_NON_CONVERGENCE` says a row may stand open. That warning is withdrawn by the next call that settles.
 * Returns whether the grid widened a box. With a shared `budget` the replay spends a pass of it.
 */
export function alignLinkedGroupGridAndPack(model: LayoutModel, budget?: CentreBudget): boolean {
  // A warning of an earlier call is stale once a later call settles: it is raised again below when this one does not.
  model.diagnostics = model.diagnostics.filter(item => !(item.code === 'GROUP_GRID_NON_CONVERGENCE' && item.message.startsWith(GRID_PACK_WARNING)));
  let widened = false;
  const replay = (): void => {
    const passes = budget?.passes ?? 0;
    rebuildRegionGeometry(model, budget, undefined, true);
    if (budget !== undefined) consumeGrowthPass(budget, passes);
  };
  for (let round = 0; round < GRID_PACK_ROUNDS; round++) {
    const grid = alignGrid(model);
    if (!grid.changed) return widened;
    widened = true;
    // A grid that refuses what the pack would undo widens onto a packed row and leaves it packed; a row that stood open before the grid is packed once.
    // A flank the grid moved asks for the region replay even when no beside row needs packing; one replay serves both. A box that only grew takes no replay: a replay
    // refits the boxes and undoes the grid. Its reservations were judged before it grew (`alignGrid`: `holdsMove`, `lanesHoldGrowth`, `gapsHoldGrowth`), and the validator
    // replays the same guards.
    if (!packRowsAfterGrid(model) && !grid.flanksMoved) return widened;
    replay();
  }
  // The grid still widened after the last pack. The model is left with the grid aligned (`validateGroupLabelBands` reads the grid, and accepts it) and a row may stand open: say so.
  const last = alignGrid(model);
  if (last.changed) {
    // A flank moved by this last reading stands off the regions reserved beside it: replayed with the budget as it is, spent or not.
    if (last.flanksMoved) replay();
    placementWarning(model, 'GROUP_GRID_NON_CONVERGENCE', `${GRID_PACK_WARNING} ${GRID_PACK_ROUNDS} rounds; the grid is left aligned and a beside row may stand open.`, [], 'group');
  }
  return widened;
}
const GRID_PACK_WARNING = 'The linked-group grid and the pack of the beside rows did not settle in';
/** The rounds of the grid and the pack: one to pack the rows a model stood open in, one to read the grid on the packed rows. The grid refuses a widening that changes which rows the pack moves, so a packed model needs no more. */
const GRID_PACK_ROUNDS = 2;

/**
 * The frames whose edge a foreign drop would run along move right by the smallest amount that leaves the band, and the frames after them
 * give way (ticket 75). The column plans keep the band already (`snapOut`); a mover that has no plan of its own (the push of a widened
 * neighbour, a lane reseated, a cell packed against its parent) can leave a frame in it, and this is the last word before the replays. A move a lane forbids is not made. Returns whether a
 * group moved; the caller replays the region producers and `resyncLabelBands` after it.
 */
export function settleKeepOut(model: LayoutModel): boolean {
  const before = new Map(Object.values(model.groups).map(group => [group, group.bounds!.x]));
  const short = derivedShortfalls(model), saved = geometrySnapshot(model);
  for (let round = 0; round < 8; round++) {
    // The frames after a moved one give way to the geometry the move made, so the sweep is read after the keep-out is applied and
    // both maps are applied together, until neither has anything left.
    const shifts = keepOutShifts(model);
    for (const [group, dx] of columnShifts(model, 0)) shifts.set(group, Math.max(shifts.get(group) ?? 0, dx));
    if (!shifts.size) break;
    const proposed = [...shifts].map(([group, dx]) => ({ group, bounds: { ...group.bounds!, x: group.bounds!.x + dx } }));
    if (!holdsMove(model, proposed)) break;
    const straight = straightOverlays(model), nodes = [...shifts.keys()].flatMap(group => group.nodes);
    for (const [group, dx] of shifts) moveGroup(model, group, dx, 0);
    rebuildNodeGeometry(model, nodes, 'current');
    // A move that leaves fewer overlay links straight is not made.
    const fewer = straightFell(straightOverlays(model), straight, true);
    tapVerdict('settleKeepOut', () => `${fewer} ${straight.length}`);
    if (fewer) {
      for (const [group, dx] of shifts) moveGroup(model, group, -dx, 0);
      rebuildNodeGeometry(model, nodes, 'current');
      break;
    }
  }
  // A sweep that ends with a hard separation (G9) broken or deepened is not made: a unit that does not give way, such as a flank beside the moved row,
  // keeps its band gap, and no close-up runs after this step. Judged once, on the sweep's end, as the frames after a moved one give way a round later
  // (ticket 162 measured a row that a keep-out pushed into its flank).
  const worse = worseSeparations(derivedShortfalls(model), short);
  if (worse.length > 0) {
    // Restored exactly as it stood, not moved back: an inverse translation leaves rounding in the boxes and the anchors.
    const moved = [...before.keys()].filter(group => saved.groups.get(group.id)!.x !== group.bounds!.x).map(group => group.id);
    restoreGeometry(model, saved);
    placementWarning(model, 'KEEP_OUT_UNDONE', `The keep-out of 7f was undone: its sweep broke or deepened the hard separations ${worse.join(', ')}; the frames stay in the drop clearance.`,
      moved, 'group');
  }
  return [...before].some(([group, x]) => group.bounds!.x !== x);
}

/** The group boxes, node boxes and port anchors as they stand, to restore exactly. */
type GeometrySnapshot = { groups: Map<string, Rect>; nodes: Map<string, Rect>; anchors: Map<string, (Point | undefined)[]> };
function geometrySnapshot(model: LayoutModel): GeometrySnapshot {
  return {
    groups: new Map(Object.values(model.groups).map(group => [group.id, { ...group.bounds! }])),
    nodes: new Map(Object.values(model.nodes).map(node => [node.id, { ...node.bounds! }])),
    anchors: new Map(Object.values(model.nodes).map(node => [node.id, node.ports.map(port => port.anchor && { ...port.anchor })])),
  };
}
function restoreGeometry(model: LayoutModel, saved: GeometrySnapshot): void {
  for (const group of Object.values(model.groups)) group.bounds = { ...saved.groups.get(group.id)! };
  for (const node of Object.values(model.nodes)) {
    node.bounds = { ...saved.nodes.get(node.id)! };
    node.ports.forEach((port, index) => { const anchor = saved.anchors.get(node.id)![index]; if (anchor) port.anchor = { ...anchor }; });
  }
  rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
}

/**
 * `closeCantons`, with the pill bounds of the moved groups rebuilt (`moveGroup` leaves them behind). Returns the farthest a group moved in x. A move leaves the region producers,
 * `syncBands` and `resyncLabelBands` to the caller: the bands are reserved in the geometry the caller replays after it.
 */
export function closeCantonsAndSettle(model: LayoutModel): number {
  const before = new Map(Object.values(model.groups).map(group => [group, group.bounds!.x]));
  const moved = closeCantons(model);
  const shifted = [...before].filter(([group, x]) => group.bounds!.x !== x);
  if (moved) rebuildNodeGeometry(model, shifted.flatMap(([group]) => group.nodes), 'current');
  // A plan that was tried and put back rebuilt the labels of its nodes, which leaves them at the end of the list, and publication compares
  // the node labels in node order. The node labels go back to their own slots in node order; no geometry is read or changed.
  const rank = new Map(Object.keys(model.nodes).map((id, index) => [id, index]));
  const slots = model.labels.flatMap((label, at) => label.owner.kind === 'node' && ['node', 'description', 'pill'].includes(label.role ?? '') ? [at] : []);
  const ordered = slots.map(at => model.labels[at]!).sort((a, b) => rank.get((a.owner as { id: string }).id)! - rank.get((b.owner as { id: string }).id)!);
  for (const [i, at] of slots.entries()) model.labels[at] = ordered[i]!;
  return moved ? Math.max(0, ...shifted.map(([group, x]) => Math.abs(group.bounds!.x - x))) : 0;
}

function consumeGrowthPass(budget: CentreBudget, before: number): void {
  if (budget.passes !== before) return;
  if (budget.remaining <= 0) return;
  budget.remaining--; budget.passes++;
}

/**
 * The title bands and in-frame bus bands, reserved at the start of 7f, before any round (architecture-2 ticket 57). Stage 5 decides each
 * band's edge (ADR-0011) and height; this reserves the room by a move in y only: a top band pushes its nodes down, a bottom band grows
 * the box down, and the tiers below move down by what their band grew, so every tier gap keeps the height stage 6 seated. Nodes of one
 * tier keep one row: every group moves its nodes down by the largest top-band shift of its tier. A frame's band is held by one rank cell
 * (`band.host`). The room a group already holds is read from the bands it carries, so a second call reserves only what is still missing
 * (a deeper stem on the title edge, a detour label under the title: `clearanceFor`). Nothing moves in x. The bands that stand in a tier
 * gap (a canton title, an across-frames bus) are the gap's: stage 6 seats them (`gapBandDemand`). Returns whether anything moved.
 *
 * A first version reserved the title bands in stage 5 itself, so 7a to 7e planned in the taller boxes; it cost 42 bends and 23 crossings
 * on the corpus (branch `t57-step2-stage5`), and the user chose this one (ticket 57 Comments).
 */
export function topUpBandClearance(model: LayoutModel): boolean {
  const before = new Map(model.tierBands.map(band => [band.tier, { ...band.bounds! }]));
  // The room each group holds for its band now: the band and the clearance it carries.
  const held = new Map(model.labelBands.map(band => [band.host ?? band.group, band]));
  const heldBus = new Map((model.busBands ?? []).filter(band => band.group !== undefined).map(band => [band.group!, band]));
  const entries = routerEntryPoints(model);
  syncBands(model, entries);
  const ids = orderedGroupIds(model.document);
  const shifts = new Map(ids.map(id => {
    const group = model.groups[id]!, band = bandHeldBy(model, id), result = { top: 0, bottom: 0 };
    if (band !== undefined) {
      const prior = held.get(id);
      const room = prior !== undefined && prior.side === band.side ? prior.bounds.height + prior.clearance : groupPadding(model, group)[band.side];
      result[band.side] = Math.max(0, band.bounds.height + band.clearance - room);
    }
    // An in-frame bus band off the title edge lies against the padding, and the group grows by the difference (mesh-bus.md, section 4).
    const bus = busRoom(model, group), padding = groupPadding(model, group), prior = heldBus.get(id);
    for (const side of ['top', 'bottom'] as const) {
      if (bus[side] <= 0 || band?.side === side) continue;
      const have = prior !== undefined && prior.side === side ? Math.max(padding[side], prior.bounds.height) : padding[side];
      result[side] = Math.max(0, Math.max(padding[side], bus[side]) - have);
    }
    return [id, result];
  }));
  const topShift = (tier: number) => Math.max(0, ...ids.filter(id => model.groups[id]!.tier === tier).map(id => shifts.get(id)!.top));
  let moved = false;
  for (const id of ids) {
    const group = model.groups[id]!, shift = shifts.get(id)!;
    const down = topShift(group.tier!);
    if (down <= PLACEMENT_EPS && shift.bottom <= PLACEMENT_EPS) continue;
    moved = true;
    for (const nodeId of group.nodes) {
      const node = model.nodes[nodeId]!;
      node.bounds!.y += down;
      for (const port of node.ports) port.anchor!.y += down;
    }
    group.bounds!.height += down + shift.bottom;
  }
  if (!moved) return false;
  rebuildBands(model);
  // The tiers below a band that grew move down by its growth, so every tier gap keeps its height.
  let shift = 0;
  for (const tierBand of [...model.tierBands].sort((a, b) => a.tier - b.tier)) {
    if (shift) for (const group of Object.values(model.groups).filter(item => item.tier === tierBand.tier)) moveGroup(model, group, 0, shift);
    shift += Math.max(0, tierBand.bounds!.height - (before.get(tierBand.tier)?.height ?? tierBand.bounds!.height));
  }
  rebuildBands(model);
  syncBands(model, entries);
  return true;
}


/**
 * Largest size difference, as a fraction of the shared extent, that the linked-group grid closes.
 * The maintainer first asked for "about 10 %"; the fixtures that motivated the rule (one-px-sources,
 * bar-both-sides) need 21 % and 26 %, and the maintainer confirmed 30 %. One number, here.
 */
export const GROUP_GRID_MAX_GROWTH = 0.30;

/** One side of a pair: a group, or every cell of a frame (a frame is one column and takes one x-extent). */
interface LinkedPair { a: LayoutGroup[]; b: LayoutGroup[]; axis: 'x' | 'y' }
const unitOf = (model: LayoutModel, group: LayoutGroup): LayoutGroup[] =>
  group.frame === undefined ? [group] : model.document.frames![group.frame]!.cells.map(id => model.groups[id]!);
const unitId = (group: LayoutGroup): string => group.frame ?? group.id;
/** Groups joined by a routed link: vertical ports across tiers share x, horizontal ports share y. */
function linkedGroupPairs(model: LayoutModel): LinkedPair[] {
  const seen = new Set<string>(), result: LinkedPair[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    const a = model.groups[model.document.nodes[link.attachments.from.node]!.group]!;
    const b = model.groups[model.document.nodes[link.attachments.to.node]!.group]!;
    // Frames share the grid, cells do not (ranked-groups spec, section 2): a frame joins the pairing
    // as one unit of all its cells, and a link between two cells of one frame pairs nothing.
    if (!from?.side || !to?.side || unitId(a) === unitId(b)) continue;
    const vertical = ['top', 'bottom'].includes(from.side) && ['top', 'bottom'].includes(to.side);
    const horizontal = ['left', 'right'].includes(from.side) && ['left', 'right'].includes(to.side);
    if (!vertical && !horizontal) continue;
    // The cells of a frame stand on different sub-tiers, so a shared y-extent means nothing to them.
    if (horizontal && (a.frame !== undefined || b.frame !== undefined)) continue;
    const key = [unitId(a), unitId(b)].sort().join('\u0000') + (vertical ? ':x' : ':y');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ a: unitOf(model, a), b: unitOf(model, b), axis: vertical ? 'x' : 'y' });
  }
  return result;
}
const rectOverlap = (p: Rect, q: Rect): boolean => p.x < right(q) - PLACEMENT_EPS && q.x < right(p) - PLACEMENT_EPS && p.y < bottom(q) - PLACEMENT_EPS && q.y < bottom(p) - PLACEMENT_EPS;

/**
 * Whether the boxes of `proposed` would make the box of a top-level frame overlap another top-level
 * frame's box (ranked-groups ticket 09). The frame boxes are derived from the cells with the proposed
 * bounds in place, and the bounds are put back before this returns. A pair that overlaps already, and a
 * pair the proposal does not touch, are not this proposal's doing and do not refuse it.
 */
function widensIntoFrame(model: LayoutModel, proposed: { group: LayoutGroup; bounds: Rect }[]): boolean {
  const frames = model.document.frames;
  if (frames === undefined) return false;
  const touched = new Set(proposed.flatMap(item => {
    let id = item.group.frame;
    while (id !== undefined && frames[id]?.parent !== undefined) id = frames[id]!.parent;
    return id === undefined ? [] : [id];
  }));
  if (!touched.size) return false;
  const tops = (): { id: string; box: Rect }[] => (deriveFrames(model) ?? []).filter(frame => frame.parent === undefined).map(frame => ({ id: frame.id, box: frame.box }));
  const clashes = (list: { id: string; box: Rect }[]): Set<string> => new Set(list.flatMap((frame, i) => list.slice(i + 1)
    .filter(other => (touched.has(frame.id) || touched.has(other.id)) && rectOverlap(frame.box, other.box)).map(other => `${frame.id}\u0000${other.id}`)));
  const before = clashes(tops());
  const saved = proposed.map(item => item.group.bounds!);
  proposed.forEach(item => { item.group.bounds = item.bounds; });
  const after = clashes(tops());
  proposed.forEach((item, i) => { item.group.bounds = saved[i]!; });
  return [...after].some(key => !before.has(key));
}


/**
 * The moves that keep the band gap to the flanks of a group the grid widens to `box` (ticket 07): the grid widens a core in place and a flank stood a band
 * gap from the old box, so each flank on the same rows moves outward by what the widening took. Returned as boxes with their shift, so the grid judges
 * them with the guards of the widening itself before anything moves.
 */
function flankShifts(model: LayoutModel, group: LayoutGroup, box: Rect): { group: LayoutGroup; bounds: Rect; dx: number }[] {
  const gap = bandGap(model), shifts: { group: LayoutGroup; bounds: Rect; dx: number }[] = [];
  for (const flank of Object.values(model.groups)) {
    if (flank.flank?.of !== group.id || flank.bounds === undefined) continue;
    if (flank.bounds.y >= bottom(box) || box.y >= bottom(flank.bounds)) continue;
    const left = flank.flank.align === 'left';
    const shortfall = gap - (left ? box.x - right(flank.bounds) : flank.bounds.x - right(box));
    if (shortfall <= PLACEMENT_EPS) continue;
    const dx = left ? -shortfall : shortfall;
    shifts.push({ group: flank, bounds: { ...flank.bounds, x: flank.bounds.x + dx }, dx });
  }
  return shifts;
}

/**
 * Linked groups share a grid (ADR-0012): two groups joined by vertical links take one x-extent, two
 * joined by horizontal links take one y-extent, whenever neither box is smaller than that union by
 * more than `GROUP_GRID_MAX_GROWTH` of it. Boxes only grow, nodes never move, and a union
 * that would overlap another group, make a frame box overlap another frame's, or cross a reserved lane window is skipped. Chains converge in
 * a bounded number of passes because every pass only merges extents.
 */
/** The recorded refusals that are not true of the model: a pair that is not linked, or that shares an extent. A grid replay honouring the record reads this on its result. */
export function forgedRefusals(model: LayoutModel, honour: ReadonlySet<string>): string[] {
  const { shares } = alignGrid(model, honour);
  return [...honour].filter(key => shares.get(key) !== false);
}
export function alignLinkedGroupGrid(model: LayoutModel, honour?: ReadonlySet<string>): boolean {
  return alignGrid(model, honour).changed;
}
/** The grid, and whether it moved a flank: the caller then owes the regions a replay (`alignLinkedGroupGridAndPack`). */
function alignGrid(model: LayoutModel, honour?: ReadonlySet<string>): { changed: boolean; flanksMoved: boolean; shares: ReadonlyMap<string, boolean> } {
  let changed = false, base: Set<string> | undefined;
  const flankMoved: string[] = [];
  const refused = new Set<string>(), heldOff = new Set<string>();
  // The pairs a reservation guard refused are a decision of this call, recorded in `model.gridRefusals` (ticket 16). A caller that validates passes the record as `honour`: those pairs are skipped as the
  // producer skipped them, because the lanes and gap plans the guards read have moved since, and every other pair is judged live.
  const decided = new Map<string, { members: LayoutGroup[]; pos: 'x' | 'y'; len: 'width' | 'height' }>(), keys = new Map<string, boolean>();
  model.diagnostics = model.diagnostics.filter(item => item.code !== 'GROUP_GRID_YIELDS_TO_PACK');
  // Within one call extents only grow and only ever onto existing box edges, so the process terminates; the cap
  // exhausting is a defect signal, not a design bound. Across calls nothing is monotone: a replay refits the boxes and a pack moves a
  // frame, so the grid and the pack end by the round bound of `alignLinkedGroupGridAndPack`, not by growth (ticket 136). Pairs × groups passes cover any cascade in
  // which each pass enables one more merge under the cap.
  const groupCount = Object.keys(model.groups).length;
  const bound = groupCount * Math.max(1, linkedGroupPairs(model).length) + 2;
  let pass = 0;
  for (; pass < bound; pass++) {
    let moved = false;
    for (const { a, b, axis } of linkedGroupPairs(model)) {
      const [pos, len] = axis === 'x' ? ['x', 'width'] as const : ['y', 'height'] as const;
      const members = [...a, ...b];
      const key = `${axis}:${members.map(group => group.id).sort().join('|')}`;
      // A recorded refusal is consumed first, whatever skip would apply to the pair below: the validator judges whether the record is true on the final model.
      if (honour?.has(key)) continue;
      const low = Math.min(...members.map(group => group.bounds![pos]));
      const high = Math.max(...members.map(group => group.bounds![pos] + group.bounds![len]));
      const extent = high - low;
      if (members.every(group => Math.abs(group.bounds![len] - extent) <= PLACEMENT_EPS && Math.abs(group.bounds![pos] - low) <= PLACEMENT_EPS)) continue;
      // A unit's own size is its union: one cell alone, or the column the cells of a frame make.
      const size = (unit: LayoutGroup[]): number => Math.max(...unit.map(group => group.bounds![pos] + group.bounds![len]))
        - Math.min(...unit.map(group => group.bounds![pos]));
      if ((extent - size(a)) / extent > GROUP_GRID_MAX_GROWTH + PLACEMENT_EPS
        || (extent - size(b)) / extent > GROUP_GRID_MAX_GROWTH + PLACEMENT_EPS) continue;
      const proposed = members.map(group => ({ group, bounds: { ...group.bounds!, [pos]: low, [len]: extent } as Rect, dx: 0 }));
      // The flanks of a widened core move out with it, and are judged by the guards below as part of the widening: one that cannot move refuses it.
      if (axis === 'x') for (const item of [...proposed]) proposed.push(...flankShifts(model, item.group, item.bounds));
      const others = Object.values(model.groups).filter(group => !proposed.some(item => item.group === group));
      if (proposed.some(item => others.some(other => rectOverlap(item.bounds, other.bounds!)))) continue;
      // Either axis keeps the reservations (ticket 16): the lane and chord guards here, the tier gaps that fit below, after the cheap guards. A refusal is kept for the call.
      const held = `${members.map(group => group.id).join('|')}${JSON.stringify(proposed.map(item => item.bounds))}`;
      if (heldOff.has(held)) continue;
      // `holdsMove` on the x axis is a live guard of main and stays unrecorded; the guards ticket 16 added are recorded.
      const refuse = (): void => { heldOff.add(held); decided.set(key, { members, pos, len }); };
      if (!holdsMove(model, proposed)) { heldOff.add(held); if (axis === 'y') decided.set(key, { members, pos, len }); continue; }
      if (!growthHolds(model, proposed)) { refuse(); continue; }
      // A widening that would stand a box, or the frame it grows, closer than the band gap to a group or frame that is not part of it is refused: the gap is kept where the box
      // is sized (ticket 19; the frames are derived from the proposed boxes, ticket 157).
      // The pack of the beside rows that follows the grid in a sheet with frames seats frame cells only, so a plain group beside the box is held by this guard too. Seating the
      // neighbour by the push of a label's widening instead was measured and loses straight overlay links on two sheets (the ticket's review record).
      if (axis === 'x' && separationsBrokenBy(model, proposed).length > 0) continue;
      // The widening is stage 7 work: it never widens a frame into the box of another frame.
      if (widensIntoFrame(model, proposed)) continue;
      // A widening the pack would undo is refused (ticket 136): the widened frame moves the beside row, the grid puts the moved box back onto the
      // extent of its partner, and the two step against each other. The grid gives way. Judged row by row: the groups the pack would move after the widening
      // must be the groups it would move before it, so a row that stood open already does not excuse a widening that opens another.
      if (model.document.frames !== undefined) {
        const key = members.map(group => group.id).join('|');
        if (refused.has(key)) continue;
        base ??= packOpens(model, []);
        if (!sameSet(base, packOpens(model, proposed))) {
          refused.add(key);
          const ids = orderedGroupIds(model.document).filter(id => members.some(group => group.id === id));
          model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'GROUP_GRID_YIELDS_TO_PACK',
            message: `The linked groups ${ids.join(', ')} keep their own extents: sharing one would open a row that the pack of the beside rows holds, and the grid gives way to the pack.`,
            owners: ids.map(id => ({ kind: 'group' as const, id })) });
          continue;
        }
      }
      if (!gapsHoldGrowth(model, proposed)) { refuse(); continue; }
      const shifted: string[] = [], old = proposed.map(item => ({ item, bounds: { ...item.group.bounds! } }));
      for (const item of proposed) {
        if (item.dx === 0) item.group.bounds = item.bounds;
        else { moveGroup(model, item.group, item.dx, 0); shifted.push(...item.group.nodes); }
      }
      // A moved flank carries its lanes with it: the pairs after it are judged on the bands, regions and lane extents as they stand now. The labels and pills follow at the end of the call, once, so that their order is the one a single refit gives.
      // A span corridor that cannot follow the move refuses this pair: the move is undone and the lanes put back.
      if (shifted.length) {
        const lanes = JSON.stringify(model.lanes);
        try { rebuildBands(model); rebuildRegions(model); rebuildLaneExtents(model); } catch (error) {
          if (!(error instanceof PlacementRefusal && error.code === 'span')) throw error;
          for (const { item, bounds } of old) { if (item.dx === 0) item.group.bounds = bounds; else moveGroup(model, item.group, -item.dx, 0); }
          model.lanes = JSON.parse(lanes) as typeof model.lanes;
          rebuildBands(model); rebuildRegions(model);
          refuse();
          continue;
        }
      }
      flankMoved.push(...shifted);
      moved = changed = true;
    }
    if (!moved) break;
  }
  if (pass >= bound) placementWarning(model, 'GROUP_GRID_NON_CONVERGENCE', 'Linked-group grid did not settle within its pass bound; the boxes it reached are kept.', [], 'group');
  // A moved flank carries its nodes' labels and pills with it only after a refit, and the bundle and row paths reserved beside it stand where it was.
  if (flankMoved.length) rebuildNodeGeometry(model, flankMoved, 'current');
  if (changed) { rebuildBands(model); rebuildRegions(model); }
  if (honour === undefined) {
    // The record keeps the pairs this call refused that still stand apart; a pair a later pass made is not refused.
    const apart = [...decided].filter(([, { members, pos, len }]) => {
      const low = Math.min(...members.map(group => group.bounds![pos])), high = Math.max(...members.map(group => group.bounds![pos] + group.bounds![len]));
      return !members.every(group => Math.abs(group.bounds![len] - (high - low)) <= PLACEMENT_EPS && Math.abs(group.bounds![pos] - low) <= PLACEMENT_EPS);
    }).map(([key]) => key).sort();
    if (apart.length) model.gridRefusals = apart; else delete model.gridRefusals;
  }
  // Whether each linked pair shares an extent now: the validator reads the recorded pairs off this.
  if (honour !== undefined) for (const { a, b, axis } of linkedGroupPairs(model)) {
    const [pos, len] = axis === 'x' ? ['x', 'width'] as const : ['y', 'height'] as const, members = [...a, ...b];
    const low = Math.min(...members.map(group => group.bounds![pos])), high = Math.max(...members.map(group => group.bounds![pos] + group.bounds![len]));
    keys.set(`${axis}:${members.map(group => group.id).sort().join('|')}`, members.every(group => Math.abs(group.bounds![len] - (high - low)) <= PLACEMENT_EPS && Math.abs(group.bounds![pos] - low) <= PLACEMENT_EPS));
  }
  return { changed, flanksMoved: flankMoved.length > 0, shares: keys };
}


/**
 * The coordinate an overlay link's label will be centred on: the midpoint of the longest run of the
 * path the overlay rule derives, on the axis this reservation grows.
 *
 * The rule reads its eight ways off the two end boxes alone, and 7f holds the pills frozen, so
 * placement can run the very producer stage 8 will run rather than assume the shape the run takes
 * (ticket 04 B; ticket 01 recorded the `2 × OVERLAY_PILL_CLEARANCE` proxy it replaces). `undefined`
 * where the long run lies on the other axis — the way round the pair and the run down the middle of
 * the gap — because there is then nothing for 7f to widen and the stage 9 ladder decides.
 *
 * "On the other axis" is read as *no reach at all* on the axis being grown. The straight branch is
 * one **diagonal** from face to face (stress tickets 20 and 30) and it has reach on both; widening
 * the axis lengthens it, so it is a run 7f can reserve for and the midpoint is its own on that axis.
 * Testing for a perfectly axis-aligned run was written when every overlay path was orthogonal and
 * threw the diagonal away with the cross-axis runs. This came out under stress ticket 30: while a
 * stub ran from the anchor it was the longest run of a pair standing close together, and 7f reserved
 * about the *stub's* midpoint, inside the source pill — a run no label ever follows.
 */
function overlayLongestRun(model: LayoutModel, link: LayoutLink): PathSegment | undefined {
  return longestRun(overlayPath(model, link).segments);
}
/** `overlayRunMid` on the per-link path, before track separation (`overlayBasePath`): for the readers of placement that judge. */
function overlayBaseRunAlong(model: LayoutModel, link: LayoutLink, axis: 'x' | 'y'): number | undefined {
  const run = longestRun(overlayBasePath(model, link).segments);
  if (!run || Math.abs(run.to[axis] - run.from[axis]) <= PLACEMENT_EPS) return undefined;
  return (run.from[axis] + run.to[axis]) / 2;
}
function overlayRunMid(model: LayoutModel, link: LayoutLink, axis: 'x' | 'y'): number | undefined {
  const run = overlayLongestRun(model, link);
  if (!run || Math.abs(run.to[axis] - run.from[axis]) <= PLACEMENT_EPS) return undefined;
  return (run.from[axis] + run.to[axis]) / 2;
}

/**
 * The gap two nodes of one row must keep between their bodies for the label of a routed link between them: the room
 * `reserveLinkLabelRoom` reserves, read as a floor by the stages that widen a body into the row (ticket 33). Zero
 * without such a link. A routed link that detours needs more, and the reservation adds that on its own; this is the
 * least, so a widening never takes back a room the reservation has already given.
 */
export function linkLabelGap(model: LayoutModel, a: string, b: string): number {
  let gap = 0;
  for (const link of model.links) {
    const text = model.document.links[link.sourceIndex]?.label;
    if (!text || link.technique === 'stub' || link.bundle || link.meshBus !== undefined || !link.attachments) continue;
    const ends = [link.attachments.from.node, link.attachments.to.node];
    if (!(ends.includes(a) && ends.includes(b))) continue;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    if (!from?.anchor || !to?.anchor) continue;
    const fromNode = model.nodes[link.attachments.from.node]!, toNode = model.nodes[link.attachments.to.node]!;
    const found = sameTierEnds(from, fromNode, to, toNode);
    if ('unreservable' in found) continue;
    // The path of an overlay link is derived, which costs a search: it is asked for only once the two ends are known to face. A centring
    // limit reads the per-link path (`overlayBasePath`, ticket 23): a separated run moves across its axis and keeps its direction.
    if (effectiveLayer(link) === 'overlay' && (overlayLabelsSuppressed(model) || overlayBaseRunAlong(model, link, 'x') === undefined)) continue;
    const { leftPort, leftNode, rightPort, rightNode } = found;
    const outer = (port: LayoutPort, node: LayoutNode): Rect => port.pill ? port.pill.bounds : node.bounds!;
    const protrusion = Math.max(right(outer(leftPort, leftNode)) - leftPort.anchor!.x, rightPort.anchor!.x - outer(rightPort, rightNode).x, 0);
    const required = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight }).width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    gap = Math.max(gap, required + 2 * protrusion);
  }
  return gap;
}

/**
 * Whether the room 7f reserved still holds on `model` as the validator reads it (`validateGroupLabelBands`): the room-across-a-run record
 * holds every need it names, and a replay of the label room reserves nothing more. The overlay port trade (`nestOverlayPorts`, ticket 23)
 * runs after the last reservation and makes no trade that would need room 7f did not reserve.
 */
export function roomHolds(model: LayoutModel): boolean {
  const shortfalls: LinkLabelShortfall[] = [];
  // A tier-gap room counts: the solve would pay it with height, so a move that opens one is not taken for free (ticket 57).
  return labelPaddingFault(model) === undefined && !reserveLinkLabelRoom(clone(model), shortfalls) && !shortfalls.some(tierGapShortfall);
}
/**
 * What is wrong with the record of the label rooms 7f gave up (`labelRoomUnsettled`, ticket 27), or `undefined`: every name is a described
 * link of the model, once, in link order (R5). Whether the room was short when 7f gave it up is not read again: the later 7f moves may
 * lengthen the run, and a room given up stays given up (R1). The label placement decides: with no window the label may lie across a
 * border (`LINK_LABEL_ON_BORDER`), and stage 9's collision test refuses a place on a link.
 */
export function labelRoomUnsettledFault(model: LayoutModel): string | undefined {
  const record = model.labelRoomUnsettled;
  if (record === undefined) return undefined;
  if (!Array.isArray(record) || !record.length) return 'the record is empty or not a list';
  const order = new Map(model.links.map((link, at) => [link.id, at])), suppressed = overlayLabelsSuppressed(model);
  for (const [at, name] of record.entries()) {
    const link = model.links[order.get(name) ?? -1];
    if (link === undefined || !describedLink(model, link, suppressed)) return `${name} is not a described link of the model`;
    if (at > 0 && order.get(record[at - 1]!)! >= order.get(name)!) return `${name} repeats a name or stands out of link order`;
  }
  return undefined;
}

/** The cheap part of `roomHolds`: no padding record forged and no track room short. A guard to try trades under before `roomHolds`. */
export const roomLikelyHolds = (model: LayoutModel): boolean => labelPaddingFault(model) === undefined && !trackRoomShort(model);

/** One labelled link whose run is shorter than the label it carries needs, and by how much. */
/**
 * The tier-gap term of the label room (architecture-2 ticket 57): `floors` is the growth each gap takes anyway, keyed by the sub-tier
 * above it, and `deficits` collects, for each gap, the largest growth a label across it asks and the link that asks it.
 */
export interface TierGapLabelRoom { floors: ReadonlyMap<number, number>; deficits: Map<number, { deficit: number; link: string }> }
/** Whether a shortfall is a label's room across a tier gap, which the tier-gap solve pays (architecture-2 ticket 57). */
export const tierGapShortfall = (item: LinkLabelShortfall): boolean => item.axis === 'tier gap' || item.axis === 'tier gap window';

export interface LinkLabelShortfall {
  link: string; axis: 'row' | 'row window' | 'tier gap' | 'tier gap window' | `${Side} padding of ${string}` | `overlay track in the ${Side} padding of ${string}`; required: number; room: number;
}

/**
 * Insert `deficit` px of room at `split`: everything at or right of it moves right, in every tier (see `reserveLinkLabelRoom`). A node of tier
 * `ownTier` moves only when it starts beyond the split; a node of any other tier moves when any part of it lies beyond. Returns the moved nodes.
 */
function insertRoomAt(model: LayoutModel, split: number, deficit: number, ownTier: number): string[] {
  const moved: string[] = [];
  // Label room wins over a lane beyond it (user, 2026-10-24: "make room, push the lane"): a reserved lane at or beyond the split moves out
  // with the room, so it keeps its distance to what it serves and is never crowded (R2). A perimeter lane is derived from the boxes
  // (`rebuildLaneExtents`) and follows them.
  for (const lane of model.lanes) {
    if (lane.kind === 'perimeter' || lane.x < split - PLACEMENT_EPS) continue;
    // The box is derived from the axis where it was (`validateLanes` compares exactly), so two separate sums do not drift apart.
    const centred = lane.bounds.x === lane.x - lane.bounds.width / 2;
    lane.x += deficit;
    lane.bounds.x = centred ? lane.x - lane.bounds.width / 2 : lane.bounds.x + deficit;
  }
  // A mesh-bus riser moves with its lanes, by the same sum, so each riser lane stays at the riser's x (`validateRiserLane` compares
  // exactly); its ends move with it, and the bars that reach it are derived again from the riser (`busExtent`).
  for (const bus of model.meshBuses ?? []) {
    const riser = bus.riser;
    if (riser === undefined || riser.x < split - PLACEMENT_EPS) continue;
    riser.x += deficit;
    if (riser.from) riser.from = { ...riser.from, x: riser.x };
    if (riser.to) riser.to = { ...riser.to, x: riser.x };
  }
  for (const group of Object.values(model.groups)) {
    if (group.bounds!.x >= split - PLACEMENT_EPS) { moveGroup(model, group, deficit, 0); moved.push(...group.nodes); continue; }
    if (right(group.bounds!) <= split + PLACEMENT_EPS) continue;
    // In the link's own tier a node moves only when it starts beyond the split: a node the detour must pass stays by the left end, so the run
    // over it spans the whole gap. In any other tier a node with any part beyond the split moves, so a wide source straddling the cut moves
    // with the bar slotted under its port and 7d's replay finds that slot where it left it.
    const shifted = group.nodes.filter(id => group.tier === ownTier
      ? model.nodes[id]!.bounds!.x >= split - PLACEMENT_EPS : right(model.nodes[id]!.bounds!) > split + PLACEMENT_EPS);
    for (const id of shifted) {
      const node = model.nodes[id]!;
      node.bounds!.x += deficit;
      for (const port of node.ports) { port.anchor!.x += deficit; if (port.pill) port.pill.bounds.x += deficit; }
    }
    if (shifted.length) { moved.push(...shifted); fitRegionGroup(model, group); }
  }
  return moved;
}

/**
 * The room a label `extent` long lacks on the run it rides (`run`), read on the drawn boxes as they stand now (frames derived afresh):
 * the growth at `split` after which one window of the run (`labelRunWindows`, the windows stage 9 places the label in) holds it
 * (`labelWindowDeficit`). Zero when a window holds it now, or when `run` is absent (the path bends and stage 9 decides). `undefined`
 * when no growth at the split gives a window that holds it: a box that moves with the far end cuts the run.
 */
function labelWindowRoom(model: LayoutModel, run: PathSegment | undefined, extent: number, split: number, farEndMoves = false,
  turned?: { across: number; axis: 'x' | 'y'; link: LayoutLink }, atLeast = 0): number | undefined {
  if (run === undefined) return 0;
  const boxes = labelBorders(model);
  if (turned === undefined) return labelWindowDeficit(boxes, run, extent, split, farEndMoves, undefined, atLeast);
  return labelWindowDeficit(boxes, run, extent, split, farEndMoves, { across: turned.across, axis: turned.axis, links: reservedLinkRuns(model, turned.link.id) }, atLeast);
}

/** The grain, in px, the room across a run is rounded up to, so a replay on the grown box finds the label clear (ticket 21). */
export const LABEL_PADDING_GRAIN = 1e-3;

/** What a label beside a run in a group's padding needs across the run (`acrossRunPadding`). */
/** One edge's room across a run: the group, the edge, the padding it needs; `track` when it holds a separated overlay track (ticket 23). */
export interface AcrossRunRoom { group: string; side: Side; padding: number; track?: true }

/**
 * Room across a run (architecture-2 ticket 21). A run that lies in a group's padding, between the group's node bodies and one edge of
 * its box, carries its label on the side of that edge when the other side is taken: always on the top and right edges (the side stage
 * 9 tries first), and on the bottom and left edges when the box on the side of the bodies meets a node body, a pill or a border. The
 * label box is the one stage 9 tries (`runLabelBox`, R1). It stays clear of the edge's stroke (`labelCrossesBorder`) when the padding
 * on that edge, from the node bodies to the box edge, is at least the label's reach beyond the bodies plus the half stroke: that figure,
 * rounded up to `LABEL_PADDING_GRAIN`, is the result. It does not depend on where the group stands, so a move does not change it.
 *
 * `undefined` when the run has no axis, no window of the run holds the label, or the run lies in no padding of a group: between two
 * node rows, outside every group box, or in a rank cell (whose border the frame draws). An edge that holds the group title is left to
 * the title band, which reserves the room below the title for a detour (ADR-0014).
 */
export function acrossRunPadding(model: LayoutModel, borders: readonly Rect[], run: PathSegment, size: { width: number; height: number }, half: number): AcrossRunRoom | undefined {
  const stroke = DEFAULT_STROKE_WIDTHS.group / 2;
  // The padding the run lies in (`paddingOf`, one reader with the overlay track room, R1). Last key: group id order; the boxes of one
  // tier do not overlap, so at most one group holds the run.
  const held = paddingOf(model, run.from, run.to);
  if (held === undefined || held.title) return undefined;
  const id = held.group, side = held.side, group = model.groups[id]!, bodies = union(group.nodes.map(node => model.nodes[node]!.bounds!));
  // The box stage 9 tries (`besideRunLabelBox`): on a bottom or left edge, a label that stands on the side of the bodies needs no room.
  const placed = besideRunLabelBox(model, borders, run, size, half);
  if (placed === undefined || (side === 'bottom' || side === 'left') && !placed.second) return undefined;
  const label = placed.box;
  const reach = side === 'top' ? bodies.y - label.y : side === 'bottom' ? bottom(label) - bottom(bodies) : side === 'left' ? bodies.x - label.x : right(label) - right(bodies);
  return { group: id, side, padding: roomGrain(reach + stroke) };
}

/** A room across a run, rounded up to `LABEL_PADDING_GRAIN`. */
const roomGrain = (room: number): number => Math.ceil(room / LABEL_PADDING_GRAIN - PLACEMENT_EPS) * LABEL_PADDING_GRAIN;

/**
 * The room across the runs of an overlay link's separated tracks (architecture-2 ticket 23): a run that track separation moved out
 * into a plain group's padding, beyond the run the per-link rule derived there, on an edge no title holds, needs that padding to reach
 * the run plus one overlay track pitch to the border (half the stroke, `OVERLAY_GAP`, half the border's stroke). The tracks are decided
 * beyond the edge as it stands (`overlayPath` lets a run cross the edge it grows), and 7f grows the edge to hold them. A moved track
 * of a labelled link in a top or bottom padding holds the label beyond it too: half the stroke, the normal gap, the text and half the
 * border's stroke, as a label beside a run asks (`acrossRunPadding`); the label window of a run that near the border is cut away. Every
 * such track of the link holds it, not only the run the label rides now: which run is longest can change with a later move, and the
 * need may not flip with it. A track in a side padding holds its label room the same way; a reserved lane beyond that edge moves out
 * with the room (`insertRoomAt`).
 */
export function trackRoomPadding(model: LayoutModel, link: LayoutLink, labelHeight?: number): AcrossRunRoom[] {
  const stroke = linkStrokeWidth(link);
  const label = labelHeight === undefined ? undefined : trackLabelRoom(stroke, labelHeight);
  return overlayTrackRuns(model, link).flatMap(({ base, drawn }) => {
    const room = trackRoomNeed(model, base, drawn, stroke, label, roomGrain);
    return room === undefined ? [] : [{ ...room, track: true as const }];
  });
}
/** The track rooms of a drawn overlay link (`trackRoomPadding`), with its label when it shows one: 7f and the validator read this (R1). */
const trackRooms = (model: LayoutModel, link: LayoutLink): AcrossRunRoom[] =>
  effectiveLayer(link) === 'overlay' && link.meshBus === undefined && link.attachments !== undefined
    ? trackRoomPadding(model, link, trackLabelHeight(model, link)) : [];
/** The padding a group's box holds on one edge, from its node bodies to the box edge. */
function heldEdge(model: LayoutModel, group: string, side: Side): number {
  const box = model.groups[group]!.bounds!, bodies = union(model.groups[group]!.nodes.map(node => model.nodes[node]!.bounds!));
  return side === 'top' ? bodies.y - box.y : side === 'bottom' ? bottom(box) - bottom(bodies) : side === 'left' ? bodies.x - box.x : right(box) - right(bodies);
}
/** Whether a separated overlay track needs more room than its edge holds now (`trackRooms`): what `reserveAcrossRunRoom` would grow (ticket 23). */
export const trackRoomShort = (model: LayoutModel): boolean =>
  model.links.some(link => trackRooms(model, link).some(room => room.padding - heldEdge(model, room.group, room.side) > PLACEMENT_EPS));

/**
 * The checks a validator makes on `model.labelPadding` (R5). Every entry names a plain group (not a rank cell), one of its edges, a
 * finite positive room and at least one link of the model. For each named link whose label needs room on that edge now
 * (`acrossRunPadding`), or whose separated overlay track does (`trackRoomPadding`, ticket 23), the room holds the need. Geometry a legal later move changes is no fault: a need that moved off the edge or
 * below the room, a link that carries no label on a run now (overlay label suppression reads the density), and a room the ordinary
 * padding has reached (a padding row added later). The record keeps the largest room it was grown to (it only grows); "above the
 * ordinary padding" holds when 7f writes it. Whether the box still holds the room is the replay's to check (`reserveLinkLabelRoom`
 * on a copy reports a shortfall).
 */
export function labelPaddingFault(model: LayoutModel): string | undefined {
  const record = model.labelPadding;
  if (record === undefined) return undefined;
  const borders = labelBorders(model), suppressed = overlayLabelsSuppressed(model), byId = new Map(model.links.map(link => [link.id, link]));
  const unsettled = new Set(model.labelRoomUnsettled ?? []);
  for (const [id, sides] of Object.entries(record)) {
    const group = model.groups[id];
    if (group === undefined || group.frame !== undefined || !group.nodes.length) return `${id} is not a group whose padding a label can grow`;
    for (const [side, entry] of Object.entries(sides) as [Side, LabelPaddingEntry][]) {
      if (!['top', 'right', 'bottom', 'left'].includes(side) || entry === undefined || !Number.isFinite(entry.room) || entry.room <= 0) return `${id} ${side} records ${entry?.room} px`;
      if (!Array.isArray(entry.links) || !entry.links.length) return `${id} ${side} names no link`;
      for (const name of entry.links) {
        const link = byId.get(name);
        if (link === undefined) return `${id} ${side} names ${name}, which is not a link of the model`;
        // A room 7f gave up later (ticket 27) is the label placement's: its need is not checked against the record.
        if (unsettled.has(name)) continue;
        const run = describedLink(model, link, suppressed) ? riddenRun(model, link) : undefined;
        const label = run === undefined ? undefined : acrossRunPadding(model, borders, run, labelSize(model, link), linkStrokeWidth(link) / 2);
        const tracks = trackRooms(model, link);
        for (const need of [label, ...tracks]) {
          if (need !== undefined && need.group === id && need.side === side && need.padding > entry.room + PLACEMENT_EPS) {
            return `${id} ${side} records ${entry.room} px and ${name} needs ${need.padding} px`;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * The run whose room across 7f reserves: an overlay link's longest run (`overlayPath`), the run stage 9 tries first. A routed link's
 * path is not drawn yet: its straight runs stand between two pill faces, outside every padding, and a detour is left to stage 9.
 */
function riddenRun(model: LayoutModel, link: LayoutLink): PathSegment | undefined {
  return effectiveLayer(link) === 'overlay' ? overlayLongestRun(model, link) : undefined;
}

/**
 * Grow, for every labelled run in a group's padding, that edge's padding by exactly the room its label lacks across the run
 * (`acrossRunPadding`, ticket 21), and record the room and the link (`model.labelPadding`). The group's own content and the tiers below
 * move down for the top edge (a sibling of its tier stays), the tiers below for the bottom edge, and the room is inserted at the bodies' face for a side edge (`insertRoomAt`); the
 * box then grows on the edge by the record, so no other gap shrinks. Returns whether anything grew. `runOf` gives the run a label
 * rides (`riddenRun`); a test passes a side run, which no overlay path of the corpus takes yet.
 */
export function reserveAcrossRunRoom(model: LayoutModel, settle: (nodes: string[]) => void, shortfalls: LinkLabelShortfall[],
  runOf: (model: LayoutModel, link: LayoutLink) => PathSegment | undefined = riddenRun, only?: 'tracks'): boolean {
  let changed = false;
  const suppressed = overlayLabelsSuppressed(model);
  // A label's room across its run (ticket 21), then the room of the link's separated overlay tracks (ticket 23); each is read on the
  // model as the growth before it left it. `only: 'tracks'` reads the tracks alone.
  const unsettled = new Set(model.labelRoomUnsettled ?? []);
  const roomsOf = (link: LayoutLink): (AcrossRunRoom | undefined)[] => {
    // A room 7f gave up (ticket 27, `labelRoomUnsettled`) asks for nothing across its run either.
    if (unsettled.has(link.id)) return [];
    const run = only === undefined && describedLink(model, link, suppressed) ? runOf(model, link) : undefined;
    const label = run === undefined ? undefined : acrossRunPadding(model, labelBorders(model), run, labelSize(model, link), linkStrokeWidth(link) / 2);
    return [label, ...trackRooms(model, link)];
  };
  for (const link of model.links) for (const room of roomsOf(link)) {
    if (room === undefined) continue;
    const group = model.groups[room.group]!, bodies = union(group.nodes.map(node => model.nodes[node]!.bounds!));
    const held = heldEdge(model, room.group, room.side);
    const deficit = room.padding - held;
    if (deficit <= PLACEMENT_EPS) continue;
    const tier = group.tier!;
    if (room.side === 'top' || room.side === 'bottom') {
      // The tiers below move down; for the top edge the group's own content moves too, its box top stays, and a sibling of its tier stays (R2).
      const moved = Object.values(model.groups).filter(item => (item.tier !== undefined && item.tier > tier) || (room.side === 'top' && item === group));
      for (const item of moved) moveGroup(model, item, 0, deficit);
      settle(moved.flatMap(item => item.nodes));
    } else {
      const split = room.side === 'left' ? bodies.x : right(bodies);
      settle(insertRoomAt(model, split, deficit, tier));
    }
    // The room only grows and its links only join, in link order (R3), so a later pass never takes back a room an earlier one grew.
    const sides = (model.labelPadding ??= {})[room.group] ??= {}, prior = sides[room.side];
    const order = new Map(model.links.map((item, at) => [item.id, at]));
    sides[room.side] = { room: Math.max(prior?.room ?? 0, room.padding),
      links: [...new Set([...(prior?.links ?? []), link.id])].sort((x, y) => order.get(x)! - order.get(y)!) };
    fitRegionGroup(model, group);
    shortfalls.push({ link: link.id, axis: room.track ? `overlay track in the ${room.side} padding of ${room.group}` : `${room.side} padding of ${room.group}`, required: room.padding, room: held });
    changed = true;
  }
  return changed;
}

const labelSize = linkLabelSize;

/** The borders a link label stays clear of (`labelBorders`, read by 7f and the overlay track separation). */
export { labelBorders };

/**
 * A link's description influences its length (ADR-0014): the run a label will follow must be long
 * enough for the measured text plus the shortening margins before anything is routed. Stage 9
 * centres the label on the run's midpoint, so the room is measured symmetrically about that
 * midpoint: for a routed link the anchor midpoint out to the nearer pill face (or node edge); for
 * an overlay link the midpoint of the longest run of the path `overlayPath` will publish, since
 * that is the run the label follows. A link between two tiers moves nothing: its deficit is a term of
 * the height of the tier gap below the upper tier (`gapRoom`), which the one solve at the end of 7f sets
 * (`solveTierGaps`, architecture-2 ticket 57). A link between two ends of one tier inserts the room at the gap itself:
 * every group starting at or beyond the split moves right, in every tier; in a straddling group a
 * node of the link's own tier moves when it starts beyond the split (a node the detour passes stays
 * by the left end) and a node of any other tier when any part of it lies beyond (a wide source moves
 * with the bar slotted under it), so alignments, flank sides and bar-to-source slots all move alike.
 * A routed link that will detour (ends that are not level, or a straight run `straightCorridorClear`
 * rejects) adds both stroke-aware stems and the anchor-side pill protrusion. Every authored label on
 * a drawn link counts — bars, overlay links whose labels are not suppressed — except bundle members,
 * whose geometry 7e owns. Self-links, same-tier links through top/bottom ports and pairs whose ports do
 * not face each other are diagnosed and left to the stage 9 ladder. Room beyond a reserved lane is inserted,
 * and the lane moves out with it (`insertRoomAt`). A label also stays in one region (ticket 19): on every run a label rides, one window
 * between the borders the run crosses must hold it (`labelWindowRoom`), and the growth is the larger of the two.
 */
export function reserveLinkLabelRoom(model: LayoutModel, shortfalls: LinkLabelShortfall[] = [], gapRoom?: TierGapLabelRoom): boolean {
  let changed = false;
  // What each reservation was for. The replay that refuses a published model throws on the return
  // value alone, and the sentence named neither the link nor the amount: three rebuilds to find one
  // number, which is the same cost tickets 13 and 14 recorded for their own messages. A caller that
  // has to decide whether a move makes this pass reserve *more* than it already did reads the link
  // names out of the same record.
  const record = (link: LayoutLink, axis: LinkLabelShortfall['axis'], required: number, room: number): void => {
    shortfalls.push({ link: link.id, axis, required, room });
  };
  const suppressed = overlayLabelsSuppressed(model);
  // Who yields among the labels on diagonal lines is decided once per pair, before the first reservation that reads it (R1).
  recordLabelYields(model, labelBorders(model));
  const outer = (port: LayoutPort, node: LayoutNode): Rect => port.pill ? port.pill.bounds : node.bounds!;
  const settle = (nodes: string[]): void => { if (nodes.length) rebuildNodeGeometry(model, nodes, 'current'); };
  // The room of separated overlay tracks first (ticket 23): a track decided beyond the edge it grows stands inside the box before a
  // label window is read on its run.
  if (reserveAcrossRunRoom(model, settle, shortfalls, riddenRun, 'tracks')) changed = true;
  const unsettled = new Set(model.labelRoomUnsettled ?? []);
  for (const link of model.links) {
    // A bus member's label goes to the bus tooltip (mesh-bus.md, section 6): it asks for no room.
    if (!describedLink(model, link, suppressed) || !link.attachments) continue;
    // A room 7f gave up (ticket 27) is not reserved again: the label placement decides, and with no window the label may lie across a
    // border (`LINK_LABEL_ON_BORDER`).
    if (unsettled.has(link.id)) {
      placementWarning(model, 'LINK_LABEL_ROOM_UNRESERVED', `${link.id} did not hold its label room after the passes of a settle round (labelRoomUnsettled); its label room is not reserved and the label placement decides.`, [link.id]);
      continue;
    }
    const text = model.document.links[link.sourceIndex]!.label!;
    const from = findPort(model, link.attachments.from), to = findPort(model, link.attachments.to);
    if (!from?.anchor || !to?.anchor) continue;
    const fromNode = model.nodes[link.attachments.from.node]!, toNode = model.nodes[link.attachments.to.node]!;
    const fromGroup = model.groups[model.document.nodes[fromNode.id]!.group]!, toGroup = model.groups[model.document.nodes[toNode.id]!.group]!;
    const unreserved = (why: string): void => placementWarning(model, 'LINK_LABEL_ROOM_UNRESERVED', `${link.id} ${why}; its label room cannot be reserved and the label placement decides.`, [link.id]);
    if (fromNode === toNode) { unreserved('returns to its own node'); continue; }
    const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
    const overlay = effectiveLayer(link) === 'overlay';
    // One figure for both families: the text and its two shortening margins. The room below is
    // measured out to the two pill faces, and since stress ticket 30 an overlay link's straight run
    // is measured between those same two faces — so the run the label rides is exactly the room,
    // and the overlay case needs no allowance of its own. It did while the run started a stub beyond
    // each face (synthetics review ticket 01's reading of ADR-0014); there is no stub now.
    const required = measured.width + 2 * LINK_LABEL_GEOMETRY.shortenMargin;
    if (fromGroup.tier !== toGroup.tier) {
      const [upper, lower, upperPort, lowerPort] = fromNode.bounds!.y <= toNode.bounds!.y ? [fromNode, toNode, from, to] : [toNode, fromNode, to, from];
      const upperTier = model.groups[model.document.nodes[upper.id]!.group]!.tier!;
      const centre = overlay ? overlayRunMid(model, link, 'y') : (upperPort.anchor!.y + lowerPort.anchor!.y) / 2;
      // An overlay L out of a hinted lateral side (ticket 116): when its longest run is horizontal, the room is inserted at the split of that run.
      const run = centre === undefined && overlay && (from.sideHint === true || to.sideHint === true) ? overlayLongestRun(model, link) : undefined;
      if (run !== undefined && overlayPath(model, link).segments.length === 2 && Math.abs(run.to.y - run.from.y) <= PLACEMENT_EPS) {
        const short = required - Math.abs(run.to.x - run.from.x);
        // The split lies in the gap between the node that holds the vertical run (with its pill) and the lateral face, as in the same-tier branch: a
        // split at the middle of the run can fall inside a wide peer, which then moves with the lateral node and the run does not grow (review H2).
        const lateralIsFrom = from.sideHint === true, lateralNode = lateralIsFrom ? fromNode : toNode, lateralPort = lateralIsFrom ? from : to;
        const verticalNode = lateralIsFrom ? toNode : fromNode, verticalPort = lateralIsFrom ? to : from;
        const lateralEast = lateralPort.anchor!.x > verticalPort.anchor!.x;
        const gapFrom = lateralEast ? Math.max(right(verticalNode.bounds!), right(outer(verticalPort, verticalNode))) : Math.max(right(lateralNode.bounds!), right(outer(lateralPort, lateralNode)));
        const gapTo = lateralEast ? Math.min(lateralNode.bounds!.x, outer(lateralPort, lateralNode).x) : verticalPort.anchor!.x;
        // West of the vertical (the lateral face looks east): the peer sits in another tier, and `insertRoomAt` moves it whole when any part of it lies beyond
        // the split, so a left edge that overhangs the lateral face does not matter: the split need only stand left of the vertical port's x.
        const gapOk = gapTo - gapFrom > PLACEMENT_EPS, split = (gapFrom + gapTo) / 2;
        // A label stays in one region: one window of the horizontal run, between the borders it crosses, must hold it (`labelWindowDeficit`).
        // With no gap to grow, nothing moves (split at infinity): a window that does not hold the label now is reported (ticket 20).
        const windowed = labelWindowRoom(model, run, measured.width, gapOk ? split : Infinity);
        if (!gapOk) {
          // One report: a run too short says so; a run long enough whose windows hold no label says that.
          if (short > PLACEMENT_EPS) unreserved('has no gap between the vertical run and the lateral face to insert its label room in');
          else if (windowed === undefined) unreserved('crosses a drawn box along its side run, with no gap before the lateral face to grow; no window between borders holds its label');
          continue;
        }
        if (windowed === undefined) unreserved('crosses a drawn box along its side run; no window between borders can be reserved for its label');
        const deficit = Math.max(short, windowed ?? 0);
        if (deficit <= PLACEMENT_EPS) continue;
        // The lateral end's tier is the link's own tier for the move: its body stays by the run's end.
        const moved = insertRoomAt(model, split, deficit, model.groups[model.document.nodes[lateralNode.id]!.group]!.tier!);
        settle(moved);
        if ((windowed ?? 0) > short) record(link, 'row window', measured.width, measured.width - windowed!);
        else record(link, 'row', required, required - deficit);
        changed = true;
        continue;
      }
      if (centre === undefined) { unreserved('draws its longest overlay run across the tier gap, not along it'); continue; }
      const mid = centre;
      // A side lane (side-faces.md, Section 10): the label rides the vertical run, the drop and the lane, so the run ends at the lateral port's y,
      // not at the node's face. The move in y below moves the lateral node with its tier, and the lane's extent follows the port.
      const lane = model.lanes.find(item => isSideLane(item) && item.owner.kind === 'link' && item.owner.id === link.id);
      const laned = lane !== undefined
        || (overlay && (from.sideHint === true || to.sideHint === true)); // an overlay L's vertical run ends at the lateral anchor too (review L1)
      const upperEdge = laned && upperPort.side !== 'bottom' ? upperPort.anchor!.y : Math.max(bottom(upper.bounds!), bottom(outer(upperPort, upper)));
      const lowerEdge = laned && lowerPort.side !== 'top' ? lowerPort.anchor!.y : Math.min(lower.bounds!.y, outer(lowerPort, lower).y);
      const room = 2 * Math.min(mid - upperEdge, lowerEdge - mid);
      // A label stays in one region: one window of the run it rides, between the drawn borders the run crosses, must hold it
      // (`labelWindowDeficit`). The run is the overlay path's longest run, the side lane's vertical run (at the lane's x, down to the
      // lateral port's y), or the straight drop between two level anchors; a routed drop between anchors that are not level bends,
      // and stage 9 decides. The solve moves every group below the upper tier down, so the split is the top of the highest of them. The
      // run's lower end moves with its node even when its pill stands out above that top (`farEndMoves`); no upper-tier box is taken as moved.
      // A held routed chord (ticket 22) is one diagonal line between its anchors, as an overlay line is: its label lies on it, turned. The line is
      // read from the anchors as they stand now (`straightChord`, geometry only), as stage 9 draws it, not from a path an earlier pass stored.
      const anchored = !overlay && isRoutedChord(model, link) ? straightChord(model, link, undefined, true) : undefined;
      const chord: PathSegment | undefined = anchored === undefined ? undefined : { from: anchored.from, to: anchored.to, owner: { ...link.owner } };
      const longest = overlay ? overlayLongestRun(model, link) : chord;
      // A diagonal run carries its label on the line, turned (ticket 20): its windows read the turned box's height.
      const diagonal = longest !== undefined && isDiagonalRun(longest);
      const x = lane !== undefined ? lane.x : Math.abs(lowerPort.anchor!.x - upperPort.anchor!.x) <= PLACEMENT_EPS ? upperPort.anchor!.x : undefined;
      const ridden: PathSegment | undefined = overlay || diagonal
        ? (longest !== undefined && (diagonal || Math.abs(longest.to.x - longest.from.x) <= PLACEMENT_EPS) ? longest : undefined)
        : x === undefined || lowerEdge - upperEdge <= PLACEMENT_EPS ? undefined
          : { from: { x, y: upperEdge }, to: { x, y: lowerEdge }, owner: { ...link.owner } };
      const split = tierGapSplit(model, link);
      // Stage 9 tries the longest run first: a side lane's side run that is longer than its vertical run, and has a window that holds
      // the label now, carries the label, and the vertical run needs no window. The lengths here are the anchor runs, not the pieces
      // `labelRuns` joins (the router has not drawn them yet), so the order can differ from stage 9's by a stem. That decides only which
      // window is reserved: stage 9 tries every run with the borders as walls before it falls back, and the side run's window holds.
      const lateral = lane === undefined ? undefined : findPort(model, lane.port!)?.anchor;
      const sideRun: PathSegment | undefined = lateral === undefined || lane === undefined ? undefined
        : { from: { x: lane.x, y: lateral.y }, to: { x: lateral.x, y: lateral.y }, owner: { ...link.owner } };
      const onSide = sideRun !== undefined && ridden !== undefined && Math.abs(sideRun.to.x - sideRun.from.x) > Math.abs(ridden.to.y - ridden.from.y)
        && labelWindowRoom(model, sideRun, measured.width, Infinity) === 0;
      // The window is read at the growth its gap takes anyway (the plan's, a label's before it, this run's symmetric room), never at
      // none (architecture-2 ticket 57).
      const base = Math.max(0, required - room, gapRoom?.floors.get(upperTier) ?? 0);
      const windowed = onSide ? 0 : labelWindowRoom(model, ridden, measured.width, split, true,
        diagonal ? { across: haloSize(measured).height, axis: 'y', link } : undefined, base);
      if (windowed === undefined) unreserved(diagonal
        ? 'crosses a drawn box in its tier gap; no window between borders, clear of the reserved link runs and of the label bands it yields to, can be reserved for its label'
        : 'crosses a drawn box in its tier gap; no window between borders can be reserved for its label');
      const deficit = Math.max(required - room, windowed ?? 0);
      if (deficit <= PLACEMENT_EPS) continue;
      // The room across a tier gap is a term of the gap's height, which the one solve at the end of 7f sets (architecture-2 ticket 57):
      // the deficit is handed to it for the gap below the upper tier, and nothing moves here. The rows of a group keep the row branch below.
      const was = gapRoom?.deficits.get(upperTier);
      if (gapRoom !== undefined && (was === undefined || deficit > was.deficit)) gapRoom.deficits.set(upperTier, { deficit, link: link.id });
      // The record names the figure that asks the growth: the label width against its gap window, or the run against its symmetric room.
      if ((windowed ?? 0) > required - room) record(link, 'tier gap window', measured.width, measured.width - windowed!);
      else record(link, 'tier gap', required, room);
      continue;
    }
    const ends = sameTierEnds(from, fromNode, to, toNode);
    if ('unreservable' in ends) { unreserved(ends.unreservable); continue; }
    const { leftPort, leftNode, rightPort, rightNode } = ends;
    const centre = overlay ? overlayRunMid(model, link, 'x') : (leftPort.anchor!.x + rightPort.anchor!.x) / 2;
    if (centre === undefined) { unreserved('draws its longest overlay run across the row, not along it'); continue; }
    const mid = centre;
    // A routed link detours when its ends are not level or when the straight run between them is not
    // clear — the same stroke-aware reading of nodes, pills, foreign group boxes with their margin,
    // lanes, fixed runs and bundle rows and envelopes that pins row paths and reserves corridors
    // (`straightCorridorClear`).
    const straight: PathSegment = { from: { ...leftPort.anchor! }, to: { ...rightPort.anchor! }, owner: { ...link.owner } };
    const detour = !overlay
      && (Math.abs(leftPort.anchor!.y - rightPort.anchor!.y) > PLACEMENT_EPS || !straightCorridorClear(model, link, straight));
    const room = 2 * Math.min(mid - Math.max(right(leftNode.bounds!), right(outer(leftPort, leftNode))), Math.min(rightNode.bounds!.x, outer(rightPort, rightNode).x) - mid);
    // A detour's long run ends at an anchor on one side and at a turn on the other, so its midpoint is
    // not the pill-face midpoint: the label centred there must clear the pill on the anchor side.
    const protrusion = Math.max(right(outer(leftPort, leftNode)) - leftPort.anchor!.x, rightPort.anchor!.x - outer(rightPort, rightNode).x, 0);
    const wanted = required + (detour ? stemReach(model, leftNode) + stemReach(model, rightNode) + 2 * protrusion : 0);
    // Insert the room at the gap itself: everything at or right of the split — in every tier — moves
    // right together, and a group straddling the split shifts only its nodes beyond it. Alignments,
    // flank sides and bar-to-source slots all survive because both ends of each of them move alike;
    // nothing ever moves left into a preceding group. A reserved lane at or beyond the split cannot
    // move, so such a link is diagnosed instead.
    const faceLeft = Math.max(right(leftNode.bounds!), right(outer(leftPort, leftNode))), faceRight = Math.min(rightNode.bounds!.x, outer(rightPort, rightNode).x);
    const split = (faceLeft + faceRight) / 2;
    // A label stays in one region: one window of the run it rides, between the drawn borders the run crosses, must hold it
    // (`labelWindowDeficit`). The run is the overlay path's longest run, or the straight run between the two pill faces; a routed
    // link that detours bends, and stage 9 decides.
    const longest = overlay ? overlayLongestRun(model, link) : undefined;
    const ridden: PathSegment | undefined = overlay
      ? (longest !== undefined && Math.abs(longest.to.y - longest.from.y) <= PLACEMENT_EPS ? longest : undefined)
      : detour || faceRight - faceLeft <= PLACEMENT_EPS ? undefined
        : { from: { x: faceLeft, y: leftPort.anchor!.y }, to: { x: faceRight, y: leftPort.anchor!.y }, owner: { ...link.owner } };
    const windowed = labelWindowRoom(model, ridden, measured.width, split);
    if (windowed === undefined) unreserved('crosses a drawn box in its row; no window between borders can be reserved for its label');
    const deficit = Math.max(wanted - room, windowed ?? 0);
    if (deficit <= PLACEMENT_EPS) continue;
    const moved = insertRoomAt(model, split, deficit, fromGroup.tier!);
    settle(moved);
    // The record names the figure that drove the growth, as in the tier gap.
    if ((windowed ?? 0) > wanted - room) record(link, 'row window', measured.width, measured.width - windowed!);
    else record(link, 'row', wanted, room);
    changed = true;
  }
  // Room across a run (ticket 21), on the geometry the reservations along the runs left.
  if (reserveAcrossRunRoom(model, settle, shortfalls)) changed = true;
  if (changed) { rebuildBands(model); rebuildRegions(model); }
  return changed;
}

/** Transaction-owned stage-7f producer. It replaces every affected claim before publication. */
export function produceGroupLabelBands(model: LayoutModel): void {
  produceGroupLabelBandsRaw(model);
  // A routed port of a member row that 7f left within the riser keep-out is reported once, on the final geometry of the producer; the entries an earlier
  // call left are stale (mesh-bus.md, section 11.5). A title push is a move that must be made, so here the breach is a warning and not an error.
  model.diagnostics = model.diagnostics.filter(item => item.code !== 'MESH_BUS_RISER_KEEP_OUT');
  for (const breach of riserKeepOutBreaches(model)) {
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'MESH_BUS_RISER_KEEP_OUT', owners: [{ kind: 'node', id: breach.node }],
      message: `${breach.node} has a routed port on the facing edge within the riser keep-out of x ${Math.round(breach.riser * 100) / 100}; a leg there stands closer than the run clearance to the riser.` });
  }
  // A forced move that put a foreign unit across a bar extension of a trunk is a warning (mesh-bus.md, section 12.5): the guard refuses an optional move only.
  reportTrunkCrossings(model);
}
function produceGroupLabelBandsRaw(model: LayoutModel): void {
  // A frame whose extreme sub-tiers both belong to child frames has no cell of its own to hold a
  // title. It draws none, and says so.
  for (const id of Object.keys(model.document.frames ?? {})) {
    // A canton's title is held by the sub-tier, not by a cell, so it is never unhosted.
    if (isCantonFrame(model, id)) continue;
    if (frameSide(model, id) === undefined) {
      placementWarning(model, 'FRAME_TITLE_UNHOSTED', `Frame ${id} has no own cell on its top or bottom edge; its title is not drawn.`, [id], 'group');
    }
  }
  topUpBandClearance(model);
  holdColumnsAfterPush(model);
  reserveLinkLabelRoom(model);
  const budget = createCentreBudget();
  rebuildRegionGeometry(model, budget, undefined, true);
  while (true) {
    // Linked groups share a grid before the bands are reserved in their (possibly wider) boxes, and
    // every described link keeps the run its label needs after whatever the replay moved. Either
    // movement, like a changed reservation, must replay the region producers (bars, paths) first.
    alignLinkedGroupGridAndPack(model, budget);
    const roomChanged = reserveLinkLabelRoom(model);
    // A replay that changes reserved outward geometry changes the reservation; refit before placing.
    const bandsChanged = syncBands(model);
    if ((bandsChanged || roomChanged) && budget.remaining > 0) {
      const passes = budget.passes;
      rebuildRegionGeometry(model, budget, undefined, true);
      consumeGrowthPass(budget, passes);
      continue;
    }
    if (roomChanged) {
      // Room moved geometry after the shared budget ran out: replay the producers once more with that
      // same spent budget (no fresh centring passes) so no claim is left stale, and say so — the final
      // gates decide the retained geometry.
      rebuildRegionGeometry(model, budget, undefined, true);
      syncBands(model);
      if (!model.diagnostics.some(item => item.code === 'PLACEMENT_NON_CONVERGENCE')) model.diagnostics.push({
        stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE',
        message: 'Link-label room reservation exhausted the shared eight-pass budget; final gates decide the retained geometry.',
      });
    }
    // The replays above may widen a canton in place; the cantons close up to a band gap again before anything is planned in them
    // (ranked-groups ticket 65). A move replays the region producers, as any movement does.
    if (budget.remaining > 0 && closeCantonsAndSettle(model) > 0) {
      const passes = budget.passes;
      rebuildRegionGeometry(model, budget, undefined, true);
      consumeGrowthPass(budget, passes);
      continue;
    }
    // A spent budget cannot replay a move, so the close-up is skipped here. Stage 7f closes the cantons again after the tier gaps grow
    // (`mutation.ts`, with its own rounds), and says so there when they do not settle; a warning here would fire on a run it closes later.
    // The titles are placed once, at the end of 7f (`placeGroupTitles`); none stands while placement moves.
    model.labels = model.labels.filter(label => label.role !== 'group');
    return;
  }
}

/**
 * The label bands again after a move of groups (a replay, the tier gap room, the corridor move). A pure vertical translation leaves every
 * band's height and clearance where they were, so the reservation still holds; where it does not, the full producer runs and reserves.
 * No title stands here: titles are placed once, at the end of 7f (`placeGroupTitles`, architecture-2 ticket 54).
 *
 * The fallback is given the bands the **first** step reserved, not the ones measured here.
 * `topUpBandClearance` reads the room a group already holds from the bands the model carries, so a
 * model carrying the new bands would measure each of them against itself, reserve nothing for a
 * clearance that grew between the two steps, and leave the fit to box growth into the gap the
 * measurement has just opened.
 *
 * **The fallback moves nodes.** `produceGroupLabelBands` reserves link-label room, so a caller that runs this after something is frozen
 * (the corridor move, where the corridors are fixed) has to measure the fallback's effect for itself, and cannot do it with
 * `reserveLinkLabelRoom`: the producer drives that to its fixed point before returning, so it reports nothing outstanding on exactly the
 * path that moved geometry.
 */
export function resyncLabelBands(model: LayoutModel): void {
  const reserved = clone(model.labelBands);
  const reserveAgain = (): void => { model.labelBands = reserved; produceGroupLabelBands(model); };
  if (syncBands(model)) { reserveAgain(); return; }
  // A move of groups can move a separated overlay track (ticket 23): the joint separation reads every path, so a run the room held before
  // can need more after it, on any edge. A box that no longer holds a track's room gets it again (`reserveLinkLabelRoom`, as the
  // validator replays it); the nodes the room moves change the region paths (rows, flanks, bars), so the regions are replayed, and a
  // band the moves leave out of step, or a track room still short after the replay, sends the replay to the full producer, which loops
  // until nothing changes.
  if (trackRoomShort(model) && reserveLinkLabelRoom(model)) {
    rebuildRegionGeometry(model, undefined, undefined, true);
    if (syncBands(model) || trackRoomShort(model)) reserveAgain();
  }
}

/**
 * Recheck exact stable claims against final paths without moving geometry or allocating a new budget. The group titles are read from
 * their record (`groupTitlesFault`).
 */
export function validateGroupLabelBands(model: LayoutModel): void {
  attemptCounters.validationReplays++; attemptCounters.candidateCopies += 2;
  // Replay the grid on a copy: a settled model does not change; a genuinely unsettled chain exhausts
  // the pass bound again. A serialized diagnostic alone proves nothing.
  // The yield record is read, never decided again (R1); a forged or incomplete one is refused (R5).
  const fault = labelYieldsFault(model);
  if (fault !== undefined) throw new Error(`The label yields are forged: ${fault}`);
  // The room across a run is read from its record and checked against the runs that need it (ticket 21, R5).
  // The direct families are read from their record and the geometry, never decided again (ticket 22, R1/R5).
  const family = directFamiliesFault(model);
  if (family !== undefined) throw new Error(`The direct family record is forged: ${family}`);
  // The fan admissions are read from their record and the geometry, never admitted again (architecture-2 ticket 40, R1/R5).
  const fan = fanAdmissionsFault(model);
  if (fan !== undefined) throw new Error(`The fan admission record is forged: ${fan}`);
  const padding = labelPaddingFault(model);
  if (padding !== undefined) throw new Error(`The label padding record is forged: ${padding}`);
  // The stem depths are read from their record (architecture-2 ticket 57, R1); a record the geometry does not call for is refused (R5).
  const stems = stemDepthsFault(model);
  if (stems !== undefined) throw new Error(`The stem depth record is forged: ${stems}`);
  const unsettledRoom = labelRoomUnsettledFault(model);
  if (unsettledRoom !== undefined) throw new Error(`The record of the label rooms 7f gave up is forged: ${unsettledRoom}`);
  const yields = clone(model);
  if (recordLabelYields(yields, labelBorders(yields))) throw new Error('The label yields leave a pair of labels on diagonal lines undecided');
  const shortfalls: LinkLabelShortfall[] = [];
  // A label's room across a tier gap is no reservation the replay makes (the solve sets the gap), so a shortfall there is a fault too.
  if (reserveLinkLabelRoom(clone(model), shortfalls) || shortfalls.some(tierGapShortfall)) {
    // A separated overlay track (ticket 23) is named as such: its room is the track's, not a label's.
    const tracks = shortfalls.filter(item => item.axis.startsWith('overlay track')), labels = shortfalls.filter(item => !item.axis.startsWith('overlay track'));
    throw new Error([
      ...(labels.length ? ['A labelled link is shorter than the run its label reserved: '
        + labels.map(item => `${item.link} needs ${item.required} px along its ${item.axis} and holds ${item.room} px`).join('; ')] : []),
      ...(tracks.length ? ['An overlay track stands beyond the padding reserved for it: '
        + tracks.map(item => `${item.link} needs ${item.required} px for its ${item.axis} and holds ${item.room} px`).join('; ')] : []),
    ].join('. '));
  }
  const trial = clone(model);
  trial.diagnostics = trial.diagnostics.filter(item => item.code !== 'GROUP_GRID_NON_CONVERGENCE');
  // The producer's refusals are honoured for the pairs it names (the lanes and plans they read have moved since); a record that names a pair the boxes already share is a forgery.
  const honour = new Set(model.gridRefusals ?? []);
  const replay = alignGrid(trial, honour), changed = replay.changed, exhausted = trial.diagnostics.some(item => item.code === 'GROUP_GRID_NON_CONVERGENCE');
  const forged = [...honour].filter(key => replay.shares.get(key) !== false);
  if (forged.length) throw new Error(`The grid refusals ${forged.join(', ')} name pairs that are not linked or that already share an extent`);
  if (changed && !exhausted) {
    const moved = orderedGroupIds(model.document).filter(id => !equal(model.groups[id]!.bounds, trial.groups[id]!.bounds))
      .map(id => `${id} ${JSON.stringify(model.groups[id]!.bounds)} would be ${JSON.stringify(trial.groups[id]!.bounds)}`);
    throw new Error(`Linked groups do not share the grid their links require: ${moved.join('; ')}`);
  }
  const entries = routerEntryPoints(model);
  if (!equal(model.labelBands, expectedBands(model, entries))) throw new Error('Group label bands contradict final group geometry');
  // The bus bands and the bar and stubs of every bus are read off the settled row and frames; the side is fixed at the freeze (mesh-bus.md, section 4).
  if (!equal(model.busBands ?? [], expectedBusBands(model))) throw new Error('Bus bands contradict final group geometry');
  for (const bus of model.meshBuses ?? []) {
    for (const ref of bus.ports) if (findPort(model, ref)?.side !== bus.side) throw new Error(`Bus port of ${ref.node} does not stand on the side ${bus.id} was fixed on`);
    const geometry = busGeometry(model, bus);
    if (!equal({ bar: bus.bar, stubs: bus.stubs, labelRoom: bus.labelRoom }, { bar: geometry?.bar, stubs: geometry?.stubs, labelRoom: geometry?.labelRoom })) {
      throw new Error(`The bar and stubs of ${bus.id} contradict final group geometry`);
    }
    // The trunk x is derived in 7a and at every replay; 7f sets its joins on the bars, and every bar reaches it (mesh-bus.md, section 12.5).
    if (bus.trunk !== undefined) {
      if (!equal(bus.trunk.joins, trunkJoins(model, bus))) throw new Error(`The trunk of ${bus.id} contradicts the bars it joins`);
      for (const id of bus.trunk.buses) {
        const bar = model.meshBuses!.find(item => item.id === id)?.bar;
        if (bar !== undefined && (Math.min(bar.from.x, bar.to.x) > bus.trunk.x! + PLACEMENT_EPS || Math.max(bar.from.x, bar.to.x) < bus.trunk.x! - PLACEMENT_EPS)) throw new Error(`The bar of ${id} does not reach the trunk of ${bus.id}`);
      }
    }
    // The riser x is set in 7a; only room 7f inserts left of it moves it, with its lanes (`insertRoomAt`). 7f sets its ends on the two
    // bars, and both bars reach it.
    if (bus.riser !== undefined) {
      const ends = riserEnds(model, bus);
      if (!equal({ from: bus.riser.from, to: bus.riser.to }, { from: ends?.from, to: ends?.to })) throw new Error(`The riser of ${bus.id} contradicts the bars it joins`);
      for (const bar of [bus, model.meshBuses!.find(item => item.id === bus.joined)]) {
        if (bar?.bar !== undefined && (bar.bar.from.x > bus.riser.x + PLACEMENT_EPS || bar.bar.to.x < bus.riser.x - PLACEMENT_EPS)) throw new Error(`The bar of ${bar.id} does not reach the riser of ${bus.id}`);
      }
    }
  }
  for (const band of model.labelBands) {
    if (!Number.isFinite(band.clearance) || band.clearance < GROUP_PADDING - PLACEMENT_EPS) throw new Error(`Group ${band.group} reserves less than the ordinary padding below its label band`);
    // A canton band stands outside its member frames, which hold the margin; the frame check (G9) reads them.
    for (const nodeId of isCantonFrame(model, band.group) ? [] : model.groups[band.host ?? band.group]!.nodes) {
      const box = model.nodes[nodeId]!.bounds!;
      const clear = band.side === 'top' ? box.y >= bottom(band.bounds) + band.clearance - PLACEMENT_EPS : bottom(box) <= band.bounds.y - band.clearance + PLACEMENT_EPS;
      if (!clear) throw new Error(`Group ${band.group} does not retain its reserved clearance beside its label band`);
    }
  }
  // Stage 8 keeps these entry points and the below-band clearance reserved during placement.
  for (const { band, entry } of bandEntryConflicts(model, entries)) {
    if ((band.host ?? band.group) !== model.document.nodes[entry.node]!.group) continue;
    throw new Error(`Reserved ${entry.kind} entry point of ${entry.link} lies inside the ${band.group} label band reservation`);
  }
  // The titles are read from their record, never placed again (R1); a forged or missing record is refused (R5, R6).
  const titles = groupTitlesFault(model);
  if (titles !== undefined) throw new Error(`The group titles are forged: ${titles}`);
}

/**
 * Stage 7f: reserve and place deterministic group labels, then freeze final placement. `abortAt` is a check of the command deadline (a side trial's,
 * side-faces.md Section 19.5): it throws between the passes of 7f and so ends the whole command. It never changes the layout (ticket 141).
 * A call with no `abortAt` never throws for that reason.
 */
export function bands(model: LayoutModel, abortAt?: () => void, trace?: (event: AttemptTraceEvent) => void, moves?: boolean): LayoutModel {
  return withLayoutMutation(model, 'bands', () => {}, abortAt, trace, moves);
}
