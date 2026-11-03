import type { AlignmentDeclineReason, AlignmentTarget, LayoutLink, LayoutModel } from '../model/layout.js';
import type { Feed } from './read/feeds.js';
import { faceKey } from './turn-order.js';
import { portId } from './skeleton-graph.js';
import { chordKind, isRoutedChord } from './frame-paths.js';

/**
 * The alignment-target record of the centring steps (architecture-2 ticket 66, `LayoutModel.alignmentTargets`). One producer writes it, the end of
 * each centring step (`writeAlignmentTargets`); the vertical tally of ticket 65 reads its declined entries (`declinedTargets`); the publication
 * check refuses a malformed record (`alignmentTargetsFault`) and names a decline its own replay writes that the record lacks (`sameDeclines`).
 */

/** The reasons a step declines a target, in the order the kept branch reads them: ticket 65's post-conditions, then the overlay guard. */
export const ALIGNMENT_DECLINE_REASONS: readonly AlignmentDeclineReason[] = ['riser', 'lane-crossing', 'span', 'chord-clearance', 'overlay-straight'];
/** The model stages at which the record must be there: from the centre rule's output to the input of 7f (the bands rule). */
const RECORD_STAGES: readonly string[] = ['centre', 'bars', 'bundles'];

/** What one step learned about its targets, read by the writer at the step's end on whatever geometry the step leaves. */
export interface TargetNotes {
  /** The feed of each wanted child port, and the x it wants (`groupFeeds`). */
  seats: ReadonlyMap<string, Feed>;
  wanted: ReadonlyMap<string, number>;
  /** The body edges, from the wanted x, of each target `alignSide` widened the body toward in this step. */
  grown: Map<string, { low: number; high: number }>;
  /** The body edges, from the wanted x, of each wanted port where the step began: the room of a target that stood and that the step moves off. */
  start: Map<string, { low: number; high: number }>;
  /** The targets the kept branch refused to keep, with the guard or post-condition and its key. */
  declined: Map<string, { reason: AlignmentDeclineReason; by: string }>;
}

/** The direct members of the direct families: a direct member owes a vertical even as a held cross chord. */
export const directMembers = (model: LayoutModel): Set<string> =>
  new Set((model.directFamilies ?? []).flatMap(family => family.members.filter(member => member.mode === 'direct').map(member => member.link)));

/**
 * Whether a feed owes a vertical (ticket 65): its link is an orthogonal link, a frame chord or a direct member. A held cross-frame chord owes none
 * (CONTEXT.md: any angle). One predicate for the tally and the record.
 */
export function owesVertical(model: LayoutModel, link: LayoutLink | undefined, direct: ReadonlySet<string>): boolean {
  return link === undefined || !isRoutedChord(model, link) || chordKind(model, link) !== 'cross' || direct.has(link.id);
}

/** Where a feed's x is read: the far port, or the lane of a transit feed (the lane of the feed's link that stands at the feed's x). */
export function feedFar(model: LayoutModel, feed: Feed): string {
  if (!feed.transit) return portId(feed.parent.ref);
  const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === feed.link && item.x === feed.x);
  if (lane === undefined) throw new Error(`The transit feed ${feed.link} has no lane at x ${feed.x}`);
  return `lane:${lane.id}`;
}

/**
 * The wanted ports of `nodes` whose target is declined. From the centre rule's output to the input of 7f the record must be there: a model
 * without it is refused (R6). Before 7c and after 7f (the record is dropped) absent says no target is declined.
 */
export function declinedTargets(model: LayoutModel, nodes: readonly string[]): Set<string> {
  const record = model.alignmentTargets;
  if (record === undefined) {
    if (RECORD_STAGES.includes(model.stage)) throw new Error(`The alignment targets are undecided at stage ${model.stage}`);
    return new Set();
  }
  const result = new Set<string>();
  for (const node of nodes) for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    for (const entry of record[faceKey(node, side)] ?? []) if (entry.state === 'declined') result.add(entry.port);
  }
  return result;
}

const byPort = (a: AlignmentTarget, b: AlignmentTarget): number => (a.port < b.port ? -1 : a.port > b.port ? 1 : 0);
/** An entry without its pass: what a replay must write again. */
const decided = (entry: AlignmentTarget): string => JSON.stringify({ ...entry, pass: 0 });

/**
 * Writes the targets of one step at its end, read on the geometry the step leaves (all exits: it stood, the window or a post-condition declined it,
 * the guard of ticket 75 undid it). Each wanted port: a declined entry stays (final for the attempt); a target the kept branch refused is
 * `declined`; one that stands (miss <= 0.5 px, as `unresolved` reads it) is `kept`; one the step grew the body toward, or one that was kept or
 * grown before, is `grown` with its room. A port that is no target in any state has no entry. Every face of the group that has entries is
 * written again, so a face whose feeds yielded keeps only its declined entries (or `[]`). An entry whose decision does not change keeps the pass
 * that wrote it. No record (before 7c, after 7f): nothing is written.
 */
export function writeAlignmentTargets(model: LayoutModel, nodes: readonly string[], notes: TargetNotes, pass: number): void {
  const record = model.alignmentTargets;
  if (record === undefined) return;
  const links = new Map(model.links.map(link => [link.id, link]));
  let direct: Set<string> | undefined;
  const faces = new Map<string, AlignmentTarget[]>();
  for (const node of nodes) for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const key = faceKey(node, side);
    if (record[key] !== undefined) faces.set(key, []);
  }
  const anchors = new Map<string, number>();
  for (const node of nodes) for (const port of model.nodes[node]!.ports) {
    const key = portId(port.ref);
    if (port.anchor && !anchors.has(key)) anchors.set(key, port.anchor.x);
  }
  for (const [key, want] of notes.wanted) {
    const feed = notes.seats.get(key)!, x = anchors.get(key);
    if (x === undefined) continue;
    const face = faceKey(feed.child.ref.node, feed.child.side!);
    const list = faces.get(face) ?? [];
    faces.set(face, list);
    const was = record[face]?.find(entry => entry.port === key);
    if (was?.state === 'declined') { list.push(was); continue; }
    const base = { port: key, link: feed.link, far: feedFar(model, feed), owes: owesVertical(model, links.get(feed.link), direct ??= directMembers(model)) ? 'vertical' as const : 'any' as const, pass };
    const refused = notes.declined.get(key);
    let entry: AlignmentTarget | undefined;
    if (refused !== undefined) entry = { ...base, state: 'declined', reason: refused.reason, by: refused.by };
    else if (Math.abs(x - want) <= 0.5) entry = { ...base, state: 'kept' };
    else {
      const extent = notes.grown.get(key) ?? (was?.state === 'grown' ? was.extent : was?.state === 'kept' ? notes.start.get(key) : undefined);
      if (extent !== undefined) entry = { ...base, state: 'grown', extent: { low: extent.low, high: extent.high } };
    }
    if (entry === undefined) continue;
    list.push(was !== undefined && decided(was) === decided(entry) ? was : entry);
  }
  // A declined target whose feed this step does not want stays declined: the decline is final for the placement attempt.
  for (const [face, list] of faces) {
    for (const entry of record[face] ?? []) if (entry.state === 'declined' && !list.some(item => item.port === entry.port)) list.push(entry);
    // Port-key order (R3): the last key, as a port id is unique on its face.
    record[face] = list.sort(byPort);
  }
}

/**
 * Whether a replay of a step writes no decline the stored face lacks (the publication check, R1/R5). A decline is the one decision of the record:
 * final, and read by the tally. `kept` and `grown` are where the targets stood when the producer's last step on the group ended, and a move
 * after it (the parent stand, a region rebuild, a 7f move) can leave them behind without a decision changing, so they are not compared.
 * A stored decline the replay drops cannot happen (the writer keeps a decline); one it writes again equal is the same decision.
 */
export function sameDeclines(stored: readonly AlignmentTarget[] | undefined, replayed: readonly AlignmentTarget[] | undefined): boolean {
  const kept = new Set((stored ?? []).filter(entry => entry.state === 'declined').map(decided));
  return (replayed ?? []).every(entry => entry.state !== 'declined' || kept.has(decided(entry)));
}

/**
 * The first fault of a stored record, or undefined (R5): a face of a node in the model, a port on that face, a link that ends at it, a far end
 * that exists (the link's other port, or a lane of the link), the enum values and the fields each state carries, port-key order and no repeat.
 */
export function alignmentTargetsFault(model: LayoutModel): string | undefined {
  const record = model.alignmentTargets;
  if (record === undefined) return undefined;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'the record is not an object';
  const links = new Map(model.links.map(link => [link.id, link]));
  const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
  for (const [face, list] of Object.entries(record)) {
    const cut = face.lastIndexOf('|'), node = model.nodes[face.slice(0, cut)], side = face.slice(cut + 1);
    if (cut < 0 || node === undefined || !['top', 'bottom', 'left', 'right'].includes(side)) return `${face} is no node face`;
    if (!Array.isArray(list)) return `${face} holds no list`;
    for (const [index, entry] of list.entries()) {
      const at = `${face} entry ${index}`;
      if (entry === null || typeof entry !== 'object') return `${at} is no entry`;
      const port = node.ports.find(item => item.side === side && portId(item.ref) === entry.port);
      if (port === undefined) return `${at}: ${String(entry.port)} is no port on the face`;
      if (index > 0 && !(list[index - 1]!.port < entry.port)) return `${at}: ${entry.port} is out of port-key order or repeated`;
      const link = links.get(entry.link);
      const ends = link?.attachments ? [link.attachments.from, link.attachments.to] : [];
      const mine = ends.findIndex(end => portId(end) === entry.port);
      if (link === undefined || mine < 0) return `${at}: ${String(entry.link)} does not end at ${entry.port}`;
      if (typeof entry.far !== 'string') return `${at}: no far end`;
      if (entry.far.startsWith('lane:')) {
        const lane = entry.far.slice('lane:'.length);
        if (!model.lanes.some(item => item.id === lane && item.owner.kind === 'link' && item.owner.id === link.id)) return `${at}: ${entry.far} is no lane of ${link.id}`;
      } else if (portId(ends[1 - mine]!) !== entry.far) return `${at}: ${entry.far} is not the far end of ${link.id}`;
      if (entry.owes !== 'vertical' && entry.owes !== 'any') return `${at}: owes ${String(entry.owes)}`;
      if (!Number.isInteger(entry.pass) || entry.pass < 0) return `${at}: pass ${String(entry.pass)}`;
      if (entry.state === 'declined') {
        if (!ALIGNMENT_DECLINE_REASONS.includes(entry.reason!) || typeof entry.by !== 'string' || !entry.by) return `${at}: a declined entry without its reason`;
        if (entry.extent !== undefined) return `${at}: a declined entry with an extent`;
      } else if (entry.state === 'grown') {
        if (entry.extent === undefined || !finite(entry.extent.low) || !finite(entry.extent.high) || entry.extent.low > entry.extent.high) return `${at}: a grown entry without its extent`;
        if (entry.reason !== undefined || entry.by !== undefined) return `${at}: a grown entry with a reason`;
      } else if (entry.state === 'kept') {
        if (entry.extent !== undefined || entry.reason !== undefined || entry.by !== undefined) return `${at}: a kept entry with a reason or an extent`;
      } else return `${at}: state ${String((entry as { state: unknown }).state)}`;
    }
  }
  return undefined;
}
