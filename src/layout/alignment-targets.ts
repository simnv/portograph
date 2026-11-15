import type { AlignmentDeclineReason, AlignmentSeat, AlignmentTarget, LayoutLink, LayoutModel } from '../model/layout.js';
import { withinAlignmentCap } from './size.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { readCache } from '../model/read-cache.js';
import type { Feed } from './read/feeds.js';
import { faceKey } from './turn-order.js';
import { portId } from './skeleton-graph.js';
import { chordKind, isRoutedChord } from './frame-paths.js';
import { linkById } from './peers.js';

/**
 * The alignment-target record of the centring steps (architecture-2 ticket 66, `LayoutModel.alignmentTargets`). One producer writes it, the end of
 * each centring step (`writeAlignmentTargets`); the vertical tally of ticket 65 reads its declined entries (`declinedTargets`); the publication
 * check refuses a malformed record (`alignmentTargetsFault`) and names a decline its own replay writes that the record lacks (`sameDeclines`).
 */

/** The reasons a step declines a target, in the order the kept branch reads them: ticket 65's post-conditions, then the overlay guard. */
export const ALIGNMENT_DECLINE_REASONS: readonly AlignmentDeclineReason[] = ['riser', 'lane-crossing', 'span', 'chord-clearance', 'overlay-straight', 'cap'];
/** The model stages at which the record may be there: from the centre rule's output to the output of 7f (the bands rule); the route rule drops it. */
const RECORD_STAGES: readonly string[] = ['centre', 'bars', 'bundles', 'bands'];
/** The finding of the publication check: a face where the replay declines a target the record does not. */
export const ALIGNMENT_TARGETS_DIFFER = 'alignment-targets-differ';

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
  /** The seats of the step that changed a body (ADR-0027), by node id: the slide, the width before and after, and the ports they stood. */
  seated: Map<string, Omit<AlignmentSeat, 'pass'>>;
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
 * Test only: a sink for the record's events (the kept branch's verdict, the record 7f publishes). Unset in production; the layout never reads it.
 * Its own tap, not `verdictTap`: these are no judges, and the verdict digests of the judges must not move for them.
 */
export const targetTap: { sink?: (name: string, value: string) => void } = {};
/** Gives an event to the test sink, when there is one. `value` is built only then. */
export function tapTarget(name: string, value: () => string): void {
  if (targetTap.sink !== undefined) targetTap.sink(name, value());
}

/**
 * The wanted ports of `nodes` whose target is declined. Absent says no target is declined: a model before 7c, a routed model, or one whose
 * centre rule ran no producer (a hand-made transaction; `centreDraft` names that case, `ALIGNMENT_TARGETS_UNDECIDED`).
 */
export function declinedTargets(model: LayoutModel, nodes: readonly string[], reason?: AlignmentDeclineReason): Set<string> {
  const record = model.alignmentTargets;
  if (record === undefined) return new Set();
  const result = new Set<string>();
  for (const node of nodes) for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    for (const entry of record[faceKey(node, side)] ?? []) if (entry.state === 'declined' && (reason === undefined || entry.reason === reason)) result.add(entry.port);
  }
  return result;
}

const SIDES = ['top', 'bottom', 'left', 'right'] as const;
/**
 * The links by id and the direct members, per link list: the writer runs after every step, and the list and the families do not change while
 * the steps run (a new list or a new family list is read again).
 */
const indexes = new WeakMap<readonly LayoutLink[], { families: unknown; links: ReadonlyMap<string, LayoutLink>; direct: Set<string> }>();
const linkIndexCache = readCache('alignmentLinkIndex');
function computeLinkIndex(model: LayoutModel): { families: unknown; links: ReadonlyMap<string, LayoutLink>; direct: Set<string> } {
  return { families: model.directFamilies, links: linkById(model), direct: directMembers(model) };
}
function linkIndex(model: LayoutModel): { links: ReadonlyMap<string, LayoutLink>; direct: Set<string> } {
  const known = indexes.get(model.links);
  if (known !== undefined && known.families === model.directFamilies) {
    return linkIndexCache.hit(model, known, () => computeLinkIndex(model));
  }
  linkIndexCache.miss();
  const fresh = computeLinkIndex(model);
  indexes.set(model.links, fresh);
  return fresh;
}
const byPort = (a: AlignmentTarget, b: AlignmentTarget): number => (a.port < b.port ? -1 : a.port > b.port ? 1 : 0);
/** An entry without its pass, field by field (no key order): what a replay must write again. */
const decided = (entry: AlignmentTarget): string => JSON.stringify([entry.port, entry.link, entry.far, entry.owes, entry.state, entry.reason ?? null, entry.by ?? null,
  entry.extent?.low ?? null, entry.extent?.high ?? null]);

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
  if (record === undefined || (!notes.wanted.size && !nodes.some(node => SIDES.some(side => record[faceKey(node, side)] !== undefined)))) return;
  const { links, direct } = linkIndex(model);
  const faces = new Map<string, AlignmentTarget[]>();
  for (const node of nodes) for (const side of SIDES) {
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
    // A wanted port has an anchor from 7a on (`misses` reads it the same way); one without it has no x to judge.
    if (x === undefined) continue;
    const face = faceKey(feed.child.ref.node, feed.child.side!);
    const list = faces.get(face) ?? [];
    faces.set(face, list);
    const was = record[face]?.find(entry => entry.port === key);
    // A decline of a guard is final; a `cap` decline is the last seat's (ADR-0027): the next step decides the seat again.
    if (was?.state === 'declined' && was.reason !== 'cap') { list.push(was); continue; }
    const base = { port: key, link: feed.link, far: feedFar(model, feed), owes: owesVertical(model, links.get(feed.link), direct) ? 'vertical' as const : 'any' as const, pass };
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
    for (const entry of record[face] ?? []) if (entry.state === 'declined' && entry.reason !== 'cap' && !list.some(item => item.port === entry.port)) list.push(entry);
    // Port-key order (R3): the last key, as a port id is unique on its face.
    record[face] = list.sort(byPort);
  }
}

/**
 * Whether a replay of a step writes no decline the stored face lacks (the publication check, R1/R5). A decline is the one decision of the record:
 * final, and read by the tally. `kept` and `grown` are where the targets stood when the producer's last step on the group ended, and a move
 * after it (the parent stand, a region rebuild, a 7f move) can leave them behind without a decision changing, so they are not compared.
 * A stored decline the replay drops cannot happen (the writer keeps a decline); one it writes again equal is the same decision. A `cap`
 * decline is not compared: the seat reads no stored decline, and the writer does not keep a `cap` decline, so it is a note of where the body
 * stood, not a decision, and a replay from a later body width names another target.
 */
export function sameDeclines(stored: readonly AlignmentTarget[] | undefined, replayed: readonly AlignmentTarget[] | undefined): boolean {
  const kept = new Set((stored ?? []).filter(entry => entry.state === 'declined').map(decided));
  return (replayed ?? []).every(entry => entry.state !== 'declined' || entry.reason === 'cap' || kept.has(decided(entry)));
}

/**
 * The first fault of a stored record, or undefined (R5): a record outside the stages it lives at; a face of a node in the model, a port on that face, a link that ends at it, a far end
 * that exists (the link's other port, or a lane of the link), the enum values and the fields each state carries, port-key order and no repeat.
 */
export function alignmentTargetsFault(model: LayoutModel): string | undefined {
  const record = model.alignmentTargets;
  // The record lives from the centre rule's output to the output of 7f; before and after it is no record of anything. Absent is undecided.
  if (record === undefined) return undefined;
  if (!RECORD_STAGES.includes(model.stage)) return `a record at stage ${model.stage}`;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'the record is not an object';
  const links = linkById(model);
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
        // Only 7f declines for a guard (its draft is the first at a chord stage): such a decline in a model before its output was written by no
        // producer. The cap declines from the centre rule on (ADR-0027).
        if (model.stage !== 'bands' && entry.reason !== 'cap') return `${at}: a decline at stage ${model.stage}, before 7f`;
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

/**
 * Writes the seats of one step that stood (ADR-0027, `LayoutModel.alignmentSeats`): each node whose seat slid or grew its body gets the seat, with
 * the pass. A node whose seat changed nothing keeps its entry and the pass that wrote it. No record (before 7c, after 7f): nothing is written.
 */
export function writeAlignmentSeats(model: LayoutModel, seated: ReadonlyMap<string, Omit<AlignmentSeat, 'pass'>>, pass: number): void {
  const record = model.alignmentSeats;
  if (record === undefined) return;
  for (const [node, seat] of seated) record[node] = { dx: seat.dx, from: seat.from, width: seat.width, ports: [...seat.ports], pass };
}

/**
 * Whether one end of `link` stands where it stands only by a seat that slid its body (ADR-0027): the port is one its node's recorded seat stood,
 * and that seat moved the body. Read by the acceptance gate of the fan wrap (ruling of 2026-11-15): a link the plain run stands straight only
 * by such a move is not counted as lost by the two lines.
 */
export function standsBySeatMove(model: LayoutModel, link: LayoutLink): boolean {
  if (!link.attachments || model.alignmentSeats === undefined) return false;
  return [link.attachments.from, link.attachments.to].some(end => {
    const seat = Object.hasOwn(model.alignmentSeats!, end.node) ? model.alignmentSeats![end.node] : undefined;
    return seat !== undefined && Math.abs(seat.dx) > PLACEMENT_EPS && seat.ports.includes(portId(end));
  });
}

/**
 * The first fault of a stored seat record, or undefined (R5): a record outside the stages it lives at, a key that is no node, a field that is
 * not a finite number, a width below the width before, a seat that grew a body past the alignment cap (`withinAlignmentCap` on the faces
 * whose ports it stood), a port list that is empty, out of port-key order, repeated or names a port the node does not have on its top or
 * bottom face.
 */
export function alignmentSeatsFault(model: LayoutModel): string | undefined {
  const record = model.alignmentSeats;
  if (record === undefined) return undefined;
  if (!RECORD_STAGES.includes(model.stage)) return `a record at stage ${model.stage}`;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'the record is not an object';
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  for (const [id, seat] of Object.entries(record)) {
    const node = Object.hasOwn(model.nodes, id) ? model.nodes[id] : undefined;
    if (node === undefined) return `${id} is no node`;
    if (seat === null || typeof seat !== 'object') return `${id} holds no seat`;
    if (!finite(seat.dx) || !finite(seat.from) || !finite(seat.width) || seat.from <= 0) return `${id}: a seat without its numbers`;
    if (!Number.isInteger(seat.pass) || seat.pass < 0) return `${id}: pass ${String(seat.pass)}`;
    if (seat.width < seat.from - PLACEMENT_EPS) return `${id}: the seat narrowed the body`;
    if (!Array.isArray(seat.ports) || !seat.ports.length) return `${id}: a seat that stood no port`;
    const sides = new Set<string>();
    for (const [index, port] of seat.ports.entries()) {
      if (index > 0 && !(seat.ports[index - 1]! < port)) return `${id}: ${String(port)} is out of port-key order or repeated`;
      const item = node.ports.find(candidate => portId(candidate.ref) === port && (candidate.side === 'top' || candidate.side === 'bottom'));
      if (item === undefined) return `${id}: ${String(port)} is no port on its top or bottom face`;
      sides.add(item.side!);
    }
    // The cap reads the record's own numbers (R5: the record, not a diagnostic): a body another rule made wide may align inside its width.
    if (!withinAlignmentCap(model, node, [...sides] as ('top' | 'bottom')[], seat)) return `${id}: the seat grew the body to ${seat.width} px, past the alignment cap`;
  }
  return undefined;
}
