import type { Point, Side } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutNode, LayoutPort } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { EPS } from '../score/geometry.js';
import { endpoints, port as portOf, refKey, routed as isRoutedLink } from '../score/model.js';
import { ofKind, type ReservationOf } from './reservations.js';
import { SIDE_TIE_ORDER } from './sides-one.js';
import { portId } from './skeleton-graph.js';
import { faceKey } from './turn-order.js';
import { proposalGroups, proposalKey, proposeFarEndOrder } from './far-end-order.js';

/**
 * The one reader of G5 `port-order` on a face (dense-16x9 ticket 49): the gate (`portOrder`), the far-end round (`staleFaces`, `proposeFarEndOrder`) and the
 * publication check read it, so they cannot disagree about a face.
 *
 * A face fails when two of its free ports stand the wrong way round (`facePositions`, `standsWrong`), unless one of two records decides its order:
 * - the turn round recorded the face (`freeze.turnOrder`): G5 judges it by that record (`turnRecordFaults`);
 * - the far-end round declined the far-end order of the face on a full trial (`farEndDecision` in the ledger): the whole-sheet measure of that trial
 *   (the unified order, or a guard) is the rule, and G5 accepts the face while the record holds: the ports stand in the recorded order and exactly the
 *   recorded pairs stand the wrong way round. A record that no longer holds is stale: G5 judges the face again, and the publication names the record.
 */

/** One free port of a face as G5 reads it: where it stands along the face, and the range of its far ends along the same axis. */
export interface PortPosition { port: LayoutPort; own: number; min: number; max: number }

export const alongOf = (side: Side): 'x' | 'y' => (side === 'top' || side === 'bottom' ? 'x' : 'y');

/** Every port's far anchors by port key, over the routed links, a link seen from both ends (G5's index; a link whose far port is missing contributes nothing). */
export function farAnchorIndex(model: LayoutModel, routedLinks: ReadonlySet<LayoutLink>): Map<string, Point[]> {
  const farAnchors = new Map<string, Point[]>();
  for (const link of model.links) {
    if (!routedLinks.has(link)) continue;
    const ends = endpoints(link);
    for (const [near, far] of [[ends.from, ends.to], [ends.to, ends.from]] as const) {
      const target = portOf(model, far);
      if (!target) continue;
      const at = refKey(near), list = farAnchors.get(at);
      if (list) list.push(target.anchor!); else farAnchors.set(at, [target.anchor!]);
    }
  }
  return farAnchors;
}

/** The ports of one face that G5 judges by far-end ranges: not authored, with at least one routed far end. */
export function facePositions(node: LayoutNode, side: Side, farAnchors: ReadonlyMap<string, readonly Point[]>): PortPosition[] {
  const along = alongOf(side);
  return node.ports.filter(port => port.side === side && port.authorOrder === undefined).flatMap(port => {
    const peers = farAnchors.get(refKey(port.ref));
    if (!peers?.length) return [];
    let min = Infinity, max = -Infinity;
    for (const anchor of peers) {
      if (anchor[along] < min) min = anchor[along];
      if (anchor[along] > max) max = anchor[along];
    }
    return [{ port, own: port.anchor![along], min, max }];
  });
}

/** G5's comparison: `x` stands before `y` on the face while its far ends lie strictly after the far ends of `y`. */
export const standsWrong = (x: { own: number; min: number }, y: { own: number; max: number }): boolean => x.own < y.own - EPS && x.min > y.max + EPS;

/** Whether any two free ports of a face stand the wrong way round (G5 `port-order` on this face). */
export function faceIsStale(positions: readonly PortPosition[]): boolean {
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    if (standsWrong(positions[i]!, positions[j]!) || standsWrong(positions[j]!, positions[i]!)) return true;
  }
  return false;
}

/** The links that G5 reads as routed on a placement model: a routed link with a path. */
export const routedLinksOf = (model: LayoutModel): Set<LayoutLink> =>
  new Set(model.links.filter(link => isRoutedLink(link) && link.path !== undefined && link.path.segments.length > 0));


/** A pair of free ports of one face that stands the wrong way round: `before` stands first on the face, and its far ends lie strictly after those of `after`. */
export type WrongPair = readonly [before: string, after: string];

/** The pairs of a face that stand the wrong way round, by `portId`, sorted. */
export function wrongPairs(positions: readonly PortPosition[]): WrongPair[] {
  const pairs: WrongPair[] = [];
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    const a = positions[i]!, b = positions[j]!;
    if (standsWrong(a, b)) pairs.push([portId(a.port.ref), portId(b.port.ref)]);
    if (standsWrong(b, a)) pairs.push([portId(b.port.ref), portId(a.port.ref)]);
  }
  return pairs.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) : x[0] < y[0] ? -1 : 1));
}

/** The ports of a face in engine order, by `portId`. */
const engineIds = (model: LayoutModel, node: string, side: Side): string[] =>
  [...model.nodes[node]!.ports.filter(port => port.side === side)].sort((a, b) => (a.engineOrder ?? 0) - (b.engineOrder ?? 0)).map(port => portId(port.ref));

export type FarEndDecisionEntry = ReservationOf<'farEndDecision'>;

/** The far-end decisions of the model's ledger, by `faceKey`. */
export const farEndDecisions = (model: LayoutModel): Map<string, FarEndDecisionEntry> =>
  new Map(ofKind(model.reservations ?? [], 'farEndDecision').map(entry => [faceKey(entry.payload.node, entry.payload.side), entry] as const));

/**
 * Why the proposal of a far-end decision does not show the trial that earned it (dense-16x9 ticket 49, review 2), or `undefined`: each face stands in the
 * proposal once, the decided face among them, and its wanted order differs from the standing order and puts every recorded pair the other way round (the
 * order that removes the recorded inversions).
 */
export function proposalFault(payload: FarEndDecisionEntry['payload']): string | undefined {
  const { node, side, ports, pairs, binding } = payload, keys = binding.proposal.map(face => faceKey(face.node, face.side));
  if (new Set(keys).size !== keys.length) return 'the proposal names a face twice';
  const wanted = binding.proposal.find(face => face.node === node && face.side === side);
  if (wanted === undefined) return 'the proposal does not hold the face';
  const order = wanted.ports.map(ref => portId(ref));
  if (JSON.stringify(order) === JSON.stringify(ports.map(ref => portId(ref)))) return 'the proposal asks for the order that stands';
  if (pairs.some(([before, after]) => !(order.indexOf(after) >= 0 && order.indexOf(after) < order.indexOf(before)))) return 'the proposal does not put the recorded pairs the other way round';
  return undefined;
}

/**
 * Why the proposal of a far-end decision is not the one the round generates on the model it was judged against (dense-16x9 ticket 49, review 3, R1: one
 * generator), or `undefined`. The round proposes with `proposeFarEndOrder` on the baseline and the decisions it holds then (those of the ledger with a lower
 * `revision`: the decisions of the same trial share its revision); a trial that a guard refused as a whole is tried again by group (`proposalGroups`). So the
 * recorded proposal equals that first proposal or one of its groups, in full: every face, every order, no other face. A follow-up proposal (`next`), read
 * from a refused trial's own final positions, is not generated from the saved model, so it earns no decision.
 */
export function generatedProposalFault(model: LayoutModel, entry: FarEndDecisionEntry): string | undefined {
  const held = new Map(ofKind(model.reservations ?? [], 'farEndDecision').filter(item => item.revision < entry.revision).map(item => [faceKey(item.payload.node, item.payload.side), item] as const));
  const first = proposeFarEndOrder(model, [], held).faces, recorded = proposalKey(entry.payload.binding.proposal);
  if (proposalKey(first) === recorded || proposalGroups(model, first).some(group => proposalKey(group) === recorded)) return undefined;
  return 'the proposal is not the one the far-end round generates on the sheet';
}

/** A digest of a JSON value, the keys of every object sorted: two FNV-1a 32-bit hashes of the canonical text (no runtime dependency, the same in a browser). */
export function digestOf(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])])) : item;
  const text = JSON.stringify(canonical(value)) ?? '';
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
/** The input of a command as a far-end decision binds it (dense-16x9 ticket 49, review 1): the document with its layout options. */
export const inputDigest = (model: LayoutModel): string => digestOf(model.document);
/**
 * The far-end geometry a judge read as a decision binds it (review 1): every port anchor and the routed links. The declined trial keeps the baseline, and
 * stage 9 moves no port, so the published model of that baseline has the same digest; a later kept trial gives another.
 */
export function baselineDigest(model: LayoutModel): string {
  const anchors = Object.values(model.nodes).flatMap(node => node.ports.map(port => [refKey(port.ref), port.side, port.anchor?.x ?? null, port.anchor?.y ?? null] as const))
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return digestOf({ anchors, routed: [...routedLinksOf(model)].map(link => link.id).sort() });
}

/**
 * Why a far-end decision does not hold on the model, or `undefined`: the model is of the input the decision bound (`inputDigest`) and of the baseline
 * it was judged on (`baselineDigest`), the ports stand in the recorded order, and exactly the recorded pairs stand wrong.
 */
export function decisionStale(model: LayoutModel, entry: FarEndDecisionEntry, wrong: readonly WrongPair[]): string | undefined {
  const { node, side, ports, pairs, binding } = entry.payload;
  if (model.nodes[node] === undefined) return 'the face does not exist';
  if (binding.input !== inputDigest(model)) return 'the record is of another input or other layout options';
  if (binding.baseline !== baselineDigest(model)) return 'the sheet is not the one the trial was judged against';
  if (JSON.stringify(engineIds(model, node, side)) !== JSON.stringify(ports.map(ref => portId(ref)))) return 'the ports do not stand in the recorded order';
  if (JSON.stringify(wrong) !== JSON.stringify(pairs)) return 'the far ends no longer stand in the recorded order';
  return proposalFault(entry.payload) ?? generatedProposalFault(model, entry);
}

/** How the reader judges one face. */
export interface FaceReading {
  node: string;
  side: Side;
  /** The pairs that stand the wrong way round, by far-end ranges (empty for a turn-recorded face, which its record judges). */
  wrong: WrongPair[];
  /** The record that decides the order of the face, if one does; `stale` says why a far-end decision no longer holds. */
  record?: { kind: 'turn' } | { kind: 'decision'; entry: FarEndDecisionEntry; stale?: string };
  /** Whether G5 fails the face by far-end ranges: a wrong pair, and no record that holds. */
  fails: boolean;
}

/** The reading of one face, with the far anchors of the routed links (`farAnchorIndex`) and the decisions of the ledger (`farEndDecisions`). */
export function readFace(model: LayoutModel, node: string, side: Side, index: ReadonlyMap<string, readonly Point[]>,
  decisions: ReadonlyMap<string, FarEndDecisionEntry> = farEndDecisions(model)): FaceReading {
  if ((model.freeze?.turnOrder ?? []).some(face => face.node === node && face.side === side)) return { node, side, wrong: [], record: { kind: 'turn' }, fails: false };
  const wrong = wrongPairs(facePositions(model.nodes[node]!, side, index)), entry = decisions.get(faceKey(node, side));
  if (entry === undefined) return { node, side, wrong, fails: wrong.length > 0 };
  const stale = decisionStale(model, entry, wrong);
  return { node, side, wrong, record: { kind: 'decision', entry, ...(stale === undefined ? {} : { stale }) }, fails: stale !== undefined && wrong.length > 0 };
}

/** The reading of every face of the model, in node and side order, on the far anchors of `routedLinks`. */
export function readFaces(model: LayoutModel, routedLinks: ReadonlySet<LayoutLink>, nodes: readonly string[] = orderedNodeIds(model.document)): FaceReading[] {
  const index = farAnchorIndex(model, routedLinks), decisions = farEndDecisions(model);
  return nodes.flatMap(node => SIDE_TIE_ORDER.map(side => readFace(model, node, side, index, decisions)));
}

/** The far-end decisions that no longer hold on the model, with why (the publication names them, R6), in ledger order. */
export function staleFarEndDecisions(model: LayoutModel, routedLinks: ReadonlySet<LayoutLink>): { entry: FarEndDecisionEntry; why: string }[] {
  const index = farAnchorIndex(model, routedLinks);
  return ofKind(model.reservations ?? [], 'farEndDecision').flatMap(entry => {
    const { node, side } = entry.payload;
    if (model.nodes[node] === undefined) return [{ entry, why: 'the face does not exist' }];
    const why = decisionStale(model, entry, wrongPairs(facePositions(model.nodes[node]!, side, index)));
    return why === undefined ? [] : [{ entry, why }];
  });
}
