import type { Point, Rect, Side } from '../model/geometry.js';
import type { Course, LayoutGroup, LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { courseGeometry, ringsOf } from './course-lanes.js';
import { polylineCrossings, polylineTurns } from './course-plan.js';
import { authoredSide, groupShape } from './grid.js';
import { crossingsOf, strictCrossing } from './read/crossings.js';
import { linkFacts, type EndFacts } from './read/courses.js';
import { orderProfile, keys, pathBends, reading, routedFamily, routedBends, compare, lazyCount, type Reading } from './objective.js';
import { findPort } from './row-paths.js';
import { score } from '../score/index.js';
import { portKey } from './sides-one.js';
import { portId } from './skeleton-graph.js';

/**
 * The course round's measure and judge (architecture ticket 15, phase 4; the redesign of 2026-10-05). `measureCourses` reads the 7f baseline and its routed
 * result and names the links whose route is a poor one (removed, many turns, or crossed often); for each it builds the perimeter courses its ends admit and
 * keeps the one whose promised polyline beats the baseline route by the unified order. The pipeline places again with those courses reserved in stage 5,
 * routes the trial, and `judgeCourseTrial` keeps it only on the routed result. The promise of a course is the polyline its own lane geometry reserves.
 */

/** How far 7c may be asked to seat the natural end of a course under its lane: two stems. */
export const ALIGN_REACH = 30;

export interface CourseOffer {
  courses: Course[];
  /** For each offered link: the turns and crossings promised, and the baseline's. */
  promised: Map<string, { turns: number; crossings: number; base: { turns: number; crossings: number } }>;
}

/** The baseline route of a link is a poor one: removed, four turns or more, or two turns and three crossings or more. */
export function poorRoute(turns: number | undefined, crossings: number): boolean {
  return turns === undefined || turns >= 4 || (turns >= 2 && crossings >= 3);
}

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
  const offer: CourseOffer = { courses: [], promised: new Map() };
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
    if (!poorRoute(turns0, crossings0)) continue;
    const [upper, lower] = found.from.tier < found.to.tier ? [found.from, found.to] : [found.to, found.from];
    if (upper.tier === lower.tier) continue;
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
        const course: Course = { link: link.id, kind: found.crossed.length > 0 ? 'transit' : 'skirt', side: s,
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
        let geometry = courseGeometry(probe, link, course, lane, occ, ringsOf([]));
        if (geometry === undefined) continue;
        if (!geometry.aligned && lane.aligned === true) {
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
        if (better < 0) Object.assign(best, candidate, { course, points: geometry.polyline });
      }
    }
    if (best.course === undefined) continue;
    const gain = turns0 === undefined ? true : best.turns < turns0 || (best.turns === turns0 && best.crossings < crossings0);
    if (!gain) continue;
    offer.courses.push(best.course);
    offer.promised.set(link.id, { turns: best.turns, crossings: best.crossings, base: { turns: turns0 ?? Infinity, crossings: crossings0 } });
    paths.set(link.id, best.points);
  }
  return offer;
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

const courseProfile = orderProfile('course', [keys.fewerBent('routed'), keys.fewerTurns('routed'), keys.fewerCrossings], [], [], true);

export interface CourseVerdict { kept: boolean; reason: string; removed: string[]; worse: string[] }

const routedReading = (model: LayoutModel): Reading => reading({ routed: routedFamily(routedBends(model)), crossings: lazyCount(() => routedCrossingPairs(model)), crossingMode: 'pairs', tie: [] });

/**
 * Whether the trial that reserves `courses` is kept: no link the baseline keeps is removed, no offered link has more turns than on the baseline, and the
 * unified order on the routed result gains (fewer bent links, then fewer turns, then fewer crossings).
 */
export function judgeCourseTrial(routedBase: LayoutModel, routedTrial: LayoutModel, offered: Iterable<string>): CourseVerdict {
  const base = routedBends(routedBase), trial = routedBends(routedTrial);
  const removed = [...base.keys()].filter(id => !trial.has(id));
  const worse = [...offered].filter(id => !trial.has(id) || (base.has(id) && trial.get(id)! > base.get(id)!));
  const verdict = (kept: boolean, reason: string): CourseVerdict => ({ kept, reason, removed, worse });
  if (removed.length > 0) return verdict(false, `the trial's route removes ${removed.join(', ')}, which the baseline's route keeps`);
  if (worse.length > 0) return verdict(false, `a link with a course has more turns than on the baseline (${worse.join(', ')})`);
  // No gate gets worse: a course that buys a turn with a lane overlap or a clearance is no gain (the stop rule of ticket 15, phase 4).
  const gateFailures = (model: LayoutModel): Map<string, number> | undefined => {
    try { return new Map(Object.entries(score(model, { force: true }).snapshot.gates).map(([id, gate]) => [id, gate.passed ? 0 : gate.violations.length])); } catch { return undefined; }
  };
  const gatesNow = gateFailures(routedTrial), gatesThen = gateFailures(routedBase);
  if (gatesNow === undefined) return verdict(false, 'the routed trial does not score');
  const gateWorse = [...gatesNow].filter(([id, count]) => count > (gatesThen?.get(id) ?? 0)).map(([id]) => id);
  if (gateWorse.length > 0) return verdict(false, `the routed trial fails the gates ${gateWorse.join(', ')} more than the baseline`);
  const now = routedReading(routedTrial), then = routedReading(routedBase);
  if (!(compare(now, then, courseProfile) < 0)) return verdict(false, `the routed trial gives no gain (${now.routed.bent} bent links, ${now.routed.turns} turns, ${now.crossings()} crossings, against ${then.routed.bent}, ${then.routed.turns} and ${then.crossings()})`);
  return verdict(true, '');
}
