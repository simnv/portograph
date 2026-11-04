/**
 * The predicates of the reservation ledger that read a placed or routed model (architecture 2, ticket 03).
 *
 * They live apart from `reservations.ts` because they reach the chord, lane and trunk readers, which reach the mutation module, and the mutation module validates
 * the ledger: the data module must stay a leaf. A reservation whose owner is missing from the model fails; it never passes for want of something to read.
 */
import type { LayoutModel } from '../model/layout.js';
import { isRoutedChord } from './frame-paths.js';
import { pathBends } from './objective.js';
import { sideLaneSource, transitTiers } from './lanes.js';
import { findPort } from './row-paths.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { spanLaneId } from './lane-kind.js';
import { trunkKey } from './bus-room.js';
import { trunkBuses, trunkHeads } from './trunk.js';
import { portKey } from './sides-one.js';
import { corridorSideFailure, floorFailure, ofKind, rowOrderFailure, type Reservation, type ReservationFailure, type Reservations } from './reservations.js';

type Found = { why: string; key?: string; link?: string };

const portOf = (model: LayoutModel, ref: { node: string }, key: string) => model.nodes[ref.node]?.ports.find(port => portKey(port.ref) === key);

function holdsOne(item: Reservation, model: LayoutModel): Found | undefined {
  switch (item.kind) {
    case 'rowOrder': {
      const why = rowOrderFailure(item, model);
      return why === undefined ? undefined : { why };
    }
    case 'corridorSide': {
      const why = corridorSideFailure(item, model);
      return why === undefined ? undefined : { why, link: item.payload.link };
    }
    case 'pitchFloor':
    case 'nodeFloor': {
      const why = floorFailure(item, model);
      return why === undefined ? undefined : { why };
    }
    case 'spanChord': {
      const link = model.links.find(other => other.id === item.payload.link), id = item.payload.link;
      if (link === undefined) return { why: `${id} is missing`, link: id };
      if (!isRoutedChord(model, link)) return { why: `${id} does not hold a routed chord`, link: id };
      // The chord owns a corridor over every band it transits (Section 14.3): a band without one is a wall the router would discover.
      const open = transitTiers(model, link).filter(tier => !model.lanes.some(lane => lane.id === spanLaneId(id, tier)));
      return open.length === 0 ? undefined : { why: `${id} has no corridor in the sub-tiers ${open.join(', ')}`, link: id };
    }
    case 'sideFace': {
      // The port stands on the side the reservation names (a course face may supersede the hint).
      const key = portKey(item.payload.port), port = portOf(model, item.payload.port, key);
      if (port === undefined) return { why: `the port ${key} is missing`, key };
      if (port.courseHint !== true && (port.sideHint !== true || port.side !== item.payload.side)) return { why: `the port ${key} does not stand on ${item.payload.side}`, key };
      // A port hinted for the straight shape of a routed link must hold its chord at 7e. Otherwise it would be routed with no lane and no chord, and the router would find its route.
      const promise = item.payload.promise;
      if (promise?.shape !== 'straight') return undefined;
      const link = model.links.find(candidate => candidate.id === promise.link);
      if (link === undefined) return { why: `${promise.link} is missing`, key, link: promise.link };
      return link.layer === 'routed' && !isRoutedChord(model, link)
        ? { why: `a port hinted for a chord does not hold its chord at stage 7e (${promise.link})`, key, link: promise.link } : undefined;
    }
    case 'laneOwner': {
      // A port hinted for the routed L must own a source-aligned side lane at 7e. Without one the router would find its route (an exterior corridor gives three bends).
      const link = item.payload.link, key = portKey(item.payload.port);
      if (portOf(model, item.payload.port, key) === undefined) return { why: `the port ${key} is missing`, key, link };
      const owner = model.links.find(candidate => candidate.id === link);
      if (owner === undefined) return { why: `${link} is missing`, key, link };
      // The lane is aligned now: the far port of the link stands on the lane's x (the flag alone says only that 7a seated it so).
      const lane = model.lanes.find(candidate => candidate.kind === 'side' && candidate.owner.kind === 'link' && candidate.owner.id === link && candidate.aligned === true);
      const anchor = lane === undefined || !owner.attachments ? undefined : findPort(model, sideLaneSource(owner, lane))?.anchor;
      return lane !== undefined && anchor !== undefined && Math.abs(anchor.x - lane.x) <= PLACEMENT_EPS
        ? undefined : { why: `a port hinted for a side lane has no source-aligned lane at stage 7e (${link})`, key, link };
    }
    case 'course': {
      const wanted = item.payload.course, have = model.courses?.find(course => course.link === wanted.link);
      if (!model.links.some(link => link.id === wanted.link)) return { why: `${wanted.link} is missing`, link: wanted.link };
      if (have === undefined || JSON.stringify(have) !== JSON.stringify(wanted)) return { why: `${wanted.link} does not take its course`, link: wanted.link };
      return undefined;
    }
    case 'turnOrder': {
      const scope = item.payload.scope;
      if (model.turnOrder !== true) return { why: 'the model does not carry the turn order' };
      if ('links' in scope && !scope.links.every(id => (model.turnLinks ?? []).includes(id))) return { why: 'the model does not order the faces of every reserved link' };
      return item.payload.requireChanged && (model.freeze?.turnOrder ?? []).length === 0 ? { why: 'the turn order moved no face' } : undefined;
    }
    case 'trunkDeclined': {
      const keys = trunkHeads(model).map(head => trunkKey(trunkBuses(model, head)));
      const scope = item.payload.scope;
      if ('all' in scope) return keys.length === 0 ? undefined : { why: 'a trunk join stands although every trunk is declined' };
      return keys.includes(scope.key) ? { why: `the trunk join ${scope.key} stands although it is declined` } : undefined;
    }
    default: return undefined;
  }
}

/**
 * The failures of the reservations that a 7e model can show, in ledger order. A round asks once after the final 7e of a trial, before 7f and the route, for every active
 * reservation (the kept entries of earlier rounds too); `only` names a subset for a caller that answers for some.
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

/**
 * The failures of the routed obligations of a ledger against a routed model: a course that was kept with a turn count publishes no more turns than it promised
 * (`maxTurns`). It runs before every commit of a judged trial and for the model the command publishes; a 7e prediction of the turns would only be a lower bound.
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
