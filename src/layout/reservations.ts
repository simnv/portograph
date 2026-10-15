/**
 * The reservation ledger (architecture 2, ticket 03): what placement is told to keep, as one immutable value.
 *
 * Before the ledger a hint was a wish. Each round offered it through one of eight `place()` channels, placement ran again, and the
 * result was guarded after the fact. The load-bearing rule of the pipeline says nothing may be discovered in routing that could have been
 * reserved in placement; the ledger makes that rule explicit. A reservation is plain JSON data (it lives on the model, which requires
 * plain JSON), and every predicate that judges one is code in this file, outside the model.
 */
import type { Course, LayoutModel, LayoutStage, Owner, PortRef, Side, Size } from '../model/index.js';
import { portKey } from './sides-one.js';
import { isRoutedChord } from './frame-paths.js';
import { pathBends } from './objective.js';

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
}
export type ReservationKind = keyof ReservationPayload;

export type Reservation = { [K in ReservationKind]: Readonly<{
  id: string;
  kind: K;
  owner: ReservationOwner;
  producer: RoundId | 'lanes' | 'bands';
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
  turnOrder: 'sides-two', trunkDeclined: 'resolve', riserKeepOut: 'lanes', trunkExtension: 'lanes', laneSide: 'lanes', sideAlignment: 'lanes', spanCorridor: 'lanes',
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

/**
 * The failures of the reservations that a 7e model can show, in ledger order. A round asks once, after its final 7e and before 7f and the route, with `only` naming the
 * entries it answers for (a side round judges its faces and lanes, a span round its own chords, a turn round its turn order).
 */
export function holds(ledger: Reservations, model: LayoutModel, only: (entry: Reservation) => boolean = () => true): ReservationFailure[] {
  const failures: ReservationFailure[] = [];
  for (const entry of ledger) {
    if (!only(entry)) continue;
    const found = holdsOne(entry, model);
    if (found !== undefined) failures.push({ id: entry.id, kind: entry.kind, entry, ...found });
  }
  return failures;
}

type Found = { why: string; key?: string; link?: string };
function holdsOne(item: Reservation, model: LayoutModel): Found | undefined {
  switch (item.kind) {
    case 'pitchFloor': {
      const have = model.nodes[item.payload.node]?.sidePitch?.[item.payload.side];
      return have !== undefined && have >= item.payload.min ? undefined : { why: `the ${item.payload.side} pitch of ${item.payload.node} is under ${item.payload.min}` };
    }
    case 'nodeFloor': {
      const size = model.nodes[item.payload.node]?.size;
      return size !== undefined && size.width >= item.payload.min.width && size.height >= item.payload.min.height ? undefined : { why: `${item.payload.node} is smaller than its floor` };
    }
    case 'spanChord': {
      const link = model.links.find(other => other.id === item.payload.link);
      return link !== undefined && isRoutedChord(model, link) ? undefined : { why: `${item.payload.link} does not hold a routed chord`, link: item.payload.link };
    }
    case 'sideFace': {
      // A port hinted for the straight shape of a routed link must hold its chord at 7e. Otherwise it would be routed with no lane and no chord, and the router would find its route.
      const promise = item.payload.promise;
      if (promise?.shape !== 'straight') return undefined;
      const link = model.links.find(candidate => candidate.id === promise.link);
      return link !== undefined && link.layer === 'routed' && !isRoutedChord(model, link)
        ? { why: `a port hinted for a chord does not hold its chord at stage 7e (${promise.link})`, key: portKey(item.payload.port), link: promise.link } : undefined;
    }
    case 'laneOwner': {
      // A port hinted for the routed L must own a source-aligned side lane at 7e. Without one the router would find its route (an exterior corridor gives three bends).
      const link = item.payload.link;
      return model.lanes.some(lane => lane.kind === 'side' && lane.owner.kind === 'link' && lane.owner.id === link && lane.aligned === true)
        ? undefined : { why: `a port hinted for a side lane has no source-aligned lane at stage 7e (${link})`, key: portKey(item.payload.port), link };
    }
    case 'turnOrder':
      return item.payload.requireChanged && (model.freeze?.turnOrder ?? []).length === 0 ? { why: 'the turn order moved no face' } : undefined;
    default: return undefined;
  }
}

/**
 * The failures of the routed obligations of a ledger against a routed model: a course that was kept with a turn count publishes no more turns than it promised
 * (`maxTurns`). It runs for every later trial that is judged and for the model the command publishes; a 7e prediction of the turns would only be a lower bound.
 * `got` is the turns the link has, absent when it has no route.
 */
export function holdsRouted(ledger: Reservations, routed: LayoutModel): (ReservationFailure & { got: number | undefined; max: number })[] {
  const failures: (ReservationFailure & { got: number | undefined; max: number })[] = [];
  for (const entry of ofKind(ledger, 'course')) {
    const max = entry.payload.maxTurns;
    if (max === undefined) continue;
    const link = routed.links.find(item => item.id === entry.payload.course.link), got = link === undefined ? undefined : pathBends(link);
    if (got === undefined || got > max) failures.push({ id: entry.id, kind: 'course', entry, why: `${entry.payload.course.link} has ${got === undefined ? 'no route' : `${got} turns`}, ${max} were promised`, link: entry.payload.course.link, got, max });
  }
  return failures;
}
/** The turn count each kept course promised, by link id: what the turn round's judgment compares a trial with. */
export function promisedTurns(ledger: Reservations): Map<string, number> {
  return new Map(ofKind(ledger, 'course').flatMap(({ payload }) => payload.maxTurns === undefined ? [] : [[payload.course.link, payload.maxTurns] as const]));
}

/**
 * A restored layout must carry a ledger that agrees with what the model records. Each channel checks its own kind against the field it
 * stands behind; a ledger entry the model does not show, or a model field no entry explains, is a layout the pipeline did not publish.
 */
export function validateReservations(model: LayoutModel): void {
  const ledger = model.reservations ?? [];
  if (!Array.isArray(ledger)) throw new Error('Reservations must be a list');
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
    if (!same(coursesOf(ledger).map(course => course.link), (model.courses ?? []).map(course => course.link))) throw new Error('Reserved courses differ from the courses of the model');
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
  // A floor is a promise about the placed geometry, which later stages may only grow; the kinds below are checked on every restored stage.
  for (const failure of holds(ledger.filter(item => RESTORED.has(item.kind)), model)) throw new Error(`Reservation ${failure.id} does not hold: ${failure.why}`);
}
/** The kinds whose predicate reads only what every published stage keeps. */
const RESTORED: ReadonlySet<ReservationKind> = new Set<ReservationKind>(['pitchFloor', 'nodeFloor']);
