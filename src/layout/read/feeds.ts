import type { LayoutGroup, LayoutModel, LayoutPort } from '../../model/layout.js';
import { courseOf } from '../course-lanes.js';
import { endMode } from '../course-rows.js';
import { isSideLane, sideLaneSource } from '../lanes.js';
import { findPort } from '../row-paths.js';
import { portId } from '../skeleton-graph.js';
import { nodeTier } from './tier.js';

/**
 * Shared readers: "what feeds this group?" Two modes, and they are not one answer. Ticket 74 unifies them; until then each is
 * named for the pass that reads it, and the differences are the ticket's list (also in `.scratch/architecture/issues/03-shared-readers.md`):
 *
 * | | `centringFeeds` (7c centring) | `columnPullFeeds` (column pull) |
 * | --- | --- | --- |
 * | asks | a document tier and the authority tier | a unit and the set of source groups |
 * | admits a parent | any parent on the authority side, on the authority tier or beyond it through an owned lane | a parent in `sources`, or beyond them with an owned lane at the sub-tier next to the child |
 * | flank | refuses both ends when either is in a flank | tests a flank only for a parent beyond the sources; a source flank and the child's own flank pass |
 * | side lane | adds one feed per link with a side lane, x = the lane's | has no such branch |
 * | transit lane | the lane owned in the authority tier | the lane owned in the sub-tier `near` the child; none when the parent stands there |
 * | missing anchor | asserts it (`!`) | skips the link |
 * | result | one `Feed` per link end, with the port pair | the x of each distinct port, by port id (a port reached twice is one entry) |
 */

/**
 * `x` is the authoritative feed x: the parent anchor, or the owned lane x in the adjacent tier for a
 * transit. `key` is the parent port either way: a parent port feeding several children is vertical
 * to one of them (the first by x), and the rest fan — lanes packed at lane width cannot seat two
 * default-width children side by side, so a per-lane winner would only manufacture infeasible pins.
 */
export interface Feed { parent: LayoutPort; child: LayoutPort; link: string; x: number; key: string; transit: boolean }
export function centringFeeds(model: LayoutModel, tier: number, authority: number): Feed[] {
  const result: Feed[] = [];
  for (const link of model.links) {
    if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
    for (const [parentRef, childRef] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
      if (!parentRef || !childRef || nodeTier(model, childRef.node) !== tier) continue;
      // The parent is in the adjacent authority tier, or beyond it for a link that transits the
      // adjacent tier through an owned lane (7a). Both fix the x the child must sit under.
      const parentTier = nodeTier(model, parentRef.node);
      if (parentTier === undefined || (tier > authority ? parentTier > authority : parentTier < authority)) continue;
      if ([parentRef.node, childRef.node].some(id => model.groups[model.document.nodes[id]!.group]!.flank)) continue;
      const parent = findPort(model, parentRef)!, child = findPort(model, childRef)!;
      if (parent.side !== (tier > authority ? 'bottom' : 'top') || child.side !== (tier > authority ? 'top' : 'bottom')) continue;
      // A bundle member carries its lane only until 7e, which owns member geometry; only a
      // non-bundle transit with an owned lane in the authority tier fixes its child's x here.
      const lane = parentTier === authority ? undefined
        : model.lanes.find(lane => lane.owner.kind === 'link' && lane.owner.id === link.id && lane.tier === authority && lane.kind !== 'span');
      if (parentTier !== authority && (!lane || link.bundle)) continue;
      result.push({ parent, child, link: link.id, x: lane ? lane.x : parent.anchor!.x,
        key: portId(parent.ref), transit: Boolean(lane) });
    }
    // A side lane is one feed of its link: the far port is the child and sits under the lane's x (side-faces.md, Section 10, *The far port*).
    const side = model.lanes.find(lane => isSideLane(lane) && lane.owner.kind === 'link' && lane.owner.id === link.id);
    if (side) {
      const farRef = sideLaneSource(link, side), lateralRef = side.port!;
      const farTier = nodeTier(model, farRef.node);
      if (farTier === tier && ![farRef.node, lateralRef.node].some(id => model.groups[model.document.nodes[id]!.group]!.flank)) {
        result.push({ parent: findPort(model, lateralRef)!, child: findPort(model, farRef)!, link: link.id, x: side.x, key: portId(lateralRef), transit: true });
      }
    }
    // An aligned perimeter lane is one feed of its link as well: the natural end of the course is the child and sits under the lane's x, so the drop into
    // its face has no turn (architecture ticket 15, phase 4). A course that promises the drop reserves this feed with its lane.
    const course = courseOf(model, link.id), perimeter = model.lanes.find(lane => lane.kind === 'perimeter' && lane.aligned === true && lane.owner.kind === 'link' && lane.owner.id === link.id);
    if (course !== undefined && perimeter !== undefined) {
      for (const [which, other] of [['from', 'to'], ['to', 'from']] as const) {
        if (endMode(course, which) !== 'natural' || nodeTier(model, link.attachments[which].node) !== tier) continue;
        const childRef = link.attachments[which], parentRef = link.attachments[other];
        if ([childRef.node, parentRef.node].some(id => model.groups[model.document.nodes[id]!.group]!.flank)) continue;
        const child = findPort(model, childRef)!, parent = findPort(model, parentRef)!;
        if (child.side !== (nodeTier(model, parentRef.node)! < tier ? 'top' : 'bottom')) continue;
        result.push({ parent, child, link: link.id, x: perimeter.x, key: portId(parentRef), transit: true });
      }
    }
  }
  return result;
}

/** The two ends of the routed feed links of one unit against the tier packed before it. */
export interface UnitFeeds {
  /** The x of each distinct port of the tier before, by port id. */
  parents: Map<string, number>;
  /** The x of each distinct port of the unit, by port id, with the cell that holds it. */
  children: Map<string, { x: number; cell: string }>;
}

/**
 * The feeds of a unit towards `sources`, the groups of the tier that is packed before it. `below` says the unit stands
 * below them: its ports on the side that faces them are the top ones. The inner pass of a canton (ticket 56) reads the
 * sources off the tier of another member, or off the tier outside the canton for the member tier nearest the anchor.
 */
export function columnPullFeeds(model: LayoutModel, sources: ReadonlySet<string>, below: boolean): (unit: { groups: readonly LayoutGroup[] }) => UnitFeeds {
  return unit => {
    const parents = new Map<string, number>(), children = new Map<string, { x: number; cell: string }>();
    const mine = new Set(unit.groups.map(group => group.id));
    for (const link of model.links) {
      if (link.layer !== 'routed' || link.technique === 'stub' || !link.attachments) continue;
      for (const [own, other] of [[link.attachments.from, link.attachments.to], [link.attachments.to, link.attachments.from]]) {
        const ownGroup = model.document.nodes[own!.node]?.group, otherGroup = model.document.nodes[other!.node]?.group;
        if (ownGroup === undefined || otherGroup === undefined || !mine.has(ownGroup)) continue;
        const ownTier = model.groups[ownGroup]!.tier!, otherTier = model.groups[otherGroup]!.tier;
        const near = below ? ownTier - 1 : ownTier + 1;
        // A parent beyond the sources, on their side, is admitted when its link transits the sub-tier `near` through an owned lane: `centringFeeds`
        // admits every parent on the authority side, and the pull must read the same feeds (ticket 69). A bundle member has no lane.
        const beyond = !sources.has(otherGroup) && otherTier !== undefined && !model.groups[otherGroup]!.flank && (below ? otherTier < near : otherTier > near);
        if (!sources.has(otherGroup) && !beyond) continue;
        const child = findPort(model, own!), parent = findPort(model, other!);
        if (!child?.anchor || !parent?.anchor) continue;
        if (child.side !== (below ? 'top' : 'bottom') || parent.side !== (below ? 'bottom' : 'top')) continue;
        // A link that transits the sub-tier next to the sub-tier of the child (7a) reaches it through its owned lane, and centring (`centringFeeds`)
        // puts the child under that lane, not under the parent port. Both rules read one x, or the last to run
        // wins and a second pass flips the child back (ranked-groups ticket 64). A bundle member carries no lane here.
        const lane = otherTier === near || link.bundle ? undefined
          : model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === link.id && item.tier === near && item.kind !== 'span');
        if (beyond && lane === undefined) continue;
        children.set(portId(child.ref), { x: child.anchor.x, cell: ownGroup });
        parents.set(portId(parent.ref), lane?.x ?? parent.anchor.x);
      }
    }
    return { parents, children };
  };
}

