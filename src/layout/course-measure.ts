import type { Point, Rect, Side } from '../model/geometry.js';
import type { Course, Lane, LayoutGroup, LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { courseGeometry, ringsOf } from './course-lanes.js';
import { probeBypassLanes, probeGapLane } from './lanes.js';
import { bypassGeometry } from './course-bypass.js';
import { carriesTitle } from './bands.js';
import { gapGeometry, gapPolyline } from './course-gap.js';
import { polylineCrossings, polylineTurns } from './course-plan.js';
import { authoredSide, groupShape } from './grid.js';
import { crossingsOf, strictCrossing } from './read/crossings.js';
import { linkFacts, overlayFacts, type EndFacts, type LinkFacts } from './read/courses.js';
import { profiles, drawnOverlays, read, pathBends, reading, routedFamily, routedBends, compare, lazyCount, type Reading } from './objective.js';
import { measurePortPill } from '../text/index.js';
import { findPort } from './row-paths.js';
import { EDGE_MARGIN, RING_PITCH, paddingRows, rowsInset } from './course-rows.js';
import { added as namesAdded, constraintFindings, gateFindings, separationWorse, spanBlockedNew } from './trial-findings.js';
import { portKey } from './sides-one.js';
import type { ScoreCounts } from '../score/types.js';
import { portId } from './skeleton-graph.js';
import { overlayChordAdmitted } from './frame-paths.js';

/**
 * The course round's measure and judge (architecture ticket 15, phase 4; the redesign of 2026-10-05). `measureCourses` reads the 7f baseline and its routed
 * result and names the links whose route is a poor one (removed, many turns, or crossed often) or a step that an L can shorten (`stepRoute`); for each it builds the perimeter courses its ends admit and
 * keeps the one whose promised polyline beats the baseline route by the unified order. The pipeline places again with those courses reserved in stage 5,
 * routes the trial, and `judgeCourseTrial` keeps it only on the routed result. The promise of a course is the polyline its own lane geometry reserves.
 */

/** How far 7c may be asked to seat the natural end of a course under its lane: two stems. */
export const ALIGN_REACH = 30;

export interface CourseOffer {
  courses: Course[];
  /** For each offered link: the turns and crossings promised, and the baseline's. */
  promised: Map<string, { turns: number; crossings: number; base: { turns: number; crossings: number } }>;
  /** The links whose row bypass the measure declined for a reason that is worth naming (`ROW_BYPASS_DECLINED`); a link that is no bypass case is not named. */
  declined: { link: string; why: string }[];
}

/** The baseline route of a link is a poor one: removed, four turns or more, or two turns and three crossings or more. */
export function poorRoute(turns: number | undefined, crossings: number): boolean {
  return turns === undefined || turns >= 4 || (turns >= 2 && crossings >= 3);
}

/** The turns of a step: down the stem, along a row of the tier gap, down into the far end. */
const STEP_TURNS = 2;
/**
 * The baseline route of a link between two neighbouring tiers is a step: two turns in the one tier gap between the ends, and no crossing (architecture-2
 * ticket 09, follow-up). An L into a free lateral face of one end joins the same two ports with one turn. A step is no poor route, and it is offered a course
 * only when that course is shorter and crosses nothing (`stepGain`), so it adds no crossing to the joint trial of the poor routes.
 */
export function stepRoute(found: LinkFacts, turns: number | undefined, crossings: number): boolean {
  return found.from.tier !== found.to.tier && found.crossed.length === 0 && turns === STEP_TURNS && crossings === 0;
}
/** The course a step takes: fewer turns than the step (one: an L), and no crossing. */
export const stepGain = (turns: number, crossings: number): boolean => turns < STEP_TURNS && crossings === 0;

const pointsOf = (link: LayoutLink): Point[] => {
  const segments = link.path?.segments ?? [];
  return segments.length === 0 ? [] : [segments[0]!.from, ...segments.map(segment => segment.to)];
};

/** The links a course may not touch (design, Section 4, hard limits), read from the document and the placed model. */
function refused(model: LayoutModel, link: LayoutLink): boolean {
  const route = model.document.links[link.sourceIndex]?.route;
  if (link.groupLink !== undefined || link.technique === 'stub' || (route !== undefined && route !== 'straight')) return true;
  for (const which of ['from', 'to'] as const) {
    const ref = link.attachments?.[which];
    if (ref === undefined || authoredSide(model, ref) !== undefined) return true;
    const group = model.document.nodes[ref.node]!.group, shape = groupShape(model, group);
    if (shape === 'grid' || shape === 'bar') return true;
  }
  return false;
}

/** How many link ends stand on a port. */
const usage = (model: LayoutModel, key: string): number => model.links.reduce((sum, link) => sum + (['from', 'to'] as const).filter(which => link.attachments && portKey(link.attachments[which]) === key).length, 0);

/** The port as the course would leave it: on the face the course names, at the middle of the face for a lateral face. */
function movedPort(port: LayoutPort, box: Rect, face: Side): LayoutPort {
  const anchor = face === 'top' ? { x: port.anchor!.x, y: box.y } : face === 'bottom' ? { x: port.anchor!.x, y: box.y + box.height }
    : { x: face === 'left' ? box.x : box.x + box.width, y: box.y + box.height / 2 };
  return { ...port, side: face, anchor };
}

type Mode = 'natural' | 'side' | 'padding';

/** The modes an end offers on the lane side `s`, from the order facts of the placed baseline (design, Section 4). */
function modes(end: EndFacts, isUpper: boolean, s: 'left' | 'right', free: boolean): Mode[] {
  const found: Mode[] = [];
  if (end.side === (isUpper ? 'bottom' : 'top')) found.push('natural');
  if (!free) return found;
  if (end.edge[s] && end.unitEdge[s]) found.push('side');
  if (end.unitEdge[s] && (isUpper ? end.firstRank : end.lastRank)) found.push('padding');
  return found;
}

/** Fewer ports and rows added, then the shorter run, as the design's tie key. */
const added = (modesUsed: Mode[]): number => modesUsed.filter(mode => mode !== 'natural').length;

export function measureCourses(base: LayoutModel, routedBase: LayoutModel, refusedLinks: ReadonlySet<string> = new Set()): CourseOffer {
  const offer: CourseOffer = { courses: [], promised: new Map(), declined: [] };
  // The gap lanes of the offers made so far: a later skirt's column is read with them standing.
  const gapLanes: Lane[] = [];
  // The group edges that an offered bypass stands on: a second bypass on the same edge is declined.
  const bypassEdges = new Set<string>();
  const facts = linkFacts(base);
  const paths = new Map<string, Point[]>();
  for (const link of routedBase.links) if (link.layer === 'routed' && link.removed !== true) paths.set(link.id, pointsOf(link));
  const crossedBy = (id: string, points: readonly Point[]): number => {
    let count = 0;
    for (const [other, path] of paths) if (other !== id && path.length > 1 && polylineCrossings(points, path) > 0) count++;
    return count;
  };
  const nodes = { ...base.nodes };
  for (const link of base.links) {
    const found = facts.get(link.id);
    if (found === undefined || refusedLinks.has(link.id) || refused(base, link)) continue;
    const routed = routedBase.links.find(item => item.id === link.id);
    const turns0 = routed === undefined ? undefined : pathBends(routed);
    const crossings0 = routed === undefined || turns0 === undefined ? 0 : crossingsOf(routedBase, link.id);
    // A shared named port whose links come from two directions: this link meets the pill from its own side (phase 6). The port keeps its side.
    const approach = approachCourse(base, facts, found, usage, turns0);
    if (approach !== undefined) {
      offer.courses.push(approach.course);
      offer.promised.set(link.id, { turns: approach.turns, crossings: 0, base: { turns: turns0 ?? Infinity, crossings: crossings0 } });
      continue;
    }
    const poor = poorRoute(turns0, crossings0), step = !poor && stepRoute(found, turns0, crossings0);
    if (!poor && !step) continue;
    const [upper, lower] = found.from.tier < found.to.tier ? [found.from, found.to] : [found.to, found.from];
    if (upper.tier === lower.tier) {
      // A skirt: both ends in one band with a unit between them. It reads its cost from the baseline's route (turns0, crossings0), and every eligible skirt is
      // offered a column-gap course; the judge keeps the trial only if the published result wins by the unified order.
      const gap = gapCourse(base, found, usage, crossedBy, turns0, crossings0, gapLanes);
      if (gap !== undefined) {
        offer.courses.push(gap.course);
        offer.promised.set(link.id, { turns: gap.turns, crossings: gap.crossings, base: { turns: turns0 ?? Infinity, crossings: crossings0 } });
        paths.set(link.id, gap.points);
        gapLanes.push(gap.lane);
        continue;
      }
      // A link of one row that a node of the row blocks: the row bypass (ticket 24, phase 5). One per edge of a group in an offer.
      const bypass = bypassCandidate(base, link, found, usage, crossedBy, turns0, bypassEdges);
      if (bypass !== undefined && 'why' in bypass) offer.declined.push({ link: link.id, why: bypass.why });
      else if (bypass !== undefined) {
        offer.courses.push(bypass.course);
        offer.promised.set(link.id, { turns: bypass.turns, crossings: bypass.crossings, base: { turns: turns0 ?? Infinity, crossings: crossings0 } });
        paths.set(link.id, bypass.points);
        bypassEdges.add(`${found.from.group}|${bypass.course.edge}`);
      }
      continue;
    }
    const best = perimeterBest(base, link, found, upper, lower, crossedBy, nodes, false);
    if (best.course === undefined || (step && !stepGain(best.turns, best.crossings))) continue;
    const gain = turns0 === undefined ? true : best.turns < turns0 || (best.turns === turns0 && best.crossings < crossings0);
    if (!gain) continue;
    offer.courses.push(best.course);
    offer.promised.set(link.id, { turns: best.turns, crossings: best.crossings, base: { turns: turns0 ?? Infinity, crossings: crossings0 } });
    paths.set(link.id, best.points);
  }
  return offer;
}

/**
 * The row bypass of a link whose two ends stand in one row group with a node between them (ticket 24, phase 5; turn-order.md, Section 6): the edge of the row that
 * fewer legs cross within the span of the two ends (the title edge on a tie), a stem in the gap beside each end and one padding row. It is offered when the stems
 * can be reserved and the promised polyline has no more turns than the baseline route; the judge keeps it only on the published result. `undefined`: no bypass case.
 */
function bypassCandidate(base: LayoutModel, link: LayoutLink, found: LinkFacts, usageOf: (model: LayoutModel, key: string) => number,
  crossedBy: (id: string, points: readonly Point[]) => number, turns0: number | undefined, taken: ReadonlySet<string>):
  { course: Course; turns: number; crossings: number; points: Point[] } | { why: string } | undefined {
  const group = base.groups[found.from.group];
  if (!found.rowBetween || found.to.group !== found.from.group || group === undefined || group.frame !== undefined || group.flank !== undefined || groupShape(base, group.id) !== 'row') return undefined;
  if ((found.from.side !== 'left' && found.from.side !== 'right') || (found.to.side !== 'left' && found.to.side !== 'right')) return undefined;
  if (usageOf(base, portKey(found.from.ref)) !== 1 || usageOf(base, portKey(found.to.ref)) !== 1) return undefined;
  const order = group.rowOrder ?? group.nodes, at = [order.indexOf(found.from.node), order.indexOf(found.to.node)];
  if (at.some(index => index < 0)) return undefined;
  const span = order.slice(Math.min(...at), Math.max(...at) + 1);
  const legs = (side: 'top' | 'bottom'): number => span.reduce((sum, id) => sum + base.nodes[id]!.ports.filter(port => port.side === side && usageOf(base, portKey(port.ref)) > 0).length, 0);
  const edge: 'top' | 'bottom' = legs('top') !== legs('bottom') ? (legs('top') < legs('bottom') ? 'top' : 'bottom') : carriesTitle(base, group, 'bottom') && !carriesTitle(base, group, 'top') ? 'bottom' : 'top';
  if (taken.has(`${group.id}|${edge}`)) return { why: `another bypass stands on the ${edge} edge of ${group.id}` };
  const course: Course = { link: link.id, kind: 'bypass', edge, from: { face: found.from.side }, to: { face: found.to.side }, runs: ['gap', 'padding', 'gap'] };
  const model: LayoutModel = { ...base, courses: [...(base.courses ?? []), course] };
  const geometry = bypassGeometry(model, link, course);
  if (geometry === undefined) return undefined;
  const admitted = probeBypassLanes(base, link, course);
  if ('why' in admitted) return { why: admitted.why };
  const turns = polylineTurns(geometry.polyline);
  if (turns0 !== undefined && turns > turns0) return undefined;
  return { course, turns, crossings: crossedBy(link.id, geometry.polyline), points: geometry.polyline };
}

/** The best perimeter course of a link between two tiers: the sides and the modes of both ends, judged by turns, crossings, ports and rows added, then the nearer margin. */
export interface PerimeterBest { turns: number; crossings: number; added: number; distance: number; course: Course | undefined; points: Point[]; lane?: Lane }
export function perimeterBest(base: LayoutModel, link: LayoutLink, found: LinkFacts, upper: EndFacts, lower: EndFacts, crossedBy: (id: string, points: readonly Point[]) => number,
  nodes: LayoutModel['nodes'], overlay: boolean, stack?: readonly Lane[]): PerimeterBest {
  const best = { turns: Infinity, crossings: Infinity, added: Infinity, distance: Infinity, course: undefined as Course | undefined, points: [] as Point[] };
  for (const s of ['left', 'right'] as const) {
    const upperModes = modes(upper, true, s, usage(base, portKey(upper.ref)) === 1 && base.groups[upper.group]?.flank === undefined);
    const lowerModes = modes(lower, false, s, usage(base, portKey(lower.ref)) === 1 && base.groups[lower.group]?.flank === undefined);
    for (const a of upperModes) for (const b of lowerModes) {
      if (a === 'natural' && b === 'natural') continue;
      const ends = (end: EndFacts, mode: Mode, isUpper: boolean): { face: Side; mode: Mode } =>
        ({ face: mode === 'natural' ? end.side : mode === 'side' ? s : isUpper ? 'top' : 'bottom', mode });
      const U = ends(upper, a, true), L = ends(lower, b, false);
      const fromUpper = found.from === upper, first = fromUpper ? U : L, last = fromUpper ? L : U;
      const runs: Course['runs'] = [...(first.mode === 'padding' ? ['padding' as const] : []), ...(first.mode === 'natural' ? ['tier-gap' as const] : []), 'perimeter',
        ...(last.mode === 'natural' ? ['tier-gap' as const] : []), ...(last.mode === 'padding' ? ['padding' as const] : [])];
      const course: Course = { link: link.id, kind: overlay ? 'overlay' : found.crossed.length > 0 ? 'transit' : 'skirt', side: s,
        from: { face: first.face }, to: { face: last.face }, runs };
      // The probe: the baseline with the two ports where the course puts them, and the one course. The far natural port is promised on the lane (7c seats it).
      const probeNodes = { ...nodes };
      for (const [ref, end] of [[found.from.ref, first], [found.to.ref, last]] as const) {
        const node = base.nodes[ref.node]!, port = findPort(base, ref)!;
        if (end.mode === 'natural') continue;
        probeNodes[ref.node] = { ...node, ports: node.ports.map(item => portId(item.ref) === portId(ref) ? movedPort(port, node.bounds!, end.face) : item) };
      }
      const probe: LayoutModel = { ...base, nodes: probeNodes, courses: [course], lanes: base.lanes.filter(item => !(item.owner.kind === 'link' && item.owner.id === link.id)) };
      const occ = (group: LayoutGroup): Rect => group.bounds!;
      const lane = { id: `perimeter:${link.id}`, side: s, ring: 0, ...(first.mode === 'natural' || last.mode === 'natural' ? { aligned: true as const } : {}) };
      let geometry = courseGeometry(probe, link, course, lane, occ, ringsOf(stack ?? []));
      if (geometry === undefined) continue;
      // The lanes chosen before this one stand as 7a will stack them: a lane takes the ring after every lane of its side whose extent it meets.
      let ring = 0;
      if (stack !== undefined) {
        const first = geometry;
        ring = stack.filter(other => other.side === s && other.bounds.y < first.bounds.y + first.bounds.height - 1e-6 && other.bounds.y + other.bounds.height > first.bounds.y + 1e-6).length;
        if (ring > 0) { geometry = courseGeometry(probe, link, course, { ...lane, ring }, occ, ringsOf(stack), stack); if (geometry === undefined) continue; }
      }
      if (!overlay && !geometry.aligned && lane.aligned === true) {
        // Seat the natural end under the lane, as 7c does (the promise of the round), and read the polyline again.
        const natural = first.mode === 'natural' ? found.from : last.mode === 'natural' ? found.to : undefined;
        // 7c seats it only when the move is small (a node barely moves for a course, P9): two stems at most.
        if (natural !== undefined && Math.abs(natural.anchor.x - geometry.x) <= ALIGN_REACH) {
          const node = probeNodes[natural.ref.node]!, port = findPort(probe, natural.ref)!;
          probeNodes[natural.ref.node] = { ...node, ports: node.ports.map(item => portId(item.ref) === portId(natural.ref) ? { ...item, anchor: { x: geometry!.x, y: port.anchor!.y } } : item) };
          geometry = courseGeometry({ ...probe, nodes: probeNodes }, link, course, lane, occ, ringsOf([]));
          if (geometry === undefined) continue;
        }
      }
      const turns = polylineTurns(geometry.polyline), crossings = crossedBy(link.id, geometry.polyline);
      const mean = (found.from.anchor.x + found.to.anchor.x) / 2, edge = s === 'left' ? Math.min(...Object.values(base.groups).map(group => group.bounds?.x ?? Infinity)) : Math.max(...Object.values(base.groups).map(group => (group.bounds?.x ?? -Infinity) + (group.bounds?.width ?? 0)));
      const candidate = { turns, crossings, added: added([a, b]), distance: Math.abs(mean - edge) };
      const better = candidate.turns - best.turns || candidate.crossings - best.crossings || candidate.added - best.added || candidate.distance - best.distance;
      if (better < 0) Object.assign(best, candidate, { course, points: geometry.polyline, ...(stack === undefined ? {} : { lane: { id: lane.id, kind: 'perimeter' as const, owner: { kind: 'link' as const, id: link.id }, layer: 'overlay' as const, group: found.from.group,
        tier: found.from.tier, side: s, span: geometry.span, ring, x: geometry.x, bounds: geometry.bounds } as Lane }) });
    }
  }
  return best;
}

/**
 * The approach course of a link end on a shared named port (ticket 15, phase 6; T4 of the design), or `undefined`. The end stands on a lateral face of a port that
 * another link shares and that other link comes from another direction (its far end is in the same row or on the other side of the band). The far end is in the
 * next tier, on the face that looks at this one. The link then meets the pill on its top (far end above) or bottom (far end below) edge: a drop from a row of the
 * tier gap, two turns. It is offered only when the baseline route has more turns.
 */
function approachCourse(base: LayoutModel, facts: ReadonlyMap<string, LinkFacts>, found: LinkFacts, usageOf: (model: LayoutModel, key: string) => number, turns0: number | undefined):
  { course: Course; turns: number } | undefined {
  if (turns0 !== undefined && turns0 <= APPROACH_TURNS) return undefined;
  for (const which of ['from', 'to'] as const) {
    const end = which === 'from' ? found.from : found.to, far = which === 'from' ? found.to : found.from;
    if (end.ref.anonymous === true || end.ref.name === undefined || (end.side !== 'left' && end.side !== 'right')) continue;
    if (Math.abs(end.tier - far.tier) !== 1 || usageOf(base, portKey(end.ref)) < 2) continue;
    const above = far.tier < end.tier;
    if (far.side !== (above ? 'bottom' : 'top')) continue;
    // Another link at the port comes from another direction: the far end of the port's other link is in the same row or on the other side of the band.
    const direction = (item: LinkFacts): number | undefined => {
      const mine = portKey(item.from.ref) === portKey(end.ref) ? item.to : portKey(item.to.ref) === portKey(end.ref) ? item.from : undefined;
      return mine === undefined ? undefined : Math.sign(mine.tier - end.tier);
    };
    const own = Math.sign(far.tier - end.tier);
    const others = [...facts.values()].filter(item => item.link.id !== found.link.id && direction(item) !== undefined);
    if (!others.some(item => direction(item) !== own)) continue;
    // One side per approach: another link at the port that comes from the same side would meet the pill at the same point, and nothing joins their stems.
    if (others.some(item => direction(item) === own)) continue;
    const approach: Side = above ? 'top' : 'bottom';
    // The port is the end port of its face toward the approach: a nearer port's stem or pill would stand in the way of the vertical stem.
    const node = base.nodes[end.ref.node];
    if (node === undefined || node.ports.some(item => item.side === end.side && portKey(item.ref) !== portKey(end.ref) && item.anchor !== undefined
      && (above ? item.anchor.y < end.anchor.y : item.anchor.y > end.anchor.y))) continue;
    // The stem's corridor is clear of every other node: the pill's outer half and the clearance either side, from the node's face on the approach side to the far end.
    const pill = measurePortPill(end.ref.name), half = pill.width / 4 + APPROACH_CLEARANCE;
    const x0 = end.anchor.x - half, x1 = end.anchor.x + (end.side === 'right' ? 1 : -1) * pill.width / 4 + half * (end.side === 'right' ? 1 : -1);
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    const yFar = far.anchor.y, yNear = end.anchor.y;
    const blocked = Object.values(base.nodes).some(other => other.id !== end.ref.node && other.bounds !== undefined
      && other.bounds.x < hi && other.bounds.x + other.bounds.width > lo && other.bounds.y < Math.max(yFar, yNear) && other.bounds.y + other.bounds.height > Math.min(yFar, yNear)
      && other.id !== far.ref.node);
    if (blocked) continue;
    const course: Course = { link: found.link.id, kind: 'shared-port', runs: ['tier-gap'],
      from: { face: found.from.side, ...(which === 'from' ? { approach } : {}) }, to: { face: found.to.side, ...(which === 'to' ? { approach } : {}) } };
    return { course, turns: APPROACH_TURNS };
  }
  return undefined;
}

/** The turns of a drop onto a pill from a row of the tier gap: the stem turns into the row, and the row into the drop. */
const APPROACH_TURNS = 2;
/** The clearance either side of an approach stem that no other node may enter: the gate clearance plus half the routed stroke. */
const APPROACH_CLEARANCE = 10.75;

/** The column-gap course of a skirt, or `undefined`: which end keeps its lateral face, which leaves by the bottom face and a U part. */
function gapCourse(base: LayoutModel, found: LinkFacts, usageOf: (model: LayoutModel, key: string) => number,
  crossedBy: (id: string, points: readonly Point[]) => number, turns0: number | undefined, crossings0: number, extra: readonly Lane[]):
  { course: Course; turns: number; crossings: number; points: Point[]; lane: Lane } | undefined {
  if (found.between.length === 0) return undefined;
  const best = { turns: Infinity, crossings: Infinity, course: undefined as Course | undefined, points: [] as Point[], lane: undefined as Lane | undefined };
  for (const lateralIsFrom of [true, false]) {
    const lateral = lateralIsFrom ? found.from : found.to, other = lateralIsFrom ? found.to : found.from;
    const side = lateral.side;
    if ((side !== 'left' && side !== 'right') || !lateral.edge[side] || base.groups[lateral.group]?.flank !== undefined) continue;
    // The other end stands on the lane's side of the lateral end, and the tier gap below it is where its U part goes.
    if (side === 'left' ? other.anchor.x >= lateral.anchor.x : other.anchor.x <= lateral.anchor.x) continue;
    if (usageOf(base, portKey(lateral.ref)) !== 1 || usageOf(base, portKey(other.ref)) !== 1) continue;
    const course: Course = { link: found.link.id, kind: 'skirt', from: { face: lateralIsFrom ? side : 'bottom' }, to: { face: lateralIsFrom ? 'bottom' : side },
      runs: lateralIsFrom ? ['gap', 'u'] : ['u', 'gap'] };
    // The admission test of 7a, on the baseline: the column must hold the lane (frames, lanes, the side run, the row's edge). It is a filter; 7a can still refuse in the trial.
    const admitted = probeGapLane(base, found.link, course, extra);
    if ('why' in admitted) continue;
    const x = admitted.lane.x;
    const geometry = gapGeometry({ ...base, courses: [course] }, found.link, course);
    if (geometry === undefined) continue;
    const points = gapPolyline(geometry, x, geometry.extent);
    const turns = polylineTurns(points), crossings = crossedBy(found.link.id, points);
    if (turns < best.turns || (turns === best.turns && crossings < best.crossings)) Object.assign(best, { turns, crossings, course, points, lane: admitted.lane });
  }
  if (best.course === undefined) return undefined;
  const gain = turns0 === undefined ? true : best.turns < turns0 || (best.turns === turns0 && best.crossings < crossings0);
  return gain && best.lane !== undefined ? { course: best.course, turns: best.turns, crossings: best.crossings, points: best.points, lane: best.lane } : undefined;
}

/**
 * The unified gain an offer promises, as (links restored, bent links saved, turns saved), compared in that order: the order of the user reads removed links
 * first. A removed link (`was` undefined) that the offer draws counts in the first entry and in no other, so it outranks any bend or turn gain with no magic number.
 */
export function gainOf(pairs: Iterable<[number | undefined, number]>): [number, number, number] {
  let restored = 0, bent = 0, turns = 0;
  for (const [was, will] of pairs) {
    if (was === undefined) { restored++; continue; }
    bent += (was > 0 ? 1 : 0) - (will > 0 ? 1 : 0); turns += was - will;
  }
  return [restored, bent, turns];
}
/** Whether gain `a` beats gain `b`, entry by entry. */
export function beats(a: readonly number[], b: readonly number[]): boolean {
  for (const [i, value] of a.entries()) if (value !== b[i]) return value > b[i]!;
  return false;
}

// ---- the judge ------------------------------------------------------------------------------------------------------------------------

/** The pairs of routed links that cross, once each (no slack, both paths as published). */
export function routedCrossingPairs(model: LayoutModel): number {
  const drawn = model.links.filter(link => link.layer === 'routed' && link.path !== undefined && link.removed !== true);
  let count = 0;
  for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) {
    if (drawn[i]!.path!.segments.some(a => drawn[j]!.path!.segments.some(b => strictCrossing(a, b)))) count++;
  }
  return count;
}

/** The user's unified order over both layers: a course that bends an overlay link to unbend a routed one is no gain. */
export const courseProfile = profiles.unified;

export interface CourseVerdict { kept: boolean; reason: string; removed: string[]; worse: string[] }

/** The optional growth of the canvas (Q2: a perimeter lane's reserved width is not optional). */
export const GROWTH_BOUND = 0.05;

/** The width and height a model's courses reserve: the outermost lane of each side with its margin, and each padding row with its depth. An upper bound. */
function reservedGrowth(model: LayoutModel): { width: number; height: number } {
  const side = { left: 0, right: 0 };
  for (const lane of model.lanes) if (lane.kind === 'perimeter' && (lane.side === 'left' || lane.side === 'right')) side[lane.side] = Math.max(side[lane.side], EDGE_MARGIN + ((lane.ring ?? 0) + 1) * RING_PITCH);
  let height = 0;
  for (const group of Object.values(model.groups)) for (const rows of Object.values(paddingRows(model, group))) height += rowsInset(rows);
  return { width: side.left + side.right, height };
}

export const routedReading = (model: LayoutModel): Reading => reading({ routed: routedFamily(routedBends(model)), overlay: read(model, { overlays: drawnOverlays(model) }).overlay,
  crossings: lazyCount(() => routedCrossingPairs(model)), crossingMode: 'pairs', tie: [] });

/**
 * Whether the trial that reserves `courses` is kept: no link the baseline keeps is removed, no offered link has more turns than on the baseline or than it promised, and the
 * unified order on the routed result gains (fewer bent links, then fewer turns, then fewer crossings).
 */
export function judgeCourseTrial(routedBase: LayoutModel, routedTrial: LayoutModel, promised: ReadonlyMap<string, number>): CourseVerdict {
  const base = routedBends(routedBase), trial = routedBends(routedTrial);
  const removed = [...base.keys()].filter(id => !trial.has(id));
  const worse = [...promised.keys()].filter(id => !trial.has(id) || (base.has(id) && trial.get(id)! > base.get(id)!));
  const verdict = (kept: boolean, reason: string): CourseVerdict => ({ kept, reason, removed, worse });
  if (removed.length > 0) return verdict(false, `the trial's route removes ${removed.join(', ')}, which the baseline's route keeps`);
  const blocked = spanBlockedNew(routedBase, routedTrial);
  if (blocked.length > 0) return verdict(false, `a move put a wall in the corridor of a spanning chord (${blocked.join(', ')})`);
  if (worse.length > 0) return verdict(false, `a link with a course has more turns than on the baseline (${worse.join(', ')})`);
  // The promise only proposes: the trial is judged on what it publishes. A course link that publishes more turns than its polyline promised is a trial that
  // did not reserve what the promise needs, and it is not kept.
  const lost = [...promised].filter(([id, turns]) => (trial.get(id) ?? Infinity) > turns).map(([id]) => id);
  if (lost.length > 0) return verdict(false, `a link with a course publishes more turns than it promised (${lost.join(', ')})`);
  // No finding is new, read as sets: a gate violation, or a hard entry of the x constraint catalogue (a band gap between two root groups), that the baseline
  // did not have. A course that buys a turn with a lane overlap, a clearance or a gap is no gain (the stop rule of ticket 15, phase 4).
  const gatesNow = gateFindings(routedTrial), gatesThen = gateFindings(routedBase);
  if (gatesNow === undefined) return verdict(false, 'the routed trial does not score');
  const gateNew = namesAdded(gatesNow.findings, gatesThen?.findings ?? new Set());
  if (gateNew.length > 0) return verdict(false, `the routed trial has gate findings the baseline does not have (${gateNew.join('; ')})`);
  const constraintNew = namesAdded(constraintFindings(routedTrial), constraintFindings(routedBase));
  if (constraintNew.length > 0) return verdict(false, `the routed trial breaks a hard constraint the baseline holds (${constraintNew.join('; ')})`);
  const separationNew = separationWorse(routedTrial, routedBase);
  if (separationNew.length > 0) return verdict(false, `the routed trial breaks or deepens a minimum separation (${separationNew.join('; ')})`);
  // Growth: optional growth stays within today's bound (5 %), and only the reserved width of a perimeter lane and the depth of a padding row may exceed it (Q2).
  const room = reservedGrowth(routedTrial), cap = (was: number | undefined, extra: number): number => (was ?? 0) * (1 + GROWTH_BOUND) + extra + 1e-6;
  if ((routedTrial.canvas?.width ?? 0) > cap(routedBase.canvas?.width, room.width) || (routedTrial.canvas?.height ?? 0) > cap(routedBase.canvas?.height, room.height)) {
    return verdict(false, `the routed trial grows the canvas past ${GROWTH_BOUND * 100} % and the width its lanes reserve`);
  }
  const now = routedReading(routedTrial), then = routedReading(routedBase);
  if (!(compare(now, then, courseProfile) < 0)) return verdict(false, `the routed trial gives no gain (${now.routed.bent + now.overlay.bent} bent links, ${now.routed.turns + now.overlay.turns} turns, ${now.crossings()} crossings, against ${then.routed.bent + then.overlay.bent}, ${then.routed.turns + then.overlay.turns} and ${then.crossings()})`);
  return verdict(true, '');
}

// ---- overlay courses (ticket 15, phase 7) ------------------------------------------------------------------------------------------------

export interface OverlayOffer {
  courses: Course[];
  /** For each offered overlay link: the turns promised and the turns of the baseline path. */
  promised: Map<string, { turns: number; base: number }>;
}

/** Whether an end of an overlay link is a port that a course may not move: an author side, or a port that a hint or a course already owns. */
function overlayEndFixed(model: LayoutModel, link: LayoutLink, which: 'from' | 'to'): boolean {
  const ref = link.attachments![which], port = findPort(model, ref);
  return port === undefined || port.sideHint === true || port.laneHint === true || port.courseHint === true || authoredSide(model, ref) !== undefined;
}

/**
 * The offered courses of the overlay links (the user's decision on Q1: an offer, not a rule): an overlay that a routed chord would not take
 * (`overlayChordAdmitted`, read on the 7f baseline) is offered the perimeter course its ends admit, on side faces, judged by turns, then crossings against
 * the routed paths of the baseline. Only a link the baseline already bent is offered one, and only when the course has fewer turns (or as many with fewer
 * crossings): a straight link cannot gain by the unified order, which the trial is judged by, so no run is spent on it.
 * An overlay with no candidate (both ends in one sub-tier, no free face) keeps the path it has.
 */
export function measureOverlayCourses(base: LayoutModel, routedBase: LayoutModel): OverlayOffer {
  const offer: OverlayOffer = { courses: [], promised: new Map() };
  const facts = overlayFacts(base);
  // The paths a course is measured against: the routed paths, the overlay paths that keep their chord (an overlay that may stay straight, a mesh-bus member, a link
  // with no candidate), and each course chosen so far. A course that crosses another overlay costs a crossing, as the solve of case 07 shows (the outer bracket
  // goes below the clients row, so that it crosses no other).
  const planned = new Set<string>();
  for (const link of base.links) {
    const found = facts.get(link.id);
    if (found !== undefined && found.from.tier !== found.to.tier && !overlayChordAdmitted(base, link)) planned.add(link.id);
  }
  const nodes = { ...base.nodes };
  const eligible = base.links.filter(link => {
    const found = facts.get(link.id);
    if (found === undefined || !planned.has(link.id)) return false;
    const route = base.document.links[link.sourceIndex]?.route;
    if (link.groupLink !== undefined || (route !== undefined && route !== 'straight') || overlayEndFixed(base, link, 'from') || overlayEndFixed(base, link, 'to')) return false;
    if ([found.from.group, found.to.group].some(group => ['grid', 'bar'].includes(groupShape(base, group)))) return false;
    const drawn = routedBase.links.find(item => item.id === link.id);
    return drawn !== undefined && pathBends(drawn) !== undefined;
  });
  // Only a link that may take a course leaves the fixed paths: a planned overlay that is not eligible keeps the path it has, and a course crosses it like any other.
  const fixedPaths = new Map<string, Point[]>();
  const offered = new Set(eligible.map(link => link.id));
  for (const link of routedBase.links) if (link.removed !== true && !offered.has(link.id)) fixedPaths.set(link.id, pointsOf(link));
  /** One pass over `order`: each link takes the best course its ends admit against the paths and lanes chosen before it. */
  const pass = (order: readonly LayoutLink[]): { link: LayoutLink; best: PerimeterBest; turns0: number }[] => {
    const paths = new Map(fixedPaths), stack: Lane[] = [...base.lanes.filter(lane => lane.kind === 'perimeter')];
    const crossedBy = (id: string, points: readonly Point[]): number => {
      let count = 0;
      for (const [other, path] of paths) if (other !== id && path.length > 1 && polylineCrossings(points, path) > 0) count++;
      return count;
    };
    const chosen: { link: LayoutLink; best: PerimeterBest; turns0: number }[] = [];
    for (const link of order) {
      const found = facts.get(link.id)!, drawn = routedBase.links.find(item => item.id === link.id)!, turns0 = pathBends(drawn)!;
      const [upper, lower] = found.from.tier < found.to.tier ? [found.from, found.to] : [found.to, found.from];
      const best = perimeterBest(base, link, found, upper, lower, crossedBy, nodes, true, stack);
      const crossings0 = crossedBy(link.id, pointsOf(drawn));
      if (best.course === undefined || turns0 === 0 || !(best.turns < turns0 || (best.turns === turns0 && best.crossings < crossings0))) { paths.set(link.id, pointsOf(drawn)); continue; }
      paths.set(link.id, best.points);
      if (best.lane !== undefined) stack.push(best.lane);
      chosen.push({ link, best, turns0 });
    }
    return chosen;
  };
  // Brackets of one margin nest: the lane that spans less stands inside (ring order, P4), so that no run crosses another lane. The first pass reads the spans,
  // the second plans in that order, so that the rings it measures are the rings 7a will give.
  const spans = new Map(pass(eligible).map(item => [item.link.id, item.best.lane?.bounds.height ?? 0] as const));
  const ordered = [...eligible].sort((a, b) => (spans.get(a.id) ?? 0) - (spans.get(b.id) ?? 0));
  for (const { link, best, turns0 } of pass(ordered)) {
    offer.courses.push(best.course!);
    offer.promised.set(link.id, { turns: best.turns, base: turns0 });
  }
  return offer;
}

/**
 * Whether the trial that reserves the overlay courses is kept: only when the published result is not worse by the unified order (bent links over both layers,
 * then turns, then crossings, the overlay link's own bend counted like any other), and the hard limits hold: no removed link, no finding the baseline lacks
 * (as sets), no hard constraint or minimum separation broken, growth within 5 % plus the reserved width, and every course published as promised (a lost promise
 * refuses the trial). The routed layer is read alone first: a course that costs a routed link a bend, a turn or a crossing is no course.
 */
export function judgeOverlayTrial(routedBase: LayoutModel, routedTrial: LayoutModel, offer: OverlayOffer): CourseVerdict {
  const base = routedBends(routedBase), trial = routedBends(routedTrial);
  const removed = [...base.keys()].filter(id => !trial.has(id));
  const verdict = (kept: boolean, reason: string): CourseVerdict => ({ kept, reason, removed, worse: [] });
  if (removed.length > 0) return verdict(false, `the trial's route removes ${removed.join(', ')}, which the baseline's route keeps`);
  const blocked = spanBlockedNew(routedBase, routedTrial);
  if (blocked.length > 0) return verdict(false, `a move put a wall in the corridor of a spanning chord (${blocked.join(', ')})`);
  const lost = [...offer.promised].filter(([id, item]) => {
    const link = routedTrial.links.find(candidate => candidate.id === id), got = link === undefined ? undefined : pathBends(link);
    return got === undefined || got > item.turns;
  }).map(([id]) => id);
  if (lost.length > 0) return verdict(false, `an overlay course publishes more turns than it promised (${lost.join(', ')})`);
  const gatesNow = gateFindings(routedTrial), gatesThen = gateFindings(routedBase);
  if (gatesNow === undefined || gatesThen === undefined) return verdict(false, 'the routed trial does not score');
  const gateNew = namesAdded(gatesNow.findings, gatesThen.findings);
  if (gateNew.length > 0) return verdict(false, `the routed trial has gate findings the baseline does not have (${gateNew.join('; ')})`);
  const constraintNew = namesAdded(constraintFindings(routedTrial), constraintFindings(routedBase));
  if (constraintNew.length > 0) return verdict(false, `the routed trial breaks a hard constraint the baseline holds (${constraintNew.join('; ')})`);
  const separationNew = separationWorse(routedTrial, routedBase);
  if (separationNew.length > 0) return verdict(false, `the routed trial breaks or deepens a minimum separation (${separationNew.join('; ')})`);
  // The growth a lane reserves counts only beyond what the baseline already reserves.
  const was = reservedGrowth(routedBase), reserved = reservedGrowth(routedTrial);
  const room = { width: Math.max(0, reserved.width - was.width), height: Math.max(0, reserved.height - was.height) }, cap = (before: number | undefined, extra: number): number => (before ?? 0) * (1 + GROWTH_BOUND) + extra + 1e-6;
  if ((routedTrial.canvas?.width ?? 0) > cap(routedBase.canvas?.width, room.width) || (routedTrial.canvas?.height ?? 0) > cap(routedBase.canvas?.height, room.height)) {
    return verdict(false, `the routed trial grows the canvas past ${GROWTH_BOUND * 100} % and the width its lanes reserve`);
  }
  // The counts are the score's own, read on the published result (published paths, the effective layer, the routed crossings Q counts plus the overlay crossing
  // pairs): the family counts and the crossings of the two layers together.
  const family = (bent: number, turns: number) => ({ straight: 0, bent, turns });
  const readingOf = (counts: ScoreCounts): Reading => reading({ routed: family(counts.routed.bent, counts.routed.turns), overlay: family(counts.overlay.bent, counts.overlay.turns),
    crossings: lazyCount(() => counts.routed.crossings + counts.overlay.crossings.pairs), crossingMode: 'pairs', tie: [] });
  // The routed layer first: an overlay course that costs a routed link a bend, a turn or a crossing (a column it moved, a row it grew) is no course, whatever the
  // overlay layer gains. The overlay bends of a link the rule took are the rule's; every other reading is the user's order.
  const routedOnly = (counts: ScoreCounts): Reading => reading({ routed: family(counts.routed.bent, counts.routed.turns), crossings: lazyCount(() => counts.routed.crossings), crossingMode: 'pairs', tie: [] });
  const routedNow = routedOnly(gatesNow.counts), routedThen = routedOnly(gatesThen.counts);
  if (compare(routedNow, routedThen, courseProfile) > 0) {
    return verdict(false, `the routed layer is worse by the unified order (${routedNow.routed.bent} bent links, ${routedNow.routed.turns} turns, ${routedNow.crossings()} crossings, against ${routedThen.routed.bent}, ${routedThen.routed.turns} and ${routedThen.crossings()})`);
  }
  const now = readingOf(gatesNow.counts), then = readingOf(gatesThen.counts);
  if (compare(now, then, courseProfile) > 0) {
    return verdict(false, `the routed trial is worse by the unified order (${now.routed.bent + now.overlay.bent} bent links, ${now.routed.turns + now.overlay.turns} turns, ${now.crossings()} crossings, against ${then.routed.bent + then.overlay.bent}, ${then.routed.turns + then.overlay.turns} and ${then.crossings()})`);
  }
  return verdict(true, '');
}
