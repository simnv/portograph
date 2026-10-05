import type { Point, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { bottom, EPS } from '../geometry/planar.js';
import { nudgingDistance, stemReach } from './bands.js';
import { plannedSegments, tierGapPlans, type GapPlan, type PlannedPart } from './gap-plan.js';
import { endPort } from './approach.js';
import { findPort } from './row-paths.js';
import { stemPlan, type StemCache } from './sides-two.js';

/**
 * ADR-0015 rule 1, per gap: the room every run that crosses a **tier gap** needs, reserved before
 * the first ownership batch runs rather than discovered by whichever batch reaches the gap first.
 *
 * A tier gap is the open band between two adjacent tier bands. The reservations that face it bound
 * it: the bottom of each lane that ends at its upper side, and the top of each lane that begins at
 * its lower side. The plan (`gap-plan.ts`, ADR-0021) orders every part of the gap in placement; this
 * module hands the plan to stage 8 as reserved geometry, part by part, tip to tip, and names the
 * links the plan left to the router (the **residual** parts) as the crossers of the rows, and as the
 * grantees of the planned verticals they cannot route round.
 *
 * It reads frozen placement and writes no model geometry, exactly as rule 1's leg reservation does
 * (`legReservation`) and for the same reason: `fixedSegments` belongs to the lanes rule, which runs
 * long before the geometry this reads exists.
 */

/** A gap a run may be allocated in: the open band between two tier bands, clipped to the lanes. */
export interface TierGap {
  low: number;
  high: number;
  /** The tier of the band above the gap, and of the band below it. */
  above: number;
  below: number;
}

/** One planned part, reserved: the geometry stage 8 keeps exactly, and the links that may stand on or cross it. */
export interface GapRun {
  link: string;
  /** The planned gap it belongs to, in the link's own traversal order. */
  index: number;
  segments: PathSegment[];
  /**
   * Residual links whose own route must cross this tier gap (residual: a part the plan declines). A run **along** a gap is a wall
   * along it and never across it, so the links that have to get through are given the crossing rather than a dead end (ADR-0015
   * rule 3). The crossing is of the row alone: the vertical parts of the run still obstruct them, except where `grants` names them.
   */
  crossers: string[];
  /** The links whose planned parts share this run's port leg: they may lie on its cover (the shared leg is an output of the plan). */
  shares?: string[];
  /**
   * Residual links granted the cover of one vertical of this run (residual: legs within `keep`, ticket 45's shape). One entry per
   * segment of `segments`; a horizontal segment has none. A residual link has no route across a planned vertical that stands within
   * `keep` of its own span, so it is absent from that vertical's cover alone, as the crossers are from the rows (2.2, S5).
   */
  grants?: string[][];
}

const same = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;
export const drawn = (link: LayoutLink): boolean => link.technique !== 'stub' && link.attachments !== undefined
  && link.layer === 'routed' && link.path === undefined;
const OUTWARD: Record<Side, number> = { top: -1, bottom: 1, left: 0, right: 0 };

/**
 * The tier gaps of this diagram, low to high. A lane overhangs its band, so the room a run really
 * has is the band gap clipped to the lane bounds that face it.
 */
export function tierGaps(model: LayoutModel): TierGap[] {
  const bands = model.tierBands.filter(band => band.bounds).sort((a, b) => a.bounds!.y - b.bounds!.y);
  const result: TierGap[] = [];
  for (const [index, entry] of bands.entries()) {
    const band = entry.bounds!, following = bands[index + 1], next = following?.bounds;
    if (!next || bottom(band) >= next.y - EPS) continue;
    let low = bottom(band), high = next.y;
    for (const lane of model.lanes) {
      if (lane.layer === 'overlay') continue;
      if (bottom(lane.bounds) > low + EPS && bottom(lane.bounds) < high - EPS) low = bottom(lane.bounds);
    }
    for (const lane of model.lanes) {
      if (lane.layer === 'overlay') continue;
      if (lane.bounds.y > low + EPS && lane.bounds.y < high - EPS) high = lane.bounds.y;
    }
    if (high > low + EPS) result.push({ low, high, above: entry.tier, below: following.tier });
  }
  return result;
}

/**
 * Every stop one link's route passes through, in the order stage 8 plans them: the two ends and the
 * ends of the runs the lanes rule fixed. An end that consumes a declared shared run starts at that
 * run's terminal, not at its port anchor.
 */
export function stopsOf(model: LayoutModel, link: LayoutLink): { point: Point; kind: 'port' | 'shared' | 'lane' }[] {
  const ends = (['from', 'to'] as const).map(end => {
    const runs = link.sharedRuns?.[end];
    if (runs?.length) return { point: runs.at(-1)!.to, kind: 'shared' as const };
    const anchor = endPort(model, link, end)?.anchor;
    return anchor ? { point: anchor, kind: 'port' as const } : undefined;
  });
  if (!ends[0] || !ends[1]) return [];
  // Every reserved run keeps its place, so the index of each planned gap is the one `planRoute`
  // plans from. Only a lane terminal opens into a tier gap: a port anchor can sit on a boundary as
  // well — a band's extent is the union of its nodes — and a run from there is that link's own stem.
  const kindOf = (segment: PathSegment): 'shared' | 'lane' => segment.lane === undefined ? 'shared' : 'lane';
  return [ends[0], ...(link.fixedSegments ?? []).flatMap(segment =>
    [{ point: segment.from, kind: kindOf(segment) }, { point: segment.to, kind: kindOf(segment) }]), ends[1]];
}

/** The gap boundary a point stands on, or undefined when it stands on neither. */
export function edgeOf(gap: TierGap, point: Point): 'low' | 'high' | undefined {
  if (same(point.y, gap.low)) return 'low';
  if (same(point.y, gap.high)) return 'high';
  return undefined;
}

/**
 * A stem that placement nested (ticket 31): its port turns deeper than the plain reach, so its tip
 * stands on a row of its own, and every port of that side that shares its port shares the tip.
 * `consumers` are the links of the port: the tip belongs to each of them. `from` and `to` bound the x
 * the tip row's leg travels: the tip column, the far port of each consumer and the lanes it owns.
 * `nested` is false for a flat stem.
 */
export interface NestedTip { anchor: Point; tip: Point; side: 'top' | 'bottom'; consumers: ReadonlySet<string>; from: number; to: number; nested: boolean }

export function nestedTips(model: LayoutModel, cache: StemCache): NestedTip[] {
  const result = new Map<string, NestedTip>();
  for (const link of model.links) {
    if (link.layer === 'overlay' || !drawn(link)) continue;
    for (const end of ['from', 'to'] as const) {
      if (link.sharedRuns?.[end]?.length) continue;
      const port = endPort(model, link, end);
      if (!port?.anchor || (port.side !== 'top' && port.side !== 'bottom')) continue;
      const depth = stemPlan(model, port, cache).depth;
      const nested = depth > stemReach(model, model.nodes[link.attachments![end].node]!) + EPS;
      const at = `${port.ref.node}|${port.side}|${port.anchor.x}`;
      const other = findPort(model, link.attachments![end === 'from' ? 'to' : 'from'])?.anchor;
      const xs = [port.anchor.x, ...(other ? [other.x] : []),
        ...model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === link.id).map(lane => lane.x)];
      const known = result.get(at);
      if (known) {
        (known.consumers as Set<string>).add(link.id);
        known.from = Math.min(known.from, ...xs);
        known.to = Math.max(known.to, ...xs);
      } else result.set(at, { side: port.side, anchor: port.anchor, consumers: new Set([link.id]),
        nested, tip: { x: port.anchor.x, y: port.anchor.y + OUTWARD[port.side] * depth }, from: Math.min(...xs), to: Math.max(...xs) });
    }
  }
  return [...result.values()];
}

/**
 * The plan of each tier gap that the model's placement fits (`plan.growth` is zero), by the gap's index. A plan that asks for
 * more room than the gap has is read from a placement the growth did not see (a corridor moved after it): nothing is planned
 * into a gap the plan does not fit, its links are the router's, and stage 8 names the gap `TIER_GAP_PART_UNFIT` (`unfitGaps`).
 */
function fittingPlans(all: readonly { plan: GapPlan }[]): Map<number, GapPlan> {
  const result = new Map<number, GapPlan>();
  for (const [key, { plan }] of all.entries()) if (plan.growth <= EPS && plan.parts.length) result.set(key, plan);
  return result;
}

const plannedIds = (plans: ReadonlyMap<number, GapPlan>): Map<number, Set<string>> =>
  new Map([...plans].map(([key, plan]) => [key, new Set(plan.parts.map(part => part.id))]));

/**
 * The links whose route meets a tier gap without a planned part in it, by the gap's index: the residual links, and every link that
 * only reaches into the gap or spans two gaps at once. A row of the plan is a wall along the gap, so each of them is given the
 * crossing (ADR-0015 rule 3). A link with a planned part in the gap is never among them: it is reserved and never routed across.
 */
function crossersOf(model: LayoutModel, gaps: TierGap[], planned: ReadonlyMap<number, ReadonlySet<string>>): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>(gaps.map((_, key) => [key, new Set<string>()]));
  for (const link of model.links) {
    if (!drawn(link)) continue;
    const stops = stopsOf(model, link);
    for (let index = 0; index * 2 + 1 < stops.length; index++) {
      const a = stops[index * 2]!, b = stops[index * 2 + 1]!;
      const low = Math.min(a.point.y, b.point.y), high = Math.max(a.point.y, b.point.y);
      const found = gaps.flatMap((gap, key) => gap.low > low - EPS && gap.high < high + EPS ? [key] : []);
      for (const [key, gap] of gaps.entries()) {
        // A run that only reaches into a gap still has to leave it, and a row across its way is a wall for it exactly as it is for
        // a run that crosses the gap end to end.
        if (!found.includes(key) && !(high > gap.low + EPS && low < gap.high - EPS)) continue;
        if (found.length === 1 && found[0] === key && planned.get(key)?.has(`${link.id}#${index}`)) continue;
        result.get(key)!.add(link.id);
      }
    }
  }
  return result;
}

/** One planned part, reserved: its segments in the order its link visits them, and the residual links that stand on its covers. */
interface PlannedRun { part: PlannedPart; segments: PathSegment[]; shares: string[]; grants: string[][] }

/**
 * The planned parts of one gap as reserved geometry (Section 4). Two planned parts on one port share the leg from the tip to the
 * higher row; the plan record names them, and nothing is written to the model.
 *
 * A residual part has no route across a planned vertical that stands within `keep` of its span: spec 2.2 grants it that vertical's
 * cover, so it publishes with a finding and not as a removal. The grant is the cover of the crossed vertical alone (ticket 52),
 * not the cover of the whole part.
 */
function plannedRuns(model: LayoutModel, plan: GapPlan, gap: TierGap): PlannedRun[] {
  const keep = nudgingDistance(model);
  return plan.parts.filter(part => part.index !== undefined).map(part => {
    // A pair with legs within `keep` (`plan.crowded`, both planned) consumes each other's leg covers and is never routed: the gate names the clash.
    const crowded = plan.crowded.flatMap(item => item.link === part.link ? [item.with] : item.with === part.link ? [item.link] : []);
    const shares = [...plan.parts.filter(other => other.link !== part.link && (other.upper.source === part.upper.source && part.upper.kind === 'tip'
      || other.lower.source === part.lower.source && part.lower.kind === 'tip')).map(other => other.link), ...crowded];
    const segments = plannedSegments(part, gap);
    const grants = segments.map(segment => {
      if (!same(segment.from.x, segment.to.x)) return [];
      const x = segment.from.x;
      return [...new Set(plan.residual.filter(item => {
        const span = item.span ?? (item.upper && item.lower
          ? { x0: Math.min(item.upper.x, item.lower.x), x1: Math.max(item.upper.x, item.lower.x) } : undefined);
        return span !== undefined && x > span.x0 - keep + 1e-9 && x < span.x1 + keep - 1e-9;
      }).map(item => item.link))].sort();
    });
    return { part, segments, shares: [...new Set(shares)].sort(), grants };
  });
}

/**
 * ADR-0015 rule 1 per tier gap, from frozen placement and keyed by the link and the planned gap it belongs to. Stage 8 stitches
 * each run back unchanged and routes only what is left beyond it.
 *
 * A **planned part** (`gap-plan.ts`) is reserved tip to tip: its upper leg, its run on its row and its lower leg, a Z part's two
 * rows and middle drop, or the one vertical of a drop. A residual part (any part the plan declines, and every part of a gap the
 * plan does not fit) is reserved nothing: it is the router's, a crosser of the rows of its gap, and it holds the grant of every
 * planned vertical it has no route round.
 */
export function allocateGapRuns(model: LayoutModel, all: readonly { gap: TierGap; plan: GapPlan }[] = tierGapPlans(model)): GapRun[] {
  const gaps = tierGaps(model);
  if (!gaps.length) return [];
  const plans = fittingPlans(all);
  if (!plans.size) return [];
  const crossers = crossersOf(model, gaps, plannedIds(plans));
  const result: GapRun[] = [];
  for (const [key, plan] of [...plans].sort((a, b) => a[0] - b[0])) {
    const across = [...crossers.get(key)!].sort();
    for (const run of plannedRuns(model, plan, gaps[key]!)) {
      const granted = run.grants.some(list => list.length);
      result.push({ link: run.part.link, index: run.part.index!, segments: run.segments, crossers: across.filter(id => id !== run.part.link),
        ...(run.shares.length ? { shares: run.shares } : {}), ...(granted ? { grants: run.grants } : {}) });
    }
  }
  return result;
}
