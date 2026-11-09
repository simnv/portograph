import type { LayoutModel } from '../model/layout.js';
import { compareId } from './skeleton-graph.js';
import { findPort } from './row-paths.js';
import { linkLayer } from './link-layer.js';
import { ASPECT_EPS, PLACEMENT_EPS, SIGN_EPS } from './tolerance.js';
import { routedBends } from './objective.js';
import { betterByUnified } from './turn-measure.js';
import { gateFindings, constraintFindings, separationWorse, added as namesAdded } from './trial-findings.js';
import { overlayCrossingPairs } from './read/crossings.js';
import { aspectGap, LIFT_NARROWER_PX } from './lift.js';

/**
 * The pairs of one routed and one overlay path that cross: the unified order of the judge counts them with the routed and the overlay
 * crossings (lift v2 open point 3), because neither X (routed with routed) nor the overlay pairs count them (mode `pairs`; a removed link and a stub are no path). */
export function mixedCrossings(model: LayoutModel): number {
  const paths = (layer: 'routed' | 'overlay') => model.links.filter(link => link.removed !== true && link.technique !== 'stub' && link.path !== undefined
    && link.path.segments.length > 0 && linkLayer(link) === layer).map(link => link.path!.segments);
  const routed = paths('routed'), overlay = paths('overlay');
  let found = 0;
  for (const a of routed) for (const b of overlay) found += overlayCrossingPairs([a, b]);
  return found;
}

/**
 * The tolerant area judge (D-Q5 after lift-v3). `noLift` is the published run with no lift, `smallest` the kept run with the least area; `T`
 * the tolerance (`LIFT_AREA_TOLERANCE`). A trial is kept on area when it is smaller than both; or when it is smaller than `noLift`, at most `T`
 * larger than `smallest`, and narrower (`LIFT_NARROWER_PX`) or nearer square (`aspectGap`) than `smallest`.
 */
export interface AreaTolerance { noLift: LayoutModel; smallest: LayoutModel; T: number }

/**
 * The judge of a lift trial, on the published baseline and the published trial: no link removed, no new gate or hard constraint finding, no
 * separation broken or deepened, every straight link (both layers) still straight, every vertical link still vertical and every routed link
 * on the faces it had (except the trial's side entries, which turn to the lateral faces), no link with more bends, the area rule
 * (`AreaTolerance`), and the unified order (bent links, then turns, then crossings) not worse. Returns the reason to decline, or the straight
 * links kept.
 */
export function judgeLift(routedBase: LayoutModel, routedTrial: LayoutModel, sideEntry: ReadonlySet<string>, tolerance: AreaTolerance): { reason?: string; straight: string[]; area: [number, number]; tolerated?: boolean } {
  const area = (m: LayoutModel): number => (m.canvas?.width ?? 0) * (m.canvas?.height ?? 0);
  const areas: [number, number] = [area(routedBase), area(routedTrial)];
  const was = routedBends(routedBase), now = routedBends(routedTrial);
  const no = (reason: string) => ({ reason, straight: [], area: areas });
  const removed = [...was.keys()].filter(id => !now.has(id)).sort(compareId);
  if (removed.length) return no(`the trial's route removes ${removed.join(', ')}`);
  const lost = [...was].filter(([id, bends]) => bends === 0 && (now.get(id) ?? 1) > 0).map(([id]) => id).sort(compareId);
  if (lost.length) return no(`the link${lost.length > 1 ? 's' : ''} ${lost.join(', ')} ${lost.length > 1 ? 'are' : 'is'} straight without the lift and not with it`);
  // A vertical link (one segment on one x) stays vertical, in both layers (D-Q5: "a vertical feed stays vertical").
  const vertical = (model: LayoutModel): Set<string> => new Set(model.links.filter(link => link.path?.segments.length === 1
    && Math.abs(link.path.segments[0]!.from.x - link.path.segments[0]!.to.x) <= PLACEMENT_EPS).map(link => link.id));
  const wasVertical = vertical(routedBase), nowVertical = vertical(routedTrial);
  // A side entry of the trial may leave the vertical (D-Q5 revised); it stays straight or gains no bend (the rules above and below).
  const tilted = [...wasVertical].filter(id => !nowVertical.has(id) && !sideEntry.has(id)).sort(compareId);
  if (tilted.length) return no(`the link${tilted.length > 1 ? 's' : ''} ${tilted.join(', ')} ${tilted.length > 1 ? 'are' : 'is'} vertical without the lift and not with it`);
  // A routed link keeps the faces it leaves and enters, except a side entry of the trial (D-Q5 revised).
  const faces = (model: LayoutModel, id: string): string | undefined => {
    const link = model.links.find(item => item.id === id), ends = link?.attachments;
    if (link === undefined || ends === undefined || linkLayer(link) !== 'routed') return undefined;
    return `${findPort(model, ends.from)?.side}/${findPort(model, ends.to)?.side}`;
  };
  const turned = [...was.keys()].filter(id => !sideEntry.has(id) && faces(routedBase, id) !== faces(routedTrial, id)).sort(compareId);
  if (turned.length) return no(`the routed link${turned.length > 1 ? 's' : ''} ${turned.join(', ')} ${turned.length > 1 ? 'change' : 'changes'} the faces ${turned.length > 1 ? 'they leave' : 'it leaves'} or ${turned.length > 1 ? 'enter' : 'enters'}`);
  const gained = [...was].filter(([id, bends]) => (now.get(id) ?? Infinity) > bends).map(([id]) => id).sort(compareId);
  if (gained.length) return no(`the link${gained.length > 1 ? 's' : ''} ${gained.join(', ')} gain${gained.length > 1 ? '' : 's'} a bend`);
  const gatesNow = gateFindings(routedTrial), gatesThen = gateFindings(routedBase);
  if (gatesNow === undefined || gatesThen === undefined) return no('the routed trial does not score');
  const gateNew = namesAdded(gatesNow.findings, gatesThen.findings);
  if (gateNew.length) return no(`the routed trial has gate findings the baseline does not have (${gateNew.slice(0, 3).join('; ')})`);
  const constraintNew = namesAdded(constraintFindings(routedTrial), constraintFindings(routedBase));
  if (constraintNew.length) return no(`the routed trial breaks a hard constraint the baseline holds (${constraintNew.slice(0, 3).join('; ')})`);
  const separationNew = separationWorse(routedTrial, routedBase);
  if (separationNew.length) return no(`the routed trial breaks or deepens a minimum separation (${separationNew.slice(0, 3).join('; ')})`);
  let tolerated = false;
  const noLift = area(tolerance.noLift), least = area(tolerance.smallest), small = tolerance.smallest.canvas;
  if (!(areas[1] < noLift - SIGN_EPS)) return no(`the canvas area is ${Math.round(areas[1])} px² with the lift, not less than ${Math.round(noLift)} px² with no lift`);
  if (!(areas[1] < least - SIGN_EPS)) {
    const width = routedTrial.canvas?.width ?? 0, height = routedTrial.canvas?.height ?? 0;
    const better = width < (small?.width ?? 0) - LIFT_NARROWER_PX || aspectGap(width, height) < aspectGap(small?.width ?? 0, small?.height ?? 0) - ASPECT_EPS;
    if (!(areas[1] <= least * (1 + tolerance.T) && better)) return no(`the canvas area is ${Math.round(areas[1])} px² with the lift, not less than the smallest ${Math.round(least)} px²${better ? `, and more than ${tolerance.T * 100} % above it` : ', and not narrower or nearer square'}`);
    tolerated = true;
  }
  const count = (c: NonNullable<ReturnType<typeof gateFindings>>['counts'], m: LayoutModel) => ({ bent: c.routed.bent + c.overlay.bent, turns: c.routed.turns + c.overlay.turns, crossings: c.routed.crossings + c.overlay.crossings.pairs + mixedCrossings(m) });
  const before = count(gatesThen.counts, routedBase), after = count(gatesNow.counts, routedTrial);
  if (betterByUnified(after, before)) return no(`the unified order is worse with the lift (${after.bent} bent links, ${after.turns} turns, ${after.crossings} crossings, against ${before.bent}, ${before.turns} and ${before.crossings})`);
  return { straight: [...was].filter(([, bends]) => bends === 0).map(([id]) => id).sort(compareId), area: areas, ...(tolerated ? { tolerated } : {}) };
}

