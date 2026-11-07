import { blockReservationsFault } from './block-checks.js';
import type { FanFallbackReason, FanFamily, LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { EPS, segmentDistance } from '../geometry/planar.js';
import { linkStrokeWidth, pathStrokeWidth } from '../theme/geometry.js';
import { chordsApart, chordVerdict, fanCrossedBoxes, fixedPointRefusal, foreignBox, isRoutedChord, orthogonalLeg, siblingStemCrowded, SIDE_EDGE_SLACK } from './frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { portId } from './skeleton-graph.js';

/**
 * The joint admission of a fan family (architecture-2 ticket 40, merged design Sections 2 and 3).
 *
 * The members of one family are decided together, once on each placed model, inside the rows fixed point (`rebuildRowPaths`): of the members
 * whose chord stands alone (`chordVerdict` with the fan's walls), the largest set whose chords hold together is drawn straight, and the rest
 * fall back, each alone, to the orthogonal route. A set holds when each of its chords keeps the clearance from every held chord it does not
 * strictly cross (G6 stays geometric: two members under 10 px apart cannot both stand) and clears the fixed point (`fixedPointRefusal`): the legs
 * of every link that stays orthogonal, where a fallback of its own family is crossed when the chord's x-span holds its leg, and the titles it must
 * fit beside. The freeze at the start of 7f holds the members that are straight then and records them (`fanAdmissions`); nothing later
 * decides them again (R1).
 */

/** The member sets one family's search tests at most, on one placed model (R4: a count, per family). A truncated search keeps the best set found. */
export const FAN_SEARCH_BUDGET = 512;

const chordPath = (link: LayoutLink, segment: PathSegment): NonNullable<LayoutLink['path']> =>
  ({ owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [{ ...segment, owner: { ...link.owner }, straight: true }] });
const automatic = (model: LayoutModel, link: LayoutLink): boolean => model.document.links[link.sourceIndex]?.route === undefined;

/** Make the member orthogonal for the rows rule: no path, and the automatic technique. */
export function makeFanOrthogonal(model: LayoutModel, link: LayoutLink): void {
  delete link.path;
  if (automatic(model, link)) link.technique = 'orthogonal';
}
function makeChord(model: LayoutModel, link: LayoutLink, segment: PathSegment): void {
  link.path = chordPath(link, segment);
  if (automatic(model, link)) link.technique = 'straight';
}

/** The result of one family's search: the members drawn straight, with their chords, and whether the budget cut the search short. */
interface FamilyVerdict { straight: LayoutLink[]; segments: Map<string, PathSegment>; truncated: boolean; tested: number; bodyRefusals: number }

/**
 * The largest set of the family's members whose chords hold together, every other member orthogonal. Read whole (R3: no first-wins): the
 * members in the order of their port keys (hub port, then far port), larger sets first, then the shorter total length, then the port keys.
 * Leaves every member orthogonal; the caller draws the chosen set.
 */
function familyVerdict(model: LayoutModel, family: FanFamily, members: readonly LayoutLink[], budget: number): FamilyVerdict {
  for (const link of members) makeFanOrthogonal(model, link);
  const hubOf = new Map(family.members.map(member => [member.link, member.hub]));
  const keyOf = (link: LayoutLink): string => {
    const ends = link.attachments!, hubFirst = ends.from.node === hubOf.get(link.id);
    return `${portId(hubFirst ? ends.from : ends.to)}|${portId(hubFirst ? ends.to : ends.from)}`;
  };
  const segments = new Map<string, PathSegment>();
  let bodyRefusals = 0;
  for (const link of members) {
    const verdict = chordVerdict(model, link, SIDE_EDGE_SLACK);
    if ('segment' in verdict) segments.set(link.id, verdict.segment);
    else if (verdict.reason === 'body') bodyRefusals++;
  }
  // The last key is the port keys of the member, which are unique (R3).
  const open = members.filter(link => segments.has(link.id)).sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  const pair = (a: string, b: string): string => a < b ? `${a}|${b}` : `${b}|${a}`;
  const apart = new Map<string, boolean>();
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const a = open[i]!, b = open[j]!;
    apart.set(pair(a.id, b.id), chordsApart(segments.get(a.id)!, segments.get(b.id)!, linkStrokeWidth(a), linkStrokeWidth(b)));
  }
  let tested = 0, truncated = false;
  /**
   * Whether every chord of `set` can still hold once the members from `index` on are decided: the members from `index` on that keep apart from
   * the whole set are drawn as chords too, so they are no walls. A chord's refusals only grow as members fall back (each fallback adds legs, and a
   * chord it keeps apart from adds no clearance), so a set that a chord or a leg refuses here fails in every completion: the walk stops there
   * (no group title refuses a chord: a title yields to it, architecture-2 ticket 54). At the end of the walk this is the test of the set itself,
   * so a set is drawn only when it holds as drawn. One call is one tested configuration of the budget.
   */
  const canHold = (set: readonly LayoutLink[], index: number): boolean => {
    if (!set.length) return true;
    tested++;
    const chords = [...set, ...open.slice(index).filter(link => set.every(other => apart.get(pair(link.id, other.id)) === true))];
    for (const link of chords) makeChord(model, link, segments.get(link.id)!);
    const held = set.every(link => fixedPointRefusal(model, link, segments.get(link.id)!) === undefined);
    for (const link of chords) makeFanOrthogonal(model, link);
    return held;
  };
  const length = (set: readonly LayoutLink[]): number => set.reduce((sum, link) => {
    const segment = segments.get(link.id)!;
    return sum + Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  }, 0);
  const setKey = (set: readonly LayoutLink[]): string => set.map(keyOf).sort().join('\u0000');
  let best: LayoutLink[] = [], bestLength = Infinity, bestKey = '';
  const offer = (set: LayoutLink[]): void => {
    const total = length(set), key = setKey(set);
    if (set.length < best.length || (set.length === best.length && (total > bestLength + EPS || (Math.abs(total - bestLength) <= EPS && key >= bestKey)))) return;
    best = [...set]; bestLength = total; bestKey = key;
  };
  // Include before exclude, so the first set reached is a large one; a branch whose chords cannot hold, or that cannot beat the best, is not walked.
  const walk = (index: number, set: LayoutLink[]): void => {
    if (truncated || set.length + (open.length - index) < best.length) return;
    if (tested >= budget) { truncated = true; return; }
    if (!canHold(set, index)) return;
    if (index === open.length) { if (set.length > 0) offer(set); return; }
    const link = open[index]!;
    if (set.every(other => apart.get(pair(link.id, other.id)) === true)) walk(index + 1, [...set, link]);
    walk(index + 1, set);
  };
  // Try the whole set directly: a compatible block costs one check, even above the 512 subset budget.
  const full = open.length === members.length && open.every((link, i) => open.slice(i + 1).every(other => apart.get(pair(link.id, other.id)) === true));
  if (family.kind === 'solid' && full && canHold(open, open.length)) offer(open);
  else walk(0, []);
  return { straight: best, segments, truncated, tested, bodyRefusals };
}

/**
 * What a validator checks on `model.fanAdmissions` (R5): it reads the record and the geometry, and never admits a member again. Absent on a sheet with
 * no fan family, and before the freeze; present after it. One entry per member of every family, in the order of `fanFamilies`. A straight member is a
 * frozen chord, every box it names holds neither of its ends, and its chord as it stands crosses no box it does not name (G2 excuses no other);
 * an orthogonal member is no frozen chord and names its reason.
 */
export function fanAdmissionsFault(model: LayoutModel): string | undefined {
  const blockFault = blockReservationsFault(model);
  if (blockFault !== undefined) return blockFault;
  const record = model.fanAdmissions;
  if (model.fanFamilies === undefined) return record === undefined ? undefined : 'an admission is recorded on a sheet with no fan family';
  if (record === undefined) return model.frozenChords === undefined ? undefined : 'the freeze recorded no admission';
  if (model.frozenChords === undefined) return 'an admission is recorded before the freeze';
  const expected = model.fanFamilies.flatMap(family => family.members.map(member => `${family.id}|${member.link}`));
  if (record.length !== expected.length || record.some((item, index) => `${item.family}|${item.link}` !== expected[index])) return 'the admissions do not list the members of the families in order';
  const frozen = new Set(model.frozenChords);
  for (const item of record) {
    const link = model.links.find(other => other.id === item.link);
    if (link === undefined) return `${item.link} is not a link of the model`;
    if (item.mode === 'straight') {
      if (!frozen.has(item.link)) return `${item.link} is straight and holds no frozen chord`;
      if (item.reason !== undefined) return `${item.link} is straight and names a reason`;
      const crosses = item.crosses ?? [];
      if (crosses.some((id, index) => index > 0 && crosses[index - 1]! >= id)) return `${item.link} names its boxes out of order`;
      const own = crosses.find(id => !foreignBox(model, link, id));
      if (own !== undefined) return `${item.link} names ${own}, which is no foreign box of it`;
      // The chord as it stands crosses no box its record does not name (G2 excuses those only).
      const segment = link.path?.segments.length === 1 ? link.path.segments[0]! : undefined;
      const extra = segment === undefined ? undefined : fanCrossedBoxes(model, link, segment).find(id => !crosses.includes(id));
      if (extra !== undefined) return `${item.link} crosses ${extra}, which its record does not name`;
    } else {
      if (frozen.has(item.link)) return `${item.link} holds a chord its admission refused`;
      if (item.reason === undefined) return `${item.link} is refused with no reason`;
      if (item.crosses !== undefined) return `${item.link} is orthogonal and names boxes`;
    }
  }
  return undefined;
}

/**
 * Before the freeze, the chords a retry of 7f refused (`placementAttempt`: a fan member, or any held chord a group title met on an axis) or a
 * sibling's stem refuses (`refuseStemCrowded`) fall back: they are made orthogonal, and their legs are walls again. Every held chord within the
 * clearance of such a leg takes the fixed point again; the ones that fail fall back together, after all of the round were read (R3: no chord of
 * a round sees a leg of its own round), and their legs are the walls of the next round, until none fails (R2: nothing held stands beside a leg it
 * was not judged against). Bounded: a chord falls back at most once. Returns the reason of every refused chord and of every fan member of the
 * cascade: the given one for a refused chord, the fixed-point refusal for a member of the cascade (so the freeze never records it as `family`,
 * which would say the search left it out). A chord of the cascade that is no fan member is named by the freeze's own checks.
 */
export function refuseChords(draft: LayoutModel, refused: ReadonlyMap<string, FanFallbackReason>): Map<string, FanFallbackReason> {
  const reasons = new Map<string, FanFallbackReason>();
  const walls = draft.links.filter(link => refused.has(link.id) && link.path !== undefined);
  for (const link of walls) { makeFanOrthogonal(draft, link); reasons.set(link.id, refused.get(link.id)!); }
  for (let fresh = walls; fresh.length;) {
    const legs = fresh.flatMap(link => (['from', 'to'] as const).flatMap(end => { const leg = orthogonalLeg(draft, link, end); return leg ? [{ leg, link }] : []; }));
    const failed = draft.links.flatMap(chord => {
      if (!isRoutedChord(draft, chord)) return [];
      const segment = chord.path!.segments[0]!, stroke = linkStrokeWidth(chord);
      const near = legs.some(({ leg, link }) => link.id !== chord.id && segmentDistance(segment, leg) - (stroke + linkStrokeWidth(link)) / 2 < STRAIGHT_PATH_CLEARANCE.path - EPS);
      const refusal = near ? fixedPointRefusal(draft, chord, segment) : undefined;
      return refusal === undefined ? [] : [{ chord, refusal }];
    });
    for (const { chord, refusal } of failed) {
      makeFanOrthogonal(draft, chord);
      if (chord.fanFamily !== undefined) reasons.set(chord.id, refusal);
    }
    fresh = failed.map(item => item.chord);
  }
  return reasons;
}

/**
 * Before the freeze (architecture-2 ticket 40): the held fan members that pass the stem of a sibling fallback (`siblingStemCrowded`) fall back
 * as `stem`, all of those at once, and their legs are walls in turn (`refuseChords`), until none passes a stem. The admission let them cross
 * the legs, since a fallback's side is not final inside the rows fixed point; at the freeze it is. Returns the reason of every member that fell
 * back here. Bounded: each round makes at least one chord fall back.
 */
export function refuseStemCrowded(draft: LayoutModel): Map<string, FanFallbackReason> {
  const reasons = new Map<string, FanFallbackReason>();
  for (;;) {
    const crowded = draft.links.filter(link => link.fanFamily !== undefined && isRoutedChord(draft, link) && siblingStemCrowded(draft, link)).map(link => link.id).sort();
    if (!crowded.length) return reasons;
    for (const [id, reason] of refuseChords(draft, new Map(crowded.map(id => [id, 'stem' as const])))) reasons.set(id, reason);
  }
}

/**
 * Admit every fan family of the draft, in family id order (R3): each family's verdict is drawn before the next family is read, so a later family
 * reads the earlier one's chords as held and its fallbacks' legs as walls. `members` are the draft's member links that are chord candidates.
 * Before the freeze only; a truncated search is named once per family (`FAN_SEARCH_TRUNCATED`). `budget` is the count of tested configurations
 * per family (`FAN_SEARCH_BUDGET`; a test passes a smaller one).
 */
export function admitFanFamilies(draft: LayoutModel, members: readonly LayoutLink[], budget = FAN_SEARCH_BUDGET): void {
  for (const family of draft.fanFamilies ?? []) {
    const own = members.filter(link => link.fanFamily === family.id);
    if (!own.length) continue;
    // A solid block is offered only after settled placement has reserved its gap. Earlier row probes own no decision.
    if (family.kind === 'solid' && !draft.blockReservations?.some(item => item.family === family.id)) {
      for (const link of own) makeFanOrthogonal(draft, link);
      continue;
    }
    const verdict = familyVerdict(draft, family, own, budget);
    if (family.kind === 'solid') {
      const prefix = `${family.id}: `;
      draft.diagnostics = draft.diagnostics.filter(note => note.code !== 'SOLID_BLOCK_ADMISSION' || !note.message.startsWith(prefix));
      draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'SOLID_BLOCK_ADMISSION',
        message: `${prefix}${own.length} members, ${verdict.segments.size} standalone, ${verdict.bodyRefusals} body refusals, ${verdict.segments.size * (verdict.segments.size - 1) / 2} pair checks, ${verdict.tested} sets, ${verdict.straight.length} held${verdict.truncated ? ', truncated' : ''}.`,
        owners: own.map(link => link.owner) });
    }
    for (const link of verdict.straight) makeChord(draft, link, verdict.segments.get(link.id)!);
    if (verdict.truncated && !draft.diagnostics.some(item => item.code === 'FAN_SEARCH_TRUNCATED' && item.owners?.some(owner => owner.kind === 'link' && owner.id === own[0]!.id))) {
      draft.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'FAN_SEARCH_TRUNCATED',
        message: `The member search of the fan family ${family.id} stopped at ${budget} tested configurations; the best set found is kept.`,
        owners: own.map(link => ({ kind: 'link' as const, id: link.id })) });
    }
  }
}
