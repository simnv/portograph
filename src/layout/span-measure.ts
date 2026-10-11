import type { LayoutLink, LayoutModel, PathSegment } from '../model/layout.js';
import { pathStrokeWidth } from '../theme/geometry.js';
import { chordVerdict, fixedPointRefusal, spanCandidate, type ChordRefusal } from './frame-paths.js';
import { laneRunKind } from './lane-kind.js';
import { pathBends } from './objective.js';

/**
 * The span round's offer (architecture ticket 22, docs/design/routed-chords.md, Section 14.4). `measureSpans` reads the 7f baseline and its routed result and
 * names the links that may become a spanning chord: a routed link between two document tiers that are not consecutive, whose corridor (the chord over every
 * transited band, grown by the gate clearances) is clear of every wall a cross-frame chord reads. Phase 1 runs it as a shadow, for the trace only.
 */

/** Why a candidate is not offered: the first check of `chordVerdict` that refused it, `chord` for a chord held earlier in the pass that stands too near, `leg` for the leg of a link that stays orthogonal. */
export type SpanRefusal = ChordRefusal;

export interface SpanOffer {
  /** The offered links, in link order. */
  links: string[];
  /** The chord of each offered link, as the baseline geometry gives it. */
  chords: Map<string, PathSegment>;
  /** Each candidate that was not offered, with the first check that refused it. */
  refused: Map<string, SpanRefusal>;
  /** Offered links whose chord a held chord or a leg stem crowds on the baseline geometry: the port pitch of the trial decides (see `PITCH_BOUND`). */
  crowded: Map<string, SpanRefusal>;
  /** The candidates of the baseline, in link order. Empty offer when none is bent today. */
  candidates: string[];
}

/** The model with the lanes, paths and runs of the given candidates taken away, and each carrying the span hint: what the corridor is read against. */
function withoutLanes(model: LayoutModel, ids: ReadonlySet<string>): LayoutModel {
  return {
    ...model,
    lanes: model.lanes.filter(lane => !(lane.owner.kind === 'link' && ids.has(lane.owner.id) && laneRunKind(lane) === 'transit')),
    links: model.links.map(link => {
      if (!ids.has(link.id)) return link;
      const rest: LayoutLink = { ...link, spanHint: true };
      delete rest.path; delete rest.fixedSegments;
      return rest;
    }),
  };
}

/**
 * The corridor reader: the chord of a candidate when every wall of Section 14.2 leaves it clear, else the first check that refuses it. `model` must be the
 * baseline with the offered lanes removed and the chords accepted earlier in the pass held as pinned chords (`measureSpans` builds it): a held chord is a wall
 * at the chord clearance unless the two cross strictly, and the legs of the links that stay orthogonal are walls too (`fixedPointRefusal`, the rule 7f freezes by).
 */
export function spanVerdict(model: LayoutModel, link: LayoutLink, undecided: ReadonlySet<string> = new Set()): { segment: PathSegment; near?: 'chord' | 'leg' | 'title' } | { reason: SpanRefusal } {
  const hinted = link.spanHint === true ? link : { ...link, spanHint: true as const };
  const verdict = chordVerdict(model, hinted);
  if (!('segment' in verdict)) return verdict;
  const held = fixedPointRefusal({ ...model, links: model.links.map(item => item.id === link.id ? hinted : item) }, hinted, verdict.segment, undecided);
  return held === undefined ? verdict : { reason: held };
}

/**
 * The refusals that depend on the port pitch, which the re-run changes: the baseline's ports stand where the lane pitch put them, and stage 5 of the trial gives a
 * hinted end none, then the fan rule (ticket 89) spreads the face for the chord clearance. A chord that a held chord or the stem of a leg crowds on the baseline is
 * offered; the trial publishes it or the judge refuses the trial (`promise`).
 */
const PITCH_BOUND: ReadonlySet<SpanRefusal> = new Set(['chord', 'leg']);

/** The candidates of the baseline that are bent in its routed result, or removed: no chord can lower the bent count of a sheet without one. */
export function measureSpans(base: LayoutModel, routedBase: LayoutModel): SpanOffer {
  const offer: SpanOffer = { links: [], chords: new Map(), refused: new Map(), crowded: new Map(), candidates: [] };
  const candidates = base.links.filter(link => link.removed !== true && spanCandidate(base, link));
  offer.candidates = candidates.map(link => link.id);
  const bent = candidates.some(link => {
    const routed = routedBase.links.find(item => item.id === link.id);
    const turns = routed === undefined ? undefined : pathBends(routed);
    return turns === undefined || turns > 0;
  });
  if (!bent) return offer;
  let copy = withoutLanes(base, new Set(offer.candidates));
  const undecided = new Set(offer.candidates);
  for (const id of offer.candidates) {
    const link = copy.links.find(item => item.id === id)!;
    undecided.delete(id);
    const verdict = spanVerdict(copy, link, undecided);
    if (!('segment' in verdict) && !PITCH_BOUND.has(verdict.reason)) { offer.refused.set(id, verdict.reason); continue; }
    const segment = 'segment' in verdict ? verdict.segment : (chordVerdict(copy, link) as { segment: PathSegment }).segment;
    if (!('segment' in verdict)) offer.crowded.set(id, verdict.reason);
    offer.links.push(id); offer.chords.set(id, segment);
    // The chord is held for the rest of the pass: a pinned straight path, as 7f keeps it.
    const held: LayoutLink = { ...link, technique: 'straight', path: { owner: { ...link.owner }, layer: 'routed', fixed: true, ...pathStrokeWidth(link), segments: [{ ...segment, straight: true }] } };
    copy = { ...copy, links: copy.links.map(item => item.id === id ? held : item) };
  }
  return offer;
}
