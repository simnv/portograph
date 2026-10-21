import type { LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import type { PortRef } from '../model/document.js';
import { EPS } from '../geometry/planar.js';
import { portAnchor } from '../geometry/index.js';
import { centringFeeds, type Feed } from './read/feeds.js';
import { isRoutedChord } from './frame-paths.js';
import { laneRunKind } from './lane-kind.js';
import { findPort } from './row-paths.js';
import { orderedNodeIds } from '../model/model.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { placementWarning } from './regions.js';
import { nodeTier } from './read/tier.js';
import { portId } from './skeleton-graph.js';

/**
 * A port with one link stands over the port it feeds (architecture ticket 15). Centring aligns the child side only: the row repack and the window
 * clamp then move the child, and nothing moved the other port back, so the link got a jog its face had room to avoid. Both passes below read the
 * same feeds (`centringFeeds`) the centring passes and the publication check read, and a port moves only along its face: between its neighbours (one
 * pitch from each) and inside the end insets `alignSide` keeps, so the port order and the body do not change.
 *
 * `standPortsOverChildren` runs after the last centring pass, for the feeds that need no corridor. A feed that rides a transit corridor is
 * `seatLaneSources`', which runs inside the corridor reseat of 7f: the corridor may move only there (every centring replay reads its x as the feed x),
 * and the source port and the corridor have to move together.
 *
 * A port that cannot reach the other end's x stays, and the link is named `CENTRE_ALIGNMENT_INFEASIBLE`.
 */
function faces(model: LayoutModel) {
  const count = new Map<string, number>();
  for (const link of model.links) {
    if (!link.attachments) continue;
    for (const end of [link.attachments.from, link.attachments.to]) count.set(portId(end), (count.get(portId(end)) ?? 0) + 1);
  }
  const isBar = (node: string): boolean => model.document.groups[model.document.nodes[node]!.group]!.shape === 'bar';
  const linkOf = new Map(model.links.map(link => [link.id, link]));
  /** The x range a port can take on its face without moving a neighbour or the body. */
  const room = (port: LayoutPort): { low: number; high: number } => {
    const node = model.nodes[port.ref.node]!, side = port.side!, box = node.bounds!, pitch = node.sidePitch![side]!, inset = 10 + pitch / 2;
    const ports = node.ports.filter(item => item.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
    const index = ports.findIndex(item => item === port);
    return { low: index === 0 ? box.x + inset : ports[index - 1]!.anchor!.x + pitch, high: index === ports.length - 1 ? box.x + box.width - inset : ports[index + 1]!.anchor!.x - pitch };
  };
  return {
    linkOf,
    place(port: LayoutPort, x: number): void {
      const box = model.nodes[port.ref.node]!.bounds!;
      port.anchor = portAnchor(box, port.side!, x - box.x);
      rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
    },
    /** Whether the port may stand at `x`: centring never moves the anchor tier or a flank (`mutation.ts`), so their ports stay where they are. */
    reaches(port: LayoutPort, x: number): boolean {
      const group = model.groups[model.document.nodes[port.ref.node]!.group]!;
      if (group.tier === model.anchorTier || group.flank) return false;
      const { low, high } = room(port);
      return x >= low - EPS && x <= high + EPS;
    },
    /** The two ends of a feed as (upper, lower) by the tier of their nodes. */
    upper: (one: LayoutPort, two: LayoutPort): [LayoutPort, LayoutPort] => nodeTier(model, one.ref.node) <= nodeTier(model, two.ref.node) ? [one, two] : [two, one],
    sole: (port: LayoutPort): boolean => count.get(portId(port.ref)) === 1,
    eligible: (feed: Feed): boolean => {
      const link = linkOf.get(feed.link)!;
      return !link.bundle && link.technique !== 'mesh-bus' && !isRoutedChord(model, link) && !isBar(feed.parent.ref.node) && !isBar(feed.child.ref.node);
    },
    feeds: (steps: readonly { tier: number; authority: number }[]): Feed[] => steps.flatMap(({ tier, authority }) => centringFeeds(model, tier, authority)),
  };
}
function name(model: LayoutModel, link: LayoutLink): void {
  if (model.diagnostics.some(d => d.code === 'CENTRE_ALIGNMENT_INFEASIBLE' && d.owners?.some(owner => 'id' in owner && owner.id === link.id))) return;
  placementWarning(model, 'CENTRE_ALIGNMENT_INFEASIBLE', `${link.id} keeps a jog: neither of its ports can reach the other's x within its face; routing completes it.`, [link.id]);
}

export function standPortsOverChildren(model: LayoutModel, steps: readonly { tier: number; authority: number }[]): void {
  const read = faces(model);
  for (const feed of read.feeds(steps)) {
    if (feed.transit || !read.eligible(feed)) continue;
    // The parent is the port of the upper tier, whichever side of the anchor tier the feed reads it on. A parent port with several links is a fan: the
    // first child by x owns the vertical, and the rest stay where the fan puts them.
    const [parent, child] = read.upper(feed.parent, feed.child);
    if (!read.sole(parent)) continue;
    const parentAt = parent.anchor!.x, childAt = child.anchor!.x;
    if (Math.abs(parentAt - childAt) <= 0.5) continue;
    // Only the parent port moves: the child side is `alignSide`'s, which may also widen the body and so answers to the widening allowance.
    if (read.reaches(parent, childAt)) read.place(parent, childAt);
    else name(model, read.linkOf.get(feed.link)!);
  }
}

/** What `seatLaneSources` did, to be taken back when the corridor reseat is refused, and to be named when the link keeps its jog. */
export interface LaneSources { undo: () => void; settle: (model: LayoutModel) => void }
/**
 * The source port of a transit corridor goes over the port the corridor follows, so that the corridor's reseat gives a straight link and not the same jog
 * at the other end. Only a link with one corridor, whose source port carries no other link and can reach the child's x, is seated.
 */
export function seatLaneSources(model: LayoutModel, steps: readonly { tier: number; authority: number }[]): LaneSources {
  const read = faces(model), moved: { ref: PortRef; x: number }[] = [], pending: { link: string; source: PortRef; child: PortRef }[] = [];
  for (const feed of read.feeds(steps)) {
    if (!feed.transit || !read.eligible(feed) || !read.sole(feed.parent)) continue;
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === feed.link);
    if (lanes.length !== 1 || laneRunKind(lanes[0]!) !== 'transit') continue;
    const sourceAt = feed.child.anchor!.x, target = feed.parent.anchor!.x;
    if (Math.abs(sourceAt - target) <= 0.5) continue;
    pending.push({ link: feed.link, source: feed.child.ref, child: feed.parent.ref });
    if (!read.sole(feed.child) || !read.reaches(feed.child, target)) continue;
    moved.push({ ref: feed.child.ref, x: sourceAt });
    read.place(feed.child, target);
  }
  const at = (m: LayoutModel, ref: PortRef): number => findPort(m, ref)!.anchor!.x;
  return {
    undo() { for (const item of moved.splice(0)) read.place(findPort(model, item.ref)!, item.x); },
    settle(final) {
      // A link whose corridor does not stand at both ports is a jog the layout knew about; the lane x is the feed x of the source.
      for (const item of pending) {
        const lane = final.lanes.find(candidate => candidate.owner.kind === 'link' && candidate.owner.id === item.link);
        if (lane === undefined || Math.abs(at(final, item.source) - lane.x) > 0.5 || Math.abs(at(final, item.child) - lane.x) > 0.5) name(final, final.links.find(link => link.id === item.link)!);
      }
    },
  };
}
