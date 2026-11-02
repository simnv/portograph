import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { EPS, near } from '../geometry/planar.js';
import { isRoutedChord } from './frame-paths.js';
import { sharedBlockers, overlayBasePath } from './overlay-paths.js';
import { drawn, overlayCrossingPairs, overlayCrossingPoints, portKey, type Drawn } from './read/crossings.js';
import { isOneSegment } from './read/overlay-straight.js';
import { findPort } from './row-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { worseSeparations, type Shortfall } from './constraints/separation.js';

/**
 * One reading of a candidate and one comparison of two readings (architecture ticket 04).
 *
 * Every optional move in placement asks one question: is this candidate better than the model as it stands? The answer used to be
 * spelled out at each of a dozen sites, each with its own order of criteria. Here a `Reading` holds the raw discrete counts a judge
 * can ask for, per link family (routed and overlay), and a `Profile` is a named order over two readings: hard gates first, then the
 * lexicographic keys of one `byKeys` comparator. A profile is of one of two kinds. An `order` profile has only antisymmetric keys and ends in a
 * deterministic key, so it is a total preorder and may sort (`compare`). A `gate` profile has a key that is not antisymmetric (a key that is never
 * negative, or a candidate that has no say): it answers "is `a` better than `b`" or "no worse" through `gains` and `holds`, a candidate against an
 * incumbent, and the type refuses it to `compare`. Each current judge is a
 * profile that gives exactly the verdict the judge gave (the differential test `test/layout/objective-differential.test.ts` records
 * them); the `unified` profile is the order the user approved (2026-10-04); the 7f decisions of `decide.ts` judge by it (architecture ticket 13, phase 4).
 *
 * Counts are exact integers, with no tolerance between two readings: a profile that needs a tolerance names it in the key. A key is
 * `a` against `b` and is negative when `a` is better. `a` is the candidate, `b` the model as it stands.
 */

/** Test only: a sink for every verdict a judge gives, in order. Unset in production; the layout never reads it. */
export const verdictTap: { sink?: (name: string, value: string) => void } = {};

/** Gives a judge's verdict to the test sink, when there is one. `value` is built only then. */
export function tapVerdict(name: string, value: () => string): void {
  if (verdictTap.sink !== undefined) verdictTap.sink(name, value());
}

/** What one link family (routed, or overlay) shows. A judge fills what it reads; a field it does not read is 0 or absent. */
export interface Family {
  /**
   * How many links stand straight, by the predicate of the reader that built the family. It is not one count: overlay `as drawn`, overlay
   * `chord`, routed chords, routed on one axis and the held chords of a fan are different quantities. Read only what the profile of the judge
   * that built the readings reads, and never compare readings that two judges built.
   */
  straight: number;
  /** Which ones. Needed by the keys that ask for a set. */
  straightIds?: ReadonlySet<string>;
  /** How many links have a turn. */
  bent: number;
  /** Which ones. */
  bentIds?: ReadonlySet<string>;
  /** The turns of all the links of the family. */
  turns: number;
  /** The turns of each link, where a judge asks link by link. */
  bends?: ReadonlyMap<string, number>;
}

/** The crossing counters that a `Reading` can hold, named as in `read/crossings.ts`. A count of one mode is no estimate of another's. */
export type CrossingMode = 'pairs' | 'points' | 'links' | 'none';

/** A crossing count that is read once and only when a key asks. `value` is `undefined` until it has been read. */
export interface LazyCount { (): number; value: number | undefined }

export function lazyCount(count: () => number): LazyCount {
  const lazy = (): number => (lazy.value ??= count());
  lazy.value = undefined as number | undefined;
  return lazy;
}

const NONE = lazyCount(() => 0);

/** The minimum-separation shortfalls of a settled model (ticket 17), read once and only when a gate asks: the catalogue is built on the first ask. */
export type LazySeparation = () => ReadonlyMap<string, Shortfall>;
export function lazySeparation(read: () => ReadonlyMap<string, Shortfall>): LazySeparation {
  let value: ReadonlyMap<string, Shortfall> | undefined;
  return () => (value ??= read());
}

export interface Reading {
  overlay: Family;
  routed: Family;
  /** The crossings, read when asked. */
  crossings: LazyCount;
  crossingMode: CrossingMode;
  /** The canvas as published so far. */
  growth: { width: number; height: number };
  /** A candidate whose chords bend one that is straight at the mean (the overlay window). */
  bendsMean?: boolean;
  /** Named finding sets that a gate compares, candidate against incumbent (the lane reseat: centring, link label room). Absent reads as empty. */
  sets?: Readonly<Record<string, ReadonlySet<string>>>;
  /** Named facts of the candidate alone that a gate asks (the lane reseat: the corridors stand at their child, no body on a frozen chord). Absent reads as false. */
  facts?: Readonly<Record<string, boolean>>;
  /** The minimum separations the candidate breaks, by catalogue id, read when a gate asks (`separationHeld`). Absent reads as none. */
  separation?: LazySeparation;
  /** How far the column rules would move a group of the settled model: 0 at their fixed point (ticket 67). Absent reads as 0. */
  drift?: number;
  /** The widest canvas the candidate may have, when it is wider than the incumbent's: the growth bound of the move (ticket 80). Absent reads as no bound. */
  widthCap?: number;
  /** The last key of every order: a candidate's own position (its distance, then its x), compared as numbers in turn. Absent reads as equal. */
  tie?: readonly number[];
}

const EMPTY: Family = { straight: 0, bent: 0, turns: 0 };

/** A reading from the parts that a judge has: the rest stays empty. */
export function reading(parts: Partial<Reading> = {}): Reading {
  return { overlay: EMPTY, routed: EMPTY, crossings: NONE, crossingMode: 'none', growth: { width: 0, height: 0 }, ...parts };
}

/** The family of a set of straight ids and nothing else: the reading of a judge that asks "did a straight link fall". */
export function straightOf(ids: ReadonlySet<string>): Family {
  return { straight: ids.size, straightIds: ids, bent: 0, turns: 0 };
}

// ---- reading a model ------------------------------------------------------------------------------------------------------------

/** The bends of one routed path: each change of direction, and each reversal. Undefined when the route removed the link. */
export function pathBends(link: LayoutLink): number | undefined {
  if (link.removed === true || link.path === undefined) return undefined;
  const path = link.path.segments;
  let turns = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y, bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
    if (!near(ax * by - ay * bx, 0) || ax * bx + ay * by < -EPS) turns++;
  }
  return turns;
}

/** The bends of every link that a routed model keeps, by link id. */
export const routedBends = (model: LayoutModel): Map<string, number> => {
  const bends = new Map<string, number>();
  for (const link of model.links) { const count = pathBends(link); if (count !== undefined) bends.set(link.id, count); }
  return bends;
};

/**
 * Whether the straight overlay links a move began with are no longer all there. `byCount` asks only that their number does not fall (a swap of
 * one for another is no loss: the close-up, the keep-out, the centring step); otherwise each one must still stand (the column pull, whose moves
 * are small). `after` lists the links now straight, `before` the links that were.
 */
export function straightFell(after: readonly { id: string }[], before: readonly { id: string }[], byCount: boolean): boolean {
  const family = (list: readonly { id: string }[]): Family => ({ straight: list.length, straightIds: new Set(list.map(item => item.id)), bent: 0, turns: 0 });
  return !holds(reading({ overlay: family(after) }), reading({ overlay: family(before) }), byCount ? profiles.keepCount : profiles.keepSet);
}

/** The routed family of a bends map (`routedBends`): the links with a turn, and the turns of all. `straight` is the count of held chords the reader gives. */
export function routedFamily(bends: ReadonlyMap<string, number>, straight = 0): Family {
  let bent = 0, turns = 0;
  const bentIds = new Set<string>();
  for (const [id, count] of bends) if (count > 0) { bent++; turns += count; bentIds.add(id); }
  return { straight, bent, bentIds, turns, bends };
}

/** The routed links a placement model states with an attachment: no stub, no removed link. */
export const placedRouted = (model: LayoutModel): LayoutLink[] =>
  model.links.filter(link => link.layer === 'routed' && link.attachments && link.removed !== true && link.technique !== 'stub');

/**
 * What to read of a model. `overlays` are the overlay links to read, drawn by the ordinary overlay rule (never the published one: an
 * opt-in that lets a link pass over a body must not change where placement stands). `routed` asks the bends of every link a routed model
 * keeps (`bends`), and which routed links stand straight: a chord (`chords`), or a chord or a segment on one axis (`aligned`).
 * `crossings` names the mode counted among the overlay paths (`pairs`: the 7f rank move; `points`: the overlay window).
 */
export interface ReadOptions {
  overlays?: readonly LayoutLink[];
  routed?: { bends?: boolean; straight?: 'chords' | 'aligned' };
  crossings?: 'pairs' | 'points';
  growth?: boolean;
}

/** The overlay links the overlay rule draws as chords or bends: attached, and no member of a mesh bus (neither straight nor bent). */
export const drawnOverlays = (model: LayoutModel): LayoutLink[] => model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined && link.attachments);

export function read(model: LayoutModel, options: ReadOptions): Reading {
  const parts: Partial<Reading> = {};
  if (options.overlays !== undefined) {
    const blockers = sharedBlockers(model);
    const paths = options.overlays.map(link => ({ link, segments: overlayBasePath(model, link, blockers).segments }));
    const straightIds = new Set(paths.filter(path => isOneSegment(path.segments)).map(path => path.link.id));
    const bentIds = new Set(paths.filter(path => path.segments.length > 1).map(path => path.link.id));
    parts.overlay = { straight: straightIds.size, straightIds, bent: bentIds.size, bentIds, turns: paths.reduce((sum, path) => sum + path.segments.length - 1, 0) };
    if (options.crossings === 'pairs') {
      parts.crossings = lazyCount(() => overlayCrossingPairs(paths.map(path => path.segments)));
      parts.crossingMode = 'pairs';
    } else if (options.crossings === 'points') {
      parts.crossings = lazyCount(() => overlayCrossingPoints(paths.map(({ link, segments }): Drawn => drawn([segments[0]!.from, ...segments.map(segment => segment.to)],
        [portKey(link.attachments!.from), portKey(link.attachments!.to)]))));
      parts.crossingMode = 'points';
    }
  }
  if (options.routed !== undefined) {
    let routed: Family = EMPTY;
    if (options.routed.bends) {
      routed = routedFamily(routedBends(model));
    }
    if (options.routed.straight !== undefined) {
      const ids = new Set((options.routed.straight === 'chords' ? model.links.filter(link => isRoutedChord(model, link)) : placedRouted(model).filter(link => {
        if (isRoutedChord(model, link)) return true;
        const from = findPort(model, link.attachments!.from)?.anchor, to = findPort(model, link.attachments!.to)?.anchor;
        return from !== undefined && to !== undefined && (Math.abs(from.x - to.x) <= 0.5 || Math.abs(from.y - to.y) <= 0.5);
      })).map(link => link.id));
      routed = { ...routed, straight: ids.size, straightIds: ids };
      // A placed link that is not aligned is bent: the least a placement model can say before the route. An orthogonal link between two facing ports that do not
      // line up needs a Z, two turns; a path read (`bends`) overrides this.
      if (!options.routed.bends && options.routed.straight === 'aligned') {
        const placed = placedRouted(model).filter(link => !ids.has(link.id)).map(link => link.id);
        routed = { ...routed, bent: placed.length, bentIds: new Set(placed), turns: 2 * placed.length };
      }
    }
    parts.routed = routed;
  }
  if (options.growth) parts.growth = { width: model.canvas?.width ?? 0, height: model.canvas?.height ?? 0 };
  return reading(parts);
}

// ---- keys and profiles ----------------------------------------------------------------------------------------------------------

/** `a` against `b`: negative when `a` is better, 0 when the key cannot tell them apart. */
export type Key = (a: Reading, b: Reading) => number;

/** A hard condition on a pair. It answers why the candidate is refused, or `undefined` when it passes. */
export type Gate = (a: Reading, b: Reading) => string | undefined;

const cmp = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);

/** The ids of `of` that `by` does not hold. */
const missing = (of: ReadonlySet<string> | undefined, by: ReadonlySet<string> | undefined): number => {
  let count = 0;
  if (of !== undefined) for (const id of of) if (by?.has(id) !== true) count++;
  return count;
};

const fewerCrossings: Key = (a, b) => {
  if (a.crossingMode !== b.crossingMode) throw new Error(`crossing counts of mode ${a.crossingMode} and ${b.crossingMode} are no pair`);
  return cmp(a.crossings(), b.crossings());
};

/** The keys. Each reads one count of one family, or of both. */
export const keys = {
  /** More links straight. */
  moreStraight: (family: 'overlay' | 'routed'): Key => (a, b) => cmp(b[family].straight, a[family].straight),
  /** Fewer links bent. */
  fewerBent: (family: 'overlay' | 'routed' | 'both'): Key => (a, b) => family === 'both'
    ? cmp(a.overlay.bent + a.routed.bent, b.overlay.bent + b.routed.bent) : cmp(a[family].bent, b[family].bent),
  /** Fewer turns in all. */
  fewerTurns: (family: 'overlay' | 'routed' | 'both'): Key => (a, b) => family === 'both'
    ? cmp(a.overlay.turns + a.routed.turns, b.overlay.turns + b.routed.turns) : cmp(a[family].turns, b[family].turns),
  /** Fewer crossings, in the one mode both readings name. */
  fewerCrossings,
  /** Fewer crossings, but only where the candidate bends no chord that is straight at the mean: a candidate that does gets no say. */
  fewerCrossingsUnlessBendsMean: ((a, b) => (a.bendsMean === true ? 0 : fewerCrossings(a, b))) as Key,
  /** Fewer of the straight links of `b` lost: `b`'s straight set is kept. */
  keepsStraightSet: (family: 'overlay' | 'routed'): Key => (a, b) => missing(b[family].straightIds, a[family].straightIds),
};

/**
 * The comparator of an ordered list of keys: the first key that tells the two apart decides, and the end is a deterministic key (`tie`,
 * number by number, then equal). A list ending this way is a total preorder; two readings with equal `tie` are equal.
 */
export function byKeys(order: readonly Key[], requireTie = false): Key {
  return (a, b) => {
    for (const key of order) {
      const result = key(a, b);
      if (result !== 0) return result;
    }
    if (requireTie && (a.tie === undefined || b.tie === undefined)) throw new Error('this order ends in the position of the candidates: both readings need a `tie`');
    const x = a.tie ?? [], y = b.tie ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const result = cmp(x[i] ?? 0, y[i] ?? 0);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** A named order over two readings: gates, then `order`, then `late` gates (a refusal that the order check shadows keeps its place). */
export interface Profile {
  readonly name: string;
  readonly kind: 'order' | 'gate';
  readonly gates: readonly Gate[];
  readonly order: Key;
  readonly late: readonly Gate[];
}

/** A profile whose keys are all antisymmetric: it may sort. `requireTie` makes a missing `tie` an error and not an accidental equality. */
export interface OrderProfile extends Profile { readonly kind: 'order' }

export function orderProfile(name: string, order: readonly Key[], gates: readonly Gate[] = [], late: readonly Gate[] = [], requireTie = false): OrderProfile {
  return { name, kind: 'order', gates, order: byKeys(order, requireTie), late };
}

/** A profile with a key that is not antisymmetric: for `gains` and `holds` only, never for sorting. */
export function gateProfile(name: string, order: readonly Key[], gates: readonly Gate[] = [], late: readonly Gate[] = []): Profile {
  return { name, kind: 'gate', gates, order: byKeys(order), late };
}

/** `a` against `b` under a profile: negative when `a` is better. The gates are not asked. */
export const compare = (a: Reading, b: Reading, by: OrderProfile): number => by.order(a, b);

/** The first gate that refuses, or `undefined`. */
export function refusal(a: Reading, b: Reading, gates: readonly Gate[]): string | undefined {
  for (const gate of gates) {
    const why = gate(a, b);
    if (why !== undefined) return why;
  }
  return undefined;
}

/** Whether `a` is strictly better than `b` and no gate refuses it. */
export const gains = (a: Reading, b: Reading, by: Profile): boolean => refusal(a, b, by.gates) === undefined && by.order(a, b) < 0 && refusal(a, b, by.late) === undefined;

/** Whether `a` is no worse than `b` and no gate refuses it. */
export const holds = (a: Reading, b: Reading, by: Profile): boolean => refusal(a, b, by.gates) === undefined && by.order(a, b) <= 0 && refusal(a, b, by.late) === undefined;

/** A gate: the turns of a family do not rise. */
export const turnsNotUp = (family: 'overlay' | 'routed'): Gate => (a, b) => (a[family].turns <= b[family].turns ? undefined : `the ${family} turns rise`);

/** A gate: the crossings do not rise (the 7f rank move: a lower rank adds no crossing). */
export const crossingsNotUp: Gate = (a, b) => (fewerCrossings(a, b) <= 0 ? undefined : 'a crossing is added');

/** A gate: every straight routed link of `b` stays straight. */
export const routedSetKept: Gate = (a, b) => (missing(b.routed.straightIds, a.routed.straightIds) === 0 ? undefined : 'a straight routed link is lost');

/** A gate: the candidate names no finding in the set `name` that the incumbent does not. A trade of one item for another is not "no worse". */
export const noNewFindings = (name: string): Gate => (a, b) => {
  const held = b.sets?.[name];
  for (const item of a.sets?.[name] ?? []) if (held?.has(item) !== true) return `${name} names ${item}`;
  return undefined;
};

/**
 * A gate: the candidate breaks no minimum separation that the incumbent held, and none deeper than the incumbent's own (ticket 17). It is the last gate of a
 * profile, so the catalogue is built only for a candidate that every earlier gate and the order let through.
 */
export const separationHeld: Gate = (a, b) => {
  if (a.separation === undefined) return undefined;
  const worse = worseSeparations(a.separation(), b.separation?.() ?? new Map());
  return worse.length === 0 ? undefined : `a minimum separation is broken or deepened (${worse.join(', ')})`;
};

/** A gate: the candidate has the fact `name`. */
export const factHolds = (name: string): Gate => a => (a.facts?.[name] === true ? undefined : `${name} does not hold`);

/** The creep the rounds of 7f end under (`CANTON_CREEP` of the mutation step): a settled model that drifts less than this is at rest. */
export const REST = 0.5;

/** A gate: the candidate drifts no more than the incumbent, or `REST` where the incumbent drifts less (a creep of a fraction of a pixel does not turn the guard off). */
export const driftHeld: Gate = (a, b) => ((a.drift ?? 0) <= Math.max(b.drift ?? 0, REST) + PLACEMENT_EPS ? undefined : 'the column rules would undo the move');

/** A gate: the canvas of the candidate stays within the width bound it names, or the width the incumbent had, the larger. */
export const widthBound: Gate = (a, b) => (a.widthCap === undefined || widthWithin(a, b, a.widthCap) ? undefined : 'the canvas grows past its bound');

/** How many straight links of `b` in `family` `a` does not hold. */
export const lostStraight = (a: Reading, b: Reading, family: 'overlay' | 'routed'): number => missing(b[family].straightIds, a[family].straightIds);

/** Whether the canvas width of `a` stays within `cap` or the width `b` had, the larger. */
export const widthWithin = (a: Reading, b: Reading, cap: number): boolean => a.growth.width <= Math.max(b.growth.width, cap) + PLACEMENT_EPS;

// ---- the profiles of the judges that stand today --------------------------------------------------------------------------------

/**
 * One table, one line per judge (ticket 04, Build): the judge, the profile, and the order it gives.
 *
 * | judge | profile | gates | keys |
 * | --- | --- | --- | --- |
 * | `sheetGains` (overlay-place) | `sheetGains` | overlay turns not up | fewer overlay bent, fewer crossings (points) |
 * | `windowsHold` (overlay-place) | `windowsHold` | | more overlay straight, fewer of the before-set lost, fewer crossings (points); holds |
 * | `pickTarget`, `windowTarget` (overlay-window) | `windowTarget` | | more overlay straight, fewer crossings unless it bends the mean, tie (distance to the mean, x); candidate against incumbent |
 * | `judgeTrial` (side-judge) | `sideTrial` | lane links, total turns, neighbours; late: straight chords of 7e do not fall | fewer routed bent, fewer routed turns |
 * | `fanRoundHolds` (fan-spread) | `fanRound` | | more routed straight (held chords); holds |
 * | `closeUp`, `pullTier` (by count), `settleKeepOut`, `centreGroupStep` | `keepCount` | | more overlay straight; holds |
 * | `pullTier` (by link), the held-column probe | `keepSet` | | fewer of the before-set lost; holds |
 * | the 7f decisions (`decide.ts`: chord-clear cheap and settled, the rank move, the best of the candidates, the linkless step, the lane reseat) | the `judges` table below | the hard limits (the width bound, the column rules, G6 crowded pairs, G5 disordered ports, the tier-gap parts, a body on a frozen chord; for the settled chord and rank moves and the reseat also the link label room; for the reseat also the centring and the corridors at their child; a tier gap the reseat leaves short is the solve's, architecture-2 ticket 57) | `unified` |
 * | the judges table | `unified` | | fewer bent over both layers, fewer turns over both, fewer crossings, tie |
 */
const unifiedOrder = [keys.fewerBent('both'), keys.fewerTurns('both'), keys.fewerCrossings];

export const profiles = {
  sheetGains: orderProfile('sheetGains', [keys.fewerBent('overlay'), keys.fewerCrossings], [turnsNotUp('overlay')]),
  windowsHold: gateProfile('windowsHold', [keys.moreStraight('overlay'), keys.keepsStraightSet('overlay'), keys.fewerCrossings]),
  windowTarget: gateProfile('windowTarget', [keys.moreStraight('overlay'), keys.fewerCrossingsUnlessBendsMean]),
  fanRound: orderProfile('fanRound', [keys.moreStraight('routed')]),
  keepCount: orderProfile('keepCount', [keys.moreStraight('overlay')]),
  keepSet: gateProfile('keepSet', [keys.keepsStraightSet('overlay')]),
  /** A drift check alone: the column rules would not undo the move (the cheap test of a lower rank move). */
  driftHeld: gateProfile('driftHeld', [], [driftHeld]),
  /** The order the user approved on 2026-10-04: fewer bent links over both layers, then fewer turns, then fewer crossings. The 7f decisions judge by it (`judges`). */
  unified: orderProfile('unified', unifiedOrder, [], [], true),
} satisfies Record<string, Profile>;

/**
 * The judge of each kind of 7f choice (architecture ticket 13, phase 4): the unified order of the user (fewer bent links over both layers, fewer turns,
 * fewer crossings, then the position of the candidate) behind the hard limits of the kind. This is the one place that names them. A routed straight link is
 * no gate any more: a net gain may bend one. A crossing added is no veto.
 */
/** The findings a settled chord-clear candidate must not add (G6 crowded pairs, G5 disordered ports, tier-gap parts the plan declines). */
const noNewPlacementFindings = [noNewFindings('crowded'), noNewFindings('disordered'), noNewFindings('residuals')];
/**
 * A settled chord-clear or rank candidate names no link whose label room a replay of the reservation would still grow (architecture-2 ticket 27,
 * as the lane reseat asks). The settle round reserves the room, so the set is empty where growth helps; the gate refuses a move where it does not.
 */
const roomHeld = noNewFindings('room');

export const judges = {
  /** A chord-clear candidate on the geometry after the move, against the geometry before it: fewer bent links over both layers, no new body on a frozen chord. */
  chordCheap: orderProfile('chordCheap', unifiedOrder, [], [noNewFindings('blocked')], true),
  /** The candidates that passed, against the best so far, by the unified order; the nearest of equals stays (its `tie` is its distance, then its dx). */
  chordBest: orderProfile('chordBest', unifiedOrder, [], [], true),
  /** Of the lower rank moves that passed, the one that stays (ticket 146). */
  rankMove: orderProfile('rankMove', unifiedOrder, [], [], true),
  /** The column rules (ticket 67) do not undo a lower rank move: the cheap test before a settled copy is paid for. */
  driftHeld: profiles.driftHeld,
  /** A chord-clear candidate on its settled copy, against the settled copy without it: the order gains, and the column rules, the width bound, the findings and the link label room hold. */
  chordSettled: orderProfile('chordSettled', unifiedOrder, [], [driftHeld, widthBound, ...noNewPlacementFindings, roomHeld, separationHeld], true),
  /** The same for a lower rank cell. */
  rankSettled: orderProfile('rankSettled', unifiedOrder, [], [driftHeld, widthBound, ...noNewPlacementFindings, roomHeld, separationHeld], true),
  /** A group with no link steps out of a chord: the picture is no worse by the order, and G6 and G5 name nothing new. */
  linkless: orderProfile('linkless', unifiedOrder, [], [noNewFindings('crowded'), noNewFindings('disordered'), separationHeld], true),
  /** The lane reseat on its settled copy, against the incumbent with its lanes held. */
  laneReseat: orderProfile('laneReseat', unifiedOrder, [], [noNewFindings('centring'), noNewFindings('room'), noNewFindings('crowded'), noNewFindings('disordered'), factHolds('lanesHold'), factHolds('chordsClear'), separationHeld], true),
} satisfies Record<string, Profile>;

/**
 * The profile of the side round's verdict (side-faces.md, Section 19.4). The hinted links, the removed links and the hints that face away stay
 * with the judge: they name links of the offer. What is here is the order (fewer bent links, then fewer bends in all) and the lane clause
 * (ticket 119): each lane link's own bends fall, the total does not rise, no link without a hint gets worse. `a` is the routed trial and `b`
 * the routed baseline; `routed.straight` of each is the chord count of its 7e model.
 */
export function sideTrialProfile(hinted: ReadonlySet<string>, lanes: readonly string[]): OrderProfile {
  const laneGates: Gate[] = lanes.length === 0 ? [] : [
    (a, b) => {
      const notFewer = lanes.filter(id => !(a.routed.bends!.has(id) && b.routed.bends!.has(id) && a.routed.bends!.get(id)! < b.routed.bends!.get(id)!));
      return notFewer.length > 0 ? `a lane link has no fewer bends than on the baseline (${notFewer.join(', ')})` : undefined;
    },
    (a, b) => (a.routed.turns > b.routed.turns ? `the trial with a lane raises the total bends (${a.routed.turns} against ${b.routed.turns})` : undefined),
    (a, b) => {
      const neighbours = [...a.routed.bends!].filter(([id, count]) => !hinted.has(id) && count > (b.routed.bends!.get(id) ?? count)).map(([id]) => id);
      return neighbours.length > 0 ? `the trial with a lane makes a neighbour worse (${neighbours.join(', ')})` : undefined;
    },
  ];
  return orderProfile('sideTrial', [keys.fewerBent('routed'), keys.fewerTurns('routed')], laneGates,
    [(a, b) => (a.routed.straight < b.routed.straight ? 'the trial loses a straight chord' : undefined)]);
}
