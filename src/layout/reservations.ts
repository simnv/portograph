/**
 * The reservation ledger (architecture 2, ticket 03): what placement is told to keep, as one immutable value.
 *
 * Before the ledger a hint was a wish. Each round offered it through one of eight `place()` channels, placement ran again, and the
 * result was guarded after the fact. The load-bearing rule of the pipeline says nothing may be discovered in routing that could have been
 * reserved in placement; the ledger makes that rule explicit. A reservation is plain JSON data (it lives on the model, which requires
 * plain JSON), and every predicate that judges one is code in this file, outside the model.
 */
import type { Course, GroupExit, LayoutModel, LayoutStage, Owner, PortRef, Rect, Side, Size } from '../model/index.js';
import { portKey } from './sides-one.js';
import { frameSubtreeCells } from '../model/model.js';

export type RoundId = 'initial' | 'fan' | 'span' | 'course' | 'side' | 'turn' | 'overlay';
/** A model owner, or the command (a reservation no single element owns: the turn order of every face, a budget decline of every trunk). */
export type ReservationOwner = Owner | { kind: 'command'; id: string };

export interface ReservationPayload {
  /** A fan of chords needs this port pitch on a face (ticket 89). */
  pitchFloor: { node: string; side: Side; min: number };
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
  /** Stage 5 orders the ports of a face by the planned first turn of their links. */
  turnOrder: { scope: { all: true } | { links: readonly string[] }; requireChanged: boolean };
  /** A trunk join (or every trunk join) that placement declines. */
  trunkDeclined: { scope: { all: true } | { key: string }; reason: string };
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
   * child frame by its id. `feeds` is the premise: each feeding row the order was read from, with the order it stood in. Stage 4 writes
   * it after the free rows are ordered; an absent entry means the feeds decide nothing there.
   */
  rowOrder: { cell: string; order: readonly string[]; feeds: readonly RowFeed[] } | { frame: string; order: readonly string[]; feeds: readonly RowFeed[] };
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
}
export type ReservationKind = keyof ReservationPayload;
/** A feeding row of a `rowOrder` or `groupOrder` entry: the group, and the order its nodes stood in when the feeds were read. */
export interface RowFeed { row: string; order: readonly string[] }

export type Reservation = { [K in ReservationKind]: Readonly<{
  id: string;
  kind: K;
  owner: ReservationOwner;
  producer: RoundId | 'skeleton' | 'lanes' | 'bands';
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
  pitchFloor: 'size', nodeFloor: 'size', sideFace: 'sides-one', laneOwner: 'sides-one', course: 'sides-one', spanChord: 'resolve',
  turnOrder: 'sides-two', trunkDeclined: 'resolve', riserKeepOut: 'lanes', trunkExtension: 'lanes', laneSide: 'lanes', sideAlignment: 'lanes', spanCorridor: 'lanes', groupExit: 'lanes', labelRoom: 'lanes',
  rowOrder: 'skeleton', groupOrder: 'skeleton', corridorSide: 'skeleton',
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
    if (old.kind === 'pitchFloor' && entry.kind === 'pitchFloor') {
      if (entry.payload.min > old.payload.min) result[at] = { ...old, revision: entry.revision, producer: entry.producer, payload: { ...old.payload, min: entry.payload.min } };
    } else if (old.kind === 'nodeFloor' && entry.kind === 'nodeFloor') {
      const min = { width: Math.max(old.payload.min.width, entry.payload.min.width), height: Math.max(old.payload.min.height, entry.payload.min.height) };
      if (!same(min, old.payload.min)) result[at] = { ...old, revision: entry.revision, producer: entry.producer, payload: { ...old.payload, min } };
    } else if (old.kind === 'sideFace' && entry.kind === 'sideFace') {
      if (old.payload.side !== entry.payload.side) throw new Error(`Reservation ${entry.id} asks for the side ${entry.payload.side}, and the ledger holds ${old.payload.side}`);
      if (old.payload.promise === undefined && entry.payload.promise !== undefined) result[at] = { ...old, payload: { ...old.payload, promise: entry.payload.promise } };
    } else if (old.kind === 'course' && entry.kind === 'course') {
      if (!same(old.payload.course, entry.payload.course)) throw new Error(`Reservation ${entry.id} conflicts with a course the ledger holds`);
    } else if (old.kind === 'turnOrder' && entry.kind === 'turnOrder') {
      if ('links' in old.payload.scope && 'links' in entry.payload.scope) {
        const links = [...new Set([...old.payload.scope.links, ...entry.payload.scope.links])];
        result[at] = { ...old, payload: { scope: { links }, requireChanged: old.payload.requireChanged || entry.payload.requireChanged } };
      } else if (entry.payload.requireChanged && !old.payload.requireChanged) result[at] = { ...old, payload: { ...old.payload, requireChanged: true } };
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

/** The courses every placement run reserves, in declaration order. */
export function coursesOf(ledger: Reservations): Course[] {
  return ofKind(ledger, 'course').map(({ payload }) => clone(payload.course));
}
export function courseEntries(courses: readonly Course[], promised: ReadonlyMap<string, number> | undefined, producer: RoundId, revision: number): Reservations {
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

/** Whether every face takes the turn order, and the links whose faces take it when not every face does. */
export function turnOf(ledger: Reservations): { all: boolean; links: string[]; requireChanged: boolean } {
  let all = false, requireChanged = false;
  const links: string[] = [];
  for (const { payload } of ofKind(ledger, 'turnOrder')) {
    if ('all' in payload.scope) all = true; else for (const id of payload.scope.links) if (!links.includes(id)) links.push(id);
    requireChanged ||= payload.requireChanged;
  }
  return { all, links, requireChanged };
}
export function turnEntries(turn: boolean, links: readonly string[], requireChanged: boolean, producer: RoundId, revision: number): Reservations {
  const command = { kind: 'command' as const, id: 'turn-order' };
  return [
    ...(turn ? [reservation('turnOrder', command, 'all', producer, revision, { scope: { all: true }, requireChanged })] : []),
    ...(links.length > 0 ? [reservation('turnOrder', command, 'links', producer, revision, { scope: { links: [...links] }, requireChanged: false })] : []),
  ];
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
export function declinedEntries(declined: DeclinedTrunks, revision: number): Reservations {
  const owner = { kind: 'command' as const, id: 'trunk-declines' };
  return [
    ...[...declined].map(([key, reason]) => reservation('trunkDeclined', { kind: 'mesh-bus', id: key }, key, 'initial', revision, { scope: { key }, reason })),
    ...(declined.all ? [reservation('trunkDeclined', owner, 'all', 'initial', revision, { scope: { all: true }, reason: declined.allReason })] : []),
  ];
}

// ---- Predicates and validators ---------------------------------------------------------------------------------------------------

/** The predicate of a floor against a placed model: sizes and pitches only grow, so it holds at every stage. */
export function floorFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind === 'pitchFloor') {
    const have = model.nodes[item.payload.node]?.sidePitch?.[item.payload.side];
    return have !== undefined && have >= item.payload.min ? undefined : `the ${item.payload.side} pitch of ${item.payload.node} is under ${item.payload.min}`;
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
export function rowOrderFailure(item: Reservation, model: LayoutModel): string | undefined {
  if (item.kind !== 'rowOrder') return undefined;
  const payload = item.payload;
  for (const feed of payload.feeds) {
    const row = model.groups[feed.row];
    if (row === undefined || !same(row.rowOrder ?? row.nodes, feed.order)) return `the feeding row ${feed.row} no longer stands in the order the entry read`;
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
const STORED_KINDS: ReadonlySet<string> = new Set(['pitchFloor', 'nodeFloor', 'sideFace', 'laneOwner', 'course', 'spanChord', 'turnOrder', 'trunkDeclined', 'rowOrder', 'groupOrder', 'corridorSide']);
const PRODUCERS: ReadonlySet<string> = new Set(['initial', 'fan', 'span', 'course', 'side', 'turn', 'overlay', 'skeleton', 'lanes', 'bands']);

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
      return scopeOk && typeof payload['requireChanged'] === 'boolean' ? undefined : bad;
    }
    case 'rowOrder': {
      const order = payload['order'], one = isString(payload['cell']) !== isString(payload['frame']);
      return one && feedsShape(payload['feeds']) && orderShape(order) ? undefined : bad;
    }
    case 'groupOrder': {
      return Number.isInteger(payload['tier']) && feedsShape(payload['feeds']) && orderShape(payload['order']) ? undefined : bad;
    }
    case 'corridorSide': {
      return isString(payload['link']) && Number.isInteger(payload['tier']) && isString(payload['group']) && (payload['side'] === 'left' || payload['side'] === 'right') ? undefined : bad;
    }
    default: {
      const scope = payload['scope'];
      return isObject(scope) && (scope['all'] === true || isString(scope['key'])) && isString(payload['reason']) ? undefined : bad;
    }
  }
}

/**
 * A restored layout must carry a ledger that agrees with what the model records. Each channel checks its own kind against the field it
 * stands behind; a ledger entry the model does not show, or a model field no entry explains, is a layout the pipeline did not publish.
 */
export function validateReservations(model: LayoutModel): void {
  const ledger = model.reservations ?? [];
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
  if (model.reservations !== undefined) {
    // The turn order of the ledger is the model's: every face, or the faces of the reserved links, or none.
    const turn = turnOf(ledger);
    if ((turn.all || turn.links.length > 0) !== (model.turnOrder === true)) throw new Error('The reserved turn order differs from the turn order of the model');
    if (!turn.all && !same(turn.links, model.turnLinks ?? [])) throw new Error('The reserved turn links differ from the turn links of the model');
  }
  // A floor is a promise about the placed geometry, which later stages may only grow, and a feed order a promise no later stage may turn;
  // the kinds below are checked on every restored stage.
  for (const item of ledger) {
    const why = floorFailure(item, model) ?? rowOrderFailure(item, model) ?? groupOrderFailure(item, model) ?? corridorSideFailure(item, model);
    if (why !== undefined) throw new Error(`Reservation ${item.id} does not hold: ${why}`);
  }
}
