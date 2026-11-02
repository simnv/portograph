import type { LayoutGroup, LayoutModel } from '../../model/layout.js';
import { frameNodes } from '../frames.js';
import { findPort } from '../row-paths.js';

/**
 * Shared readers: the edge a title takes (ADR-0011): the horizontal edge with fewer routed link ports, so the title sits opposite
 * the links that enter it. Ties keep the top. Two modes count different ports, and a frame title and a cell title can land on
 * different edges for the same ports when a link runs inside the frame:
 *
 * - `groupTitleEdge` counts every routed port of the group's nodes. Read for a group's own title, and by the mesh bus.
 * - `frameTitleEdge` counts only the ports of links that cross the frame's boundary: a link between two cells of one frame is
 *   inside it and asks nothing of the title. Read for the title of a frame and of a canton.
 *
 * Both read frozen port topology (`naturalSide` first), so placement, publication and restore agree. A stub draws no path and
 * is not counted.
 */

type Edge = 'top' | 'bottom';

/** The count of top and bottom ports of `members`, over the routed links; `crossingOnly` keeps only the links with one end outside `members`. */
function countPorts(model: LayoutModel, members: ReadonlySet<string>, crossingOnly: boolean): Edge {
  const counts = { top: 0, bottom: 0 };
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    const ends = [link.attachments.from, link.attachments.to];
    if (crossingOnly && members.has(ends[0]!.node) === members.has(ends[1]!.node)) continue;
    for (const ref of ends) {
      if (!members.has(ref.node)) continue;
      const found = findPort(model, ref), side = found === undefined ? undefined : found.naturalSide ?? found.side;
      if (side === 'top' || side === 'bottom') counts[side]++;
    }
  }
  return counts.top > counts.bottom ? 'bottom' : 'top';
}

/** Mode `all ports`: the edge of a group's title, before any title is moved. */
export function groupTitleEdge(model: LayoutModel, group: LayoutGroup): Edge {
  return countPorts(model, new Set(group.nodes), false);
}

/** Mode `boundary-crossing ports`: the edge of a frame's title, before any title is moved. Reads every node of the frame's cells and child frames. */
export function frameTitleEdge(model: LayoutModel, frame: string): Edge {
  return countPorts(model, new Set(frameNodes(model, frame)), true);
}
