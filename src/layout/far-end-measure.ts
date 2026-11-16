import type { Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { faceKey } from './turn-order.js';
import { guardRoutedTrial, unifiedOrder } from './turn-measure.js';
import { proposeFarEndOrder, staleFaces, type FarEndFace, type FarEndProposal } from './far-end-order.js';

/**
 * The far-end round (dense-16x9 ticket 07): the offer and the judge. The offer is the order of the ports of every face that fails G5 on the published geometry of a
 * completed placement, read from the final far ends (`proposeFarEndOrder`). The trial reserves it, places again (a fresh stage 5 seats it, every later stage re-reserves around it),
 * and the judge keeps the trial only when the final ranges agree.
 */

export const measureFarEndOrder = (routedBase: LayoutModel): FarEndProposal => proposeFarEndOrder(routedBase);

export interface FarEndVerdict {
  kept: boolean;
  reason: string;
  /** The trial left a proposed face stale: the proposal read from the trial's own final positions (the settled faces kept), for the next trial of the round. */
  next?: FarEndFace[];
  /** The faces that fail G5 on the baseline and on the trial. */
  before?: number;
  after?: number;
}

const names = (faces: readonly { node: string; side: Side }[]): Set<string> => new Set(faces.map(face => faceKey(face.node, face.side)));

/**
 * The judge of a far-end trial. Kept only when: no face fails G5 on the trial that did not fail on the baseline; the guards every judged re-run holds (`guardRoutedTrial`: no removed
 * link, no new gate or constraint finding, no broken separation, no kept course over its turns, no larger canvas); the published result is not worse by the unified order (bent links,
 * turns, crossings): the repair buys a port order, and may not pay for it with a bend; and the final ranges agree on every proposed face, or on some of them and on no fewer faces
 * than the baseline. A refused trial that left a face stale carries the next proposal, which reads the trial's own final positions.
 */
export function judgeFarEndTrial(routedBase: LayoutModel, routedTrial: LayoutModel, keptPromises: ReadonlyMap<string, number>, proposed: readonly FarEndFace[]): FarEndVerdict {
  const was = names(staleFaces(routedBase)), now = names(staleFaces(routedTrial)), asked = names(proposed);
  const before = was.size, after = now.size;
  const open = [...asked].filter(face => now.has(face));
  const fresh = [...now].filter(face => !was.has(face));
  // What the next trial reads: the faces of this trial that settled, kept, and every face that is stale on the trial's own final positions, sorted again from them.
  const refuse = (reason: string): FarEndVerdict => {
    const next = open.length > 0 || fresh.length > 0 ? proposeFarEndOrder(routedTrial, proposed.filter(face => !now.has(faceKey(face.node, face.side)))).faces : [];
    return { kept: false, reason, ...(next.length > 0 ? { next } : {}), before, after };
  };
  if (fresh.length > 0) return refuse(`the trial leaves faces out of far-end order that the baseline had in order (${fresh.join(', ')})`);
  const guarded = guardRoutedTrial(routedBase, routedTrial, keptPromises);
  if (typeof guarded === 'string') return refuse(guarded);
  const { before: was3, after: now3, order } = unifiedOrder(guarded);
  if (order > 0) return refuse(`the routed trial is worse by the unified order (${now3.bent} bent links, ${now3.turns} turns, ${now3.crossings} crossings, against ${was3.bent}, ${was3.turns} and ${was3.crossings})`);
  // A face the new order did not settle stays out of order as it was on the baseline: the trial is kept when it settles more faces than it leaves (no face is worse), and the round
  // goes on with the faces left. A trial that settles none is refused.
  if (open.length > 0 && after >= before) return refuse(`the final far ends of ${open.join(', ')} disagree with the proposed order`);
  return { kept: true, reason: '', before, after };
}
