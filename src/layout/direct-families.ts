import type { Point } from '../model/geometry.js';
import type { DirectFamily, DirectMemberReason, DirectUnit, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { EPS, intersection, samePoint, segmentDistance } from '../geometry/planar.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { effectiveLayer } from '../score/model.js';
import { chordKind, chordVerdict, fixedPointRefusal, isRoutedChord, SIDE_EDGE_SLACK, strictCrossing } from './frame-paths.js';
import { findPort, STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { groupShape } from './grid.js';
import { bandGap, portId } from './skeleton-graph.js';
import { plannedSegments, tierGapPlan } from './gap-plan.js';
import { tierGaps } from './gap-runs.js';
import { moveBands } from './gap-room.js';
import { clone } from './bundle-geometry.js';

/**
 * Facing units link direct (architecture-2 ticket 22, slice 1).
 *
 * Two **units** face each other when they stand on adjacent occupied sub-tier bands: a unit is a node, or one packed row of one layout
 * group. The routed links between two facing rows form a **facing pair**; the pair splits into one **direct family** per source node,
 * the node on the side with fewer nodes (the upper side on a tie): a node↔row or node↔node family (user, 2026-10-23). When the
 * orthogonal drawing of the pair crosses more than once at the members of a family, the family is **triggered** and its members are
 * drawn as routed chords, best effort: a member that cannot (blocked, flatter than 30 degrees on the grown gap, a crossing inside its
 * fan, clearance) stays orthogonal with the reason recorded. Fans of two source nodes may cross each other straight.
 *
 * Placement first grows the tier gap so that the members reach 30 degrees, up to `DIRECT_GAP_CAP` times the band gap, and then decides
 * on the grown gap. Both happen once, at the start of 7f, immediately before `freezeChords`, and are recorded on the model
 * (`model.directFamilies`, R1): an accepted member is a held chord from then on; a refused one stays orthogonal and no later replay offers
 * it the chord again. Slice 1 takes anonymous or distinct-port, unlabelled, non-bundle members between two `row` units (no grid, bar or flank).
 */

/** The steepest a member may lean: at least 30 degrees from horizontal, inclusive (user, 2026-10-23). Read for a chord across a tier gap only. */
export const DIRECT_MIN_SLOPE = 1 / Math.sqrt(3);
/** A triggered family may grow its tier gap until the gap is this many band gaps tall (user, 2026-10-23: about twice the normal gap). */
export const DIRECT_GAP_CAP = 2;
/** The member sets one family's search tries at most (R4: per family). A truncated search keeps the best set found and says so. */
export const DIRECT_SEARCH_BUDGET = 4096;
/** Trials of the gap growth before the verdict (R4, per placement attempt): each adds what the flat members of the one before still ask. */
const GROWTH_TRIALS = 3;

const OK_SIDES = { upper: 'bottom', lower: 'top' } as const;

/** Whether a chord from `from` to `to` stands at least 30 degrees from horizontal (`abs(dy) >= abs(dx) / sqrt(3)`, inclusive). */
export function steepEnough(segment: { from: Point; to: Point }): boolean {
  const dx = Math.abs(segment.to.x - segment.from.x), dy = Math.abs(segment.to.y - segment.from.y);
  return dy >= dx * DIRECT_MIN_SLOPE - EPS;
}

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
 * The link as a member of slice 1, or undefined: routed and drawn, no bundle, no label, no authored route but `straight`, a chord
 * candidate, its two ports on no other routed link, both ends in `row` units on adjacent occupied sub-tier bands, the upper port on
 * `bottom` and the lower one on `top`. Topology and frozen sides only, so a validator reads the same answer.
 */
function memberOf(model: LayoutModel, link: LayoutLink, next: ReadonlyMap<number, number>): Member | undefined {
  if (link.layer !== 'routed' || effectiveLayer(link) !== 'routed' || !link.attachments || link.bundle !== undefined || link.removed === true) return undefined;
  if (link.technique === 'stub' || link.technique === 'mesh-bus' || link.spanHint === true) return undefined;
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
 * body, frame, title and corridor (`chordVerdict`), at least 30 degrees from horizontal, apart from every other member of its fan, and
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
    if (!steepEnough(verdict.segment)) { reasons.set(member.link.id, 'angle'); continue; }
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
  // The last tie-break key: the semantic port keys of the set (R3).
  const keyOf = (set: readonly LayoutLink[]): string => set.map(link => portId(link.attachments!.from) + portId(link.attachments!.to)).sort().join('\u0000');
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

/** The height of the tier gap between two sub-tier bands, from the bottom of the upper band to the top of the lower one. */
function gapHeight(model: LayoutModel, gap: { above: number; below: number }): number | undefined {
  const above = model.tierBands.find(band => band.tier === gap.above)?.bounds, below = model.tierBands.find(band => band.tier === gap.below)?.bounds;
  return above && below ? below.y - (above.y + above.height) : undefined;
}

/** How much more height a member's chord needs to stand at 30 degrees; 0 when it does already. */
function steepnessNeed(model: LayoutModel, member: Member): number {
  const ends = anchors(model, member);
  if (!ends) return Infinity;
  return Math.max(0, Math.abs(ends[1].x - ends[0].x) * DIRECT_MIN_SLOPE - (ends[1].y - ends[0].y));
}

interface Decided { families: DirectFamily[]; diagnostics: LayoutModel['diagnostics'] }

/**
 * The decision on one model (the draft or a growth trial): every triggered member is made orthogonal, then each triggered family takes
 * its verdict in family order, its chords held for the families after it. Writes the paths; returns the records.
 */
function decide(model: LayoutModel, plans: readonly { candidate: FamilyCandidate; family: DirectFamily }[]): Decided {
  const diagnostics: LayoutModel['diagnostics'] = [];
  for (const { candidate, family } of plans) if (family.triggered) for (const member of candidate.members) makeOrthogonal(model, linkOf(model, member.link.id));
  const families: DirectFamily[] = [];
  for (const { candidate, family } of plans) {
    if (!family.triggered) { families.push(family); continue; }
    const members = candidate.members.map(member => ({ ...member, link: linkOf(model, member.link.id) }));
    const own = new Set(members.map(member => member.link.id));
    const crossable = new Set(candidate.pairMembers.map(member => member.link.id).filter(id => !own.has(id)));
    const verdict = familyVerdict(model, members, crossable);
    for (const member of members) if (verdict.direct.has(member.link.id)) makeChord(model, member.link, verdict.segments.get(member.link.id)!);
    if (verdict.truncated) diagnostics.push({ stage: 'placement', severity: 'warning', code: 'DIRECT_FAMILY_SEARCH_TRUNCATED',
      message: `The member search of the direct family ${family.id} stopped at ${DIRECT_SEARCH_BUDGET} sets; the best set found is kept.`,
      owners: members.map(member => ({ kind: 'link' as const, id: member.link.id })) });
    families.push({ ...family, members: members.map(member => verdict.direct.has(member.link.id)
      ? { link: member.link.id, mode: 'direct' as const }
      : { link: member.link.id, mode: 'orthogonal' as const, reason: verdict.reasons.get(member.link.id) ?? 'crowds' }) });
  }
  return { families, diagnostics };
}
const linkOf = (model: LayoutModel, id: string): LayoutLink => model.links.find(link => link.id === id)!;

/**
 * Decide every direct family of the draft, once, at the start of 7f and before `freezeChords` (R1), and record `model.directFamilies`
 * (`[]` = planned, no family). The tier gap of a triggered family first grows so that its members reach 30 degrees, at most to
 * `DIRECT_GAP_CAP` band gaps (R2: the room is reserved in placement, before the freeze): the growth is tried on a copy, cut back to what
 * the members the verdict keeps need, and applied to the draft with `replay`, the 7f replay of a group move. The verdict then runs on the
 * grown draft. A family whose orthogonal drawing crosses once or never is recorded untriggered and left as the other rules make it.
 */
export function planDirectFamilies(draft: LayoutModel, replay: (model: LayoutModel) => void): void {
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
      crossings, inversions: inverted, witnesses, triggered, growth: 0,
      portPlan: candidate.members.map((member, index) => ({ link: member.link.id, index,
        upper: { port: portId(member.link.attachments![member.upper]), side: OK_SIDES.upper }, lower: { port: portId(member.link.attachments![member.lower]), side: OK_SIDES.lower } })),
      members: candidate.members.map(member => ({ link: member.link.id, mode: 'unplanned' as const })) };
    return { candidate, family };
  });
  // The growth a tier gap asks on a model: the most any triggered member that the verdict refused as too flat needs, among those the
  // cap lets reach 30 degrees (the gap no taller than `DIRECT_GAP_CAP` band gaps).
  const asks = (model: LayoutModel, flat: ReadonlySet<string>): Map<number, number> => {
    const result = new Map<number, number>();
    for (const { candidate, family } of plans) {
      if (!family.triggered) continue;
      const height = gapHeight(model, candidate.gap);
      if (height === undefined) continue;
      const room = Math.max(0, DIRECT_GAP_CAP * bandGap(model) - height);
      for (const member of candidate.members) {
        if (!flat.has(member.link.id)) continue;
        const need = steepnessNeed(model, { ...member, link: linkOf(model, member.link.id) });
        if (need > EPS && need <= room + EPS) result.set(candidate.gap.below, Math.max(result.get(candidate.gap.below) ?? 0, need));
      }
    }
    return result;
  };
  const flatOf = (families: readonly DirectFamily[]): Set<string> =>
    new Set(families.flatMap(family => family.members.filter(member => member.reason === 'angle').map(member => member.link)));
  const directOf = (families: readonly DirectFamily[]): number => families.reduce((sum, family) => sum + family.members.filter(member => member.mode === 'direct').length, 0);
  const total = (growth: ReadonlyMap<number, number>): number => [...growth.values()].reduce((sum, extra) => sum + extra, 0);
  // Trials (R4: `GROWTH_TRIALS`): each grows the gaps by what the flat members of the trial before still ask, on a copy that the 7f replay has
  // settled (the replay re-centres, so the need is read on the trial, never on the ungrown draft). The trial with the most direct members is
  // kept, then the one that grew less; the ungrown draft is the first candidate.
  let growth = new Map<number, number>();
  let best = { growth, direct: directOf(decide(clone(draft), plans).families) };
  let ask = asks(draft, flatOf(decide(clone(draft), plans).families));
  for (let trial = 0; trial < GROWTH_TRIALS && ask.size; trial++) {
    growth = new Map(growth);
    for (const [tier, extra] of ask) growth.set(tier, (growth.get(tier) ?? 0) + extra);
    const copy = clone(draft);
    moveBands(copy, growth);
    replay(copy);
    const { families } = decide(copy, plans);
    const direct = directOf(families);
    if (direct > best.direct || (direct === best.direct && total(growth) < total(best.growth) - EPS)) best = { growth, direct };
    ask = asks(copy, flatOf(families));
  }
  growth = best.growth;
  if (growth.size) {
    moveBands(draft, growth);
    replay(draft);
    for (const [tier, extra] of growth) draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'DIRECT_FAMILY_GAP_GROWN',
      message: `The tier gap above tier ${tier} grew ${extra.toFixed(2)} px so that its direct families stand at 30 degrees.`,
      owners: plans.filter(item => item.family.triggered && item.candidate.gap.below === tier).flatMap(item => item.candidate.members.map(member => ({ kind: 'link' as const, id: member.link.id }))) });
  }
  for (const item of plans) item.family.growth = growth.get(item.candidate.gap.below) ?? 0;
  const { families, diagnostics } = decide(draft, plans);
  draft.diagnostics.push(...diagnostics);
  draft.directFamilies = families;
}

/** The trigger, read the same way by the decision and the validator: the orthogonal drawing crosses more than once, or the inversions prove it. */
export const triggers = (crossings: number | 'unresolved', inverted: number): boolean => (crossings !== 'unresolved' && crossings > 1) || inverted > 1;

/**
 * What a validator checks on `model.directFamilies` (R5): it reads the record and the geometry, and never decides a family again.
 * Absent before 7f; absent after the freeze is a fault (the freeze always records, `[]` when no family). Each family names member links of
 * the model between its units, its trigger agrees with its counts, its growth lies within the cap, a direct member is a held chord and a
 * refused one is not, and no two direct members of one fan touch.
 */
export function directFamiliesFault(model: LayoutModel): string | undefined {
  const record = model.directFamilies;
  if (record === undefined) return model.frozenChords !== undefined ? 'the chords are frozen and no direct family was planned' : undefined;
  const frozen = new Set(model.frozenChords ?? []);
  const seen = new Set<string>();
  for (const family of record) {
    if (family.triggered !== triggers(family.crossings, family.inversions)) return `${family.id} is recorded ${family.triggered ? '' : 'un'}triggered against its counts`;
    if (!(family.growth >= 0 && family.growth <= DIRECT_GAP_CAP * bandGap(model) + EPS)) return `${family.id} records a growth of ${family.growth} px`;
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
      if (!family.triggered) { if (member.mode !== 'unplanned') return `${link.id} is ${member.mode} in the untriggered family ${family.id}`; continue; }
      if (member.mode === 'unplanned') return `${link.id} is unplanned in the triggered family ${family.id}`;
      if (member.mode === 'orthogonal' && frozen.has(link.id)) return `${link.id} holds a chord its family refused (${member.reason ?? 'no reason'})`;
      if (member.mode === 'orthogonal' && member.reason === undefined) return `${link.id} is refused with no reason`;
      if (member.mode === 'direct') {
        if (!frozen.has(link.id)) return `${link.id} is direct and holds no frozen chord`;
        const a = findPort(model, from)?.anchor, b = findPort(model, to)?.anchor;
        if (a && b) direct.push({ link, segment: { from: a, to: b } });
      }
    }
    for (let i = 0; i < direct.length; i++) for (let j = i + 1; j < direct.length; j++) {
      const one = direct[i]!, two = direct[j]!;
      const a = { ...one.segment, owner: one.link.owner }, b = { ...two.segment, owner: two.link.owner };
      if (strictCrossing(a, b)) return `${one.link.id} and ${two.link.id} of the fan ${family.id} cross`;
    }
  }
  return undefined;
}

/** The ids of the members a recorded triggered family refused: no later rule may hold their chord (R1). */
export function refusedMembers(model: LayoutModel): Set<string> {
  return new Set((model.directFamilies ?? []).filter(family => family.triggered)
    .flatMap(family => family.members.filter(member => member.mode === 'orthogonal').map(member => member.link)));
}
