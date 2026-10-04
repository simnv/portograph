import type { LayoutLink, LayoutModel } from '../model/layout.js';
import { EPS, near } from '../geometry/planar.js';
import { isRoutedChord } from './frame-paths.js';
import { overlayBlockers, overlayPath } from './overlay-paths.js';
import { drawn, overlayCrossingPairs, overlayCrossingPoints, portKey, type Drawn } from './read/crossings.js';
import { isOneSegment } from './read/overlay-straight.js';
import { findPort } from './row-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';

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
 * them); the `unified` profile is the order the user approved (2026-10-04) and nothing calls it yet.
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
    const blockers = overlayBlockers(model);
    const paths = options.overlays.map(link => ({ link, segments: overlayPath(model, link, blockers).segments }));
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
 * | `pickRankMove` (chord-clear) | `rankMove` | crossings not up, straight above base | more overlay straight, fewer overlay bent, fewer crossings (pairs), tie (|dx|, dx) |
 * | `pickTarget`, `windowTarget` (overlay-window) | `windowTarget` | | more overlay straight, fewer crossings unless it bends the mean, tie (distance to the mean, x); candidate against incumbent |
 * | `holdsSettled`, `attempt` (chord-clear) | `settled`, `settledRanked` | routed straight set kept, (ranked) crossings not up | more overlay straight |
 * | `judgeTrial` (side-judge) | `sideTrial` | lane links, total turns, neighbours; late: straight chords of 7e do not fall | fewer routed bent, fewer routed turns |
 * | `fanRoundHolds` (fan-spread) | `fanRound` | | more routed straight (held chords); holds |
 * | `closeUp`, `pullTier` (by count), `settleKeepOut`, `centreGroupStep` | `keepCount` | | more overlay straight; holds |
 * | `pullTier` (by link), the held-column probe, `stepOutOfChords` | `keepSet` | | fewer of the before-set lost; holds |
 * | none yet | `unified` | | fewer bent over both layers, fewer turns over both, fewer crossings, tie |
 */
export const profiles = {
  sheetGains: orderProfile('sheetGains', [keys.fewerBent('overlay'), keys.fewerCrossings], [turnsNotUp('overlay')]),
  windowsHold: gateProfile('windowsHold', [keys.moreStraight('overlay'), keys.keepsStraightSet('overlay'), keys.fewerCrossings]),
  rankMove: orderProfile('rankMove', [keys.moreStraight('overlay'), keys.fewerBent('overlay'), keys.fewerCrossings], [crossingsNotUp, (a, b) => (a.overlay.straight > b.overlay.straight ? undefined : 'no straight link gained')]),
  windowTarget: gateProfile('windowTarget', [keys.moreStraight('overlay'), keys.fewerCrossingsUnlessBendsMean]),
  // The count first, and the crossings only where the count rises: the crossings are read once and only when asked.
  settled: orderProfile('settled', [keys.moreStraight('overlay')], [], [routedSetKept]),
  settledRanked: orderProfile('settledRanked', [keys.moreStraight('overlay')], [], [crossingsNotUp, routedSetKept]),
  cheapCrossings: orderProfile('cheapCrossings', [keys.fewerCrossings]),
  fanRound: orderProfile('fanRound', [keys.moreStraight('routed')]),
  keepCount: orderProfile('keepCount', [keys.moreStraight('overlay')]),
  keepSet: gateProfile('keepSet', [keys.keepsStraightSet('overlay')]),
  /** The order the user approved on 2026-10-04: fewer bent links over both layers, then fewer turns, then fewer crossings. Not switched on anywhere. */
  unified: orderProfile('unified', [keys.fewerBent('both'), keys.fewerTurns('both'), keys.fewerCrossings], [], [], true),
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
