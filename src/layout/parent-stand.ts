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
 * A move is declined, and its link named, for one of three reasons, each with its own code: the port cannot reach the other end's x within its face
 * (`CENTRE_ALIGNMENT_INFEASIBLE`); the moves of its group together would change the offset the group step centres on by more than half a pixel, and the step
 * would shift the whole group (`CENTRE_PARENT_MOVE_SHIFTS_GROUP`); its face holds a port that stands on a corridor of its own, which the next pass would pack
 * again (`CENTRE_PARENT_MOVE_HELD_FACE`). A move that changes the offset is taken when the group fills the column of its frame and the step puts it at the same
 * x for both offsets (`stepTakesOffset`); the move is recorded (`CENTRE_PARENT_MOVE_AT_WALL`, information).
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
const DECLINES = {
  reach: { code: 'CENTRE_ALIGNMENT_INFEASIBLE', text: "its port cannot reach the other port's x within its face" },
  offset: { code: 'CENTRE_PARENT_MOVE_SHIFTS_GROUP', text: 'moving its port would change the offset its group is centred on and shift the group' },
  face: { code: 'CENTRE_PARENT_MOVE_HELD_FACE', text: 'its face holds a port that stands on a corridor of its own, which a move would pack again' },
} as const;
function name(model: LayoutModel, link: LayoutLink, why: keyof typeof DECLINES = 'reach'): void {
  const { code, text } = DECLINES[why];
  if (model.diagnostics.some(d => d.code === code && d.owners?.some(owner => 'id' in owner && owner.id === link.id))) return;
  placementWarning(model, code, `${link.id} keeps a jog: ${text}; routing completes it.`, [link.id]);
}

/**
 * The record of a move taken although it changes the offset its group step centres on: the group fills the column of its frame, so the step does not shift
 * it (`stepTakesOffset`). Information only; no validator reads it (`centreViolations` replays the step on the geometry, R5).
 */
function walled(model: LayoutModel, link: LayoutLink): void {
  if (model.diagnostics.some(d => d.code === 'CENTRE_PARENT_MOVE_AT_WALL' && d.owners?.some(owner => 'id' in owner && owner.id === link.id))) return;
  model.diagnostics.push({ stage: 'placement', severity: 'info', code: 'CENTRE_PARENT_MOVE_AT_WALL',
    message: `${link.id} stands straight: its port moved over the other port, and its group fills the column of its frame, so the group does not shift.`, owners: [{ kind: 'link', id: link.id }] });
}

/**
 * The order the movers of a face take: the ones that go left, from the left, then the ones that go right, from the right, each in engine order. A port moves
 * between neighbours as they stand, so the order, and not the order of `model.links`, decides what a face gives (review of ticket 15).
 */
function inFaceOrder<T>(items: T[], port: (item: T) => LayoutPort, target: (item: T) => number): T[] {
  const key = (item: T): string => `${port(item).ref.node}\u0000${port(item).side}`;
  const at = (item: T): number => port(item).engineOrder!;
  const left = (item: T): boolean => target(item) < port(item).anchor!.x;
  return [...items].sort((a, b) => key(a).localeCompare(key(b)) || Number(left(b)) - Number(left(a)) || (left(a) ? at(a) - at(b) : at(b) - at(a)));
}

/** What `standPortsOverChildren` reads of a group step (`centre.ts`): the feeds the step centres on, and whether a change of its offset shifts the group. */
export interface StepReader {
  /** The feeds the step of `group` centres on (the selection `centreGroupStepRaw` makes). */
  feeds: (tier: number, list: Feed[], group: string) => Feed[];
  /** Whether the step of `group` puts the group at the same x for the offsets `from` and `to` (`stepTakesOffset`): the group fills the column of its frame. */
  takes: (tier: number, list: Feed[], group: string, from: number, to: number) => boolean;
}

export function standPortsOverChildren(model: LayoutModel, steps: readonly { tier: number; authority: number }[], reader: StepReader): void {
  const read = faces(model), movers: { feed: Feed; parent: LayoutPort; target: number; wall: boolean }[] = [];
  const lists = steps.map(({ tier, authority }) => centringFeeds(model, tier, authority));
  const groupOf = (feed: Feed): string => model.document.nodes[feed.child.ref.node]!.group;
  const stepOf = (feed: Feed): number => lists.findIndex(list => list.includes(feed));
  /** Whether the step of the feed's group leaves the group where it is when its offset goes from `from` to `to`. */
  const takes = (feed: Feed, from: number, to: number): boolean => reader.takes(steps[stepOf(feed)]!.tier, lists[stepOf(feed)]!, groupOf(feed), from, to);
  /**
   * The offset a group step centres on: the mean x of its distinct parent ports against the mean x of its distinct child ports, over the feeds the step
   * itself centres on (`reader.feeds`, the selection `centreGroupStepRaw` makes). The ports in `moved` stand at their new x.
   */
  const offset = (feed: Feed, moved: ReadonlyMap<string, number>): number => {
    const at = stepOf(feed);
    const own = reader.feeds(steps[at]!.tier, lists[at]!, groupOf(feed));
    const parents = new Map(own.map(item => [item.key, moved.get(item.key) ?? item.x]));
    const children = new Map(own.map(item => [portId(item.child.ref), moved.get(portId(item.child.ref)) ?? item.child.anchor!.x]));
    const mean = (values: Iterable<number>): number => { const xs = [...values]; return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
    return mean(parents.values()) - mean(children.values());
  };
  /** The offset of each group step before any move: the moves of one group together may not change it by more than half a pixel. */
  const start = new Map<Feed, number>();
  const placed = new Map<string, number>();
  // In the order of the ports, not of the links: what an earlier move leaves in the offset decides the next.
  for (const feed of [...lists.flat()].sort((a, b) => portId(a.parent.ref).localeCompare(portId(b.parent.ref)) || portId(a.child.ref).localeCompare(portId(b.child.ref)))) {
    if (feed.transit || !read.eligible(feed)) continue;
    // The parent is the port of the upper tier, whichever side of the anchor tier the feed reads it on. A parent port with several links is a fan: the
    // first child by x owns the vertical, and the rest stay where the fan puts them.
    const [parent, child] = read.upper(feed.parent, feed.child);
    if (!read.sole(parent) || Math.abs(parent.anchor!.x - child.anchor!.x) <= 0.5) continue;
    // A move is free only when the step of the group cannot follow it: the offset the step centres on stays where it was, or the group fills the column of
    // its frame and the step puts it at the same x for both offsets (`stepTakesOffset`). Otherwise the group would shift, and every other port of it would
    // leave its feed: the move is declined.
    if (!start.has(feed)) start.set(feed, offset(feed, new Map()));
    const after = offset(feed, new Map([...placed, [portId(parent.ref), child.anchor!.x]]));
    const wall = Math.abs(after - start.get(feed)!) > 0.5;
    if (wall && !takes(feed, start.get(feed)!, after)) {
      name(model, read.linkOf.get(feed.link)!, 'offset');
      continue;
    }
    placed.set(portId(parent.ref), child.anchor!.x);
    movers.push({ feed, parent, target: child.anchor!.x, wall });
  }
  // Only the parent port moves: the child side is `alignSide`'s, which may also widen the body and so answers to the widening allowance.
  // A port with a corridor of its own stands where 7a put the corridor, and the next pass packs the ports next to a moved one again (`alignSide` places a
  // port that has no target of its own between the kept ones): a face that holds such a port, other than a mover, keeps its ports where they stand.
  const corridor = new Set(model.lanes.filter(lane => lane.owner.kind === 'link').map(lane => (lane.owner as { id: string }).id));
  const movingPorts = new Set(movers.map(item => item.parent));
  const held = (parent: LayoutPort): boolean => model.nodes[parent.ref.node]!.ports.some(port => port.side === parent.side && !movingPorts.has(port)
    && model.links.some(link => corridor.has(link.id) && link.attachments && [link.attachments.from, link.attachments.to].some(end => portId(end) === portId(port.ref))));
  for (const { feed, parent, target, wall } of inFaceOrder(movers, item => item.parent, item => item.target)) {
    if (held(parent)) name(model, read.linkOf.get(feed.link)!, 'face');
    else if (read.reaches(parent, target)) {
      read.place(parent, target);
      if (wall) walled(model, read.linkOf.get(feed.link)!);
    } else name(model, read.linkOf.get(feed.link)!);
  }
}

/** What `seatLaneSources` did, to be taken back when the corridor reseat is refused, and to be named when the link keeps its jog. */
export interface LaneSources { undo: () => void; reconcile: () => void; settle: (model: LayoutModel) => void }
/**
 * The source port of a transit corridor goes over the port the corridor follows, so that the corridor's reseat gives a straight link and not the same jog
 * at the other end. Only a link with one corridor, whose source port carries no other link and can reach the child's x, is seated. `reconcile` runs after
 * `reseatLanes`, which skips a link for reasons of its own (a shared end, a foreign frame, a corridor that is not free, a feed order that would break):
 * a source port whose corridor did not follow goes back, so that no link jogs at both ends.
 */
export function seatLaneSources(model: LayoutModel, steps: readonly { tier: number; authority: number }[]): LaneSources {
  const read = faces(model), moved: { ref: PortRef; x: number; target: number; link: string }[] = [], pending: { link: string; source: PortRef; child: PortRef }[] = [];
  const wanted: { feed: Feed; target: number }[] = [];
  for (const feed of read.feeds(steps)) {
    if (!feed.transit || !read.eligible(feed) || !read.sole(feed.parent)) continue;
    const lanes = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === feed.link);
    if (lanes.length !== 1 || laneRunKind(lanes[0]!) !== 'transit') continue;
    if (Math.abs(feed.child.anchor!.x - feed.parent.anchor!.x) <= 0.5) continue;
    pending.push({ link: feed.link, source: feed.child.ref, child: feed.parent.ref });
    if (read.sole(feed.child)) wanted.push({ feed, target: feed.parent.anchor!.x });
  }
  for (const { feed, target } of inFaceOrder(wanted, item => item.feed.child, item => item.target)) {
    if (!read.reaches(feed.child, target)) continue;
    moved.push({ ref: feed.child.ref, x: feed.child.anchor!.x, target, link: feed.link });
    read.place(feed.child, target);
  }
  const at = (m: LayoutModel, ref: PortRef): number => findPort(m, ref)!.anchor!.x;
  return {
    undo() { for (const item of moved.splice(0).reverse()) read.place(findPort(model, item.ref)!, item.x); },
    reconcile() {
      for (const item of [...moved].reverse()) {
        const lane = model.lanes.find(candidate => candidate.owner.kind === 'link' && candidate.owner.id === item.link);
        if (lane !== undefined && Math.abs(lane.x - item.target) <= 0.5) continue;
        read.place(findPort(model, item.ref)!, item.x);
        moved.splice(moved.indexOf(item), 1);
      }
    },
    settle(final) {
      // A link whose corridor does not stand at both ports is a jog the layout knew about; the lane x is the feed x of the source. A link that stands has no
      // such finding left.
      for (const item of pending) {
        const lane = final.lanes.find(candidate => candidate.owner.kind === 'link' && candidate.owner.id === item.link);
        if (lane === undefined || Math.abs(at(final, item.source) - lane.x) > 0.5 || Math.abs(at(final, item.child) - lane.x) > 0.5) name(final, final.links.find(link => link.id === item.link)!);
        else final.diagnostics = final.diagnostics.filter(d => !(d.code === 'CENTRE_ALIGNMENT_INFEASIBLE' && d.message.startsWith(`${item.link} keeps a jog`) && d.owners?.some(owner => 'id' in owner && owner.id === item.link)));
      }
    },
  };
}
