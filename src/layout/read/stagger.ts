import type { LayoutLink, LayoutModel, StaggerRow } from '../../model/layout.js';

/** The line a staggered member stands on: `'far'` when listed in `plan.far`, else `'near'` (R1: one reader). */
export function lineOf(plan: StaggerRow, id: string): 'near' | 'far' {
  return plan.far.includes(id) ? 'far' : 'near';
}

/**
 * The chord row a link belongs to (dense-16x9 ticket 03, slice C), or undefined: the group of the stagger row whose stored `chordHubs` names the
 * hub the link reaches from one of its members. Read off the stage-5 record only, never off geometry (R1).
 */
export function chordRowOf(model: LayoutModel, link: LayoutLink): string | undefined {
  const ends = link.attachments;
  if (ends === undefined || link.layer !== 'routed' || link.technique === 'stub') return undefined;
  return (model.staggerRows ?? []).find(plan => plan.chordHubs?.length && ((plan.order.includes(ends.from.node) && plan.chordHubs.includes(ends.to.node))
    || (plan.order.includes(ends.to.node) && plan.chordHubs.includes(ends.from.node))))?.group;
}

/**
 * The compact hub a link reaches from a staggered member (dense-16x9 ticket 03, slice C), or undefined: the link joins a member of a row and a
 * node that row's stored `chordHubs` lists. Its chord is the link's path, so it is no 7c feed of the hub (R1: one reader).
 */
export function chordHubOf(model: LayoutModel, link: LayoutLink): string | undefined {
  const ends = link.attachments;
  if (ends === undefined || link.layer !== 'routed' || link.technique === 'stub') return undefined;
  for (const plan of model.staggerRows ?? []) {
    if (!plan.chordHubs?.length) continue;
    if (plan.order.includes(ends.from.node) && plan.chordHubs.includes(ends.to.node)) return ends.to.node;
    if (plan.order.includes(ends.to.node) && plan.chordHubs.includes(ends.from.node)) return ends.from.node;
  }
  return undefined;
}
