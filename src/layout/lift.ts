/**
 * Group lift (D-Q5, ticket 08): a float component rises as a whole into the empty canvas of the bands above it, and stands beside the units of
 * the bands it shares, inside the span of the wide block below when it fits there (ADR-0008 amendment).
 *
 * A unit is a top-level frame with its child frames, or a plain tier group with its children. A float component is the set of units a seed
 * reaches over links of either layer to units of its own or a lower document tier (the closure): by construction it has no link to a lower
 * document tier outside it. Links from above are allowed. A routed feed from above bounds the rise at its feeder node: the fed node rises
 * until it stands in its feeder's band and never above it, and the feed then enters the fed node's side (a level side entry, one horizontal
 * segment). A stub, a bundle member or a mesh-bus feed cannot turn to a lateral face, so it keeps the component below its feeder's unit.
 * When a level side entry leaves part of the component below its feeder's band, every unit below that band moves down (`GroupLift.push`).
 *
 * Decided at placement (the load-bearing rule): the command runs once with no lift, the components are measured on its published model
 * (`measureLifts`, a band estimate), and each candidate runs the whole command again with the record as stage-1 band input (`applyLifts`);
 * the judge (`judgeLift`) keeps it on the published result. Stored as `groupLifts` (absent = nothing to decide: no float component in the
 * first slice; `[]` = decided, none). The document tier is never rewritten, only the band (`LayoutGroup.tier`) of a member group.
 * `validateGroupLifts` checks the record at every publication and at restore (R1, R5).
 */
import type { LayoutModel, GroupLift, LayoutGroup, Frame } from '../model/layout.js';
import type { Rect } from '../model/geometry.js';
import type { PortRef } from '../model/document.js';
import { portKey } from './sides-one.js';
import { linkLayer } from './link-layer.js';
import { compareId, bandGap } from './skeleton-graph.js';
import { PlacementRefusal } from './placement-refusal.js';
import { GROUP_PADDING } from './group-padding.js';
import { hintRefusal } from './side-hints.js';
import { NO_MOVE_EPS, SIGN_EPS } from './tolerance.js';

/**
 * At most this many lift trials per sheet (R4): each is one more whole command run, under its own placement cap and the caller's one budget.
 * A component past it is recorded as capped (`GROUP_LIFT_CAPPED`). The S8 fallback of a declined side entry counts as a trial.
 */
export const LIFT_TRIALS = 2;
/** The least drop of the area estimate (a fraction) that earns a component a trial; a smaller predicted gain is declined without a placement run. */
export const LIFT_MIN_GAIN = 0.01;
/**
 * The area tolerance T of the judge (D-Q5 after lift-v3). A lift set may publish up to this fraction more canvas area than the smallest-area
 * set kept when its canvas is narrower (`LIFT_NARROWER_PX`) or nearer square (`aspectGap`); the area stays below the no-lift run. 5 % is the
 * smallest tested value that keeps the user's key-sheet ruling (`a-chain-of-tiers-packs-over-its-feeds-final-x` costs +4.07 %); on the corpus
 * no sheet separates 5 % from 10 % (lift-v3 PoC, T table), so T rests on that one sheet.
 */
export const LIFT_AREA_TOLERANCE = 0.05;
/** The least drop of the canvas width, in px, that counts as narrower for the tolerated area rule of the judge. */
export const LIFT_NARROWER_PX = 1;
/**
 * Shape admission (S12): the least estimated narrowing (a fraction of the width) or drop of the aspect gap that earns a rise with no estimated
 * area gain a trial. The estimate is too coarse for a push (on `a-lifted-group-takes-its-feed-on-its-side` it gives +9 % where the published
 * run gives -38 %), so the published run judges it.
 */
export const LIFT_SHAPE_STEP = 0.05;
/** The ADR-0024 aspect gap of a canvas: |ln(W/H)|, 0 for a square (the amendment's "nearer square"). */
export const aspectGap = (width: number, height: number): number => width > 0 && height > 0 ? Math.abs(Math.log(width / height)) : Infinity;

export interface LiftUnit { id: string; groups: string[]; tier: number; scope?: string }

/** The document tier of a layout group: its document entry's `documentTier`, else its `tier`, else its parent's. */
function documentTierOf(model: LayoutModel, id: string): number | undefined {
  const source = model.document.groups[id];
  if (source === undefined) return undefined;
  if (source.documentTier !== undefined) return source.documentTier;
  if (source.tier !== undefined) return source.tier;
  return source.parent !== undefined ? documentTierOf(model, source.parent) : undefined;
}

/** The units of a resolved model and the unit of each layout group. */
export function liftUnits(model: LayoutModel): { units: Map<string, LiftUnit>; unitOf: Map<string, string> } {
  const frames = model.document.frames ?? {};
  const units = new Map<string, LiftUnit>(), unitOf = new Map<string, string>();
  for (const group of Object.values(model.groups).sort((a, b) => compareId(a.id, b.id))) {
    const source = model.document.groups[group.id];
    let id = group.id, scope: string | undefined;
    if (group.flank !== undefined) scope = 'a flank';
    else if (source?.frame !== undefined) {
      let frame = source.frame;
      for (let parent = frames[frame]?.parent; parent !== undefined && frames[parent]?.kind !== 'canton'; parent = frames[frame]?.parent) frame = parent;
      if (frames[frame]?.parent !== undefined) scope = 'a canton member';
      id = frame;
    } else if (source?.parent !== undefined) id = source.parent;
    if (source?.shape === 'bar') scope = 'a bar';
    const tier = documentTierOf(model, group.id) ?? group.tier ?? 0;
    const unit = units.get(id) ?? { id, groups: [], tier };
    unit.groups.push(group.id);
    unit.tier = Math.min(unit.tier, tier);
    if (scope !== undefined && unit.scope === undefined) unit.scope = scope;
    units.set(id, unit);
    unitOf.set(group.id, id);
  }
  // A unit that a flank stands beside moves with the flank: out of the first slice.
  for (const group of Object.values(model.groups)) {
    if (group.flank === undefined) continue;
    const owner = units.get(unitOf.get(group.flank.of) ?? '');
    if (owner !== undefined && owner.scope === undefined) owner.scope = 'beside a flank';
  }
  return { units, unitOf };
}

interface UnitLink { id: string; a: string; b: string; routed: boolean }

/** The links of either layer between two different units. */
function unitLinks(model: LayoutModel, unitOf: ReadonlyMap<string, string>): UnitLink[] {
  const out: UnitLink[] = [];
  for (const link of model.links) {
    const from = link.attachments?.from.node ?? (link.from as { node?: string }).node, to = link.attachments?.to.node ?? (link.to as { node?: string }).node;
    if (from === undefined || to === undefined) continue;
    const a = unitOf.get(model.document.nodes[from]?.group ?? ''), b = unitOf.get(model.document.nodes[to]?.group ?? '');
    if (a === undefined || b === undefined || a === b) continue;
    out.push({ id: link.id, a, b, routed: linkLayer(link) === 'routed' });
  }
  return out;
}

export interface FloatComponent { units: string[]; groups: string[]; scope?: string }

/**
 * The closure of `seed`: every unit reached over a link of either layer to a unit of the same or a lower document tier. It has no
 * such link to a unit outside it.
 */
function closure(seed: string, units: ReadonlyMap<string, LiftUnit>, links: readonly UnitLink[]): Set<string> {
  const set = new Set([seed]);
  for (let grown = true; grown;) {
    grown = false;
    for (const link of links) for (const [x, y] of [[link.a, link.b], [link.b, link.a]] as const) {
      if (set.has(x) && !set.has(y) && units.get(y)!.tier >= units.get(x)!.tier) { set.add(y); grown = true; }
    }
  }
  return set;
}

/** A link of either layer from `members` (units) to a unit outside it at the same or a lower document tier, or undefined. */
export function linkBelow(model: LayoutModel, members: ReadonlySet<string>): string | undefined {
  const { units, unitOf } = liftUnits(model);
  for (const link of unitLinks(model, unitOf)) for (const [x, y] of [[link.a, link.b], [link.b, link.a]] as const) {
    if (members.has(x) && !members.has(y) && units.get(y)!.tier >= units.get(x)!.tier) return link.id;
  }
  return undefined;
}

/** The band list: the distinct bands (sub-tiers) of the non-flank groups, top to bottom. */
export function bandList(model: LayoutModel): number[] {
  return [...new Set(Object.values(model.groups).filter(group => !group.flank && group.tier !== undefined).map(group => group.tier!))].sort((a, b) => a - b);
}

/** The two end nodes of a link: its attachments once stage 2 ran, else its document ends. */
function linkEnds(link: LayoutModel['links'][number]): (string | undefined)[] {
  return [link.attachments?.from.node ?? (link.from as { node?: string }).node, link.attachments?.to.node ?? (link.to as { node?: string }).node];
}

/**
 * The float components that may rise at least one whole band: the closures of every unit, merged where they overlap, without the ones
 * inside another; a component with no band to rise is not one (a routed feeder directly above it, or band 0). `bound` is the most
 * bands the component may rise: to band 0, and for each routed feed from above until the fed node stands in its feeder node's band (a level
 * side entry); a stub, bundle member or mesh-bus feed keeps the fed unit below every band of its feeder's unit. `plainBound` keeps every
 * fed unit below its feeder's unit (no side entry).
 */
export function floatComponents(model: LayoutModel): (FloatComponent & { bound: number; plainBound: number })[] {
  const { units, unitOf } = liftUnits(model);
  const links = unitLinks(model, unitOf), routedAll = links.filter(link => link.routed);
  const bands = bandList(model), index = new Map(bands.map((band, i) => [band, i]));
  const bandOf = (id: string): number => index.get(model.groups[id]!.tier!) ?? 0;
  const byId = new Map(model.links.map(link => [link.id, link]));
  const plainBands = (unit: string): number[] => units.get(unit)!.groups.filter(id => !model.groups[id]!.flank).map(bandOf);
  const boundOf = (set: ReadonlySet<string>, side: boolean): number => {
    const groups = [...set].flatMap(id => units.get(id)!.groups);
    let bound = Math.min(...groups.map(bandOf));
    for (const link of routedAll) for (const [x, y] of [[link.a, link.b], [link.b, link.a]] as const) {
      if (!set.has(x) || set.has(y) || units.get(y)!.tier >= units.get(x)!.tier) continue;
      const item = byId.get(link.id)!, plain = item.technique === 'stub' || item.bundle !== undefined || item.meshBus !== undefined;
      if (side && !plain) {
        const nodeGroups = linkEnds(item).map(node => model.document.nodes[node ?? '']?.group ?? '');
        const fedGroup = nodeGroups.find(id => unitOf.get(id) === x), feederGroup = nodeGroups.find(id => unitOf.get(id) === y);
        if (fedGroup !== undefined && feederGroup !== undefined) { bound = Math.min(bound, bandOf(fedGroup) - bandOf(feederGroup)); continue; }
      }
      bound = Math.min(bound, Math.min(...plainBands(x)) - Math.max(...plainBands(y)) - 1);
    }
    return bound;
  };
  const all = new Set(units.keys());
  let found: Set<string>[] = [];
  for (const id of [...units.keys()].sort(compareId)) {
    const set = closure(id, units, links);
    if (set.size === all.size || boundOf(set, false) < 1) continue;
    found.push(set);
  }
  // Overlapping closures are one component.
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
      if ([...found[j]!].some(id => found[i]!.has(id))) { found[i] = new Set([...found[i]!, ...found[j]!]); found.splice(j, 1); merged = true; break outer; }
    }
  }
  found = found.filter(set => set.size < all.size);
  // A closure that can rise only through a side entry (plain bound 0, side-entry bound 1 or more) is a component of its own when it holds no
  // smaller such closure and meets no component found above; it is not merged with the closures it overlaps (choice S2).
  const extra = [...units.keys()].sort(compareId).map(id => closure(id, units, links))
    .filter(set => set.size < all.size && boundOf(set, false) < 1 && boundOf(set, true) >= 1 && !found.some(other => [...set].some(id => other.has(id))));
  const minimal = extra.filter(set => !extra.some(other => other !== set && other.size < set.size && [...other].every(id => set.has(id))));
  for (const set of minimal) if (!found.some(other => [...set].some(id => other.has(id)))) found.push(set);
  return found.map(set => {
    const ids = [...set].sort(compareId), scope = ids.map(id => units.get(id)!.scope).find(item => item !== undefined);
    return { units: ids, groups: ids.flatMap(id => units.get(id)!.groups).sort(compareId), ...(scope !== undefined ? { scope } : {}), bound: boundOf(set, true), plainBound: boundOf(set, false) };
  }).filter(item => item.bound >= 1).sort((a, b) => compareId(a.units[0]!, b.units[0]!));
}

/** One box a unit occupies, and the bands it spans (indices into the band list). */
interface Part { unit: string; box: Rect; low: number; high: number }

/** The boxes of every unit: a top-level frame's box, a plain group's box (with its children). Read on a placed model. */
function parts(model: LayoutModel): Part[] {
  const { units } = liftUnits(model);
  const bands = bandList(model), index = new Map(bands.map((band, i) => [band, i]));
  const frames = new Map((model.frames ?? []).map(frame => [frame.id, frame]));
  const out: Part[] = [];
  for (const unit of units.values()) {
    const groups = unit.groups.map(id => model.groups[id]!).filter(group => group.bounds !== undefined && group.tier !== undefined && !group.flank);
    if (!groups.length) continue;
    const at = groups.map(group => index.get(group.tier!) ?? 0), frame = frames.get(unit.id);
    const box = frame?.box ?? union(groups.map(group => group.bounds!));
    out.push({ unit: unit.id, box, low: Math.min(...at), high: Math.max(...at) });
  }
  return out;
}
const union = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
};

/**
 * The stage-4 area estimate on placed boxes: each band is as wide as the units that stand in it, side by side a band gap apart; the canvas
 * is the widest band times the stacked band heights. `shift` moves the units of a component up by that many bands.
 */
export function areaEstimate(model: LayoutModel, members: ReadonlySet<string> = new Set(), shift = 0, push?: { at: number; by: number }): number {
  return estimateShape(model, members, shift, push).area;
}

/**
 * The estimate with its width and height. `push` (band indices, not values) moves every unit outside `members` whose top band is
 * below band index `at` down `by` bands.
 */
export function estimateShape(model: LayoutModel, members: ReadonlySet<string> = new Set(), shift = 0, push?: { at: number; by: number }, without = false): { area: number; width: number; height: number } {
  const gap = bandGap(model), bands = bandList(model), { unitOf } = liftUnits(model);
  // `without`: the canvas with the members left out (the empty space the component may stand in).
  const all = parts(model).filter(part => !without || !members.has(part.unit));
  const count = bands.length + (push?.by ?? 0);
  const lowOf = new Map(all.map(part => [part.unit, part.low]));
  const move = (unit: string): number => members.has(unit) ? -shift : push !== undefined && (lowOf.get(unit) ?? -1) > push.at ? push.by : 0;
  const widths = new Array<number>(count).fill(0), counts = new Array<number>(count).fill(0), heights = new Array<number>(count).fill(0);
  for (const part of all) {
    const k = move(part.unit);
    for (let band = part.low + k; band <= part.high + k; band++) { widths[band]! += part.box.width; counts[band]! += 1; }
  }
  for (const group of Object.values(model.groups)) {
    if (group.flank || group.bounds === undefined || group.tier === undefined || (without && members.has(unitOf.get(group.id)!))) continue;
    const band = bands.indexOf(group.tier) + move(unitOf.get(group.id)!);
    heights[band] = Math.max(heights[band]!, group.bounds.height + (group.frame !== undefined ? 2 * GROUP_PADDING : 0));
  }
  const width = Math.max(...widths.map((w, i) => w + gap * Math.max(0, counts[i]! - 1)));
  const height = heights.filter(h => h > 0).reduce((sum, h) => sum + h + gap, -gap);
  return { area: width * height, width, height };
}

/**
 * The push of a rise of `offset` bands, in band values (`GroupLift.push`) and in band indices (the estimate). The feeders of the side
 * entries the rise makes stand in band `at` (the lowest of them); the component's bands below it are `by` bands; every unit outside the
 * component whose top band is below `at` moves down `by` bands. Undefined when the rise makes no side entry, when the component does not hang
 * below `at`, or when no unit stands below `at`.
 */
export function liftPush(model: LayoutModel, unitSet: ReadonlySet<string>, offset: number): { value: { at: number; by: number }; index: { at: number; by: number } } | undefined {
  if (offset < 1) return undefined;
  const bands = bandList(model), index = new Map(bands.map((band, i) => [band, i]));
  const { units } = liftUnits(model);
  const members = [...unitSet].flatMap(id => units.get(id)!.groups).filter(id => !model.groups[id]!.flank);
  const to = new Map(members.map(id => [id, bands[index.get(model.groups[id]!.tier!)! - offset]!]));
  const entries = sideEntries(model, unitSet, to);
  if (!entries.length) return undefined;
  const feederBands = entries.flatMap(id => {
    const link = model.links.find(item => item.id === id)!;
    return linkEnds(link).map(node => model.document.nodes[node ?? '']?.group).filter((group): group is string => group !== undefined && !members.includes(group))
      .map(group => model.groups[group]!.tier!);
  });
  const at = Math.max(...feederBands), low = Math.max(...to.values());
  if (!(low > at)) return undefined;
  const below = parts(model).some(part => !unitSet.has(part.unit) && part.low > index.get(at)!);
  if (!below) return undefined;
  return { value: { at, by: low - at }, index: { at: index.get(at)!, by: index.get(low)! - index.get(at)! } };
}

export interface LiftCandidate {
  component: FloatComponent & { bound: number; plainBound: number }; offset: number; before: number; after: number; reason?: string;
  /** Choice S8: the best rise that keeps every feeder above its fed unit (the plain bound), tried once when the side-entry rise is declined. */
  fallback?: number;
  /** The push of the rise `offset` (band values), when the estimate chose it. */
  push?: { at: number; by: number };
}

/**
 * The candidates of a placed model (the end of the first run, after 7f): for each float component, the rise in whole bands with the least
 * area estimate (the highest on a tie), or the reason it does not rise. `decided` names the units already decided.
 */
export function measureLifts(model: LayoutModel, decided: ReadonlySet<string> = new Set()): LiftCandidate[] {
  const shape = estimateShape(model), before = shape.area;
  const out: LiftCandidate[] = [];
  for (const component of floatComponents(model)) {
    if (component.units.some(id => decided.has(id))) continue;
    if (component.scope !== undefined) { out.push({ component, offset: 0, before, after: before, reason: `out of the first slice: it holds ${component.scope}` }); continue; }
    const members = new Set(component.units);
    let best = 0, after = before, push: { at: number; by: number } | undefined;
    // A rise that makes a level side entry over units below takes the push when the component does not fit in the empty space beside
    // them: the rise as it is makes the canvas wider than it is with no component at all ("push what is below down"). The estimate does not
    // judge a push or a tolerated rise; the published runs do (`judgeLift` with the tolerance). A rise that gains no estimated area is still
    // tried when its estimate is narrower or nearer square by a clear step (`LIFT_SHAPE_STEP`), whatever the tolerance (the estimate is too
    // coarse for a push: on the fixture it gives +9 % where the published run gives -38 %); a rise that gains
    // area wins over one that is only tolerated.
    const bare = estimateShape(model, members, 0, undefined, true);
    let tolerated: { k: number; area: number; push?: { at: number; by: number } } | undefined;
    for (let k = component.bound; k >= 1; k--) {
      const pushed = liftPush(model, members, k);
      const plain = estimateShape(model, members, k);
      const variant = pushed !== undefined && plain.width > bare.width + 1 ? pushed : undefined;
      const est = variant !== undefined ? estimateShape(model, members, k, variant.index) : plain;
      if (est.area < after - SIGN_EPS && est.area <= before * (1 - LIFT_MIN_GAIN)) { after = est.area; best = k; push = variant?.value; continue; }
      const shaped = est.width < shape.width * (1 - LIFT_SHAPE_STEP) || aspectGap(est.width, est.height) < aspectGap(shape.width, shape.height) - LIFT_SHAPE_STEP;
      if (shaped && (tolerated === undefined || est.area < tolerated.area - SIGN_EPS)) tolerated = { k, area: est.area, ...(variant ? { push: variant.value } : {}) };
    }
    if (best === 0 && tolerated !== undefined) { best = tolerated.k; after = tolerated.area; push = tolerated.push; }
    // When the best rise needs a side entry, the best rise within the plain bound is the fallback.
    let fallback = 0, fallbackArea = before;
    if (best > component.plainBound) for (let k = component.plainBound; k >= 1; k--) {
      const area = areaEstimate(model, members, k);
      if (area < fallbackArea - SIGN_EPS && area <= before * (1 - LIFT_MIN_GAIN)) { fallbackArea = area; fallback = k; }
    }
    out.push({ component, offset: best, before, after, ...(push !== undefined ? { push } : {}), ...(fallback > 0 ? { fallback } : {}), ...(best === 0 ? { reason: `the band estimate gives no area drop of ${LIFT_MIN_GAIN * 100} % or more at any rise` } : {}) });
  }
  return out.sort((a, b) => (b.before - b.after) - (a.before - a.after) || compareId(a.component.units[0]!, b.component.units[0]!));
}

/** The record entry of a candidate before its trial; `straight` and `reason` are set by the judge. */
export function liftEntry(model: LayoutModel, candidate: LiftCandidate, offset: number, reason: string, straight: string[] = [],
  push: { at: number; by: number } | undefined = offset > 0 && offset === candidate.offset ? candidate.push : undefined): GroupLift {
  const bands = bandList(model), index = new Map(bands.map((band, i) => [band, i]));
  const members = candidate.component.groups;
  // The side: where the component stands against the units of the bands it rises into, as the measured model has them (lift v3: after the
  // push, so a unit that moves down below the component does not set the side).
  const all = parts(model), unitSet = new Set(candidate.component.units), mine = all.filter(part => unitSet.has(part.unit));
  const low = Math.min(...mine.map(part => part.low)) - offset, high = Math.max(...mine.map(part => part.high)) - offset;
  // A unit the push moves down stands below the component after the rise: it shares none of its bands.
  const pushAt = push !== undefined ? index.get(push.at)! : Infinity;
  const shifted = (part: Part): Part => part.low > pushAt ? { ...part, low: Infinity, high: Infinity } : part;
  const others = all.filter(part => !unitSet.has(part.unit)).map(shifted).filter(part => part.low <= high && low <= part.high);
  const centre = (list: Part[]): number => { const box = union(list.map(part => part.box)); return box.x + box.width / 2; };
  const side: 'left' | 'right' = mine.length && others.length && centre(mine) > centre(others) ? 'right' : 'left';
  const to = members.map(id => offset === 0 ? model.groups[id]!.tier! : bands[index.get(model.groups[id]!.tier!)! - offset]!);
  const sideEntry = offset === 0 ? [] : sideEntries(model, new Set(candidate.component.units), new Map(members.map((id, i) => [id, to[i]!])));
  return {
    units: [...candidate.component.units], members: [...members],
    tiers: members.map(id => documentTierOf(model, id) ?? model.groups[id]!.tier!),
    from: members.map(id => model.groups[id]!.tier!),
    to,
    offset, side, straight, reason,
    ...(sideEntry.length ? { sideEntry } : {}),
    ...(push !== undefined && offset > 0 ? { push: { ...push } } : {}),
  };
}

/**
 * The routed feeds into a component from a unit of a higher document tier whose fed node stands, with the bands `to` (member group to band),
 * not below its feeder node's band: the feeds the rise turns into side entries (lift v2). Sorted ids.
 */
export function sideEntries(model: LayoutModel, unitSet: ReadonlySet<string>, to: ReadonlyMap<string, number>): string[] {
  const { units, unitOf } = liftUnits(model);
  const out: string[] = [];
  for (const link of model.links) {
    if (linkLayer(link) !== 'routed' || link.technique === 'stub') continue;
    const from = link.attachments?.from.node ?? (link.from as { node?: string }).node, target = link.attachments?.to.node ?? (link.to as { node?: string }).node;
    if (from === undefined || target === undefined) continue;
    const ga = model.document.nodes[from]?.group, gb = model.document.nodes[target]?.group;
    if (ga === undefined || gb === undefined) continue;
    for (const [fed, feeder] of [[gb, ga], [ga, gb]] as const) {
      const fu = unitOf.get(fed), su = unitOf.get(feeder);
      if (fu === undefined || su === undefined || !unitSet.has(fu) || unitSet.has(su) || !(units.get(su)!.tier < units.get(fu)!.tier)) continue;
      const fedBand = to.get(fed) ?? model.groups[fed]?.tier, feederBand = model.groups[feeder]?.tier;
      if (fedBand !== undefined && feederBand !== undefined && fedBand <= feederBand) out.push(link.id);
    }
  }
  return [...new Set(out)].sort(compareId);
}

/** The ports of the side entries of the lifted entries, by `portKey`, with the lateral face each takes (lift v2): the feeder's end faces the component. */
export function liftFaces(model: LayoutModel): Map<string, 'left' | 'right'> {
  const out = new Map<string, 'left' | 'right'>();
  for (const lift of model.groupLifts ?? []) {
    if (lift.offset === 0 || !lift.sideEntry?.length) continue;
    const members = new Set(lift.members);
    for (const id of lift.sideEntry) {
      const link = model.links.find(item => item.id === id);
      const ends = link?.attachments ?? (link !== undefined && 'ordinal' in link.from && 'ordinal' in link.to ? { from: link.from as PortRef, to: link.to as PortRef } : undefined);
      if (ends === undefined) continue;
      // A port shared by several links (a fan) keeps the stage-2 rule: one face cannot be lateral for one of its links alone.
      const shared = (ref: PortRef): boolean => model.links.filter(item => [item.attachments?.from ?? item.from, item.attachments?.to ?? item.to]
        .some(end => 'ordinal' in end && portKey(end as PortRef) === portKey(ref))).length > 1;
      for (const own of [ends.from, ends.to]) {
        if (shared(own)) continue;
        // A bundle member or a mesh-bus port keeps its stage-2 face; its bundle owns the face.
        const why = hintRefusal(model, own as PortRef);
        if (why === 'the port belongs to a bundle' || why === 'the port is on a mesh bus') continue;
        const fed = members.has(model.document.nodes[own.node]?.group ?? '');
        out.set(portKey(own), fed ? (lift.side === 'right' ? 'left' : 'right') : lift.side);
      }
    }
  }
  return out;
}

/** Whether `id` is a side entry of a lifted entry of the model's record (lift v2). */
export function isSideEntry(model: LayoutModel, id: string): boolean {
  return (model.groupLifts ?? []).some(lift => lift.offset > 0 && (lift.sideEntry ?? []).includes(id));
}

/**
 * Stage 1: the band input of the lifts on a resolved model. Each lifted member stands in its `to` band; the document is not changed. A record
 * whose `from` is not the band the document gives, or whose `to` is not `offset` whole bands up, is refused (R5).
 */
export function applyLifts(model: LayoutModel, lifts: readonly GroupLift[]): void {
  // In record order: an entry was measured on the model with the entries before it applied, so its bands are read on that model.
  for (const lift of lifts) {
    // A declined entry moves no band; `validateGroupLifts` checks that its members stand in their `from` bands.
    if (lift.offset === 0) continue;
    const bands = bandList(model), index = new Map(bands.map((band, i) => [band, i]));
    lift.members.forEach((id, i) => {
      const group = model.groups[id];
      if (group === undefined || group.flank !== undefined) throw new PlacementRefusal('skeleton', `The group lift names ${id}, which is no tier group of the document`);
      if (group.tier !== lift.from[i]) throw new PlacementRefusal('skeleton', `The group lift of ${id} starts in band ${lift.from[i]}, but the document puts it in band ${group.tier}`);
      const to = lift.offset === 0 ? group.tier : bands[index.get(group.tier!)! - lift.offset];
      if (to === undefined || to !== lift.to[i]) throw new PlacementRefusal('skeleton', `The group lift of ${id} is not ${lift.offset} whole bands up`);
    });
    lift.members.forEach((id, i) => { model.groups[id]!.tier = lift.to[i]!; });
    if (lift.push !== undefined) applyPush(model, lift);
  }
}

/**
 * The push of a lifted entry. The record must give it (R5): `at` is the lowest band of the feeders of its side entries and `by` the
 * bands of the component below `at`. Every unit outside the entry whose top band is below `at` moves down `by` bands; a flank follows its group.
 */
function applyPush(model: LayoutModel, lift: GroupLift): void {
  const push = lift.push!, members = new Set(lift.members);
  const feeders = (lift.sideEntry ?? []).flatMap(id => {
    const link = model.links.find(item => item.id === id);
    if (link === undefined) return [];
    return [link.attachments?.from.node ?? (link.from as { node?: string }).node, link.attachments?.to.node ?? (link.to as { node?: string }).node]
      .map(node => model.document.nodes[node ?? '']?.group).filter((group): group is string => group !== undefined && !members.has(group))
      .map(group => model.groups[group]!.tier!);
  });
  if (!feeders.length || Math.max(...feeders) !== push.at) throw new PlacementRefusal('skeleton', `The group lift of ${lift.units.join(', ')} pushes below band ${push.at}, which is not the band of its side-entry feeders`);
  if (Math.max(...lift.to) - push.at !== push.by || push.by < 1) throw new PlacementRefusal('skeleton', `The group lift of ${lift.units.join(', ')} pushes ${push.by} bands, not the ${Math.max(...lift.to) - push.at} bands it hangs below its feeder`);
  const { units } = liftUnits(model);
  const moved = new Set<string>();
  for (const unit of units.values()) {
    if (lift.units.includes(unit.id)) continue;
    const groups = unit.groups.filter(id => !model.groups[id]!.flank);
    if (groups.length && Math.min(...groups.map(id => model.groups[id]!.tier!)) > push.at) for (const id of groups) moved.add(id);
  }
  for (const id of moved) model.groups[id]!.tier! += push.by;
  for (const group of Object.values(model.groups)) if (group.flank !== undefined && moved.has(group.flank.of)) group.tier = model.groups[group.flank.of]!.tier!;
}

/**
 * The band every member of the record stands in once the whole record is applied: its `to` band (lifted) or `from` band (declined),
 * moved down by the push of every later entry whose `at` is above the member's unit.
 */
function recordedBands(record: readonly GroupLift[], unitOf: ReadonlyMap<string, string>): Map<string, number> {
  const band = new Map<string, number>(), unitGroups = new Map<string, string[]>();
  for (const lift of record) {
    for (const [i, id] of lift.members.entries()) {
      band.set(id, lift.offset > 0 ? lift.to[i]! : lift.from[i]!);
      const unit = unitOf.get(id) ?? id;
      unitGroups.set(unit, [...(unitGroups.get(unit) ?? []), id]);
    }
    if (lift.offset === 0 || lift.push === undefined) continue;
    for (const [unit, groups] of unitGroups) {
      if (lift.units.includes(unit)) continue;
      if (Math.min(...groups.map(id => band.get(id)!)) > lift.push.at) for (const id of groups) band.set(id, band.get(id)! + lift.push.by);
    }
  }
  return band;
}

/** The groups that stand lifted, by id, with the index of their record entry. */
export function liftedGroups(model: LayoutModel): Map<string, number> {
  const out = new Map<string, number>();
  (model.groupLifts ?? []).forEach((lift, i) => { if (lift.offset > 0) for (const id of lift.members) out.set(id, i); });
  return out;
}

/**
 * The corridors of the links between groups outside `members`: the box from one end body to the other, over the bands of its two ends. A
 * link that a lift seats a body in would be bent or blocked; the seat keeps them as obstacles, so the space is reserved here, not found
 * by routing (the load-bearing rule).
 */
function corridors(model: LayoutModel, members: ReadonlySet<string>): Part[] {
  const bands = bandList(model), index = new Map(bands.map((band, i) => [band, i]));
  const out: Part[] = [];
  for (const link of model.links) {
    const ends = link.attachments;
    if (ends === undefined || link.technique === 'stub') continue;
    const a = model.nodes[ends.from.node], b = model.nodes[ends.to.node];
    const ga = model.document.nodes[ends.from.node]?.group, gb = model.document.nodes[ends.to.node]?.group;
    if (a?.bounds === undefined || b?.bounds === undefined || ga === undefined || gb === undefined || members.has(ga) || members.has(gb)) continue;
    const ta = model.groups[ga]?.tier, tb = model.groups[gb]?.tier;
    if (ta === undefined || tb === undefined || model.groups[ga]!.flank || model.groups[gb]!.flank) continue;
    const x = Math.min(a.bounds.x, b.bounds.x), right = Math.max(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width);
    out.push({ unit: `link:${link.id}`, box: { x, y: 0, width: right - x, height: 0 }, low: Math.min(index.get(ta)!, index.get(tb)!), high: Math.max(index.get(ta)!, index.get(tb)!) });
  }
  return out;
}

/**
 * The seat of a lifted component in stage 4, after the frame columns are packed: the component moves as a whole in x, to stand on its
 * recorded side of every unit of the bands it shares, a band gap from the nearest. Returns whether anything moved.
 */
export function seatLifts(model: LayoutModel, move: (group: LayoutGroup, dx: number) => void, framesOf: () => Frame[] | undefined): boolean {
  const lifted = liftedGroups(model);
  if (!lifted.size) return false;
  const gap = bandGap(model);
  let moved = false;
  for (const lift of model.groupLifts ?? []) {
    if (lift.offset === 0) continue;
    const frames = framesOf();
    if (frames !== undefined) model.frames = frames;
    const all = parts(model), mine = all.filter(part => lift.units.includes(part.unit)), others = [...all.filter(part => !lift.units.includes(part.unit)), ...corridors(model, new Set(lift.members))];
    // Beside every unit of the bands it shares, on its recorded side, a band gap away: the least shift that clears them all.
    let dx: number | undefined;
    for (const part of mine) for (const other of others) {
      if (other.low > part.high || part.low > other.high) continue;
      const want = lift.side === 'left' ? other.box.x - gap - (part.box.x + part.box.width) : other.box.x + other.box.width + gap - part.box.x;
      dx = dx === undefined ? want : lift.side === 'left' ? Math.min(dx, want) : Math.max(dx, want);
    }
    if (dx === undefined || Math.abs(dx) < NO_MOVE_EPS) continue;
    for (const id of lift.members) move(model.groups[id]!, dx);
    moved = true;
  }
  return moved;
}

/**
 * Keeps every lifted component on its recorded side of the units and link corridors of the bands it shares, a beside gap (`gap` for
 * two plain groups, `gap + slack` beside a frame) away, after a rule widened or moved a column (the rows rule, the column passes). It only
 * pushes a component away, never toward. The column passes sweep one document tier at a time and a lifted unit stands in a tier of its own
 * (`columnTiers`), so without this hold a widened neighbour comes nearer than the band gap. Returns whether anything moved.
 */
export function holdLifts(model: LayoutModel, move: (group: LayoutGroup, dx: number) => void, slack: number): boolean {
  if (!liftedGroups(model).size) return false;
  const gap = bandGap(model);
  const frames = new Set((model.document.frames ? Object.keys(model.document.frames) : []));
  let moved = false;
  for (const lift of model.groupLifts ?? []) {
    if (lift.offset === 0) continue;
    const all = parts(model), mine = all.filter(part => lift.units.includes(part.unit));
    const others = [...all.filter(part => !lift.units.includes(part.unit)), ...corridors(model, new Set(lift.members))];
    let dx = 0;
    for (const part of mine) for (const other of others) {
      if (other.low > part.high || part.low > other.high) continue;
      const room = gap + (frames.has(part.unit) || frames.has(other.unit) ? slack : 0);
      if (lift.side === 'left') dx = Math.min(dx, other.box.x - room - (part.box.x + part.box.width));
      else dx = Math.max(dx, other.box.x + other.box.width + room - part.box.x);
    }
    if (Math.abs(dx) < NO_MOVE_EPS) continue;
    for (const id of lift.members) move(model.groups[id]!, dx);
    moved = true;
  }
  return moved;
}

/**
 * The record agrees with the document and the geometry (R1, R5). Absent: the lift was not decided. Each entry names whole units, in the
 * first slice, whose groups are its members; the members are the groups of a float component (no link of the variant's layers to a unit of
 * the same or a lower document tier outside it); a lifted member stands in its `to` band, a declined one in its `from` band; every routed
 * feeder from above stands in a band above every member it feeds; the members of two entries are disjoint; each kept straight link exists.
 * (Whether a kept straight link is still straight after the later rounds is measured by the gates, not refused here.)
 */
export function validateGroupLifts(model: LayoutModel): void {
  const record = model.groupLifts;
  if (record === undefined) return;
  const fail = (message: string): never => { throw new PlacementRefusal('skeleton', `Group lift record: ${message}`); };
  if (!Array.isArray(record)) fail('not a list');
  if (model.document.layout?.autoArrange === false && record.length) fail('recorded although layout.autoArrange is false');
  const { units, unitOf } = liftUnits(model);
  const seen = new Set<string>();
  // A later entry's push moves the members of earlier entries that stand below its feeders.
  const recorded = recordedBands(record, unitOf);
  for (const lift of record) {
    const n = lift.members?.length ?? 0;
    if (!n || !Array.isArray(lift.units) || lift.tiers?.length !== n || lift.from?.length !== n || lift.to?.length !== n || !Number.isInteger(lift.offset) || lift.offset < 0
      || (lift.side !== 'left' && lift.side !== 'right') || !Array.isArray(lift.straight) || typeof lift.reason !== 'string' || !lift.reason.length) fail('an entry is malformed');
    const unitSet = new Set(lift.units);
    const expected = lift.units.flatMap(id => units.get(id)?.groups ?? [fail(`${id} is no unit`)]).sort(compareId);
    if (JSON.stringify(expected) !== JSON.stringify([...lift.members].sort(compareId))) fail(`the members of ${lift.units.join(', ')} are not their whole units`);
    for (const [i, id] of lift.members.entries()) {
      if (seen.has(id)) fail(`${id} is in two entries`);
      seen.add(id);
      if ((documentTierOf(model, id) ?? model.groups[id]!.tier) !== lift.tiers[i]) fail(`the document tier of ${id} is not ${lift.tiers[i]}`);
      const band = model.groups[id]!.tier;
      if (band !== recorded.get(id)) fail(`${id} stands in band ${band}, not in its recorded band`);
      if (lift.offset > 0 && !(lift.to[i]! < lift.from[i]!)) fail(`${id} does not rise`);
    }
    if (lift.offset === 0) continue;
    for (const id of lift.units) if (units.get(id)!.scope !== undefined) fail(`${id} is ${units.get(id)!.scope}, out of the first slice`);
    const below = linkBelow(model, unitSet);
    if (below !== undefined) fail(`the link ${below} leaves the component to a unit of the same or a lower tier`);
    for (const link of unitLinks(model, unitOf)) {
      if (!link.routed) continue;
      for (const [x, y] of [[link.a, link.b], [link.b, link.a]] as const) {
        if (!unitSet.has(x) || unitSet.has(y)) continue;
        // A fed node never stands above its feeder node; a recorded side entry stands level with it, every other feed below it.
        const item = model.links.find(entry => entry.id === link.id)!;
        const ends = linkEnds(item).map(node => model.document.nodes[node ?? '']?.group ?? '');
        const fedBand = model.groups[ends.find(id => unitOf.get(id) === x) ?? '']?.tier, feederBand = model.groups[ends.find(id => unitOf.get(id) === y) ?? '']?.tier;
        if (fedBand === undefined || feederBand === undefined) fail(`the routed link ${link.id} has no end in a band`);
        if ((lift.sideEntry ?? []).includes(link.id)) { if (fedBand !== feederBand) fail(`the side entry ${link.id} does not stand level with its feeder`); continue; }
        if (!(feederBand! < fedBand!)) fail(`the routed link ${link.id} no longer feeds the component from above`);
      }
    }
    for (const id of lift.straight) if (!model.links.some(item => item.id === id)) fail(`the kept straight link ${id} does not exist`);
    const entries = sideEntries(model, unitSet, new Map());
    if (JSON.stringify(entries) !== JSON.stringify(lift.sideEntry ?? [])) fail(`the side entries are ${entries.join(', ') || 'none'}, not ${(lift.sideEntry ?? []).join(', ') || 'none'}`);
  }
}
