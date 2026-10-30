import type { Point } from '../model/geometry.js';
import type { DirectFamily, DirectMemberReason, DirectUnit, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { EPS, intersection, samePoint, segmentDistance } from '../geometry/planar.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { chordKind, chordVerdict, fixedPointRefusal, isRoutedChord, orthogonalLeg, SIDE_EDGE_SLACK, siblingStemCrowded, strictCrossing } from './frame-paths.js';
import { findPort, STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { groupShape } from './grid.js';
import { portId } from './skeleton-graph.js';
import { plannedSegments, tierGapPlan, tierGapPlans } from './gap-plan.js';
import { tierGaps } from './gap-runs.js';
import { clone } from './bundle-geometry.js';

/**
 * Facing units link direct (architecture-2 ticket 22, slice 1).
 *
 * Two **units** face each other when they stand on adjacent occupied sub-tier bands: a unit is a node, or one packed row of one layout
 * group. The routed links between two facing rows form a **facing pair**; the pair splits into one **direct family** per source node,
 * the node on the side with fewer nodes (the upper side on a tie): a node↔row or node↔node family (user, 2026-10-23). When the
 * orthogonal drawing of the pair crosses more than once at the members of a family, the family is **triggered** and its members are
 * drawn as routed chords, best effort: a member that cannot (blocked, a crossing inside its fan, clearance) stays orthogonal with the
 * reason recorded. Fans of two source nodes may cross each other straight. There is no angle floor (user, 2026-10-24: the flat fans of
 * a-shared-end-reads-its-port-order are "closest to ideal"), and the tier gap does not grow for a family.
 *
 * The decision happens once, at the start of 7f, immediately before `freezeChords`, and is recorded on the model
 * (`model.directFamilies`, R1): an accepted member is a held chord from then on; a refused one stays orthogonal and no later replay offers
 * it the chord again. Slice 1 takes anonymous or distinct-port, unlabelled, non-bundle members between two `row` units (no grid, bar or flank).
 */

/** Retries of a 7f attempt whose direct members a later move crowded (R4: per attempt); each retry refuses the crowded members. */
export const DIRECT_RETRIES = 2;
/** The member sets one family's search tries at most (R4: per family). A truncated search keeps the best set found and says so. */
export const DIRECT_SEARCH_BUDGET = 4096;

const OK_SIDES = { upper: 'bottom', lower: 'top' } as const;


/** The layout group that holds a node, when it is a `row` unit of the rule: no flank, no bar, no grid. */
function rowOf(model: LayoutModel, node: string): string | undefined {
  const id = model.document.nodes[node]?.group;
  const group = id === undefined ? undefined : model.groups[id];
  if (group === undefined || group.flank !== undefined || group.tier === undefined) return undefined;
  return groupShape(model, id!) === 'row' ? id : undefined;
}

/** Whether another drawn routed link ends on this port: a shared port is a fan, which slice 1 leaves as today. */
function sharedPort(model: LayoutModel, link: LayoutLink, end: 'from' | 'to'): boolean {
  const key = portId(link.attachments![end]);
  return model.links.some(other => other.id !== link.id && other.layer === 'routed' && other.removed !== true && other.attachments !== undefined
    && (portId(other.attachments.from) === key || portId(other.attachments.to) === key));
}

/** A member of slice 1, oriented: the end on the upper band and the end on the lower band. */
export interface Member { link: LayoutLink; upper: 'from' | 'to'; lower: 'from' | 'to'; upperGroup: string; lowerGroup: string }

/**
 * The link as a member of slice 1, or undefined: routed and drawn (not removed), no bundle, no stub, no mesh bus, no spanning hint, no
 * label, no authored route but `straight`, a chord candidate (`chordKind`), two different end nodes, its two ports on no other drawn
 * routed link, both ends in `row` units on adjacent occupied sub-tier bands, the upper port on `bottom` and the lower one on `top`.
 * Topology and frozen sides only, so a validator reads the same answer.
 */
function memberOf(model: LayoutModel, link: LayoutLink, next: ReadonlyMap<number, number>): Member | undefined {
  if (link.layer !== 'routed' || effectiveLayer(link) !== 'routed' || !link.attachments || link.bundle !== undefined || link.removed === true) return undefined;
  if (link.technique === 'stub' || link.technique === 'mesh-bus' || link.spanHint === true) return undefined;
  // A fan family is decided in stage 1 and draws its members by its own rule, crossings and all (architecture-2 ticket 40): the fan wins.
  if (link.fanFamily !== undefined) return undefined;
  const source = model.document.links[link.sourceIndex];
  if (source?.label) return undefined;
  if (source?.route !== undefined && source.route !== 'straight') return undefined;
  if (chordKind(model, link) === undefined) return undefined;
  const { from, to } = link.attachments;
  if (from.node === to.node) return undefined;
  const one = rowOf(model, from.node), two = rowOf(model, to.node);
  if (one === undefined || two === undefined) return undefined;
  const t1 = model.groups[one]!.tier!, t2 = model.groups[two]!.tier!;
  const [upper, lower] = next.get(t1) === t2 ? ['from', 'to'] as const : next.get(t2) === t1 ? ['to', 'from'] as const : [undefined, undefined];
  if (upper === undefined) return undefined;
  if (findPort(model, link.attachments[upper])?.side !== OK_SIDES.upper || findPort(model, link.attachments[lower])?.side !== OK_SIDES.lower) return undefined;
  if (sharedPort(model, link, 'from') || sharedPort(model, link, 'to')) return undefined;
  return { link, upper, lower, upperGroup: upper === 'from' ? one : two, lowerGroup: upper === 'from' ? two : one };
}

/** One direct family before the decision: its record fields that topology gives, its members and the members of its facing pair. */
export interface FamilyCandidate {
  id: string;
  pair: string;
  units: { upper: DirectUnit; lower: DirectUnit };
  gap: { above: number; below: number };
  members: Member[];
  pairMembers: Member[];
}

/** The occupied sub-tier bands, each mapped to the next one below it. */
function nextBands(model: LayoutModel): Map<number, number> {
  const tiers = [...new Set(model.tierBands.filter(band => band.bounds !== undefined).map(band => band.tier))].sort((a, b) => a - b);
  return new Map(tiers.slice(0, -1).map((tier, index) => [tier, tiers[index + 1]!] as const));
}

/**
 * The family candidates of a placed model. The links between two facing rows form a pair; the pair splits into one family per node of
 * its source side (the side with fewer nodes, the upper side on a tie). Sorted by gap, then by id (R3: never the link order).
 */
export function familyCandidates(model: LayoutModel): FamilyCandidate[] {
  const next = nextBands(model);
  const pairs = new Map<string, Member[]>();
  for (const link of model.links) {
    const member = memberOf(model, link, next);
    if (member === undefined) continue;
    const key = `${member.upperGroup}>${member.lowerGroup}`;
    const list = pairs.get(key) ?? [];
    list.push(member);
    pairs.set(key, list);
  }
  const result: FamilyCandidate[] = [];
  for (const [pair, pairMembers] of pairs) {
    if (pairMembers.length < 2) continue;
    pairMembers.sort((a, b) => order(model, a, b));
    const first = pairMembers[0]!;
    const nodesOf = (side: 'upper' | 'lower'): string[] => [...new Set(pairMembers.map(item => item.link.attachments![item[side]].node))].sort();
    const uppers = nodesOf('upper'), lowers = nodesOf('lower');
    const source: 'upper' | 'lower' = lowers.length < uppers.length ? 'lower' : 'upper';
    const unit = (group: string, nodes: readonly string[]): DirectUnit =>
      nodes.length === 1 ? { kind: 'node', id: nodes[0]!, group } : { kind: 'row', id: group, group, nodes: [...nodes] };
    for (const node of source === 'upper' ? uppers : lowers) {
      const members = pairMembers.filter(item => item.link.attachments![item[source]].node === node);
      const other = [...new Set(members.map(item => item.link.attachments![item[source === 'upper' ? 'lower' : 'upper']].node))].sort();
      const units = source === 'upper'
        ? { upper: unit(first.upperGroup, [node]), lower: unit(first.lowerGroup, other) }
        : { upper: unit(first.upperGroup, other), lower: unit(first.lowerGroup, [node]) };
      result.push({ id: `${units.upper.kind}:${units.upper.id}>${units.lower.kind}:${units.lower.id}`, pair, units,
        gap: { above: model.groups[first.upperGroup]!.tier!, below: model.groups[first.lowerGroup]!.tier! }, members, pairMembers });
    }
  }
  return result.sort((a, b) => a.gap.above - b.gap.above || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The ends of a member's ports, upper then lower. */
function anchors(model: LayoutModel, member: Member): [Point, Point] | undefined {
  const a = findPort(model, member.link.attachments![member.upper])?.anchor, b = findPort(model, member.link.attachments![member.lower])?.anchor;
  return a && b ? [a, b] : undefined;
}
/** Peer order: by the upper port's x, then the lower port's x, then the semantic port keys (R3: never the link order). */
function order(model: LayoutModel, a: Member, b: Member): number {
  const one = anchors(model, a), two = anchors(model, b);
  if (one && two) {
    if (Math.abs(one[0].x - two[0].x) > EPS) return one[0].x - two[0].x;
    if (Math.abs(one[1].x - two[1].x) > EPS) return one[1].x - two[1].x;
  }
  const key = (item: Member): string => `${portId(item.link.attachments![item.upper])}|${portId(item.link.attachments![item.lower])}`;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/** The endpoint inversions of the pair's port order that involve a member of `members`: a pair whose upper and lower x disagree. Ties count zero. */
function inversions(model: LayoutModel, members: readonly Member[], pairMembers: readonly Member[]): number {
  const own = new Set(members.map(item => item.link.id));
  let count = 0;
  for (let i = 0; i < pairMembers.length; i++) for (let j = i + 1; j < pairMembers.length; j++) {
    if (!own.has(pairMembers[i]!.link.id) && !own.has(pairMembers[j]!.link.id)) continue;
    const a = anchors(model, pairMembers[i]!), b = anchors(model, pairMembers[j]!);
    if (a && b && (a[0].x - b[0].x) * (a[1].x - b[1].x) < -EPS) count++;
  }
  return count;
}

/** The distinct strict crossing points of two polylines; a shared run and an endpoint contact are not crossings. */
function crossingPoints(one: readonly PathSegment[], two: readonly PathSegment[]): Point[] {
  const points: Point[] = [];
  for (const a of one) for (const b of two) {
    const point = intersection(a, b);
    if (point === undefined || [a.from, a.to, b.from, b.to].some(end => samePoint(end, point))) continue;
    if (!points.some(other => samePoint(other, point))) points.push(point);
  }
  return points;
}

/**
 * The orthogonal counterfactual of one facing pair (codex design pass, section 2): on a copy with the pair's chords suppressed, the
 * tier-gap plan seats every member's part, and the strict crossings between the members' planned paths (stem, part, stem) are counted
 * once per point and pair of links. `unresolved` when the plan leaves a member residual: the count is then not known, and never read as zero.
 */
export function orthogonalCounterfactual(model: LayoutModel, gap: { above: number; below: number }, members: readonly Member[]):
  { crossings: number | 'unresolved'; witnesses: { links: [string, string]; at: Point }[] } {
  const copy = clone(model), ids = new Set(members.map(member => member.link.id));
  for (const link of copy.links) if (ids.has(link.id)) { delete link.path; link.technique = 'orthogonal'; }
  copy.frozenChords = copy.links.filter(link => isRoutedChord(copy, link)).map(link => link.id);
  const found = tierGaps(copy).find(item => item.above === gap.above && item.below === gap.below);
  if (found === undefined) return { crossings: 'unresolved', witnesses: [] };
  const plan = tierGapPlan(copy, found);
  const paths = new Map<string, PathSegment[]>();
  for (const member of members) {
    const part = plan.parts.find(item => item.link === member.link.id);
    const ends = anchors(copy, { ...member, link: copy.links.find(link => link.id === member.link.id)! });
    if (part === undefined || ends === undefined) return { crossings: 'unresolved', witnesses: [] };
    const owner = { kind: 'link' as const, id: member.link.id };
    const tipUpper = { x: part.upper.x, y: part.upper.y }, tipLower = { x: part.lower.x, y: part.lower.y };
    paths.set(member.link.id, [{ from: ends[0], to: tipUpper, owner }, ...plannedSegments(part, found), { from: tipLower, to: ends[1], owner }]
      .filter(segment => !samePoint(segment.from, segment.to)));
  }
  const witnesses: { links: [string, string]; at: Point }[] = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const a = members[i]!.link.id, b = members[j]!.link.id;
    for (const at of crossingPoints(paths.get(a)!, paths.get(b)!)) witnesses.push({ links: [a, b], at });
  }
  return { crossings: witnesses.length, witnesses };
}

/** Whether two members of one fan neither touch nor come nearer than the chord clearance (a fan never crosses itself). */
function membersApart(a: PathSegment, b: PathSegment, strokeA: number, strokeB: number): boolean {
  return segmentDistance(a, b) - (strokeA + strokeB) / 2 >= STRAIGHT_PATH_CLEARANCE.path - EPS;
}

const chordPath = (link: LayoutLink, segment: PathSegment): NonNullable<LayoutLink['path']> =>
  ({ owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [{ ...segment, owner: { ...link.owner }, straight: true }] });

/** Make the link orthogonal for the rows rule: no path, and the automatic technique. */
function makeOrthogonal(model: LayoutModel, link: LayoutLink): void {
  delete link.path;
  if (model.document.links[link.sourceIndex]?.route === undefined) link.technique = 'orthogonal';
}
function makeChord(model: LayoutModel, link: LayoutLink, segment: PathSegment): void {
  link.path = chordPath(link, segment);
  if (model.document.links[link.sourceIndex]?.route === undefined) link.technique = 'straight';
}

/**
 * The verdict of one triggered family on the model: the largest set of members that hold together as chords, each one clear of every
 * body, frame, title and corridor (`chordVerdict`), apart from every other member of its fan, and
 * clear of the held chords and of the legs of every link that stays orthogonal (`fixedPointRefusal`). The legs of the other fans of the
 * same pair may be crossed strictly (`crossable`). The set is searched whole (R3: no first-wins), largest first, then the shorter chords,
 * then the semantic port keys. Leaves the members as it found them.
 */
function familyVerdict(model: LayoutModel, members: readonly Member[], crossable: ReadonlySet<string>):
  { direct: Set<string>; segments: Map<string, PathSegment>; reasons: Map<string, DirectMemberReason>; truncated: boolean } {
  const reasons = new Map<string, DirectMemberReason>();
  const segments = new Map<string, PathSegment>();
  for (const member of members) {
    const verdict = chordVerdict(model, member.link, SIDE_EDGE_SLACK);
    if ('reason' in verdict) { reasons.set(member.link.id, verdict.reason); continue; }
    segments.set(member.link.id, verdict.segment);
  }
  const open = members.filter(member => segments.has(member.link.id)).map(member => member.link);
  const key = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`;
  const apart = new Map<string, boolean>();
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const a = open[i]!, b = open[j]!;
    apart.set(key(a.id, b.id), membersApart(segments.get(a.id)!, segments.get(b.id)!, linkStrokeWidth(a), linkStrokeWidth(b)));
  }
  // A set holds when each of its chords clears what stays orthogonal: the members left out keep their legs.
  const holds = (set: readonly LayoutLink[]): Map<string, DirectMemberReason> => {
    const failed = new Map<string, DirectMemberReason>();
    const saved = members.map(member => [member.link, member.link.path, member.link.technique] as const);
    for (const member of members) makeOrthogonal(model, member.link);
    for (const link of set) makeChord(model, link, segments.get(link.id)!);
    for (const link of set) {
      const reason = fixedPointRefusal(model, link, segments.get(link.id)!, undefined, crossable);
      if (reason !== undefined) failed.set(link.id, reason);
    }
    for (const [link, path, technique] of saved) {
      if (path === undefined) delete link.path; else link.path = path;
      if (technique === undefined) delete link.technique; else link.technique = technique;
    }
    return failed;
  };
  let best: LayoutLink[] = [], bestCost = Infinity, bestKey = '', visited = 0, truncated = false;
  const cost = (set: readonly LayoutLink[]): number => set.reduce((sum, link) => {
    const segment = segments.get(link.id)!;
    return sum + Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  }, 0);
  // The last tie-break key: the semantic port keys of the set, upper port then lower port, so a link drawn the other way round keys the same (R3).
  const oriented = new Map(members.map(member => [member.link.id, `${portId(member.link.attachments![member.upper])}|${portId(member.link.attachments![member.lower])}`]));
  const keyOf = (set: readonly LayoutLink[]): string => set.map(link => oriented.get(link.id)!).sort().join('\u0000');
  const offer = (set: LayoutLink[]): void => {
    if (set.length < best.length) return;
    const c = cost(set), k = keyOf(set);
    if (set.length === best.length && (c > bestCost + EPS || (Math.abs(c - bestCost) <= EPS && k >= bestKey))) return;
    if (holds(set).size > 0) return;
    best = [...set]; bestCost = c; bestKey = k;
  };
  const walk = (index: number, set: LayoutLink[]): void => {
    if (visited >= DIRECT_SEARCH_BUDGET) { truncated = true; return; }
    visited++;
    if (set.length + (open.length - index) < best.length) return;
    if (index === open.length) { if (set.length > 0) offer(set); return; }
    const link = open[index]!;
    if (set.every(other => apart.get(key(link.id, other.id)) === true)) walk(index + 1, [...set, link]);
    walk(index + 1, set);
  };
  walk(0, []);
  const direct = new Set(best.map(link => link.id));
  // Name a reason for every open member left out: the first check that refuses it beside the chosen set.
  for (const link of open) {
    if (direct.has(link.id)) continue;
    const clash = best.find(other => apart.get(key(link.id, other.id)) === false);
    if (clash !== undefined) { reasons.set(link.id, intersection(segments.get(link.id)!, segments.get(clash.id)!) !== undefined ? 'crossing' : 'clearance'); continue; }
    const failed = holds([...best, link]);
    reasons.set(link.id, failed.get(link.id) ?? 'crowds');
  }
  return { direct, segments, reasons, truncated };
}


interface Decided { families: DirectFamily[]; diagnostics: LayoutModel['diagnostics'] }

/**
 * The decision on the draft: every triggered member is made orthogonal, then each triggered family takes
 * its verdict in family order, its chords held for the families after it. Writes the paths; returns the records.
 */
function decide(model: LayoutModel, plans: readonly { candidate: FamilyCandidate; family: DirectFamily }[], refused: ReadonlySet<string>): Decided {
  const diagnostics: LayoutModel['diagnostics'] = [];
  for (const { candidate, family } of plans) if (family.triggered) for (const member of candidate.members) makeOrthogonal(model, linkOf(model, member.link.id));
  const families: DirectFamily[] = [];
  const settings: { index: number; crossable: ReadonlySet<string> }[] = [];
  for (const { candidate, family } of plans) {
    if (!family.triggered) { families.push(family); continue; }
    const members = candidate.members.map(member => ({ ...member, link: linkOf(model, member.link.id) }));
    const own = new Set(members.map(member => member.link.id));
    const crossable = new Set(candidate.pairMembers.map(member => member.link.id).filter(id => !own.has(id)));
    const verdict = familyVerdict(model, members.filter(member => !refused.has(member.link.id)), crossable);
    for (const member of members) if (refused.has(member.link.id)) verdict.reasons.set(member.link.id, 'crowds');
    for (const member of members) if (verdict.direct.has(member.link.id)) makeChord(model, member.link, verdict.segments.get(member.link.id)!);
    if (verdict.truncated) diagnostics.push({ stage: 'placement', severity: 'warning', code: 'DIRECT_FAMILY_SEARCH_TRUNCATED',
      message: `The member search of the direct family ${family.id} stopped at ${DIRECT_SEARCH_BUDGET} sets; the best set found is kept.`,
      owners: members.map(member => ({ kind: 'link' as const, id: member.link.id })) });
    families.push({ ...family, members: members.map(member => verdict.direct.has(member.link.id)
      ? { link: member.link.id, mode: 'direct' as const }
      : { link: member.link.id, mode: 'orthogonal' as const, reason: verdict.reasons.get(member.link.id) ?? 'crowds' }) });
    settings.push({ index: families.length - 1, crossable });
  }
  // A family decided first read the members of the later families as orthogonal legs. Once every family stands, a member refused for a leg or a held
  // chord takes its chord when it holds now: apart from the direct members of its fan, clear by the fixed point, and every chord already held still
  // holding beside it. Repeated in family and peer order until nothing changes (R3: the order is the families' ids and the peer order).
  for (let changed = true; changed;) {
    changed = false;
    for (const { index, crossable } of settings) {
      const record = families[index]!;
      for (const entry of record.members) {
        if (entry.mode !== 'orthogonal' || refused.has(entry.link) || (entry.reason !== 'leg' && entry.reason !== 'chord')) continue;
        const link = linkOf(model, entry.link), verdict = chordVerdict(model, link, SIDE_EDGE_SLACK);
        if (!('segment' in verdict)) continue;
        const fan = record.members.filter(item => item.mode === 'direct').map(item => linkOf(model, item.link));
        if (fan.some(other => !membersApart(verdict.segment, other.path!.segments[0]!, linkStrokeWidth(link), linkStrokeWidth(other)))) continue;
        if (fixedPointRefusal(model, link, verdict.segment, undefined, crossable) !== undefined) continue;
        makeChord(model, link, verdict.segment);
        // Only a held chord near the new one can lose its fixed point to it.
        const near = (other: LayoutLink): boolean => segmentDistance(verdict.segment, other.path!.segments[0]!) - (linkStrokeWidth(link) + linkStrokeWidth(other)) / 2 < STRAIGHT_PATH_CLEARANCE.path + EPS;
        const held = families.flatMap((item, at) => item.members.filter(m => m.mode === 'direct').map(m => ({ link: linkOf(model, m.link), crossable: settings.find(x => x.index === at)!.crossable })))
          .filter(item => near(item.link));
        if (held.some(item => fixedPointRefusal(model, item.link, item.link.path!.segments[0]!, undefined, item.crossable) !== undefined)) { makeOrthogonal(model, link); continue; }
        entry.mode = 'direct'; delete entry.reason; changed = true;
      }
    }
  }
  // A refused member is orthogonal now, and its legs are new walls. A held chord the decision did not judge beside them (a labelled chord, a chord
  // outside every family, a direct member of another family) may stand within the clearance of such a leg: G6 would fail it, and no later rule
  // looks again. So every held chord near the leg of an orthogonal member takes the fixed point again (with its family's crossable legs), and a
  // chord that fails is refused: orthogonal, and recorded as a refused member where it is one. Its own legs are walls in turn, until none fails.
  refuseChordsNearNewLegs(model, families, settings);
  return { families, diagnostics };
}
const linkOf = (model: LayoutModel, id: string): LayoutLink => model.links.find(link => link.id === id)!;

/** See the note at the end of `decide`: the held chords within the clearance of an orthogonal member's leg take the fixed point again. */
function refuseChordsNearNewLegs(model: LayoutModel, families: DirectFamily[], settings: readonly { index: number; crossable: ReadonlySet<string> }[]): void {
  const walls = new Set(families.filter(family => family.triggered).flatMap(family => family.members.filter(member => member.mode === 'orthogonal').map(member => member.link)));
  const memberOf = (id: string): { family: DirectFamily; crossable: ReadonlySet<string> } | undefined => {
    for (const { index, crossable } of settings) if (families[index]!.members.some(member => member.link === id)) return { family: families[index]!, crossable };
    return undefined;
  };
  for (let changed = walls.size > 0; changed;) {
    changed = false;
    const legs = [...walls].sort().flatMap(id => {
      const link = linkOf(model, id);
      return (['from', 'to'] as const).flatMap(end => { const leg = orthogonalLeg(model, link, end); return leg ? [{ leg, link }] : []; });
    });
    // Link order is the model's; the outcome does not depend on it, because a chord is refused only for the legs, and a refusal adds walls that the next round reads.
    for (const chord of model.links) {
      if (!isRoutedChord(model, chord)) continue;
      const segment = chord.path!.segments[0]!, stroke = linkStrokeWidth(chord);
      if (!legs.some(({ leg, link }) => link.id !== chord.id && segmentDistance(segment, leg) - (stroke + linkStrokeWidth(link)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS)) continue;
      const owner = memberOf(chord.id);
      const reason = fixedPointRefusal(model, chord, segment, undefined, owner?.crossable);
      if (reason === undefined) continue;
      makeOrthogonal(model, chord);
      walls.add(chord.id);
      changed = true;
      const entry = owner?.family.members.find(member => member.link === chord.id);
      if (entry !== undefined) { entry.mode = 'orthogonal'; entry.reason = reason; }
    }
  }
}

/**
 * Decide every direct family of the draft, once, at the start of 7f and before `freezeChords` (R1), and record the triggered ones in
 * `model.directFamilies` (absent = none triggered). A family whose orthogonal drawing crosses once or never is not recorded and is left as the other rules make it.
 */
export function planDirectFamilies(draft: LayoutModel, refused: ReadonlySet<string> = new Set()): void {
  const candidates = familyCandidates(draft);
  const counted = new Map<string, ReturnType<typeof orthogonalCounterfactual>>();
  const plans = candidates.map(candidate => {
    if (!counted.has(candidate.pair)) counted.set(candidate.pair, orthogonalCounterfactual(draft, candidate.gap, candidate.pairMembers));
    const pair = counted.get(candidate.pair)!, own = new Set(candidate.members.map(member => member.link.id));
    const witnesses = pair.witnesses.filter(item => own.has(item.links[0]) || own.has(item.links[1]));
    const crossings = pair.crossings === 'unresolved' ? 'unresolved' as const : witnesses.length;
    const inverted = inversions(draft, candidate.members, candidate.pairMembers);
    // An inversion count above one proves the threshold without the plan (each inversion is a crossing the orthogonal drawing cannot avoid).
    const triggered = triggers(crossings, inverted);
    const family: DirectFamily = { id: candidate.id, units: candidate.units, gap: candidate.gap, baselineOrder: candidate.members.map(member => member.link.id),
      crossings, inversions: inverted, witnesses, triggered,
      portPlan: candidate.members.map((member, index) => ({ link: member.link.id, index,
        upper: { port: portId(member.link.attachments![member.upper]), side: OK_SIDES.upper }, lower: { port: portId(member.link.attachments![member.lower]), side: OK_SIDES.lower } })),
      members: candidate.members.map(member => ({ link: member.link.id, mode: 'unplanned' as const })) };
    return { candidate, family };
  });
  const { families, diagnostics } = decide(draft, plans, refused);
  draft.diagnostics.push(...diagnostics);
  // Only a triggered family is recorded. Absent before the freeze = not planned; absent once `frozenChords` is set = planned, no family
  // triggered (an untriggered family changes nothing, and a sheet with none publishes the bytes it did before ticket 22).
  const triggered = families.filter(family => family.triggered);
  if (triggered.length) draft.directFamilies = triggered; else delete draft.directFamilies;
}

/** The trigger, read the same way by the decision and the validator: the orthogonal drawing crosses more than once, or the inversions prove it. */
export const triggers = (crossings: number | 'unresolved', inverted: number): boolean => (crossings !== 'unresolved' && crossings > 1) || inverted > 1;

/**
 * What a validator checks on `model.directFamilies` (R5): it reads the record and the geometry, and never decides a family again.
 * Absent = no triggered family (or, before the freeze, not planned yet); a record before the freeze is a fault. Each family names member links of
 * the model between its units, and every member link between its units (`memberOf`, topology only); its trigger agrees with its counts, and
 * its witnesses with its crossings; a direct member is a held chord and a refused one is not; and no two direct members of one fan cross.
 */
export function directFamiliesFault(model: LayoutModel): string | undefined {
  const record = model.directFamilies;
  if (record === undefined) return undefined;
  if (model.frozenChords === undefined) return 'a direct family is recorded before the freeze';
  const frozen = new Set(model.frozenChords ?? []);
  const seen = new Set<string>();
  const next = nextBands(model);
  for (const family of record) {
    if (!family.triggered || !triggers(family.crossings, family.inversions)) return `${family.id} is recorded without a trigger its counts give`;
    if (family.witnesses.length !== (family.crossings === 'unresolved' ? 0 : family.crossings)) return `${family.id} names ${family.witnesses.length} witnesses for ${family.crossings} crossings`;
    const units = family.units;
    const holds = (unit: DirectUnit, node: string): boolean => unit.kind === 'node' ? unit.id === node : unit.nodes.includes(node);
    const direct: { link: LayoutLink; segment: { from: Point; to: Point } }[] = [];
    for (const member of family.members) {
      const link = model.links.find(item => item.id === member.link);
      if (link?.attachments === undefined) return `${family.id} names ${member.link}, which is not a link of the model`;
      if (seen.has(link.id)) return `${link.id} is a member of two families`;
      seen.add(link.id);
      const { from, to } = link.attachments;
      if (!((holds(units.upper, from.node) && holds(units.lower, to.node)) || (holds(units.upper, to.node) && holds(units.lower, from.node)))) {
        return `${link.id} does not join the units of ${family.id}`;
      }
      if (member.mode === 'unplanned') return `${link.id} is unplanned in the triggered family ${family.id}`;
      if (member.mode === 'orthogonal' && frozen.has(link.id)) return `${link.id} holds a chord its family refused (${member.reason ?? 'no reason'})`;
      if (member.mode === 'orthogonal' && member.reason === undefined) return `${link.id} is refused with no reason`;
      if (member.mode === 'direct') {
        if (!frozen.has(link.id)) return `${link.id} is direct and holds no frozen chord`;
        const a = findPort(model, from)?.anchor, b = findPort(model, to)?.anchor;
        if (a && b) direct.push({ link, segment: { from: a, to: b } });
      }
    }
    // Every member link between the two units is listed: the family is decided whole, so none may be left out of the record.
    for (const link of model.links) {
      const member = memberOf(model, link, next);
      if (member === undefined) continue;
      const upper = link.attachments![member.upper].node, lower = link.attachments![member.lower].node;
      if (holds(units.upper, upper) && holds(units.lower, lower) && !family.members.some(item => item.link === link.id)) return `${family.id} leaves out ${link.id}, which joins its units`;
    }
    for (let i = 0; i < direct.length; i++) for (let j = i + 1; j < direct.length; j++) {
      const one = direct[i]!, two = direct[j]!;
      const a = { ...one.segment, owner: one.link.owner }, b = { ...two.segment, owner: two.link.owner };
      if (strictCrossing(a, b)) return `${one.link.id} and ${two.link.id} of the fan ${family.id} cross`;
    }
  }
  return undefined;
}

/**
 * The direct members that stand, after 7f, within the chord clearance of a part the tier-gap plan seats in their gap (a leg, a row, a drop, a
 * stem), or of another held chord, and cross it nowhere strictly: what G6 would fail. Read on the model as 7f leaves it. Of two members
 * that crowd only each other, the first in family and peer order is named.
 */
export function crowdedDirectMembers(model: LayoutModel): string[] {
  const direct = (model.directFamilies ?? []).flatMap(family => family.members.filter(member => member.mode === 'direct').map(member => ({ id: member.link, gap: family.gap })));
  return crowdedChords(model, direct);
}

/**
 * The straight fan members (architecture-2 ticket 40) that 7f brought within the chord clearance of a planned part of their gap, or of another
 * held chord, crossing it nowhere strictly (`crowds`: what G6 would fail), or that pass the stem of a sibling fallback (`stem`). The gap is the one
 * between the sub-tiers of the member's two ends. A member both crowd names `crowds`.
 */
export function crowdedFanMembers(model: LayoutModel): Map<string, 'crowds' | 'stem'> {
  const straight = (model.fanAdmissions ?? []).filter(item => item.mode === 'straight').flatMap(item => {
    const link = model.links.find(other => other.id === item.link);
    if (link?.attachments === undefined) return [];
    const tiers = [link.attachments.from.node, link.attachments.to.node].map(node => model.groups[model.document.nodes[node]!.group]!.tier!);
    return [{ id: link.id, gap: { above: Math.min(...tiers), below: Math.max(...tiers) } }];
  });
  // A member that still passes a sibling fallback's stem is crowded too: the admission let it cross the leg, the leg's stem is final only now.
  const found = new Map<string, 'crowds' | 'stem'>();
  for (const { id } of straight) if (siblingStemCrowded(model, model.links.find(other => other.id === id)!)) found.set(id, 'stem');
  for (const id of crowdedChords(model, straight)) found.set(id, 'crowds');
  return found;
}

/** The held chords of `entries` that stand within the chord clearance of a planned part of their gap or of another held chord, crossing it nowhere strictly. */
function crowdedChords(model: LayoutModel, direct: readonly { id: string; gap: { above: number; below: number } }[]): string[] {
  if (!direct.length) return [];
  const plans = tierGapPlans(model);
  const crowded: string[] = [];
  for (const { id, gap } of direct) {
    const link = model.links.find(item => item.id === id), chord = link?.path?.segments.length === 1 ? link.path.segments[0]! : undefined;
    if (link === undefined || chord === undefined) continue;
    const stroke = linkStrokeWidth(link);
    const near = (segment: PathSegment, other: number): boolean => !strictCrossing(chord, segment)
      && segmentDistance(chord, segment) - (stroke + other) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS;
    const found = plans.find(item => item.gap.above === gap.above && item.gap.below === gap.below);
    let hit = false;
    for (const part of found?.plan.parts ?? []) {
      const owner = model.links.find(item => item.id === part.link);
      if (owner === undefined) continue;
      const ends = [findPort(model, owner.attachments!.from)?.anchor, findPort(model, owner.attachments!.to)?.anchor];
      const stems: PathSegment[] = [];
      for (const tip of [part.upper, part.lower]) {
        if (tip.kind !== 'tip') continue;
        const anchor = ends.find(point => point !== undefined && Math.abs(point.x - tip.x) < EPS);
        if (anchor && !samePoint(anchor, tip)) stems.push({ from: anchor, to: { x: tip.x, y: tip.y }, owner: owner.owner });
      }
      if ([...plannedSegments(part, found!.gap), ...stems].some(segment => near(segment, linkStrokeWidth(owner)))) { hit = true; break; }
    }
    // Of two direct members that crowd each other only the first is refused: the other no longer has a chord near it.
    if (!hit) for (const other of model.links) {
      if (other.id === id || crowded.includes(other.id) || !isRoutedChord(model, other)) continue;
      if (near(other.path!.segments[0]!, linkStrokeWidth(other))) { hit = true; break; }
    }
    if (hit) crowded.push(id);
  }
  return crowded;
}
