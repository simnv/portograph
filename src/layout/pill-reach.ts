import type { Side } from '../model/geometry.js';
import type { LayoutModel, LayoutNode } from '../model/layout.js';
import { measurePortPill } from '../text/index.js';
import { routedStrokeWidth } from '../theme/geometry.js';
import { GROUP_LABEL_GEOMETRY } from './title-room.js';

/**
 * How deep a run along one node side must stand to clear the text of every pill of that side (ticket 156): half the longest
 * pill text, half the widest routed stroke and the entry tolerance; 0 when the side has no named port. A pill and its text are
 * centred on the anchor, so at 9 px a name of about five characters reaches past the 15 px stem, and a run that starts or turns
 * at the plain tip crosses the text (G3 `label-collision`). Every stem tip and every fan row of the side stands at least this
 * deep, so the stems and the fan rows of one side keep one depth. The tip stays inside the router's node obstacle, which swallows
 * the whole pill (`route/obstacles`), as the plain tip does under a pill that reaches past it.
 * This leaf module imports no geometry rule, so `bands.ts` and `bundle-geometry.ts` both read it without a cycle.
 */
export function sidePillTextReach(model: Pick<LayoutModel, 'links'>, node: LayoutNode, side: Side): number {
  let text = 0;
  for (const port of node.ports) {
    if (port.side !== side || port.ref.anonymous === true || port.ref.name === undefined) continue;
    text = Math.max(text, measurePortPill(port.ref.name).text.width / 2);
  }
  if (text === 0) return 0;
  return text + routedStrokeWidth(model) / 2 + GROUP_LABEL_GEOMETRY.entryTolerance;
}
