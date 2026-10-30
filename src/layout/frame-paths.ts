import type { LayoutLink, LayoutModel, LayoutNode, LayoutPath, LayoutPort, PathSegment } from '../model/layout.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { crosses, sharedBlockers, straightChord } from './overlay-paths.js';
import { groupShape } from './grid.js';
import { bandSide, frameSide, GROUP_LABEL_GEOMETRY, legRectsFor, nudgingDistance, titleGrowthFeasible } from './bands.js';
import { frameSubtreeCells } from '../model/model.js';
import type { Point } from '../model/geometry.js';
import { stopsOf } from './gap-runs.js';
import { portId } from './skeleton-graph.js';
import { findPort, STRAIGHT_PATH_CLEARANCE, straightCorridorClear, straightLengthLimit, type CorridorOptions } from './row-paths.js';

const OUTWARD = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } } as const;
import { measureText } from '../text/index.js';
import { EPS, intersection, samePoint, segmentDistance, segmentRectDistance } from '../geometry/planar.js';
import { GROUP_LABEL_LINK_CLEARANCE } from '../theme/geometry.js';
import type { Rect } from '../model/geometry.js';
import { groupBoxes, groupConsumers } from '../score/model.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../theme/geometry.js';
import { deriveFrames } from './frames.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * The **straight** technique of a routed link inside one frame (ticket 34).
 *
 * A routed link whose two ends lie in one frame (the same document group, or a parent and its
 * child) is one straight segment between the two port faces where the chord clears every node body
 * and every pill that is not its own, and keeps the orthogonal route where it does not. The
 * candidate is topology only, known from stage 1; the confirmation reads placed bodies, so it is
 * re-derived by `rebuildRowPaths` after every move (rows, lanes, flanks, centre), and a body that
 * has moved onto the chord takes the link back to the orthogonal route.
 */

/** The document group whose frame holds this layout group: the group itself, or a cell's frame. */
export function frameOfGroup(model: LayoutModel, id: string): string {
  return model.groups[id]?.frame ?? id;
}
function parentFrame(model: LayoutModel, frame: string): string | undefined {
  const parent = model.document.frames?.[frame]?.parent ?? model.document.groups[frame]?.parent;
  return parent === undefined ? undefined : frameOfGroup(model, parent);
}
/** Whether two frames are one frame for this rule: the same, or a parent and its direct child. */
function sameFrame(model: LayoutModel, a: string, b: string): boolean {
  return a === b || parentFrame(model, a) === b || parentFrame(model, b) === a;
}

/** What a routed chord joins: two ends in one frame (`frame`), or in two frames on consecutive document tiers (`cross`, Q108). */
export type ChordKind = 'frame' | 'cross';

/** The authored tier of a layout group: a cell reads its frame's, a child group its parent's. */
function documentTier(model: LayoutModel, id: string): number | undefined {
  let group = id;
  for (let depth = 0; depth < 4; depth++) {
    const source = model.document.groups[group];
    if (source === undefined) return undefined;
    // An expanded document keeps the authored tier beside the sub-tier (stage 1); an unexpanded one has only the authored tier.
    if (source.documentTier !== undefined || source.tier !== undefined) return source.documentTier ?? source.tier;
    if (source.parent === undefined) return undefined;
    group = source.parent;
  }
  return undefined;
}

/**
 * The kind of chord a link may take, or undefined when it is no candidate. A frame chord is topology only, known from stage 1. A cross-frame
 * chord also reads the ports the side freeze fixed (stage 6): the upper end leaves by `bottom`, the lower end by `top`
 * (docs/design/routed-chords.md, Section 3).
 */
export function chordKind(model: LayoutModel, link: LayoutLink): ChordKind | undefined {
  const shared = sharedKinds;
  if (shared !== undefined) {
    // A link in the map was frozen when it went in, and a frozen object stays frozen: a hit needs no second check.
    const known = shared.get(link);
    if (known !== undefined) return known;
    if (shared.has(link)) return undefined;
    if (Object.isFrozen(link)) { const kind = chordKindOf(model, link); shared.set(link, kind); return kind; }
  }
  const scope = linkFactsScope;
  if (scope?.model !== model) {
    const step = stepKinds;
    if (step?.model !== model) return chordKindOf(model, link);
    const known = step.kinds.get(link);
    if (known !== undefined) return known;
    if (step.kinds.has(link)) return undefined;
    const kind = chordKindOf(model, link);
    step.kinds.set(link, kind);
    return kind;
  }
  const known = scope.kinds.get(link);
  if (known !== undefined) return known;
  if (scope.kinds.has(link)) return undefined;
  const kind = chordKindOf(model, link);
  scope.kinds.set(link, kind);
  return kind;
}

/**
 * What the link facts below read: ports, lanes, tier bands and the link's own shared runs. A caller that changes none of them for the
 * span of `run` (a row-path rebuild only sets paths and techniques, and the facts read a technique for `stub` alone) may have each
 * fact computed once per link. The scope holds one model; a query on any other model is never cached, and a scope never nests (a second one throws).
 */
interface LinkFactsScope { model: LayoutModel; kinds: Map<LayoutLink, ChordKind | undefined>; legs: Map<LayoutLink, Map<'from' | 'to', PathSegment | undefined>> }
let linkFactsScope: LinkFactsScope | undefined;
let sharedKinds: Map<LayoutLink, ChordKind | undefined> | undefined;
let stepKinds: { model: LayoutModel; kinds: Map<LayoutLink, ChordKind | undefined> } | undefined;
/**
 * One centring step asks for the kind of the same few chord links hundreds of times (every reading loops over the links). The step moves a group and
 * its nodes, and no port side, lane hint, group or link field that the kind reads (the argument of `withSharedLinkKinds`), so for the span of one step on
 * one model the kind of a link is read once. A step on another model, or outside a step, is never cached; a step never nests (the inner call reads through).
 */
export function withStepLinkKinds<T>(model: LayoutModel, run: () => T): T {
  if (stepKinds !== undefined) return run();
  stepKinds = { model, kinds: new Map() };
  try { return run(); } finally { stepKinds = undefined; }
}
/**
 * The replays of the centring check run a step on many copies of one model, and the copies share their links, frozen (`centreViolations`). A frozen link is the
 * same object in every copy, and a centring step moves no port side, lane hint or group, which are all that its kind reads besides the link: so its kind is
 * read once for all the copies. Only a frozen link is cached, and only while `run` is on the stack (architecture ticket 14).
 */
export function withSharedLinkKinds<T>(run: () => T): T {
  if (sharedKinds !== undefined) return run();
  sharedKinds = new Map();
  try { return run(); } finally { sharedKinds = undefined; }
}
export function withLinkFacts<T>(model: LayoutModel, run: () => T): T {
  if (linkFactsScope) throw new Error('A link-facts scope cannot nest: the outer cache would answer for the inner call');
  linkFactsScope = { model, kinds: new Map(), legs: new Map() };
  try { return run(); } finally { linkFactsScope = undefined; }
}

/**
 * A spanning-chord candidate (architecture ticket 22, docs/design/routed-chords.md, Section 14.1): Section 3 items 1, 2 and 4 hold, and the end
 * sub-tiers are not adjacent: the document tiers of the ends differ by 2 or more (item 3 reads "different" for "consecutive"), or they are consecutive
 * and a rank band of an end's own tier stands between the end sub-tiers (architecture-2 ticket 35, part 1; Q122). Topology and the stage-5 faces
 * only; the corridor test is `chordVerdict`'s. A link that already carries the hint is a candidate too.
 */
export function spanCandidate(model: LayoutModel, link: LayoutLink): boolean {
  if ((documentTierGap(model, link) === undefined && !rankBandBetween(model, link)) || chordKindOf(model, link, true) !== 'cross') return false;
  // A fan (several routed links on one port) is one shared stem tree whose leaves are the lanes of its links (7e, ticket 20): a link in it keeps its lane.
  const ends = link.attachments!;
  return ![ends.from, ends.to].some(end => model.links.some(other => other.id !== link.id && other.layer === 'routed' && other.attachments
    && [other.attachments.from, other.attachments.to].some(ref => portId(ref) === portId(end))));
}
/** How many document tiers lie between the ends of the link, when it is two or more; otherwise undefined. */
export function documentTierGap(model: LayoutModel, link: LayoutLink): number | undefined {
  const ends = link.attachments;
  if (ends === undefined) return undefined;
  const a = model.document.nodes[ends.from.node]?.group, b = model.document.nodes[ends.to.node]?.group;
  if (a === undefined || b === undefined) return undefined;
  const one = documentTier(model, a), two = documentTier(model, b);
  return one === undefined || two === undefined || Math.abs(one - two) < 2 ? undefined : Math.abs(one - two);
}
/**
 * Whether the ends stand on consecutive document tiers and a sub-tier lies strictly between their sub-tiers: a group with fewer ranks than its tier
 * leaves a rank band of that tier between the ends (Section 3, last paragraph). Topology only: the sub-tiers are stage 1's, and every sub-tier that
 * holds a group has a tier band (`validateDocument`).
 */
export function rankBandBetween(model: LayoutModel, link: LayoutLink): boolean {
  const ends = link.attachments;
  if (ends === undefined) return false;
  const a = model.document.nodes[ends.from.node]?.group, b = model.document.nodes[ends.to.node]?.group;
  if (a === undefined || b === undefined) return false;
  const one = documentTier(model, a), two = documentTier(model, b);
  if (one === undefined || two === undefined || Math.abs(one - two) !== 1) return false;
  const low = model.groups[a]?.tier, high = model.groups[b]?.tier;
  if (low === undefined || high === undefined) return false;
  return Object.values(model.groups).some(group => group.tier !== undefined && group.tier > Math.min(low, high) && group.tier < Math.max(low, high));
}

function chordKindOf(model: LayoutModel, link: LayoutLink, assumeSpan = false): ChordKind | undefined {
  if (link.layer !== 'routed' || !link.attachments || link.bundle !== undefined) return undefined;
  if (link.technique === 'stub' || effectiveLayer(link) !== 'routed') return undefined;
  const route = model.document.links[link.sourceIndex]?.route;
  if (route !== undefined && route !== 'straight') return undefined;
  const { from, to } = link.attachments;
  if (from.node === to.node) return undefined;
  // A port hinted for the routed L (ticket 119) owns a side lane, not a chord.
  if ([from, to].some(end => findPort(model, end)?.laneHint === true)) return undefined;
  const a = model.document.nodes[from.node]?.group, b = model.document.nodes[to.node]?.group;
  if (a === undefined || b === undefined) return undefined;
  // A flank and a bar own their links' paths (flank and bar rules), and a bar is not a frame member.
  if ([a, b].some(id => model.groups[id]?.flank !== undefined || groupShape(model, id) === 'bar')) return undefined;
  if (sameFrame(model, frameOfGroup(model, a), frameOfGroup(model, b))) return 'frame';
  const tiers = [documentTier(model, a), documentTier(model, b)];
  if (tiers[0] === undefined || tiers[1] === undefined) return undefined;
  const gap = Math.abs(tiers[0] - tiers[1]);
  // A spanning chord (ticket 22): the hint makes a link on tiers that are not consecutive a cross-frame candidate. An unhinted one is not.
  if (gap !== 1 && !(gap >= 2 && (assumeSpan || link.spanHint === true))) return undefined;
  const [upper, lower] = tiers[0] < tiers[1] ? [from, to] : [to, from];
  return facesAllowed(findPort(model, upper), 'bottom') && facesAllowed(findPort(model, lower), 'top') ? 'cross' : undefined;
}

/** A cross-frame chord leaves the natural face of its end, or the lateral side a hint gave the port (docs/design/side-faces.md, Section 9). */
const facesAllowed = (port: LayoutPort | undefined, natural: 'top' | 'bottom'): boolean =>
  port?.side === natural || (port?.sideHint === true && (port.side === 'left' || port.side === 'right'));
/** Topology-only test: the frame rule owns this link's path whenever geometry makes it eligible. */
export function frameLinkCandidate(model: LayoutModel, link: LayoutLink): boolean {
  return chordKind(model, link) === 'frame';
}
/** Whether the link may take a routed chord of either kind. */
export function routedChordCandidate(model: LayoutModel, link: LayoutLink): boolean {
  return chordKind(model, link) !== undefined;
}

/**
 * A link that took the straight technique and holds its pinned chord. It reserves no lane, no gap
 * run, no stem and no bar membership, and it is no obstacle to the router: like an overlay link it
 * is read by node bodies and pills only.
 */
export function isRoutedChord(model: LayoutModel, link: LayoutLink): boolean {
  return link.technique === 'straight' && link.path?.fixed === true && link.path.segments.length === 1
    && link.path.segments[0]!.straight === true && routedChordCandidate(model, link);
}

/**
 * The title sides of one link array. A title stands on the edge with fewer routed ports on links that
 * cross its group's boundary (ADR-0011), which the port sides stage 6 froze already decide; stage 7g
 * only places the label on that edge. Cached on the link array like the peer index of `sides-two`:
 * every checked transaction clones the array, and the answer reads it alone.
 */
const sidesCache = new WeakMap<LayoutModel['links'], Map<string, 'top' | 'bottom' | undefined>>();
function titleSides(model: LayoutModel): Map<string, 'top' | 'bottom' | undefined> {
  const cached = sidesCache.get(model.links);
  if (cached) return cached;
  const sides = new Map<string, 'top' | 'bottom' | undefined>();
  for (const id of Object.keys(model.document.frames ?? {})) sides.set(id, frameSide(model, id));
  for (const [id, group] of Object.entries(model.groups)) if (group.frame === undefined) sides.set(id, bandSide(model, group));
  sidesCache.set(model.links, sides);
  return sides;
}

/**
 * The strips the titles stand in: the edge each titled group or frame keeps its label on, as tall as
 * the title's band, grown by the link-free margin. The label's x is chosen in 7g, after this rule pins
 * its chord, so the whole strip is held: a chord that crossed it would meet a title that no later stage
 * could move out of the way in a frame as narrow as its own label, and stage 9 would discover what
 * placement could have reserved. Such a link keeps the orthogonal route, which the title planner already
 * detours.
 */
/** One title strip: the rectangle `titleStrips` holds, the owner of the title, its edge, and the nodes whose ports on that edge draw a leg through it. */
export interface TitleStrip {
  id: string; side: 'top' | 'bottom'; label: string; rect: Rect; members: ReadonlySet<string>;
  /** The layout group whose box is the strip and which 7f widens for a title that does not fit (`planLabels`); absent for a canton, whose band is its own. */
  host?: string;
}

function titleStrips(model: LayoutModel): TitleStrip[] {
  const strips: TitleStrip[] = [], sides = titleSides(model);
  const add = (id: string, label: string | undefined, side: 'top' | 'bottom' | undefined, box: Rect, members: readonly string[], host: string): void => {
    if (!label || side === undefined) return;
    const height = measureText(label, { fontSize: 12, weight: 700 }).height + 8 + 2 * GROUP_LABEL_LINK_CLEARANCE;
    strips.push({ id, side, label, members: new Set(members), host,
      rect: { x: box.x, y: side === 'top' ? box.y - GROUP_LABEL_LINK_CLEARANCE : box.y + box.height - height + GROUP_LABEL_LINK_CLEARANCE, width: box.width, height } });
  };
  for (const [id, frame] of Object.entries(model.document.frames ?? {})) {
    const cells = frame.cells.map(cell => model.groups[cell]).filter(group => group?.bounds !== undefined)
      .sort((a, b) => a!.tier! - b!.tier!);
    const side = sides.get(id);
    if (cells.length) {
      const host = side === 'bottom' ? cells.at(-1)! : cells[0]!;
      add(id, frame.label, side, host.bounds!, host.nodes, host.id);
    }
  }
  for (const [id, group] of Object.entries(model.groups)) {
    if (group.frame === undefined && group.bounds && group.nodes.length) add(id, model.document.groups[id]?.label, sides.get(id), group.bounds, group.nodes, id);
  }
  // A canton holds its title in a band of its sub-tier, not in a cell (canton-groups ticket 3). The band exists from 7f on; before it the
  // title edge is the strip outside the box the members give.
  for (const [id, frame] of Object.entries(model.document.frames ?? {})) {
    const box = frame.kind === 'canton' ? model.frames?.find(item => item.id === id)?.box : undefined, side = sides.get(id);
    if (!box || side === undefined || !frame.label) continue;
    const cells = frameSubtreeCells(model.document.frames ?? {}, id).map(cell => model.groups[cell]!);
    const tiers = cells.map(cell => cell.tier!), edge = side === 'top' ? Math.min(...tiers) : Math.max(...tiers);
    const members = cells.filter(cell => cell.tier === edge).flatMap(cell => cell.nodes);
    const band = model.labelBands.find(item => item.group === id && item.host === undefined);
    if (band) strips.push({ id, side, label: frame.label, members: new Set(members),
      rect: { x: box.x, y: band.bounds.y - GROUP_LABEL_LINK_CLEARANCE, width: box.width, height: band.bounds.height + 2 * GROUP_LABEL_LINK_CLEARANCE } });
    else {
      const room = measureText(frame.label, { fontSize: 12, weight: 700 }).height + 8;
      strips.push({ id, side, label: frame.label, members: new Set(members),
        rect: { x: box.x, y: side === 'top' ? box.y - room - GROUP_LABEL_LINK_CLEARANCE : box.y + box.height - GROUP_LABEL_LINK_CLEARANCE,
          width: box.width, height: room + 2 * GROUP_LABEL_LINK_CLEARANCE } });
    }
  }
  return strips;
}

/**
 * The crossing rectangle of a chord through a title band (ticket 100): the part of the segment between two y values, as its bounding box grown by
 * `half` (the half stroke) in y. In x it is grown by the half stroke and by the link-free margin of the title (`GROUP_LABEL_LINK_CLEARANCE`), both taken
 * along the normal of the chord: a title that stands the margin from the rectangle in x stands that margin from a slanted line only when the rectangle
 * is wider by the factor 1 / cos of the angle to the vertical (measured: without it G3 fails a title 7.8 px from a 52 degree chord). Undefined where the
 * segment does not reach the range. The margin is part of the rectangle here; a caller adds no other.
 */
export function crossingRect(segment: PathSegment, top: number, floor: number, half: number): Rect | undefined {
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
  let low = 0, high = 1;
  if (Math.abs(dy) < EPS) {
    if (segment.from.y < top - EPS || segment.from.y > floor + EPS) return undefined;
  } else {
    const a = (top - segment.from.y) / dy, b = (floor - segment.from.y) / dy;
    low = Math.max(0, Math.min(a, b)); high = Math.min(1, Math.max(a, b));
    if (low >= high - EPS) return undefined;
  }
  const at = (t: number): Point => ({ x: segment.from.x + t * dx, y: segment.from.y + t * dy });
  const one = at(low), two = at(high);
  const slant = Math.min(50, Math.hypot(dx, dy) / Math.max(Math.abs(dy), EPS));
  const along = (half + GROUP_LABEL_LINK_CLEARANCE) * slant;
  return { x: Math.min(one.x, two.x) - along, y: Math.min(one.y, two.y) - half,
    width: Math.abs(two.x - one.x) + 2 * along, height: Math.abs(two.y - one.y) + 2 * half };
}

/** Whether the strip is the title of the end the chord leaves, on the edge it leaves through (docs/design/routed-chords.md, Section 6). */
function ownStrip(model: LayoutModel, link: LayoutLink, strip: TitleStrip): boolean {
  return (['from', 'to'] as const).some(end => {
    const ref = link.attachments![end];
    return findPort(model, ref)?.side === strip.side && holders(model, ref.node).has(strip.id);
  });
}

/**
 * How much wider the strip must be for its title to fit beside the given obstacles, each with the link-free margin already in it: 0 when some gap
 * between two of them, or between one and the strip end less the inset (8 px, as the margin), is as wide as the measured title. Otherwise the
 * shortfall of the last gap, the only one a widening of the host to the right opens (`growthPlan` keeps the x of the box).
 */
function titleDeficit(strip: TitleStrip, obstacles: readonly Rect[]): number {
  return titleShortfall(strip.label, strip.rect, obstacles);
}
/** `titleDeficit` for a title and the x-range of its band (the 7f reservation reads it on a label band, `reserveChordTitleRoom`). */
export function titleShortfall(label: string, band: Pick<Rect, 'x' | 'width'>, obstacles: readonly Rect[]): number {
  const width = measureText(label, { fontSize: 12, weight: 700 }).width;
  const left = band.x + GROUP_LABEL_GEOMETRY.horizontalInset, end = band.x + band.width - GROUP_LABEL_GEOMETRY.horizontalInset;
  const spans = obstacles.map(rect => [rect.x, rect.x + rect.width] as const).sort((a, b) => a[0] - b[0]);
  let cursor = left;
  for (const [low, high] of spans) {
    if (low - cursor >= width - EPS) return 0;
    cursor = Math.max(cursor, high);
  }
  return end - cursor >= width - EPS ? 0 : width - (end - cursor);
}

/**
 * The crossing a vertical leg at the chord's own port would make in the strip (the leg its orthogonal fallback draws through the band, as `legRectsFor`
 * reads it), with the same margin a crossing rectangle carries. Undefined when the link has no port of its own on the strip's edge.
 */
function fallbackCrossing(model: LayoutModel, link: LayoutLink, strip: TitleStrip, half: number): Rect | undefined {
  for (const end of ['from', 'to'] as const) {
    const ref = link.attachments![end], port = findPort(model, ref);
    if (port?.anchor === undefined || port.side !== strip.side || !holders(model, ref.node).has(strip.id)) continue;
    const along = half + GROUP_LABEL_LINK_CLEARANCE;
    return { x: port.anchor.x - along, y: strip.rect.y, width: 2 * along, height: strip.rect.height };
  }
  return undefined;
}

/**
 * Whether an own title band admits a chord whose crossing leaves its title `deficit` px short (architecture-2 ticket 35, part 2). The title gets the
 * room by a widening of its host to the right, which 7f makes (`planLabels`, as it widens a title for a leg, ticket 66). The admission proves that room:
 * the widening by the whole deficit is lane-feasible now (`titleGrowthFeasible`, the planner's own decision), and the chord costs no more than its
 * lean over the fallback: its deficit exceeds the deficit the fallback leg would leave by at most the x the chord's crossing takes beyond that leg's.
 * A canton band (no host), an infeasible widening or a larger cost refuse.
 */
function leanReserved(model: LayoutModel, strip: TitleStrip, own: Rect, leg: Rect | undefined, rest: readonly Rect[], deficit: number): boolean {
  if (strip.host === undefined || leg === undefined) return false;
  const lean = Math.max(own.x + own.width, leg.x + leg.width) - Math.min(own.x, leg.x) - leg.width;
  return deficit <= titleDeficit(strip, [leg, ...rest]) + lean + EPS && titleGrowthFeasible(model, strip.host, deficit);
}

/**
 * Whether title strips refuse a chord. A frame chord refuses every strip. A cross-frame chord refuses a strip that is not its own end's on the edge
 * it leaves through, and an own strip whose title has no room. `others` reads the legs of the orthogonal links and the crossings of the held
 * chords too (the fit of the fixed point); without it the chord's own crossing alone is read (the fit of the standalone chord).
 */
function titleRefusal(model: LayoutModel, link: LayoutLink, segment: PathSegment, others: boolean): boolean {
  const kind = chordKind(model, link), strips = titleStrips(model);
  const crossed = strips.filter(strip => segmentRectDistance(segment, strip.rect) === 0);
  if (kind !== 'cross') return crossed.length > 0;
  if (crossed.some(strip => !ownStrip(model, link, strip))) return true;
  const half = linkStrokeWidth(link) / 2;
  return crossed.some(strip => {
    const own = crossingRect(segment, strip.rect.y, strip.rect.y + strip.rect.height, half);
    const rest: Rect[] = [];
    if (others) {
      // A leg is a stroke: the link-free margin is added to it here (a crossing rectangle carries its own).
      const legs = legRectsFor(model, [{ id: strip.id, bounds: strip.rect, side: strip.side, members: strip.members }], link.id);
      rest.push(...legs.map(item => item.bounds).filter(box => box.x >= strip.rect.x - EPS && box.x <= strip.rect.x + strip.rect.width + EPS)
        .map(box => ({ x: box.x - GROUP_LABEL_LINK_CLEARANCE, y: box.y, width: box.width + 2 * GROUP_LABEL_LINK_CLEARANCE, height: box.height })));
      for (const other of model.links) {
        if (other.id === link.id || !isRoutedChord(model, other) || chordKind(model, other) !== 'cross') continue;
        const rect = crossingRect(other.path!.segments[0]!, strip.rect.y, strip.rect.y + strip.rect.height, linkStrokeWidth(other) / 2);
        if (rect) rest.push(rect);
      }
    }
    if (own === undefined) return titleDeficit(strip, rest) > 0;
    const deficit = titleDeficit(strip, [own, ...rest]);
    return deficit > 0 && !leanReserved(model, strip, own, fallbackCrossing(model, link, strip, half), rest, deficit);
  });
}

/** The bare chord of the link between its two faces, or undefined when its ends coincide. Nothing is checked. */
export function chordSegment(model: LayoutModel, link: LayoutLink): PathSegment | undefined {
  const chord = straightChord(model, link);
  if (!chord || Math.hypot(chord.to.x - chord.from.x, chord.to.y - chord.from.y) < PLACEMENT_EPS) return undefined;
  return { from: chord.from, to: chord.to, owner: { ...link.owner } };
}

/**
 * Extra room a chord keeps from the corners of a side edge it leaves through, at the probe and the fixed point (docs/design/side-faces.md, Section 9):
 * the shape is judged at 7e and drawn after 7f, which moves columns and grows gaps. The freeze names the refusal `standaloneChord` gave at 7e, so it reads the slack too; `edgeLeavers` and `blockedChords` (after the freeze) read the margin alone.
 */
export const SIDE_EDGE_SLACK = 4;

/** The first check that refused a chord (`ROUTED_CHORD_REFUSED`, docs/design/routed-chords.md, Section 10). */
export type ChordRefusal = 'transit' | 'faces' | 'edge' | 'frame' | 'title' | 'body' | 'pill' | 'lane' | 'corridor' | 'chord' | 'leg';

/** The ids of the groups, frames and parents above them that hold this node. */
function holders(model: LayoutModel, node: string): Set<string> {
  const ids = new Set<string>();
  let id: string | undefined = model.document.nodes[node]?.group;
  for (let depth = 0; id !== undefined && depth < 6 && !ids.has(id); depth++) {
    ids.add(id);
    const frame = frameOfGroup(model, id);
    ids.add(frame);
    id = model.document.frames?.[frame]?.parent ?? model.document.groups[frame]?.parent;
  }
  return ids;
}

/**
 * What a cross-frame chord must clear beyond the bodies (docs/design/routed-chords.md, Section 4). Every box of `groupBoxes` that holds neither end
 * and does not consume the link is a wall with the group edge margin; a box that holds one end only is left through the horizontal edge the port
 * faces, at least the margin from each corner. Reads `model.frames`, which equals the cells after every transaction.
 */
function crossRefusal(model: LayoutModel, link: LayoutLink, segment: PathSegment, sideSlack = 0): 'edge' | 'frame' | undefined {
  const ends = link.attachments!, stroke = linkStrokeWidth(link);
  const from = holders(model, ends.from.node), to = holders(model, ends.to.node);
  const sides = { from: findPort(model, ends.from)?.side, to: findPort(model, ends.to)?.side };
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
  const margin = GROUP_EDGE_LINK_CLEARANCE - EPS;
  for (const { id, bounds } of groupBoxes(model)) {
    const one = from.has(id), two = to.has(id);
    if (one && two) continue;
    if (!one && !two) {
      if (segmentRectDistance(segment, bounds) < GROUP_EDGE_LINK_CLEARANCE + stroke / 2 - EPS && !groupConsumers(model, id).includes(link.id)) return 'frame';
      continue;
    }
    const side = one ? sides.from : sides.to;
    if (side === 'left' || side === 'right') {
      // A lateral port leaves through the side edge it faces, at least the margin (and the slack) from each corner.
      const edge = side === 'right' ? bounds.x + bounds.width : bounds.x;
      const t = Math.abs(dx) < EPS ? Infinity : (edge - segment.from.x) / dx;
      const y = segment.from.y + t * dy, room = margin + sideSlack;
      if (!(t >= -EPS && t <= 1 + EPS) || y < bounds.y + room || y > bounds.y + bounds.height - room) return 'edge';
      continue;
    }
    if (side !== 'top' && side !== 'bottom') return 'edge';
    const edge = side === 'bottom' ? bounds.y + bounds.height : bounds.y;
    const t = Math.abs(dy) < EPS ? Infinity : (edge - segment.from.y) / dy;
    const x = segment.from.x + t * dx;
    if (!(t >= -EPS && t <= 1 + EPS) || x < bounds.x + margin || x > bounds.x + bounds.width - margin) return 'edge';
  }
  return undefined;
}

/**
 * Diagnostic only (the side probe of ticket 117): for each box that holds one end only, the edge the chord should leave through, and the miss in px:
 * 0 when the chord meets that edge inside the corner margin, else how far outside it (`Infinity`: the chord does not meet that edge's line between its ends).
 */
export function edgeMisses(model: LayoutModel, link: LayoutLink, segment: PathSegment): { box: string; side: string | undefined; miss: number }[] {
  const ends = link.attachments!, from = holders(model, ends.from.node), to = holders(model, ends.to.node);
  const sides = { from: findPort(model, ends.from)?.side, to: findPort(model, ends.to)?.side };
  const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y, margin = GROUP_EDGE_LINK_CLEARANCE;
  const found: { box: string; side: string | undefined; miss: number }[] = [];
  for (const { id, bounds } of groupBoxes(model)) {
    const one = from.has(id), two = to.has(id);
    if (one === two) continue;
    const side = one ? sides.from : sides.to;
    let miss = Infinity;
    if (side === 'left' || side === 'right') {
      const t = Math.abs(dx) < EPS ? Infinity : ((side === 'right' ? bounds.x + bounds.width : bounds.x) - segment.from.x) / dx, y = segment.from.y + t * dy;
      if (t >= -EPS && t <= 1 + EPS) miss = Math.max(0, bounds.y + margin - y, y - (bounds.y + bounds.height - margin));
    } else if (side === 'top' || side === 'bottom') {
      const t = Math.abs(dy) < EPS ? Infinity : ((side === 'bottom' ? bounds.y + bounds.height : bounds.y) - segment.from.y) / dy, x = segment.from.x + t * dx;
      if (t >= -EPS && t <= 1 + EPS) miss = Math.max(0, bounds.x + margin - x, x - (bounds.x + bounds.width - margin));
    }
    found.push({ box: id, side, miss });
  }
  return found;
}

/**
 * The chord of the link when nothing that no other link can change refuses it, or the first check that does: the two faces, the tiers between
 * them, the foreign frames and the facing edge (a cross-frame chord), the title strips and the corridor the bodies and reservations leave
 * (ticket 89 review).
 */
export function chordVerdict(model: LayoutModel, link: LayoutLink, sideSlack = 0): { segment: PathSegment } | { reason: ChordRefusal } {
  const kind = chordKind(model, link);
  if (flatPerpendicularChord(model, link)) return { reason: 'faces' };
  const geometry = straightChord(model, link, undefined, true);
  if (!geometry || Math.hypot(geometry.to.x - geometry.from.x, geometry.to.y - geometry.from.y) < PLACEMENT_EPS) return { reason: 'faces' };
  // A link that crosses a tier it does not end in needs the lane lanes.ts reserves for it, and a lane
  // cannot be given back after 7c has aligned the ends under it. Such a link keeps the lane and the
  // orthogonal route, so that no move after stage 7a can leave a transit without its reservation.
  const tiers = [link.attachments!.from.node, link.attachments!.to.node].map(id => model.groups[model.document.nodes[id]!.group]!.tier!);
  // A spanning chord (ticket 22) has no lane: the bands it crosses leave a corridor, which the checks below read as walls.
  if (link.spanHint !== true && model.tierBands.some(band => band.tier > Math.min(...tiers) && band.tier < Math.max(...tiers))) return { reason: 'transit' };
  const line: PathSegment = { from: geometry.from, to: geometry.to, owner: { ...link.owner } };
  if (kind === 'cross') {
    // The port sides say which end is upper; the faces must agree, or the chord leaves a port inward.
    if (!(geometry.to.y > geometry.from.y === (tiers[0]! < tiers[1]!))) return { reason: 'faces' };
    const reason = crossRefusal(model, link, line, sideSlack);
    if (reason) return { reason };
  }
  if (titleRefusal(model, link, line, false)) return { reason: 'title' };
  const segment = chordSegment(model, link);
  if (!segment) return { reason: 'body' };
  // The chord must also hold every clearance the gates measure a routed segment against (G2, G6),
  // or a published straight link would fail the gate its rule was meant to satisfy.
  const refusal: NonNullable<CorridorOptions['refusal']> = {};
  if (!straightCorridorClear(model, link, segment, { refusal })) return { reason: refusal.reason ?? 'corridor' };
  return { segment };
}

const VERTICAL = new Set(['top', 'bottom']);
/**
 * The angle from the normal of the `top` or `bottom` face at and above which a long chord to a lateral face runs nearly along that face (user, 2026-10-24:
 * "90 degrees turn work only in some cases"). Measured on the corpus: the provider chord stands at 81.3 degrees and its L costs one bend; every long
 * perpendicular chord at 75.8 degrees or less stood in a sheet where its L cost bends (and on a-foreign-unit a G9).
 */
export const PERPENDICULAR_FLAT_ANGLE = 80;

/**
 * Whether a routed chord between perpendicular faces is refused, derived from the geometry: a `top` or `bottom` face and a lateral side stand at 90
 * degrees, the chord between the anchors is at least the straight-link length limit (`straightLengthLimit`, twice the larger dimension of the two
 * bodies), and it leaves the top or bottom face at `PERPENDICULAR_FLAT_ANGLE` or more from its normal. A shorter or steeper perpendicular chord, opposite
 * faces and two faces on one side keep the other chord rules.
 */
function derivedFlatPerpendicular(model: LayoutModel, link: LayoutLink): boolean {
  const ends = link.attachments;
  if (!ends) return false;
  const one = findPort(model, ends.from), two = findPort(model, ends.to);
  if (one?.side === undefined || two?.side === undefined || VERTICAL.has(one.side) === VERTICAL.has(two.side) || !one.anchor || !two.anchor) return false;
  const nodes = [model.nodes[ends.from.node], model.nodes[ends.to.node]];
  if (nodes.some(node => node?.bounds === undefined)) return false;
  const dx = Math.abs(two.anchor.x - one.anchor.x), dy = Math.abs(two.anchor.y - one.anchor.y);
  if (Math.hypot(dx, dy) < straightLengthLimit(nodes as LayoutNode[]) - EPS) return false;
  return Math.atan2(dx, dy) * 180 / Math.PI >= PERPENDICULAR_FLAT_ANGLE - EPS;
}

/**
 * A long, flat chord never joins perpendicular faces (architecture-2 ticket 22). Before the freeze the rule is derived from the geometry. From the
 * freeze on, the held chords are the decision (`model.frozenChords`, R1), and the rule refuses nothing: a later move in x does not take the
 * decision again. Every chord decision reads this one predicate (`chordVerdict`).
 *
 * The freeze recorded the links the rule refused until review (`perpendicularRefusals`). A scan of every golden found the record empty on every
 * sheet: a link the rule refuses takes a side-lane hint before the freeze and is no chord candidate there. So the record changed no result, and
 * it was deleted.
 */
export function flatPerpendicularChord(model: LayoutModel, link: LayoutLink): boolean {
  return model.frozenChords === undefined && derivedFlatPerpendicular(model, link);
}

/** The chord of the link when nothing that no other link can change refuses it. The fan rules ask this first. */
export function standaloneChord(model: LayoutModel, link: LayoutLink): PathSegment | undefined {
  const verdict = chordVerdict(model, link, SIDE_EDGE_SLACK);
  return 'segment' in verdict ? verdict.segment : undefined;
}

/**
 * The reserved vertical run of a link that stays orthogonal, at one end: from the port face outward to the row the plan will
 * seat, which is not known before 7f: the whole tier gap it faces when the link runs on through it, or a drop to the far port's stem tip when
 * that port stands in the band across the gap. A side port or a port with no tier gap beyond it keeps the stem alone (ticket 91).
 */
export function orthogonalLeg(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): PathSegment | undefined {
  const scope = linkFactsScope;
  if (scope?.model !== model) return orthogonalLegOf(model, link, end);
  let ends = scope.legs.get(link);
  if (!ends) scope.legs.set(link, ends = new Map());
  if (!ends.has(end)) ends.set(end, orthogonalLegOf(model, link, end));
  // Each caller gets its own segment object, so a caller that sets a field on it cannot change the cache (`from` is the port anchor, as uncached).
  const leg = ends.get(end);
  return leg && { ...leg };
}

function orthogonalLegOf(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): PathSegment | undefined {
  const port = findPort(model, link.attachments![end]), out = port?.side === undefined ? undefined : OUTWARD[port.side];
  if (!port?.anchor || !out) return undefined;
  let length: number = GROUP_LABEL_GEOMETRY.routerStem;
  if (out.x === 0) {
    const y = port.anchor.y;
    const boxes = model.tierBands.flatMap(band => band.bounds ? [band.bounds] : []);
    const edgeOf = (box: Rect): number => out.y > 0 ? box.y : box.y + box.height;
    const across = boxes.filter(box => (edgeOf(box) - y) * out.y > EPS).sort((a, b) => (edgeOf(a) - edgeOf(b)) * out.y)[0];
    if (across) {
      const edge = edgeOf(across);
      const far = findPort(model, link.attachments![end === 'from' ? 'to' : 'from']);
      // The far end stands in the band across the gap, facing back: the link ends in this gap, and its longest vertical is a drop to the
      // far port's stem tip (a row stands at most there; a row nearer the edge, at the group-edge margin, is shorter). Otherwise the
      // link runs on through the gap by a lane and the leg is the whole gap (ticket 91).
      const meets = far?.anchor !== undefined && far.side === (out.y > 0 ? 'top' : 'bottom')
        && far.anchor.y >= across.y - EPS && far.anchor.y <= across.y + across.height + EPS;
      let reach = meets ? far!.anchor!.y - out.y * GROUP_LABEL_GEOMETRY.routerStem : edge;
      if (!meets) {
        // The gap the plan sees is the band gap clipped to the lanes that face it (`tierGaps`); values are compared here, not through `edgeOf`,
        // which reads an unset epsilon through the import cycle. A link whose next stop is a lane on that far boundary ends its part at the
        // lane mouth, a stem short of the boundary, and its row stands a clearance above the mouth: the leg stops there. A lane within a
        // clearance of the port's x is a drop into the lane, and keeps the edge.
        const lanes = model.lanes.filter(lane => lane.layer !== 'overlay' && (lane.bounds.y - y) * out.y > EPS && (lane.bounds.y - edge) * out.y < -EPS);
        const boundary = out.y > 0 ? Math.min(edge, ...lanes.map(lane => lane.bounds.y)) : Math.max(edge, ...lanes.map(lane => lane.bounds.y + lane.bounds.height));
        const stops = stopsOf(model, link), stop = end === 'from' ? stops[1] : stops.at(-2);
        if (stop?.kind === 'lane' && Math.abs(stop.point.y - boundary) < EPS && Math.abs(stop.point.x - port.anchor.x) >= nudgingDistance(model) - EPS) {
          reach = boundary - out.y * GROUP_LABEL_GEOMETRY.routerStem;
        }
      }
      length = Math.max(length, Math.abs(reach - y));
    }
  }
  return { from: port.anchor, to: { x: port.anchor.x + length * out.x, y: port.anchor.y + length * out.y }, owner: { ...link.owner } };
}

/**
 * The mouth legs of the lanes that end on a boundary of the chord's gap: at the lane's x, from the lane box's end through the whole gap.
 * The row a mouth leg meets is not known before 7f, so the chord holds the clearance along all of it.
 */
function mouthLegs(model: LayoutModel, link: LayoutLink): { leg: PathSegment; other: LayoutLink | undefined }[] {
  const ends = [link.attachments!.from.node, link.attachments!.to.node].map(id => model.groups[model.document.nodes[id]!.group]!.tier!);
  const [low, high] = [Math.min(...ends), Math.max(...ends)];
  const upper = model.tierBands.find(band => band.tier === low)?.bounds, lower = model.tierBands.find(band => band.tier === high)?.bounds;
  if (low === high || !upper || !lower) return [];
  const legs: { leg: PathSegment; other: LayoutLink | undefined }[] = [];
  for (const lane of model.lanes) {
    if (lane.layer === 'overlay' || (lane.tier !== low && lane.tier !== high)) continue;
    const from = lane.tier === low ? lane.bounds.y + lane.bounds.height : upper.y + upper.height;
    const to = lane.tier === low ? lower.y : lane.bounds.y;
    const owner = lane.owner.kind === 'link' ? lane.owner.id : undefined;
    legs.push({ leg: { from: { x: lane.x, y: from }, to: { x: lane.x, y: to }, owner: { ...lane.owner } }, other: model.links.find(item => item.id === owner) });
  }
  return legs;
}

/**
 * The checks of the fixed point on a chord that stands alone: the chords already held and the vertical legs of the links that stay
 * orthogonal, mouth legs of the gap's lanes included. The first that fails names the refusal.
 */
export function fixedPointRefusal(model: LayoutModel, link: LayoutLink, segment: PathSegment, undecided?: ReadonlySet<string>, crossable?: ReadonlySet<string>): 'chord' | 'leg' | 'title' | undefined {
  // Two chords are no obstacle to each other for the router, but G6 still measures their clearance:
  // only a strict crossing excuses a pair that stands closer than 10 px (a shared end does not).
  const stroke = linkStrokeWidth(link);
  for (const other of model.links) {
    if (other.id === link.id || !isRoutedChord(model, other)) continue;
    const run = other.path!.segments[0]!;
    if (!chordsApart(segment, run, stroke, linkStrokeWidth(other))) return 'chord';
  }
  // The router leaves every other port by a stem of at least 15 px, and G6 keeps that stem 10 px from the
  // chord. Stage 8 cannot make room the chord took, so the chord stays clear of every stem placement has
  // already promised, its own ports' other links included. The stem is only the start of a vertical leg that runs on
  // to the link's gap row, so the chord holds the clearance against the whole leg (ticket 91).
  for (const other of model.links) {
    if (other.id === link.id || other.layer !== 'routed' || other.technique === 'stub' || !other.attachments || other.removed === true) continue;
    // The span offer reads every candidate as a chord to be (ticket 22): the legs of the ones not yet decided are no wall.
    if (isRoutedChord(model, other) || undecided?.has(other.id)) continue;
    for (const end of ['from', 'to'] as const) {
      const leg = orthogonalLeg(model, other, end);
      if (!leg) continue;
      // A direct member may cross the fallback leg of another source node's fan (ticket 22, user 2026-10-23). The leg reserved here runs to the far
      // stem tip, but the real one ends at a row the plan seats later, anywhere in the gap: so the chord crosses the leg's line, and a chord whose
      // x-span holds the leg's x strictly is taken as crossing it. Otherwise it keeps the clearance, as G6 measures it.
      if (crossable?.has(other.id) && Math.abs(leg.from.x - leg.to.x) < EPS && leg.from.x > Math.min(segment.from.x, segment.to.x) + EPS
        && leg.from.x < Math.max(segment.from.x, segment.to.x) - EPS) continue;
      if (segmentDistance(segment, leg) - (stroke + linkStrokeWidth(other)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return 'leg';
    }
  }
  for (const { leg, other } of mouthLegs(model, link)) {
    if (other !== undefined && undecided?.has(other.id)) continue;
    if (segmentDistance(segment, leg) - (stroke + (other ? linkStrokeWidth(other) : stroke)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS) return 'leg';
  }
  // The title of an own end still fits beside this crossing, the held chords' crossings and the legs of the band's ports (ticket 100).
  if (chordKind(model, link) === 'cross' && titleRefusal(model, link, segment, true)) return 'title';
  return undefined;
}

/** The chord this rule pins for the link, or undefined when a body stands on it or a gate would fail it. */
export function expectedFramePath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!routedChordCandidate(model, link)) return undefined;
  if (model.frozenChords !== undefined) return frozenChordPath(model, link);
  const segment = standaloneChord(model, link);
  if (!segment || fixedPointRefusal(model, link, segment) !== undefined) return undefined;
  // Declared, at any angle: the segment has no axis to read, so the gates measure it by distance.
  segment.straight = true;
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}

/**
 * From stage 7f on the decision is frozen: a link that held a chord keeps it and only the segment follows
 * its ports; a link that did not stays orthogonal, because the room a fallback needs (stems, a gap row)
 * was sized before 7f and nothing after it sizes more (ticket 34).
 */
function frozenChordPath(model: LayoutModel, link: LayoutLink): LayoutPath | undefined {
  if (!model.frozenChords!.includes(link.id)) return undefined;
  const chord = straightChord(model, link, undefined, true);
  if (!chord) return undefined;
  const segment: PathSegment = { from: chord.from, to: chord.to, owner: { ...link.owner }, straight: true };
  return { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [segment] };
}

/** The first check that refuses a cross-frame candidate at the freeze (`freezeChords`); undefined when none does. */
export function freezeRefusal(model: LayoutModel, link: LayoutLink): ChordRefusal | undefined {
  const verdict = chordVerdict(model, link, SIDE_EDGE_SLACK);
  return 'reason' in verdict ? verdict.reason : fixedPointRefusal(model, link, verdict.segment);
}

/**
 * The chords held at the start of 7f: the links that are straight now. Every cross-frame candidate that is not held is named once
 * (`ROUTED_CHORD_REFUSED`, info) with the first check that refuses it.
 */
export function freezeChords(model: LayoutModel): void {
  const held = model.links.filter(link => isRoutedChord(model, link)).map(link => link.id);
  for (const link of model.links) {
    if (held.includes(link.id) || chordKind(model, link) !== 'cross') continue;
    const reason = freezeRefusal(model, link);
    // A candidate no check refuses is not refused: it names nothing (it has no reason to give).
    if (reason === undefined) continue;
    model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'ROUTED_CHORD_REFUSED',
      message: `The link ${link.id} keeps the orthogonal route between frames: ${reason}.`, owners: [{ kind: 'link', id: link.id }] });
  }
  // The freeze is a decision even when nothing is held: a link that was not straight here stays orthogonal. An absent field would let the replays of 7f
  // take a chord the freeze refused, on boxes that the grid then widens (a row path that the region rule derives differently once the geometry settles).
  model.frozenChords = held;
}

/**
 * The frozen chords a body or a foreign pill stands on, and a cross-frame chord a foreign frame stands on. Empty when none is held.
 */
export function blockedChords(model: LayoutModel): string[] {
  if (!model.frozenChords?.length) return [];
  const blockers = sharedBlockers(model);
  return model.frozenChords.filter(id => {
    const link = model.links.find(item => item.id === id);
    if (link === undefined) return false;
    const chord = straightChord(model, link, blockers);
    if (chord === undefined) return true;
    // Only a foreign frame is a wall after the freeze. The facing edge is a decision rule: a 7f move in x (a title widening pushes a
    // column) turns the chord shallower, and refusing that move leaves the title unfit (measured: `a-member-title-widens-a-beside-row`
    // gains G6 when the edge is held, none when it is not). The chord then keeps its two faces and may leave its frame by a side edge.
    return chordKind(model, link) === 'cross' && crossRefusal(model, link, { ...chord, owner: { ...link.owner } }) === 'frame';
  });
}
/**
 * The frozen cross-frame chords that leave a frame by a side edge, or inside the corner margin, once 7f has moved the columns. The move is not
 * refused (`blockedChords`), so the chord is named here and the gates judge it (ticket 99, review).
 */
export function edgeLeavers(model: LayoutModel): string[] {
  if (!model.frozenChords?.length) return [];
  return model.frozenChords.filter(id => {
    const link = model.links.find(item => item.id === id);
    const chord = link === undefined || chordKind(model, link) !== 'cross' ? undefined : straightChord(model, link, undefined, true);
    return link !== undefined && chord !== undefined && crossRefusal(model, link, { ...chord, owner: { ...link.owner } }) === 'edge';
  });
}
/** Whether two segments cross at a point that is an end of neither (G6 excuses only such a crossing). */
export function strictCrossing(a: PathSegment, b: PathSegment): boolean {
  const point = intersection(a, b);
  return point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
}
/** Whether two chords keep the chord clearance to each other, or cross strictly (G6 excuses only a strict crossing). */
function chordsApart(a: PathSegment, b: PathSegment, strokeA: number, strokeB: number): boolean {
  const point = intersection(a, b);
  const strict = point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
  return strict || segmentDistance(a, b) - (strokeA + strokeB) / 2 >= STRAIGHT_PATH_CLEARANCE.path - EPS;
}

/**
 * Whether every frozen chord still clears every body and pill once the proposed groups take their boxes.
 * The 7f counterpart of `laneSidesHold`: a move that fails is refused for that unit, and the link is named
 * in a diagnostic. Nothing is held before 7f, so centring and the column rules pass through here unchanged.
 */
export function chordsHold(model: LayoutModel, proposed: { group: { id?: string; nodes: string[]; bounds?: Rect }; bounds: Rect }[], report = true): boolean {
  if (!model.frozenChords?.length) return true;
  const nodes = { ...model.nodes }, groups = { ...model.groups };
  for (const { group, bounds } of proposed) {
    const from = group.bounds;
    if (!from) continue;
    if (group.id !== undefined && groups[group.id]) groups[group.id] = { ...groups[group.id]!, bounds: { ...bounds } };
    const dx = bounds.x - from.x, dy = bounds.y - from.y;
    if (!dx && !dy) continue;
    for (const id of group.nodes) {
      const node = model.nodes[id];
      if (!node?.bounds) continue;
      nodes[id] = { ...node, bounds: { ...node.bounds, x: node.bounds.x + dx, y: node.bounds.y + dy },
        ports: node.ports.map(port => ({ ...port,
          ...(port.anchor ? { anchor: { x: port.anchor.x + dx, y: port.anchor.y + dy } } : {}),
          ...(port.pill ? { pill: { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x + dx, y: port.pill.bounds.y + dy } } } : {}) })) };
    }
  }
  // A cross-frame chord reads the frame boxes, which follow the cells: the proposed cells give the frames the move would draw.
  const moved = { ...model, nodes, groups };
  const frames = model.frozenChords.some(id => chordKind(model, model.links.find(link => link.id === id)!) === 'cross') ? deriveFrames(moved) : undefined;
  const held = blockedChords(frames ? { ...moved, frames } : moved);
  // A caller that tries many candidates asks with `report` off and reports the final verdict itself (ticket 77).
  if (report) for (const id of held) {
    if (!model.diagnostics.some(item => item.code === 'STRAIGHT_LINK_HELD' && item.owners?.some(owner => owner.kind === 'link' && owner.id === id))) {
      model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'STRAIGHT_LINK_HELD',
        message: `A move that would put a body on the straight link ${id} is refused.`, owners: [{ kind: 'link', id }] });
    }
  }
  return held.length === 0;
}

/**
 * The clearance of every pair of held chords that stands nearer than `within` px and does not cross strictly, keyed `a|b` in link order.
 * Read before and after 7f, it says which pairs 7f closed under the clearance (ticket 89 review); it moves nothing.
 */
export function chordClearances(model: LayoutModel, within = 30): Map<string, number> {
  const chords = model.links.filter(link => isRoutedChord(model, link));
  const result = new Map<string, number>();
  for (const [index, one] of chords.entries()) for (const other of chords.slice(index + 1)) {
    const a = one.path!.segments[0]!, b = other.path!.segments[0]!;
    if (Math.min(a.from.x, a.to.x) - within > Math.max(b.from.x, b.to.x) || Math.min(b.from.x, b.to.x) - within > Math.max(a.from.x, a.to.x)
      || Math.min(a.from.y, a.to.y) - within > Math.max(b.from.y, b.to.y) || Math.min(b.from.y, b.to.y) - within > Math.max(a.from.y, a.to.y)) continue;
    const point = intersection(a, b);
    if (point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point))) continue;
    result.set(`${one.id}|${other.id}`, segmentDistance(a, b) - (linkStrokeWidth(one) + linkStrokeWidth(other)) / 2);
  }
  return result;
}


/**
 * Whether an overlay link may stay one straight chord (architecture ticket 15, phase 7; the user's ruling Q1): only where a routed chord would be.
 * The reading is the routed rule's, with no clearance (an overlay owns no clearance gate): no cell, group box or frame that holds neither end stands on the
 * chord, and the chord leaves each box that holds one end only through the edge its port faces, inside the edge; no body or pill stands on it. It reads
 * the placed model after 7f. An overlay that fails it is a candidate for a planned course on side faces; an overlay that cannot read its faces (no side,
 * no anchor) is admitted, so that nothing is planned for it. The consecutive-tier clause of Q108 is not read: an overlay owns no transit lane, so a
 * chord across a free band reserves nothing and the boxes decide.
 */
export function overlayChordAdmitted(model: LayoutModel, link: LayoutLink): boolean {
  if (link.layer !== 'overlay' || !link.attachments || link.meshBus !== undefined) return true;
  const geometry = straightChord(model, link, undefined, true);
  if (geometry === undefined) return true;
  const ends = link.attachments, from = holders(model, ends.from.node), to = holders(model, ends.to.node);
  const sides = { from: findPort(model, ends.from)?.side, to: findPort(model, ends.to)?.side };
  const dx = geometry.to.x - geometry.from.x, dy = geometry.to.y - geometry.from.y;
  for (const { id, bounds } of groupBoxes(model)) {
    const one = from.has(id), two = to.has(id);
    if (one && two) continue;
    if (!one && !two) { if (crosses(geometry.from, geometry.to, bounds)) return false; continue; }
    // A box that holds one end: the chord leaves it through the edge the port faces, inside that edge.
    const side = one ? sides.from : sides.to;
    if (side === 'left' || side === 'right') {
      const edge = side === 'right' ? bounds.x + bounds.width : bounds.x, t = Math.abs(dx) < EPS ? Infinity : (edge - geometry.from.x) / dx, y = geometry.from.y + t * dy;
      if (!(t >= -EPS && t <= 1 + EPS) || y < bounds.y || y > bounds.y + bounds.height) return false;
      continue;
    }
    if (side !== 'top' && side !== 'bottom') return false;
    const edge = side === 'bottom' ? bounds.y + bounds.height : bounds.y, t = Math.abs(dy) < EPS ? Infinity : (edge - geometry.from.y) / dy, x = geometry.from.x + t * dx;
    if (!(t >= -EPS && t <= 1 + EPS) || x < bounds.x || x > bounds.x + bounds.width) return false;
  }
  // A rank cell that holds neither end is no obstacle to a routed link (its frame is), but it is a box the overlay may not cross (07: the chord over the LB rank).
  const nodes = [ends.from.node, ends.to.node];
  for (const group of Object.values(model.groups)) {
    if (group.frame === undefined || group.bounds === undefined || group.nodes.length === 0 || group.nodes.some(node => nodes.includes(node))) continue;
    if (crosses(geometry.from, geometry.to, group.bounds)) return false;
  }
  return straightChord(model, link) !== undefined;
}
