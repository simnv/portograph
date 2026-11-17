/**
 * The reservation ledger (architecture 2, ticket 03): what placement is told to keep, as one immutable value.
 *
 * Before the ledger a hint was a wish. Each round offered it through one of eight `place()` channels, placement ran again, and the
 * result was guarded after the fact. The load-bearing rule of the pipeline says nothing may be discovered in routing that could have been
 * reserved in placement; the ledger makes that rule explicit. A reservation is plain JSON data (it lives on the model, which requires
 * plain JSON), and every predicate that judges one is code in this file, outside the model.
 */
import type { Course, GroupExit, LayoutModel, LayoutStage, Owner, PortRef, Rect, Side, Size } from '../model/index.js';
import type { PlacementInputField } from '../model/layout.js';
import type { PairPitch } from '../model/layout.js';
import { portKey } from './sides-one.js';
import { formsChains, lateralPairs } from './bundle-ends.js';
import { PLACEMENT_EPS, SEAT_STANDS_EPS } from './tolerance.js';
import { frameSubtreeCells } from '../model/model.js';
import { blockBoxPadsFault, blockRowGapsFault, flatBlockGapsFault, steepBlocksFault } from './placement-inputs.js';

/**
 * Why a stagger is declined (`staggerDeclined`): a clause of the acceptance gate (`wrapGateDecline`, dense-16x9 tickets 22 and 35), the
 * gate's trial placement or its 7f trial refusing the lines, or a later placement that refused them (`keptStaggers`).
 */
export const STAGGER_DECLINE_CLAUSES = ['area', 'aspect', 'held-straight', 'separation', 'planned-bends', 'placement', 'trial', 'later-placement'] as const;
export type StaggerDeclineClause = typeof STAGGER_DECLINE_CLAUSES[number];
export type RoundId = 'initial' | 'fan' | 'span' | 'course' | 'side' | 'turn' | 'overlay' | 'farEnd';
/** A model owner, or the command (a reservation no single element owns: the turn order of every face, a budget decline of every trunk). */
export type ReservationOwner = Owner | { kind: 'command'; id: string };

export interface ReservationPayload {
  /** A fan of chords needs this port pitch on a face (ticket 89). */
  pitchFloor: { node: string; side: Side; min: number };
  /** A fan of chords needs this pitch between two ports (`portId`, sorted) of a face when they stand side by side (dense-16x9 ticket 04). */
  pairFloor: { node: string; side: 'top' | 'bottom'; ports: readonly [string, string]; min: number };
  /** A hinted or course node keeps the size a measured run gave it (side-faces.md, Section 8). */
  nodeFloor: { node: string; min: Size };
  /** A lateral port takes `side`; `promise` is the routed shape the face was offered for. */
  sideFace: { port: PortRef; side: 'left' | 'right'; promise?: { link: string; shape: 'straight' | 'L'; bends: number } };
  /** The port's link owns a source-aligned side lane. */
  laneOwner: { port: PortRef; side: 'left' | 'right'; link: string; bends: 1 };
  /** A planned course; `maxTurns` is the turn count it promised. */
  course: { course: Course; maxTurns?: number };
  /** The link is a spanning chord. */
  spanChord: { link: string };
  /**
   * Stage 5 orders the ports of a face by the planned first turn of their links. `except` names the faces (`node|side`) that keep far-end order in a run with either scope:
   * a face that holds a held routed chord on the baseline of the turn round (`docs/design/turn-order.md`, Section 3).
   */
  turnOrder: { scope: { all: true } | { links: readonly string[] }; except?: readonly string[]; requireChanged: boolean };
  /**
   * Stage 5 gives the ports of the face `node`/`side` this order, the whole face in engine order, in place of the order of the far ends as they stood then (dense-16x9 ticket 07). The
   * far-end round takes it from the final positions of a completed placement; later stages validate it and never choose another. Absent: the face keeps the order stage 5 finds.
   * An entry for a face replaces an earlier entry for it (the latest proposal stands).
   */
  farEndOrder: { node: string; side: Side; ports: readonly PortRef[] };
  /** A trunk join (or every trunk join) that placement declines. */
  trunkDeclined: { scope: { all: true } | { key: string }; reason: string };
  /**
   * A stagger stage 5 of the first run chose, declined: by the acceptance gate (dense-16x9 ticket 35; `clause` names the clause of
   * `wrapGateDecline` that declined it, and `links` the links it names), or by a later placement that it refused (ticket 22, review 2;
   * `clause: 'later-placement'`). Every later run keeps `group` one line, with `reason`; none decides it again.
   */
  staggerDeclined: { group: string; reason: string; clause: StaggerDeclineClause; links?: string[] };
  /**
   * The seat set of a child row (dense-16x9 ticket 36, slice 1): the last repack of the rows rule (stage 6) stands the members of the rank cell
   * `row` under their parents' bottom ports, all together, with the order, the face orders, the widths and the parents fixed (`planSeatSet`,
   * `seat-set.ts`). Every later stage reads it: the cell box covers `interval`, 7c applies `xs` and does not choose again. Written by stage 6 of
   * each placement run (producer 'rows'); 7c withdraws it whole by name when it cannot stand (`SEAT_SET_WITHDRAWN`).
   */
  seatSet: SeatSetPayload;
  /**
   * A row whose seat set this command withdrew (dense-16x9 ticket 36, ruling B): `at` names the rule, `why` the failed equation or clause. The
   * withdrawing rule writes it; the command then places once more without the set, and the rows rule of every later run writes it again from
   * the command's input (`at: 'input'`), so the row is not decided again.
   */
  seatSetDeclined: { row: string; at: string; why: string };
  /**
   * A held chord that the publication step refused (dense-16x9 ticket 14, slice 3, built for ticket 04 slice 2): on the state to publish the plan
   * named it crowded (`TIER_GAP_CHORD_CROWDED`) and it stood under the G6 clearance, so placement replays once from the kept 7e model with this
   * entry. 7f refuses `link` before the freeze as `crowds` and decides nothing again (R1); the freeze then holds no refused chord.
   */
  refusedChord: { link: string };
  /** A move keeps every routed port of a member row's facing edge from standing deeper in a riser keep-out than it did (mesh-bus.md, section 11.5). */
  riserKeepOut: { bus: string; maxDepth: readonly (readonly [string, number])[] };
  /** A move puts no foreign unit across a bar extension of a trunk join that is not across one now (section 12.5). `allowedPairs` are the `group|bus` pairs that are across now. */
  trunkExtension: { head: string; allowedPairs: readonly string[] };
  /** A move keeps each unit on its side of every reserved lane, keeps the containing frames from reaching deeper across a side lane, and keeps the frozen chords. */
  laneSide: { lanes: readonly string[]; groups: readonly (readonly [string, 'left' | 'right'])[]; frameReach: readonly (readonly [string, number])[]; chords: readonly string[] };
  /** A move does not take the far port of an aligned side lane off the lane's x. */
  sideAlignment: { lanes: readonly { lane: string; far: PortRef }[] };
  spanCorridor: { link: string; allowedBreaches: readonly string[] };
  /** A move keeps each reserved group exit clear of every box and node but the ones it leaves, and keeps its end beyond the margin of the boxes it leaves (architecture ticket 13). */
  groupExit: { exits: readonly GroupExit[] };
  /** A move leaves each same-tier link's row room as the producer reserved it: it adds no link with a row shortfall to `short` (DR-02, `label-room-guard.ts`). */
  labelRoom: { short: readonly string[] };
  /**
   * The order the feeds give a row (architecture-2 ticket 25, `feed-order.ts`): for `cell`, the nodes of a rank cell left to right; for
   * `frame`, the units that stand beside each other in the frame left to right, the frame's own cells named by the frame id and each
   * child frame by its id; for `row`, the nodes of a free row that no row above feeds, ordered by its feeds into the row below (dense-16x9
   * ticket 20; a rank cell so ordered is a `cell` entry). `feeds` is the premise: each feeding row the order was read from, with the order
   * it stood in. Stage 4 writes it after the free rows are ordered; an absent entry means the feeds decide nothing there.
   */
  rowOrder: { cell: string; order: readonly string[]; feeds: readonly RowFeed[] } | { frame: string; order: readonly string[]; feeds: readonly RowFeed[] }
    | { row: string; order: readonly string[]; feeds: readonly RowFeed[] };
  /**
   * The group order of the sub-tier `tier` that the joint stage-4 order decided with the free rows of the next sub-tier toward the anchor
   * (architecture-2 ticket 72, `joint-order.ts`): the groups named in `order` stand left to right. `feeds` is the premise, the free rows
   * whose orders the decision read, with the order each stood in. An absent entry means the joint order kept the group order there.
   */
  groupOrder: { tier: number; order: readonly string[]; feeds: readonly RowFeed[] };
  /**
   * The side of the transited group `group` that the corridor of `link` takes in sub-tier `tier`, decided in stage 4 with the free rows and
   * the group order (ticket 72). The draft, the 7c predictor and `farCoordinate` take the corridor x from `reservedCorridorX` (`lanes.ts`);
   * 7a reads the entry (`corridorSideOf`) and takes the x by the same predicate (`corridorXOnSide`) on the box it allocates against, on this
   * side, and 7f withdraws the entry by name (`CORRIDOR_SIDE_WITHDRAWN`) when it moves the lane across. Absent: the readers decide the side.
   */
  corridorSide: { link: string; tier: number; group: string; side: 'left' | 'right' };
  /**
   * The row neighbours that a free row keeps for its enclosed bundles (`bundle-neighbours.ts`): of each pair, `left` stands immediately before
   * `right` in the row order, because the bundle's members leave `left` to the right and enter `right` from the left, and a body between the two
   * ends would stand in the channel (`BUNDLE_CHANNEL_BLOCKED`). Stage 4 writes one entry for each free row that holds such a bundle and decides
   * which pairs the row can keep. A pair the row cannot keep (a node ends at most one pair on each side) is not listed, and its bundle keeps the
   * typed refusal. Absent: the row holds no such bundle, and its order is free. There is no empty entry.
   */
  bundleNeighbours: { group: string; pairs: readonly (readonly [string, string])[] };
}
export type ReservationKind = keyof ReservationPayload;
/**
 * One equation of a seat set: x(member) + memberOffset = x(far) + farOffset, the offsets measured from the left body edge. `farOffset` is the
 * value at the decision and is not binding: the ruled boundary is the far port, not the parent body, so a parent body that grows on its face keeps
 * the set; no check reads it (slice 2 makes it a variable). The check reads the link, its two ends, and the vertical: the two port anchors on one x.
 */
export interface SeatEquation { link: string; member: PortRef; far: PortRef; memberOffset: number; farOffset: number }
/** The payload of a `seatSet` entry. Every x is relative to the anchor of the far port `boundary[0]`, so the set translates as a whole. */
export interface SeatSetPayload {
  row: string;
  frame: string;
  /** The members in row order (premise: the cell's `rowOrder`), with their fixed body widths. */
  order: string[];
  widths: number[];
  /** The kept verticals to the parents. */
  seats: SeatEquation[];
  /** The verticals a member already held at stage 5 to a node outside the row: that member does not move. */
  holds: SeatEquation[];
  /** The faces of the members that carry solid block ports, in port order (a translation keeps them; the check reads them). */
  blockFaces: { node: string; side: 'top' | 'bottom'; ports: string[] }[];
  /** The far ports the equations read, with their anchor x: the boundary of the set. A parent body that grows on a face moves none of them. */
  boundary: { port: PortRef; x: number }[];
  /** The x of each member, in `order`. */
  xs: number[];
  /** The two-sided reach the cell reserves: the content box of the seated members. */
  interval: { low: number; high: number };
  /**
   * The feeds the set leaves off their parents, each with why: another child stands under the parent port (`shared-port`), the member is held by
   * another vertical (`fixed`), a parallel link of a kept seat whose faces do not keep one pitch (`pitch`; slice 2 raises the parent's pair pitch),
   * or the order and gaps leave no room with the kept set (`conflict`).
   */
  declined: { link: string; reason: 'shared-port' | 'conflict' | 'fixed' | 'pitch' }[];
}
/** A feeding row of a `rowOrder` or `groupOrder` entry: the group, and the order its nodes stood in when the feeds were read. */
export interface RowFeed { row: string; order: readonly string[] }

export type Reservation = { [K in ReservationKind]: Readonly<{
  id: string;
  kind: K;
  owner: ReservationOwner;
  producer: RoundId | 'skeleton' | 'sides-two' | 'rows' | 'lanes' | 'bands' | 'publish';
  /** The measured baseline the reservation was made on: the number of placements the command had started. */
  revision: number;
  activeFrom: LayoutStage;
  payload: ReservationPayload[K];
}> }[ReservationKind];
export type Reservations = readonly Reservation[];
export type ReservationOf<K extends ReservationKind> = Extract<Reservation, { kind: K }>;

/** A typed failure of one reservation against a model: the entry, why it fails, and the port key and link it concerns when it names them. */
export interface ReservationFailure { id: string; kind: ReservationKind; why: string; entry: Reservation; key?: string; link?: string }

export const NO_RESERVATIONS: Reservations = [];

const ownerKey = (owner: ReservationOwner): string => 'node' in owner ? `${owner.kind}:${owner.node}:${owner.link}` : `${owner.kind}:${owner.id}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ACTIVE_FROM: Record<ReservationKind, LayoutStage> = {
  pitchFloor: 'size', pairFloor: 'size', nodeFloor: 'size', sideFace: 'sides-one', laneOwner: 'sides-one', course: 'sides-one', spanChord: 'resolve',
  turnOrder: 'sides-two', farEndOrder: 'sides-two', trunkDeclined: 'resolve', staggerDeclined: 'resolve', seatSet: 'rows', seatSetDeclined: 'rows', refusedChord: 'sides-two', riserKeepOut: 'lanes', trunkExtension: 'lanes', laneSide: 'lanes', sideAlignment: 'lanes', spanCorridor: 'lanes', groupExit: 'lanes', labelRoom: 'lanes',
  rowOrder: 'skeleton', groupOrder: 'skeleton', corridorSide: 'skeleton', bundleNeighbours: 'skeleton',
};

/** A reservation that lives for one move check and is never stored: no clone of the payload, revision 0. */
export function transient<K extends ReservationKind>(kind: K, owner: ReservationOwner, detail: string, producer: Reservation['producer'], payload: ReservationPayload[K]): ReservationOf<K> {
  return { id: `${kind}:${ownerKey(owner)}:${detail}`, kind, owner, producer, revision: 0, activeFrom: ACTIVE_FROM[kind], payload } as unknown as ReservationOf<K>;
}

/** One reservation. The id is `(kind, owner, detail)`; `detail` names the port, side or scope that tells two of one owner apart. */
export function reservation<K extends ReservationKind>(kind: K, owner: ReservationOwner, detail: string, producer: Reservation['producer'], revision: number,
  payload: ReservationPayload[K]): ReservationOf<K> {
  return { id: `${kind}:${ownerKey(owner)}:${detail}`, kind, owner, producer, revision, activeFrom: ACTIVE_FROM[kind], payload: clone(payload) } as unknown as ReservationOf<K>;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The ledger with `entries` added, in declaration order. Floors merge by componentwise maximum, spans, turn links and declines by union; a
 * course that names the same link twice must agree. An entry for an id the ledger has merges into it, so reserving twice reserves once.
 */
export function reserve(ledger: Reservations, entries: Reservations): Reservations {
  const result: Reservation[] = [...ledger];
  for (const entry of entries) {
    const at = result.findIndex(item => item.id === entry.id);
    if (at < 0) { result.push(entry); continue; }
    const old = result[at]!;
    if ((old.kind === 'pitchFloor' && entry.kind === 'pitchFloor') || (old.kind === 'pairFloor' && entry.kind === 'pairFloor')) {
      if (entry.payload.min > old.payload.min) result[at] = { ...old, revision: entry.revision, producer: entry.producer, payload: { ...old.payload, min: entry.payload.min } } as Reservation;
    } else if (old.kind === 'nodeFloor' && entry.kind === 'nodeFloor') {
      const min = { width: Math.max(old.payload.min.width, entry.payload.min.width), height: Math.max(old.payload.min.height, entry.payload.min.height) };
      if (!same(min, old.payload.min)) result[at] = { ...old, revision: entry.revision, producer: entry.producer, payload: { ...old.payload, min } };
    } else if (old.kind === 'sideFace' && entry.kind === 'sideFace') {
      if (old.payload.side !== entry.payload.side) throw new Error(`Reservation ${entry.id} asks for the side ${entry.payload.side}, and the ledger holds ${old.payload.side}`);
      if (old.payload.promise === undefined && entry.payload.promise !== undefined) result[at] = { ...old, payload: { ...old.payload, promise: entry.payload.promise } };
    } else if (old.kind === 'course' && entry.kind === 'course') {
      if (!same(old.payload.course, entry.payload.course)) throw new Error(`Reservation ${entry.id} conflicts with a course the ledger holds`);
    } else if (old.kind === 'farEndOrder' && entry.kind === 'farEndOrder') {
      result[at] = entry;
    } else if (old.kind === 'turnOrder' && entry.kind === 'turnOrder') {
      const except = [...new Set([...(old.payload.except ?? []), ...(entry.payload.except ?? [])])].sort();
      const requireChanged = old.payload.requireChanged || entry.payload.requireChanged;
      const scope = 'links' in old.payload.scope && 'links' in entry.payload.scope ? { links: [...new Set([...old.payload.scope.links, ...entry.payload.scope.links])] } : old.payload.scope;
      result[at] = { ...old, payload: { scope, ...(except.length > 0 ? { except } : {}), requireChanged } };
    }
    // Every other kind is idempotent: the first entry stands.
  }
  return result;
}

/** The entries of one kind, in declaration order. */
export function ofKind<K extends ReservationKind>(ledger: Reservations, kind: K): ReservationOf<K>[] {
  return ledger.filter((item): item is ReservationOf<K> => item.kind === kind);
}

// ---- Readers: the inputs placement derives from a ledger. -------------------------------------------------------------------------

/** The port pitch each face needs, per node. */
export function pitchFloorsOf(ledger: Reservations): Map<string, Partial<Record<Side, number>>> {
  const floors = new Map<string, Partial<Record<Side, number>>>();
  for (const { payload } of ofKind(ledger, 'pitchFloor')) floors.set(payload.node, { ...floors.get(payload.node), [payload.side]: payload.min });
  return floors;
}
/** The pitch entries of a floor map, for `reserve`: one per node and side. */
export function pitchFloors(floors: ReadonlyMap<string, Partial<Record<Side, number>>>, producer: RoundId, revision: number): Reservations {
  return [...floors].flatMap(([node, pitch]) => (Object.entries(pitch) as [Side, number][]).map(([side, min]) =>
    reservation('pitchFloor', { kind: 'node', id: node }, side, producer, revision, { node, side, min })));
}

/** The pitch entries of `wanted` that raise a floor the ledger holds: a value over the held one, or over 0 when none is held (ticket 89). Empty when no face needs more. */
export function pitchGrowth(ledger: Reservations, wanted: ReadonlyMap<string, Partial<Record<Side, number>>>, producer: RoundId, revision: number): Reservations {
  const held = pitchFloorsOf(ledger), grown = new Map<string, Partial<Record<Side, number>>>();
  for (const [node, pitch] of wanted) for (const [side, value] of Object.entries(pitch) as [Side, number][]) {
    if (value > (held.get(node)?.[side] ?? 0)) grown.set(node, { ...grown.get(node), [side]: value });
  }
  return pitchFloors(grown, producer, revision);
}

/** The neighbour-pair pitches the fans need, per node and face, as the node stores them (`LayoutNode.pairPitch`, rule `fan`). */
export function pairFloorsOf(ledger: Reservations): Map<string, Partial<Record<'top' | 'bottom', PairPitch[]>>> {
  const floors = new Map<string, Partial<Record<'top' | 'bottom', PairPitch[]>>>();
  for (const { payload } of ofKind(ledger, 'pairFloor')) {
    const faces = floors.get(payload.node) ?? {};
    (faces[payload.side] ??= []).push({ rule: 'fan', ports: [...payload.ports], min: payload.min });
    floors.set(payload.node, faces);
  }
  return floors;
}
/** The pair entries of `wanted` that raise a floor the ledger holds: a value over the held one, or any when none is held. Empty when no pair needs more. */
export function pairGrowth(ledger: Reservations, wanted: readonly { node: string; side: 'top' | 'bottom'; ports: readonly [string, string]; min: number }[], producer: RoundId, revision: number): Reservations {
  const held = new Map(ofKind(ledger, 'pairFloor').map(({ payload }) => [pairDetail(payload), payload.min] as const));
  return wanted.filter(item => item.min > (held.get(pairDetail(item)) ?? 0))
    .map(item => reservation('pairFloor', { kind: 'node', id: item.node }, pairDetail(item), producer, revision, { node: item.node, side: item.side, ports: item.ports, min: item.min }));
}
/** The detail that tells two pair floors of one node apart: the face and the two port keys. */
const pairDetail = (item: { side: string; ports: readonly string[] }): string => `${item.side}:${item.ports.join('|')}`;

/** The node size floors, per node. */
export function nodeFloorsOf(ledger: Reservations): Map<string, Size> {
  return new Map(ofKind(ledger, 'nodeFloor').map(({ payload }) => [payload.node, { ...payload.min }] as const));
}
export function nodeFloors(floors: ReadonlyMap<string, Size>, producer: RoundId, revision: number): Reservations {
  return [...floors].map(([node, min]) => reservation('nodeFloor', { kind: 'node', id: node }, '', producer, revision, { node, min }));
}

/** `[node, anonymous, name, ordinal]` back to the reference `portKey` made it from. */
export function portRefOf(key: string): PortRef {
  const [node, anonymous, name, ordinal] = JSON.parse(key) as [string, boolean, string | null, number];
  return (anonymous ? { node, anonymous: true, ordinal } : { node, name: name as string, ordinal }) as PortRef;
}

/** The lateral side each hinted port takes, by `portKey`, in declaration order. */
export function sideHintsOf(ledger: Reservations): Map<string, 'left' | 'right'> {
  return new Map(ofKind(ledger, 'sideFace').map(({ payload }) => [portKey(payload.port), payload.side] as const));
}
/** The ports whose link owns a source-aligned side lane, by `portKey`. */
export function laneKeysOf(ledger: Reservations): Set<string> {
  return new Set(ofKind(ledger, 'laneOwner').map(({ payload }) => portKey(payload.port)));
}
/** The hint entries for `hints`; `promised` gives a key the shape its link was offered for. */
export function sideFaces(hints: ReadonlyMap<string, 'left' | 'right'>,
  promised: ReadonlyMap<string, { link: string; bends: number; shape: 'straight' | 'L' | 'lane' }>, producer: RoundId, revision: number): Reservations {
  return [...hints].map(([key, side]) => {
    const port = portRefOf(key), item = promised.get(key);
    const promise = item === undefined || item.shape === 'lane' ? undefined : { link: item.link, shape: item.shape, bends: item.bends };
    return reservation('sideFace', { kind: 'node', id: port.node }, key, producer, revision, { port, side, ...(promise === undefined ? {} : { promise }) });
  });
}
export function laneOwners(keys: Iterable<string>, hints: ReadonlyMap<string, 'left' | 'right'>,
  promised: ReadonlyMap<string, { link: string; bends: number; shape: 'straight' | 'L' | 'lane' }>, producer: RoundId, revision: number): Reservations {
  const entries: Reservation[] = [];
  for (const key of keys) {
    const item = promised.get(key), side = hints.get(key), port = portRefOf(key);
    if (item === undefined || side === undefined) throw new Error(`A lane on ${key} has no hint or no promised link`);
    entries.push(reservation('laneOwner', { kind: 'link', id: item.link }, key, producer, revision, { port, side, link: item.link, bends: 1 }));
  }
  return entries;
}

/** The courses every placement run reserves, in declaration order, then the u-turn courses stage 5 of the run planned for its sibling rows (producer `sides-two`). */
export function coursesOf(ledger: Reservations): Course[] {
  return ofKind(ledger, 'course').map(({ payload }) => clone(payload.course));
}
export function courseEntries(courses: readonly Course[], promised: ReadonlyMap<string, number> | undefined, producer: Reservation['producer'], revision: number): Reservations {
  return courses.map(course => reservation('course', { kind: 'link', id: course.link }, '', producer, revision,
    { course, ...(promised?.has(course.link) ? { maxTurns: promised.get(course.link)! } : {}) }));
}

/** The links that are reserved as spanning chords. */
export function spansOf(ledger: Reservations): Set<string> {
  return new Set(ofKind(ledger, 'spanChord').map(({ payload }) => payload.link));
}
export function spanEntries(links: Iterable<string>, producer: RoundId, revision: number): Reservations {
  return [...links].map(link => reservation('spanChord', { kind: 'link', id: link }, '', producer, revision, { link }));
}

/**
 * The one reader of the feed order (architecture-2 ticket 25, R1): the order the ledger reserves for the rank cell or the frame `id`, or
 * `undefined` when the feeds decide nothing there. A cell entry names the cell's nodes; a frame entry names the frame (its own cells) and
 * child frames. The skeleton replay, the column pack, the overlay order of the frames and the validators all read it here.
 */
export function rowOrderOf(ledger: Reservations | undefined, scope: 'cell' | 'frame', id: string): readonly string[] | undefined {
  for (const { payload } of ofKind(ledger ?? NO_RESERVATIONS, 'rowOrder')) if (scope === 'cell' ? 'cell' in payload && payload.cell === id : 'frame' in payload && payload.frame === id) return payload.order;
  return undefined;
}
/** The feeding rows the `rowOrder` and `groupOrder` entries read (their premises): a rule that would turn one of them leaves it alone. */
export function feedingRowsOf(ledger: Reservations | undefined): Set<string> {
  const entries = [...ofKind(ledger ?? NO_RESERVATIONS, 'rowOrder'), ...ofKind(ledger ?? NO_RESERVATIONS, 'groupOrder')];
  return new Set(entries.flatMap(({ payload }) => payload.feeds.map(feed => feed.row)));
}
/** The one reader of a corridor side (ticket 72, R1): the entry the ledger holds for the corridor of `link` in sub-tier `tier`, or undefined. */
export function corridorSideOf(ledger: Reservations | undefined, link: string, tier: number): ReservationPayload['corridorSide'] | undefined {
  return ofKind(ledger ?? NO_RESERVATIONS, 'corridorSide').find(({ payload }) => payload.link === link && payload.tier === tier)?.payload;
}

/** The one reader of the bundle neighbours of a free row (R1): the pairs `[left, right]` the ledger reserves for `group`, or none. */
export function bundleNeighboursOf(ledger: Reservations | undefined, group: string): readonly (readonly [string, string])[] {
  return ofKind(ledger ?? NO_RESERVATIONS, 'bundleNeighbours').find(({ payload }) => payload.group === group)?.payload.pairs ?? [];
}
/** The first pair of `pairs` that `order` does not hold (`left` immediately before `right`), or undefined: the one predicate of the seat, the guard and the check. */
export function splitPair(pairs: readonly (readonly [string, string])[], order: readonly string[]): readonly [string, string] | undefined {
  return pairs.find(([left, right]) => order.indexOf(left) < 0 || order.indexOf(right) !== order.indexOf(left) + 1);
}
/**
 * The predicate of a bundle neighbour entry against a placed model (R2, R5), asked by the stage-4 check, the guards and every restore. It reads the
 * record and the model, and decides no pair: each recorded pair is two distinct nodes of the group, joined by an enclosed lateral bundle whose
 * `left` end leaves to the right (`lateralPairs`, the writer's reader); the pairs form chains (`formsChains`, the writer's predicate); the row order
 * holds each pair (`splitPair`); and the boxes agree with the order (`left` stands left of `right`, no body of the group between their left edges).
 */
export function bundleNeighboursFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'bundleNeighbours') return undefined;
  const group = model.groups[item.payload.group];
  if (group === undefined) return `${item.payload.group} is missing`;
  const pairs = item.payload.pairs, supported = lateralPairs(model, group.id);
  for (const [left, right] of pairs) {
    if (!group.nodes.includes(left) || !group.nodes.includes(right) || model.nodes[left] === undefined || model.nodes[right] === undefined) return `${left} and ${right} are not both nodes of ${group.id}`;
    if (!supported.some(pair => pair.left === left && pair.right === right)) return `no enclosed bundle of ${group.id} leaves ${left} to the right and enters ${right} from the left`;
  }
  if (!formsChains(pairs)) return `the bundle neighbours of ${group.id} are not chains`;
  const split = splitPair(pairs, group.rowOrder ?? group.nodes);
  if (split !== undefined) return `${split[0]} does not stand immediately left of ${split[1]}, the two ends of a bundle in ${group.id}`;
  // The boxes agree with the order, read at the left edges, the key the row order is read by (a stage-4 row may still hold two layers whose boxes overlap in x): `left` stands left of `right`, and no body of the group stands between them.
  const edge = (id: string): number | undefined => model.nodes[id]?.bounds?.x;
  for (const [left, right] of pairs) {
    const from = edge(left), to = edge(right);
    if (from === undefined || to === undefined) return `${left} or ${right} has no box`;
    if (from > to + PLACEMENT_EPS) return `${left} does not stand left of ${right}, the two ends of a bundle in ${group.id}`;
    const between = group.nodes.find(id => { const at = edge(id); return id !== left && id !== right && at !== undefined && at > from + PLACEMENT_EPS && at < to - PLACEMENT_EPS; });
    if (between !== undefined) return `${between} stands between ${left} and ${right}, the two ends of a bundle in ${group.id}`;
  }
  return undefined;
}

/** Whether every face takes the turn order, the links whose faces take it when not every face does, and the faces that keep far-end order in either case. */
export function turnOf(ledger: Reservations): { all: boolean; links: string[]; except: string[]; requireChanged: boolean } {
  let all = false, requireChanged = false;
  const links: string[] = [], except = new Set<string>();
  for (const { payload } of ofKind(ledger, 'turnOrder')) {
    if ('all' in payload.scope) all = true; else for (const id of payload.scope.links) if (!links.includes(id)) links.push(id);
    for (const face of payload.except ?? []) except.add(face);
    requireChanged ||= payload.requireChanged;
  }
  return { all, links, except: [...except].sort(), requireChanged };
}
/** `except`: the faces (`node|side`) that keep far-end order although the other faces of the scope take the turn order; kept on every entry that the call makes. */
export function turnEntries(turn: boolean, links: readonly string[], requireChanged: boolean, producer: RoundId, revision: number, except: readonly string[] = []): Reservations {
  const command = { kind: 'command' as const, id: 'turn-order' }, faces = except.length > 0 ? { except: [...except].sort() } : {};
  return [
    ...(turn ? [reservation('turnOrder', command, 'all', producer, revision, { scope: { all: true }, ...faces, requireChanged })] : []),
    ...(links.length > 0 ? [reservation('turnOrder', command, 'links', producer, revision, { scope: { links: [...links] }, ...faces, requireChanged: false })] : []),
  ];
}

/** The faces (`node|side`) the ledger gives a far-end order, with the sequence each takes, in node and side order. */
export function farEndOrderOf(ledger: Reservations): { node: string; side: Side; ports: PortRef[] }[] {
  return ofKind(ledger, 'farEndOrder').map(({ payload }) => ({ node: payload.node, side: payload.side, ports: payload.ports.map(ref => ({ ...ref })) }))
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0) || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
}
export function farEndEntries(faces: readonly { node: string; side: Side; ports: readonly PortRef[] }[], producer: RoundId, revision: number): Reservations {
  return faces.map(face => reservation('farEndOrder', { kind: 'node', id: face.node }, face.side, producer, revision, { node: face.node, side: face.side, ports: face.ports }));
}

/** The trunk joins that the next run resolves with declined. With `all` set (the budget is spent) every trunk reads as declined. */
export class DeclinedTrunks extends Map<string, string> {
  all = false;
  allReason = 'the placement budget is spent';
  override get(key: string): string | undefined { return super.get(key) ?? (this.all ? this.allReason : undefined); }
}
export function declinedTrunksOf(ledger: Reservations): DeclinedTrunks {
  const declined = new DeclinedTrunks();
  for (const { payload } of ofKind(ledger, 'trunkDeclined')) {
    if ('all' in payload.scope) { declined.all = true; declined.allReason = payload.reason; } else declined.set(payload.scope.key, payload.reason);
  }
  return declined;
}
/** One decline: the trunk join `key`, or with no key every trunk join (the placement budget is spent). */
export function declineTrunk(key: string | undefined, reason: string, revision: number): Reservations {
  return key === undefined
    ? [reservation('trunkDeclined', { kind: 'command', id: 'trunk-declines' }, 'all', 'initial', revision, { scope: { all: true }, reason })]
    : [reservation('trunkDeclined', { kind: 'mesh-bus', id: key }, key, 'initial', revision, { scope: { key }, reason })];
}
/** The staggers the ledger declines: group to its entry, in ledger order. */
export const declinedStaggersOf = (ledger: Reservations): Map<string, ReservationPayload['staggerDeclined']> =>
  new Map(ofKind(ledger, 'staggerDeclined').map(({ payload }) => [payload.group, payload] as const));
/** Why the ledger declines a stagger, as the note `FAN_WRAP_DECLINED` says it: the reason of the gate's clause, or a later placement's refusal. */
export const staggerDeclineSentence = (payload: ReservationPayload['staggerDeclined']): string =>
  payload.clause === 'later-placement' ? `a later placement refused them: ${payload.reason}` : payload.reason;
/** One declined stagger: the row `group` stands one line in every later run, for `reason`, by `clause` (with the links the clause names). */
export const declineStagger = (group: string, reason: string, clause: StaggerDeclineClause, producer: Reservation['producer'], revision: number, links?: readonly string[]): Reservations =>
  [reservation('staggerDeclined', { kind: 'group', id: group }, '', producer, revision, { group, reason, clause, ...(links?.length ? { links: [...links] } : {}) })];
export function declinedEntries(declined: DeclinedTrunks, revision: number): Reservations {
  const owner = { kind: 'command' as const, id: 'trunk-declines' };
  return [
    ...[...declined].map(([key, reason]) => reservation('trunkDeclined', { kind: 'mesh-bus', id: key }, key, 'initial', revision, { scope: { key }, reason })),
    ...(declined.all ? [reservation('trunkDeclined', owner, 'all', 'initial', revision, { scope: { all: true }, reason: declined.allReason })] : []),
  ];
}

// ---- Predicates and validators ---------------------------------------------------------------------------------------------------

/**
 * Where each fan pair stood in a face record the last time the record was read (dense-16x9 ticket 04). A hint only, like `portPlaces`: it is
 * checked against the entry at that place on every use, and a pair is unique in a face record (`addPairPitches` merges by pair, and `pairPitchFault` refuses a record with two entries for one pair), so the answer
 * is the one a search of the face gives. A ledger holds C(n, 2) pair floors of a face of n ports, and a search per floor made the check
 * quadratic in them (0.7 s at 100 ports, 2 ms with the hint).
 */
const fanPlaces = new WeakMap<readonly PairPitch[], Map<string, number>>();
function fanEntry(list: readonly PairPitch[] | undefined, ports: readonly string[]): PairPitch | undefined {
  if (list === undefined) return undefined;
  const key = ports.join('|');
  const holds = (at: number | undefined): at is number => at !== undefined && list[at]?.rule === 'fan' && list[at]!.ports.join('|') === key;
  const hinted = fanPlaces.get(list)?.get(key);
  if (holds(hinted)) return list[hinted];
  const places = new Map<string, number>();
  list.forEach((entry, at) => { const pair = entry.ports.join('|'); if (entry.rule === 'fan' && !places.has(pair)) places.set(pair, at); });
  fanPlaces.set(list, places);
  const at = places.get(key);
  return at === undefined ? undefined : list[at];
}

/** The predicate of a floor against a placed model: sizes and pitches only grow, so it holds at every stage. */
export function floorFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind === 'pitchFloor') {
    const have = model.nodes[item.payload.node]?.sidePitch?.[item.payload.side];
    return have !== undefined && have >= item.payload.min ? undefined : `the ${item.payload.side} pitch of ${item.payload.node} is under ${item.payload.min}`;
  }
  if (item.kind === 'pairFloor') {
    const node = model.nodes[item.payload.node];
    const have = fanEntry(node?.pairPitch?.[item.payload.side], item.payload.ports);
    return have !== undefined && have.min >= item.payload.min ? undefined : `the ${item.payload.side} pair ${item.payload.ports.join(', ')} of ${item.payload.node} is under ${item.payload.min}`;
  }
  if (item.kind === 'nodeFloor') {
    const size = model.nodes[item.payload.node]?.size;
    return size !== undefined && size.width >= item.payload.min.width && size.height >= item.payload.min.height ? undefined : `${item.payload.node} is smaller than its floor`;
  }
  return undefined;
}

/**
 * The predicate of a feed order against a placed model (architecture-2 ticket 25, R2): a cell stands in the reserved order, and of two units
 * of a frame entry the one named first stands left of the other on every sub-tier they share. The premise holds too: each feeding row
 * stands in the order the entry read (a row that turned would make the reserved order cross). Order only, so it holds at every stage after 4.
 */
/**
 * Why a declined stagger (`staggerDeclined`, dense-16x9 ticket 22 review 2) does not hold on `model`, or `undefined`: the row stands one line, with no
 * stagger record and an arrangement that is not a stagger, and every link the decline names is a link of the model. The one predicate of the kind:
 * the round check (`holds`) and restore (`validateReservations`, `validateEarlyReservations`) call it.
 */
export function staggerDeclineFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'staggerDeclined') return undefined;
  const group = item.payload.group;
  if ((model.staggerRows ?? []).some(row => row.group === group) || model.groupArrangements?.[group]?.chosen === 'stagger') return `the row ${group} stands on two lines although its stagger is declined`;
  // The links a held-straight decline names are links of the model (dense-16x9 ticket 35, review 1): the record names no evidence it does not have.
  const unknown = item.payload.links?.find(id => !model.links.some(link => link.id === id));
  return unknown === undefined ? undefined : `the decline of ${group} names the link ${unknown}, which the model does not have`;
}

/** Why a `seatSet` payload is malformed, or undefined (the shape check of the kind). */
function seatSetShapeFailure(payload: Record<string, unknown>): string | undefined {
  const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
  const numbers = (value: unknown): boolean => Array.isArray(value) && value.every(isNumber);
  const ref = (value: unknown): boolean => typeof value === 'object' && value !== null && typeof (value as { node?: unknown }).node === 'string';
  const equations = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null
    && typeof item.link === 'string' && ref(item.member) && ref(item.far) && isNumber(item.memberOffset) && isNumber(item.farOffset));
  const order = payload['order'], interval = payload['interval'] as { low?: unknown; high?: unknown } | undefined;
  const ok = typeof payload['row'] === 'string' && typeof payload['frame'] === 'string' && strings(order) && (order as string[]).length > 0
    && numbers(payload['widths']) && (payload['widths'] as number[]).length === (order as string[]).length
    && numbers(payload['xs']) && (payload['xs'] as number[]).length === (order as string[]).length
    && equations(payload['seats']) && (payload['seats'] as unknown[]).length > 0 && equations(payload['holds'])
    && Array.isArray(payload['blockFaces']) && (payload['blockFaces'] as unknown[]).every(face => typeof face === 'object' && face !== null
      && typeof (face as { node?: unknown }).node === 'string' && ['top', 'bottom'].includes((face as { side?: string }).side ?? '') && strings((face as { ports?: unknown }).ports))
    && Array.isArray(payload['boundary']) && (payload['boundary'] as unknown[]).length > 0 && (payload['boundary'] as { port?: unknown; x?: unknown }[]).every(item => ref(item.port) && isNumber(item.x))
    && typeof interval === 'object' && interval !== null && isNumber(interval.low) && isNumber(interval.high) && interval.low <= interval.high
    && Array.isArray(payload['declined']) && (payload['declined'] as { link?: unknown; reason?: unknown }[]).every(item => typeof item.link === 'string' && ['shared-port', 'conflict', 'fixed', 'pitch'].includes(item.reason as string));
  return ok ? undefined : 'malformed seat set';
}

/**
 * Why a seat set (`seatSet`, dense-16x9 ticket 36) does not hold on `model`, or `undefined`. The one predicate of the kind, at the round check and
 * at both restores. Relative to its first boundary node, every member stands at its x with its width, in the cell's order; every seat and hold
 * equation holds, with its ports where the offsets put them; the boundary nodes stand where they stood relative to each other; the block faces keep
 * their port order; and the cell box covers the interval. All to `PLACEMENT_EPS`: the set moves only as a whole. One reading is wider: a hold is
 * a vertical the member stood when the rows rule read it, within `SEAT_STANDS_EPS` (`readRow`), so its two anchors are read to that half pixel.
 * The set moves the member and the far port rigidly, so the hold keeps the offset it was read with (dense-16x9 ticket 36a: a hold read 0.5 px
 * off failed the publication of the rows rule that recorded it).
 */
export function seatSetFault(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'seatSet') return undefined;
  const p = item.payload;
  if (BEFORE_SIDES_TWO.has(model.stage) || model.stage === 'sides-two') return `the seat set of ${p.row} stands on a ${model.stage} model, before stage 6 makes it`;
  const group = model.groups[p.row];
  if (group?.bounds === undefined || group.frame !== p.frame) return `${p.row} is no cell of ${p.frame}`;
  if (!same(group.rowOrder ?? group.nodes, p.order)) return `${p.row} no longer stands in the order of its seat set`;
  const port = (ref: PortRef) => model.nodes[ref.node]?.ports.find(item => portKey(item.ref) === portKey(ref));
  const provenance = seatSetProvenanceFault(p, model, port);
  if (provenance !== undefined) return provenance;
  const origin = port(p.boundary[0]!.port)?.anchor?.x;
  if (origin === undefined) return `the seat set of ${p.row} reads ${portKey(p.boundary[0]!.port)}, which has no anchor`;
  const off = (a: number, b: number): boolean => Math.abs(a - b) > PLACEMENT_EPS;
  for (const { port: ref, x } of p.boundary) {
    const at = port(ref)?.anchor?.x;
    if (at === undefined || off(at - origin, x)) return `the boundary port ${portKey(ref)} of the seat set of ${p.row} moved off its offset ${x}`;
  }
  for (const [i, id] of p.order.entries()) {
    const box = model.nodes[id]?.bounds;
    if (box === undefined || off(box.x - origin, p.xs[i]!) || off(box.width, p.widths[i]!)) return `the member ${id} of ${p.row} left its seat (x ${p.xs[i]}, width ${p.widths[i]}; at stage ${model.stage}: x ${box === undefined ? '-' : box.x - origin})`;
  }
  for (const eq of [...p.seats, ...p.holds]) {
    const a = port(eq.member), b = port(eq.far), ma = model.nodes[eq.member.node]?.bounds;
    if (a?.anchor === undefined || b?.anchor === undefined || ma === undefined) return `the equation of ${eq.link} in the seat set of ${p.row} has no ports`;
    const stands = p.holds.includes(eq) ? Math.abs(a.anchor.x - b.anchor.x) <= SEAT_STANDS_EPS : !off(a.anchor.x, b.anchor.x);
    if (off(a.anchor.x - ma.x, eq.memberOffset) || !stands) return `the link ${eq.link} no longer stands vertical in the seat set of ${p.row}`;
  }
  for (const face of p.blockFaces) {
    const now = (model.nodes[face.node]?.ports ?? []).filter(item => item.side === face.side && item.anchor && face.ports.includes(portKey(item.ref)))
      .sort((a, b) => a.anchor!.x - b.anchor!.x).map(item => portKey(item.ref));
    if (!same(now, face.ports)) return `the ${face.side} block face of ${face.node} changed its port order in the seat set of ${p.row}`;
  }
  const box = group.bounds;
  if (box.x > origin + p.interval.low + PLACEMENT_EPS || box.x + box.width < origin + p.interval.high - PLACEMENT_EPS) return `the box of ${p.row} does not cover the interval of its seat set`;
  // The interval is the room the cell reserves for the seated row: it covers every member body (the occupied extent it claims to reserve).
  const low = Math.min(...p.xs), high = Math.max(...p.xs.map((x, i) => x + p.widths[i]!));
  if (p.interval.low > low + PLACEMENT_EPS || p.interval.high < high - PLACEMENT_EPS) return `the interval of the seat set of ${p.row} does not cover its members (${low} to ${high})`;
  return undefined;
}

/**
 * Why the claims of a seat-set payload are not facts of `model` (review 1 of slice 1, finding 1), or `undefined`: each equation names a link of the
 * model whose two ends are its member port and its far port, the member in the row and the far node outside it (a seat: the member's top port
 * under a bottom port of a node above); the boundary is exactly the far ports of the equations, in key order (its first port is the origin); each
 * block face is a face of a member and lists exactly the solid-block ports of that face; every member face that carries a solid-block port is
 * listed; and each declined feed names a link with one end on a member and the other outside the row. `farOffset` is not read: it records the
 * far port's offset at the decision, and the ruled boundary is the port, not the body, so a parent body that grows keeps the set.
 */
function seatSetProvenanceFault(p: SeatSetPayload, model: LayoutModel, port: (ref: PortRef) => LayoutModel['nodes'][string]['ports'][number] | undefined): string | undefined {
  const members = new Set(p.order), links = new Map(model.links.map(link => [link.id, link] as const));
  const ends = (id: string): [string, string] | undefined => { const a = links.get(id)?.attachments; return a === undefined ? undefined : [portKey(a.from), portKey(a.to)]; };
  for (const [kind, eq] of [...p.seats.map(item => ['seat', item] as const), ...p.holds.map(item => ['hold', item] as const)]) {
    const pair = ends(eq.link), m = portKey(eq.member), f = portKey(eq.far);
    if (pair === undefined) return `the ${kind} ${eq.link} of the seat set of ${p.row} names no link of the model`;
    if (!((pair[0] === m && pair[1] === f) || (pair[0] === f && pair[1] === m))) return `the ${kind} ${eq.link} of the seat set of ${p.row} does not join its member port and its far port`;
    if (!members.has(eq.member.node) || members.has(eq.far.node)) return `the ${kind} ${eq.link} of the seat set of ${p.row} does not join a member to a node outside the row`;
    if (kind === 'seat') {
      const a = port(eq.member), b = port(eq.far);
      if (a?.side !== 'top' || b?.side !== 'bottom' || a.anchor === undefined || b.anchor === undefined || b.anchor.y >= a.anchor.y) return `the seat ${eq.link} of the seat set of ${p.row} does not feed a member's top port from a bottom port above`;
    }
  }
  const far = [...new Set([...p.seats, ...p.holds].map(eq => portKey(eq.far)))].sort(), boundary = p.boundary.map(item => portKey(item.port));
  if (!same(far, boundary)) return `the boundary of the seat set of ${p.row} is not the far ports of its equations`;
  const solid = new Map<string, Set<string>>();
  for (const link of model.links) if (link.solidBlock && link.attachments) for (const ref of [link.attachments.from, link.attachments.to]) {
    const side = port(ref)?.side;
    if (members.has(ref.node) && (side === 'top' || side === 'bottom')) { const key = `${ref.node}|${side}`; solid.set(key, (solid.get(key) ?? new Set()).add(portKey(ref))); }
  }
  for (const face of p.blockFaces) {
    const own = solid.get(`${face.node}|${face.side}`);
    if (!members.has(face.node) || own === undefined || !same([...own].sort(), [...face.ports].sort())) return `the ${face.side} block face of ${face.node} in the seat set of ${p.row} is not the solid-block face of a member`;
  }
  if (solid.size !== p.blockFaces.length) return `the seat set of ${p.row} leaves a solid-block face of a member out`;
  for (const item of p.declined) {
    const a = links.get(item.link)?.attachments;
    if (a === undefined || members.has(a.from.node) === members.has(a.to.node)) return `the declined feed ${item.link} of the seat set of ${p.row} is no link from a member to a node outside the row`;
  }
  return undefined;
}

/**
 * Why a seat-set decline (`seatSetDeclined`, dense-16x9 ticket 36, ruling B) does not hold on `model`, or `undefined`: the record exists only from
 * the rows rule on (before it a run has recorded no seat set yet, so a decline there is forged), it names a group of the model, and the
 * declined row holds no `seatSet` entry, so its cell reserves no seat interval.
 */
export function seatSetDeclinedFault(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'seatSetDeclined') return undefined;
  const { row } = item.payload;
  if (BEFORE_SIDES_TWO.has(model.stage) || model.stage === 'sides-two') return `the seat-set decline of ${row} stands on a ${model.stage} model, before stage 6 records it`;
  if (model.groups[row] === undefined) return `the seat-set decline names ${row}, which is no group of the model`;
  if ((model.reservations ?? []).some(entry => entry.kind === 'seatSet' && entry.owner.kind === 'group' && entry.owner.id === row)) return `the row ${row} is declined and still holds a seat set`;
  return undefined;
}

/** The stages before `sides-two`, in the order of `stages` (mutation.ts). */
const BEFORE_SIDES_TWO: ReadonlySet<LayoutStage> = new Set<LayoutStage>(['normalised', 'resolve', 'sides-one', 'size', 'skeleton']);
/**
 * Why a refused chord (`refusedChord`, dense-16x9 ticket 14 slice 3) does not hold on `model`, or `undefined`. The one predicate of the kind, for the
 * round check (`holds`) and both restores: the model stands at `sides-two` or later (the publication step writes the entry on the kept 7e model, so
 * an earlier model carries none, review 2 of ticket 04 slice 2), the entry names a link, and once the freeze is taken that link is no frozen chord
 * (7f refuses it before the freeze, so a record the freeze contradicts is forged, review 1 finding 3). One entry per link: the ledger ids are unique.
 */
export function refusedChordFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'refusedChord') return undefined;
  const link = item.payload.link;
  if (BEFORE_SIDES_TWO.has(model.stage)) return `a ${model.stage} model carries no refused chord (${link})`;
  if (!model.links.some(other => other.id === link)) return `${link} is no link`;
  return model.frozenChords?.includes(link) === true ? `${link} is refused, but the freeze held it` : undefined;
}
/** The chords the ledger refuses (`refusedChord`), in ledger order. */
export const refusedChordsOf = (ledger: Reservations): string[] => ofKind(ledger, 'refusedChord').map(({ payload }) => payload.link);
/** One entry per refused chord, written by the publication step. */
export const refuseChordEntries = (links: readonly string[], revision: number): Reservations =>
  links.map(link => reservation('refusedChord', { kind: 'link', id: link }, '', 'publish', revision, { link }));

export function rowOrderFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'rowOrder') return undefined;
  const payload = item.payload;
  for (const feed of payload.feeds) {
    const row = model.groups[feed.row];
    if (row === undefined || !same(row.rowOrder ?? row.nodes, feed.order)) return `the feeding row ${feed.row} no longer stands in the order the entry read`;
  }
  if ('row' in payload) {
    const group = model.groups[payload.row];
    if (group === undefined || group.frame !== undefined) return `${payload.row} is no free row`;
    return same(group.rowOrder ?? group.nodes, payload.order) ? undefined : `${payload.row} does not stand in the order its feeds give`;
  }
  if ('cell' in payload) {
    const group = model.groups[payload.cell];
    if (group === undefined || group.frame === undefined) return `${payload.cell} is no rank cell`;
    return same(group.rowOrder ?? group.nodes, payload.order) ? undefined : `${payload.cell} does not stand in the order its feeds give`;
  }
  const frames = model.document.frames ?? {};
  if (frames[payload.frame] === undefined) return `${payload.frame} is no frame`;
  const cellsOf = (unit: string): string[] | undefined => unit === payload.frame ? frames[unit]!.cells
    : frames[unit]?.parent === payload.frame ? frameSubtreeCells(frames, unit) : undefined;
  const units = payload.order.map(cellsOf);
  if (units.some(cells => cells === undefined)) return `the feed order of ${payload.frame} names a unit that is not its own`;
  for (const [i, left] of units.entries()) for (const right of units.slice(i + 1)) for (const a of left!) for (const b of right!) {
    const one = model.groups[a], two = model.groups[b];
    if (one?.bounds === undefined || two?.bounds === undefined) return `a cell of ${payload.frame} has no box`;
    if (one.tier === two.tier && one.bounds.x >= two.bounds.x) return `${a} does not stand left of ${b}, the order the feeds of ${payload.frame} give`;
  }
  return undefined;
}

/**
 * The predicate of a group order (ticket 72, R2): the premise holds (each free row the decision read stands in the order it read), and of
 * two groups the entry names, the one named first stands left of the other on its sub-tier. Order only, so it holds at every stage after 4.
 */
export function groupOrderFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'groupOrder') return undefined;
  const payload = item.payload;
  for (const feed of payload.feeds) {
    const row = model.groups[feed.row];
    if (row === undefined || !same(row.rowOrder ?? row.nodes, feed.order)) return `the free row ${feed.row} no longer stands in the order the group order read`;
  }
  for (const [i, a] of payload.order.entries()) {
    const one = model.groups[a];
    if (one?.bounds === undefined || one.tier !== payload.tier) return `${a} does not stand on sub-tier ${payload.tier}`;
    for (const b of payload.order.slice(i + 1)) {
      const two = model.groups[b];
      if (two?.bounds === undefined || two.tier !== payload.tier) return `${b} does not stand on sub-tier ${payload.tier}`;
      if (one.bounds.x >= two.bounds.x) return `${a} does not stand left of ${b}, the group order of sub-tier ${payload.tier}`;
    }
  }
  return undefined;
}

/** The stages from 7a on, where a corridor has its lane: a corridor side is checked against the lane there, and only its host before. */
const LANE_STAGES: ReadonlySet<LayoutStage> = new Set(['lanes', 'flanks', 'centre', 'bars', 'bundles', 'bands', 'route', 'link-labels', 'validate', 'emit']);
/**
 * The predicate of a corridor side (ticket 72, R2): the host stands on its sub-tier, and from 7a on the transit lane of the link in that
 * sub-tier stands on the reserved side of the host. A link that 7a does not give a plain transit lane there (a span hint, a course) is
 * judged on its host alone. 7f withdraws an entry whose lane it moves across (`withdrawCorridorSide`, `lanes.ts`), so a later stage reads no stale one.
 */
export function corridorSideFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'corridorSide') return undefined;
  const { link: id, tier, group, side } = item.payload;
  const link = model.links.find(other => other.id === id), host = model.groups[group];
  if (link === undefined) return `${id} is missing`;
  if (host?.bounds === undefined || host.tier !== tier) return `${group} does not stand on sub-tier ${tier}`;
  if (!LANE_STAGES.has(model.stage) || link.spanHint === true || (model.courses ?? []).some(course => course.link === id)) return undefined;
  const lane = model.lanes.find(other => other.kind === undefined && other.owner.kind === 'link' && other.owner.id === id && other.tier === tier);
  if (lane === undefined) return `${id} has no transit lane in sub-tier ${tier}`;
  return corridorStandsOn(lane.x, host.bounds, side) ? undefined : `the corridor of ${id} in sub-tier ${tier} does not stand ${side} of ${group}`;
}
/** Whether a corridor at `x` stands on `side` of `box`: the one predicate of the check and of the 7f withdrawal (R1). */
export function corridorStandsOn(x: number, box: Rect, side: 'left' | 'right'): boolean {
  return side === 'left' ? x < box.x : x > box.x + box.width;
}

/** The turn count each kept course promised, by link id: what the turn round's judgment compares a trial with. */
export function promisedTurns(ledger: Reservations): Map<string, number> {
  return new Map(ofKind(ledger, 'course').flatMap(({ payload }) => payload.maxTurns === undefined ? [] : [[payload.course.link, payload.maxTurns] as const]));
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPort = (value: unknown): boolean => isObject(value) && isString(value['node']) && Number.isInteger(value['ordinal']) && (value['anonymous'] === true ? value['name'] === undefined : isString(value['name']));
const feedsShape = (feeds: unknown): boolean => Array.isArray(feeds) && feeds.length > 0
  && feeds.every(feed => isObject(feed) && isString(feed['row']) && Array.isArray(feed['order']) && (feed['order'] as unknown[]).every(isString));
const orderShape = (order: unknown): boolean => Array.isArray(order) && order.length > 1 && order.every(isString) && new Set(order).size === order.length;
const STORED_KINDS: ReadonlySet<string> = new Set(['pitchFloor', 'pairFloor', 'nodeFloor', 'sideFace', 'laneOwner', 'course', 'spanChord', 'turnOrder', 'farEndOrder', 'trunkDeclined', 'staggerDeclined', 'seatSet', 'seatSetDeclined', 'refusedChord', 'rowOrder', 'groupOrder', 'corridorSide', 'bundleNeighbours']);
const PRODUCERS: ReadonlySet<string> = new Set(['initial', 'fan', 'span', 'course', 'side', 'turn', 'overlay', 'farEnd', 'skeleton', 'sides-two', 'rows', 'lanes', 'bands', 'publish']);

/** Why a stored entry is not the shape its kind has, or undefined. Restore reads JSON a hand may have written. */
function shapeFailure(entry: unknown): string | undefined {
  if (!isObject(entry)) return 'not an object';
  const { id, kind, owner, producer, payload } = entry;
  if (!isString(id) || !isString(kind) || !STORED_KINDS.has(kind)) return `kind ${String(kind)} is not stored`;
  if (!isObject(owner) || !isString(owner['kind']) || !(isString(owner['id']) || (owner['kind'] === 'barCross' && isString(owner['node'])))) return `${id} has no owner`;
  if (!isString(producer) || !PRODUCERS.has(producer)) return `${id} has no producer`;
  if (!isObject(payload)) return `${id} has no payload`;
  const bad = `${id} has a payload of the wrong shape`;
  const sides = ['top', 'bottom', 'left', 'right'];
  switch (kind) {
    case 'pitchFloor': return isString(payload['node']) && sides.includes(payload['side'] as string) && isNumber(payload['min']) && (payload['min'] as number) > 0 ? undefined : bad;
    case 'pairFloor': {
      const ports = payload['ports'];
      return isString(payload['node']) && (payload['side'] === 'top' || payload['side'] === 'bottom') && Array.isArray(ports) && ports.length === 2 && ports.every(isString)
        && (ports[0] as string) < (ports[1] as string) && isNumber(payload['min']) && (payload['min'] as number) > 0 ? undefined : bad;
    }
    case 'nodeFloor': {
      const min = payload['min'];
      return isString(payload['node']) && isObject(min) && isNumber(min['width']) && isNumber(min['height']) && (min['width'] as number) > 0 && (min['height'] as number) > 0 ? undefined : bad;
    }
    case 'sideFace': {
      const promise = payload['promise'];
      const promiseOk = promise === undefined || (isObject(promise) && isString(promise['link']) && (promise['shape'] === 'straight' || promise['shape'] === 'L') && Number.isInteger(promise['bends']));
      return isPort(payload['port']) && (payload['side'] === 'left' || payload['side'] === 'right') && promiseOk ? undefined : bad;
    }
    case 'laneOwner': return isPort(payload['port']) && (payload['side'] === 'left' || payload['side'] === 'right') && isString(payload['link']) && payload['bends'] === 1 ? undefined : bad;
    case 'course': return isObject(payload['course']) && isString(payload['course']['link']) && (payload['maxTurns'] === undefined || Number.isInteger(payload['maxTurns'])) ? undefined : bad;
    case 'spanChord': return isString(payload['link']) ? undefined : bad;
    case 'turnOrder': {
      const scope = payload['scope'];
      const scopeOk = isObject(scope) && (scope['all'] === true || (Array.isArray(scope['links']) && scope['links'].every(isString)));
      const exceptOk = payload['except'] === undefined || (Array.isArray(payload['except']) && payload['except'].every(isString));
      return scopeOk && exceptOk && typeof payload['requireChanged'] === 'boolean' ? undefined : bad;
    }
    case 'staggerDeclined': {
      const links = payload['links'];
      // The held-straight clause names the links it lost (at least one); no other clause names links (dense-16x9 ticket 35, review 1).
      const named = Array.isArray(links) && links.length > 0 && links.every(isString);
      return isString(payload['group']) && isString(payload['reason']) && (STAGGER_DECLINE_CLAUSES as readonly unknown[]).includes(payload['clause'])
        && (payload['clause'] === 'held-straight' ? named : links === undefined) ? undefined : bad;
    }
    case 'seatSet': return seatSetShapeFailure(payload) === undefined ? undefined : bad;
    case 'seatSetDeclined': return typeof payload['row'] === 'string' && typeof payload['at'] === 'string' && typeof payload['why'] === 'string' ? undefined : bad;
    case 'refusedChord': return isString(payload['link']) ? undefined : bad;
    case 'farEndOrder': {
      const ports = payload['ports'];
      return isString(payload['node']) && sides.includes(payload['side'] as string) && Array.isArray(ports) && ports.length > 1 && ports.every(isPort) && new Set(ports.map(item => JSON.stringify(item))).size === ports.length ? undefined : bad;
    }
    case 'rowOrder': {
      const order = payload['order'], one = [payload['cell'], payload['frame'], payload['row']].filter(isString).length === 1;
      return one && feedsShape(payload['feeds']) && orderShape(order) ? undefined : bad;
    }
    case 'groupOrder': {
      return Number.isInteger(payload['tier']) && feedsShape(payload['feeds']) && orderShape(payload['order']) ? undefined : bad;
    }
    case 'corridorSide': {
      return isString(payload['link']) && Number.isInteger(payload['tier']) && isString(payload['group']) && (payload['side'] === 'left' || payload['side'] === 'right') ? undefined : bad;
    }
    case 'bundleNeighbours': {
      const pairs = payload['pairs'];
      return isString(payload['group']) && Array.isArray(pairs) && pairs.length > 0
        && pairs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(isString) && pair[0] !== pair[1]) ? undefined : bad;
    }
    default: {
      const scope = payload['scope'];
      return isObject(scope) && (scope['all'] === true || isString(scope['key'])) && isString(payload['reason']) ? undefined : bad;
    }
  }
}

/** The ledger is a list of well-formed entries with unique ids, each active from its kind's stage. */
function validateLedgerShape(ledger: Reservations): void {
  if (!Array.isArray(ledger)) throw new Error('Reservations must be a list');
  for (const entry of ledger) {
    const bad = shapeFailure(entry);
    if (bad !== undefined) throw new Error(`Reservation is malformed: ${bad}`);
  }
  const ids = new Set<string>();
  for (const entry of ledger) {
    const item = entry as unknown as { id?: unknown; kind?: unknown; activeFrom?: unknown; revision?: unknown } | null;
    if (typeof item !== 'object' || item === null || typeof item.id !== 'string' || typeof item.kind !== 'string' || !Object.hasOwn(ACTIVE_FROM, item.kind)) throw new Error('A reservation is malformed');
    if (ids.has(item.id)) throw new Error(`Reservation ${item.id} is held twice`);
    ids.add(item.id);
    if (item.activeFrom !== ACTIVE_FROM[item.kind as ReservationKind]) throw new Error(`Reservation ${item.id} is active from the wrong stage`);
    if (!Number.isInteger(item.revision) || (item.revision as number) < 0) throw new Error(`Reservation ${item.id} has no revision`);
  }
}

/**
 * The restore of a model before the port topology freezes (stages up to `size`, and `skeleton`): the ledger is well formed, the floors hold
 * from stage 3 on, and the order reservations stage 4 writes hold on the model (R2, R5). The freeze-bound checks of `validateReservations` need the freeze and wait for it.
 */
/**
 * Where each reservation kind is checked (dense-16x9 ticket 22, review 4): one entry per kind, which typecheck enforces (a mapped type over
 * `ReservationKind`: a new kind without an entry does not compile). `predicate` is the kind's one per-entry check, when it has one. `at` names the
 * three readers: the round check (`holds` in `reservation-checks.ts`), restore of a frozen model (`validateReservations`) and restore of a model
 * before the freeze (`validateEarlyReservations`). For each, `true` means the reader calls `predicate` on every entry of the kind, a function means
 * it calls it on the models the function admits, and a string says how that reader reads the kind instead, or why the kind does not apply there.
 */
type ReaderCheck = true | ((model: LayoutModel) => boolean) | string;
export interface KindCheck { readonly predicate?: (item: Reservation, model: LayoutModel) => string | undefined; readonly at: { readonly round: ReaderCheck; readonly final: ReaderCheck; readonly early: ReaderCheck } }
const TRANSIENT = 'transient: it lives for one move check and is never stored (`validateLedgerShape` refuses it)';
const ROUND_OWN = 'its own check in `holdsOne` (`reservation-checks.ts`), which reads the 7e geometry';
const NOT_EARLY_YET = 'not compared before the freeze (open since before ticket 22; review 4 report)';
const AFTER_FREEZE = 'active from stage 5 (`sides-two`): a model before the freeze carries none of what it reserves';
const sized = (model: LayoutModel): boolean => model.stage === 'size' || model.stage === 'skeleton';
const transientKind: KindCheck = { at: { round: TRANSIENT, final: TRANSIENT, early: TRANSIENT } };
const everywhere = (predicate: NonNullable<KindCheck['predicate']>): KindCheck => ({ predicate, at: { round: true, final: true, early: true } });
// A floor is active from stage 3 (`size`): a stage-3 or stage-4 model keeps its pitch, pair and node floors (dense-16x9 ticket 04 review).
const floor: KindCheck = { predicate: (item, model) => floorFailure(item, model), at: { round: true, final: true, early: sized } };
export const RESERVATION_CHECKS: { readonly [K in ReservationKind]: KindCheck } = {
  pitchFloor: floor,
  pairFloor: floor,
  nodeFloor: floor,
  sideFace: { at: { round: ROUND_OWN, final: 'compared as a whole with the side hints of the ports (`validateReservations`)', early: NOT_EARLY_YET } },
  laneOwner: { at: { round: ROUND_OWN, final: 'compared as a whole with the lane hints of the ports (`validateReservations`)', early: NOT_EARLY_YET } },
  course: { at: { round: ROUND_OWN, final: 'compared as a whole with the courses of the model (`validateReservations`)', early: NOT_EARLY_YET } },
  spanChord: { at: { round: ROUND_OWN, final: 'compared as a whole with the frozen span hints (`validateReservations`)', early: NOT_EARLY_YET } },
  turnOrder: { at: { round: ROUND_OWN, final: 'compared as a whole with the turn order of the model (`validateReservations`)', early: AFTER_FREEZE } },
  farEndOrder: { at: { round: ROUND_OWN, final: 'compared as a whole with the far-end orders of the model (`validateReservations`)', early: AFTER_FREEZE } },
  trunkDeclined: { at: { round: ROUND_OWN, final: 'compared with the declined trunk joins of the model (`validateReservations`)', early: NOT_EARLY_YET } },
  // The keep-mode run copies the stagger rows into the resolved model (`place.ts`), so every stage of a run carries them (review 4).
  staggerDeclined: everywhere((item, model) => staggerDeclineFailure(item, model)),
  // Written by stage 5; the predicate refuses it on a model before 'sides-two' (dense-16x9 ticket 36).
  seatSet: everywhere((item, model) => seatSetFault(item, model)),
  seatSetDeclined: everywhere((item, model) => seatSetDeclinedFault(item, model)),
  // Written on the kept 7e model only; the predicate refuses it on a model before `sides-two` (review 2 of dense-16x9 ticket 04 slice 2).
  refusedChord: everywhere((item, model) => refusedChordFailure(item, model)),
  riserKeepOut: transientKind, trunkExtension: transientKind, laneSide: transientKind, sideAlignment: transientKind, spanCorridor: transientKind, groupExit: transientKind, labelRoom: transientKind,
  rowOrder: everywhere((item, model) => rowOrderFailure(item, model)),
  groupOrder: everywhere((item, model) => groupOrderFailure(item, model)),
  corridorSide: everywhere((item, model) => corridorSideFailure(item, model)),
  bundleNeighbours: everywhere((item, model) => bundleNeighboursFailure(item, model)),
};
/**
 * The placement inputs that stand in model fields outside the ledger (dense-16x9 ticket 04, slice 3; `PlacementInputs`): the gaps of the flat
 * blocks and the room of their members. They are not ledger entries: the rounds of `initial.ts` decide them before any round of the driver, `env` carries them and `place`
 * copies them, unchanged, into every placement run from `resolve` on. One predicate per field and the same three readers as `RESERVATION_CHECKS`.
 * The table is a mapped type over the keys of `PlacementInputs`, their one declaration: a new placement input without an entry does not compile.
 */
const NO_ROUND_WRITES = 'no round writes it: the input is decided before the rounds and copied unchanged into every run, so a round has nothing to compare';
export const FIELD_CHECKS: { readonly [K in PlacementInputField]: { readonly predicate: (model: LayoutModel) => string | undefined; readonly at: KindCheck['at'] } } = {
  // The records the predicate compares with are written from the placement stage on; before them it reads the entries alone.
  flatBlockGaps: { predicate: flatBlockGapsFault, at: { round: NO_ROUND_WRITES, final: true, early: true } },
  blockBoxPads: { predicate: blockBoxPadsFault, at: { round: NO_ROUND_WRITES, final: true, early: true } },
  blockRowGaps: { predicate: blockRowGapsFault, at: { round: NO_ROUND_WRITES, final: true, early: true } },
  steepBlocks: { predicate: steepBlocksFault, at: { round: NO_ROUND_WRITES, final: true, early: true } },
};
/** The first field of `FIELD_CHECKS` whose record fails the check `reader` makes on `model`, with why, or `undefined`. */
export function fieldFailure(model: LayoutModel, reader: keyof KindCheck['at']): string | undefined {
  for (const [field, check] of Object.entries(FIELD_CHECKS)) {
    const at = check.at[reader];
    if (typeof at === 'string' || (typeof at === 'function' && !at(model))) continue;
    const why = check.predicate(model);
    if (why !== undefined) return `${field}: ${why}`;
  }
  return undefined;
}
/** Why `item` fails the per-entry check `reader` makes on `model` (`RESERVATION_CHECKS`), or `undefined`. */
export function entryFailure(item: Reservation, model: LayoutModel, reader: keyof KindCheck['at']): string | undefined {
  const check = RESERVATION_CHECKS[item.kind], at = check.at[reader];
  if (typeof at === 'string' || (typeof at === 'function' && !at(model))) return undefined;
  return check.predicate!(item, model);
}

export function validateEarlyReservations(model: LayoutModel): void {
  // The placement inputs outside the ledger (`FIELD_CHECKS`, `early`): `place` copies them right after `resolve`, so every stage carries them.
  const field = fieldFailure(model, 'early');
  if (field !== undefined) throw new Error(`The placement input ${field}`);
  if (model.reservations === undefined) return;
  validateLedgerShape(model.reservations);
  // Every kind the table checks per entry before the freeze (`RESERVATION_CHECKS`, `early`).
  for (const item of model.reservations) {
    const why = entryFailure(item, model, 'early');
    if (why !== undefined) throw new Error(`Reservation ${item.id} does not hold: ${why}`);
  }
}


/**
 * A restored layout must carry a ledger that agrees with what the model records. Each channel checks its own kind against the field it
 * stands behind; a ledger entry the model does not show, or a model field no entry explains, is a layout the pipeline did not publish.
 */
export function validateReservations(model: LayoutModel): void {
  // The placement inputs outside the ledger (`FIELD_CHECKS`, `final`).
  const field = fieldFailure(model, 'final');
  if (field !== undefined) throw new Error(`The placement input ${field}`);
  const ledger = model.reservations ?? [];
  validateLedgerShape(ledger);
  if (model.reservations !== undefined) {
    // The size floors the ledger reserves are the ones the freeze records, node for node.
    const held = nodeFloorsOf(ledger), frozen = new Map((model.freeze?.nodeFloors ?? []).map(floor => [floor.node, floor.size] as const));
    if (held.size !== frozen.size || [...held].some(([node, size]) => !same(frozen.get(node), size))) throw new Error('Reserved node floors differ from the frozen node floors');
  }
  if (model.reservations !== undefined) {
    // A hinted port stands on the side its reservation names (a course face may supersede the hint), and every hinted port has its reservation.
    const faces = sideHintsOf(ledger);
    for (const [key, side] of faces) {
      const ref = portRefOf(key), port = model.nodes[ref.node]?.ports.find(item => portKey(item.ref) === key);
      if (port === undefined || (port.courseHint !== true && (port.sideHint !== true || port.side !== side))) throw new Error(`Reserved side face on ${key} is not the face the port stands on`);
    }
    for (const node of Object.values(model.nodes)) for (const port of node.ports) {
      if (port.sideHint === true && faces.get(portKey(port.ref)) !== port.side) throw new Error(`Side hint on ${node.id} has no reservation`);
    }
    // A lane hint is a lane owner's: the same ports, and each owner's port is a hinted one.
    const owners = laneKeysOf(ledger);
    for (const key of owners) if (!faces.has(key)) throw new Error(`Lane owner on ${key} has no side face`);
    for (const node of Object.values(model.nodes)) for (const port of node.ports) {
      if ((port.laneHint === true) !== owners.has(portKey(port.ref))) throw new Error(`Lane hint on ${node.id} does not match the lane owners`);
    }
  }
  if (model.reservations !== undefined) {
    // A trunk join the model declined is one the ledger declines, by its key or for every trunk.
    const declined = declinedTrunksOf(ledger);
    for (const key of model.declinedTrunks ?? []) if (declined.get(key) === undefined) throw new Error(`The trunk join ${key} is declined, and no reservation declines it`);
  }
  if (model.reservations !== undefined) {
    // The courses the ledger reserves are the courses the model carries, link for link.
    if (!same(coursesOf(ledger), model.courses ?? [])) throw new Error('Reserved courses differ from the courses of the model');
  }
  if (model.reservations !== undefined) {
    // The spanning chords the ledger reserves are the frozen span hints, link for link in link order.
    const held = spansOf(ledger);
    if (!same(model.links.filter(link => held.has(link.id)).map(link => link.id), model.freeze?.spans ?? []) || held.size !== (model.freeze?.spans ?? []).length) throw new Error('Reserved spanning chords differ from the frozen span hints');
  }
  // A far-end order the model carries must have the ledger that reserved it: without one the check below would pass on whatever the model says (R5).
  if (((model.farEndOrder?.length ?? 0) > 0 || (model.freeze?.farEndOrder?.length ?? 0) > 0) && model.reservations === undefined) throw new Error('The far-end order of the model has no reservation ledger');
  if (model.reservations !== undefined) {
    // The far-end orders of the ledger are the far-end orders of the model, face for face.
    if (!same(farEndOrderOf(ledger), model.farEndOrder ?? [])) throw new Error('The reserved far-end orders differ from the far-end orders of the model');
  }
  // A model that carries the turn order must carry the ledger that reserved it: without one the checks below would pass on whatever the model says.
  if (model.turnOrder === true && model.reservations === undefined) throw new Error('The turn order of the model has no reservation ledger');
  if (model.reservations !== undefined) {
    // The turn order of the ledger is the model's: every face, or the faces of the reserved links, or none.
    const turn = turnOf(ledger);
    if ((turn.all || turn.links.length > 0) !== (model.turnOrder === true)) throw new Error('The reserved turn order differs from the turn order of the model');
    if (!same(turn.all ? [] : turn.links, model.turnLinks ?? [])) throw new Error('The reserved turn links differ from the turn links of the model');
    if (!same(turn.except, model.turnExcept ?? []) || (model.turnExcept !== undefined && model.turnOrder !== true)) throw new Error('The reserved far-end faces differ from the far-end faces of the model');
  }
  // Every kind the table checks per entry on a frozen model (`RESERVATION_CHECKS`, `final`): the floors, the feed orders, the declined staggers.
  for (const item of ledger) {
    const why = entryFailure(item, model, 'final');
    if (why !== undefined) throw new Error(`Reservation ${item.id} does not hold: ${why}`);
  }
}
