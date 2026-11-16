import type { Point } from '../model/geometry.js';
import type { LayoutLink, LayoutModel, LayoutPort } from '../model/layout.js';
import { orderedNodeIds } from '../model/model.js';
import { pointTurns } from '../geometry/planar.js';
import { linkStrokeWidth, overlayTrackPitch } from '../theme/geometry.js';
import { rebuildNodeGeometry } from './node-geometry.js';
import { freeOverlayPorts } from './overlay-nest.js';
import { overlayBasePath, publishedOverlayPath, sharedBlockers } from './overlay-paths.js';
import { sharedTrackPairs, trackRuns } from './overlay-tracks.js';
import { neighbourPitch } from './pair-pitch.js';
import { portEndInsets } from './port-insets.js';
import { drawn, overlayCrossingPoints, portKey } from './read/crossings.js';
import { portId } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';

/**
 * Overlay port seat (dense-16x9 ticket 26). Two overlay links whose **end runs** (the first or the last run of a path, at its port) belong to
 * different nodes stand on one track when one port's run comes down beside the other's: the two ports stand nearer than the overlay track
 * pitch across the run, and the runs overlap along it. The separation cannot part them: it moves middle runs only, and an end run stands
 * on its port. Where the overlay base paths (`overlayBasePath`, the per-link placement path) show such a pair, a free port of the two takes a
 * seat inside its face one track pitch from the other run, so the track is reserved where the ports are seated and not found in routing.
 *
 * Decided at the end of the 7f attempt, after the ports nest (`nestOverlayPorts`), on the geometry that publishes, under the same guard
 * (`holds`: the room 7f reserved, and no centring finding more). The fact is the shared-track predicate (`sharedTrackPairs`, one predicate,
 * R1) read on the base paths, kept where both runs are end runs and their end nodes differ. The seat moves only a free overlay port
 * (`freeOverlayPorts`: no authored order, no routed link and no other link on it, no bus, no course); the seated port is never that of an
 * overlay that publishes straight (`publishedOverlayPath`, under every option), and its run leaves the face square. The port keeps its order on the face (`engineOrder` does not change) and its
 * neighbour pitch (`neighbourPitch`) to each neighbour, the spacing the node geometry check reads, so a pill keeps the clearance the face
 * pitch gives it: the neighbours on the side it moves to that would stand nearer move on by just that pitch, each of them free, and the
 * last port that moves stays inside the face's end insets (`seatMoves`; ruling of 2026-11-16). A pushed port may carry a straight overlay:
 * the judge below refuses a seat after which a link that published straight does not. A seat is kept only when the layer then shows fewer such pairs and,
 * on the published overlay paths, no more shared tracks, bent links, turns or crossing points; otherwise nothing moves and the pair
 * stays, as before the rule. The anchor is the record, as for the nest trades: no later stage seats an anchor from its slot again, and no
 * replay asks the seat again (a choice, not a fixed point).
 *
 * Order (R3): pairs by the track they share (axis, then position across, then along), then the ids of the two end nodes; candidates by
 * the length of the move, then the node id, then the position of the port on its face, then the direction (last key). At most
 * `SEAT_TRIALS` seats are tried per attempt (R4); pairs left untried then are named by `OVERLAY_SEAT_CUT` (R6). Returns the port ids that moved, sorted.
 */
export function seatOverlayEnds(model: LayoutModel, holds: (model: LayoutModel) => boolean = () => true): string[] {
  const { links, free } = freeOverlayPorts(model);
  if (links.length < 2) return [];
  const strokes = links.map(link => linkStrokeWidth(link));
  const portOf = (link: LayoutLink, end: 'from' | 'to'): LayoutPort | undefined => {
    const ref = link.attachments![end], key = portId(ref);
    return model.nodes[ref.node]?.ports.find(port => portId(port.ref) === key);
  };
  const pointsOf = (segments: readonly { from: Point; to: Point }[]): Point[] => (segments.length ? [segments[0]!.from, ...segments.map(segment => segment.to)] : []);
  const facts = (): Fact[] => {
    const shapes = sharedBlockers(model);
    const paths = links.map(link => pointsOf(overlayBasePath(model, link, shapes).segments));
    return endShares(links, paths, strokes);
  };
  // The published overlay paths (`publishedOverlayPath`, what stage 8 draws and the scorer reads, under every layout option): the layer's
  // keys, and the links that publish straight, by index. One reading for the straight test and the judge (R1).
  const measure = (): { keys: number[]; straight: Set<number> } => {
    const shapes = sharedBlockers(model);
    const points = links.map(link => pointsOf(publishedOverlayPath(model, link, shapes).segments));
    const shares = sharedTrackPairs(points.map((item, index) => ({ points: item, strokeWidth: strokes[index]! }))).length;
    const bent = points.filter(item => item.length > 2).length, turns = points.reduce((sum, item) => sum + pointTurns(item), 0);
    const crossings = overlayCrossingPoints(links.map((link, index) => drawn(points[index]!, [portKey(link.attachments!.from), portKey(link.attachments!.to)])));
    const straight = new Set(points.flatMap((item, index) => (item.length <= 2 ? [index] : [])));
    return { keys: [shares, bent, turns, crossings], straight };
  };
  let current = facts();
  if (!current.length) return [];
  let measured = measure();
  const moved = new Set<string>();
  let trials = 0, tried = false;
  // The pairs the cap leaves untried (R4, R6): named once at the end.
  const cut: Fact[] = [];
  for (const fact of [...current]) {
    // A seat kept for an earlier pair may have parted this one too.
    if (!current.some(item => item.key === fact.key)) continue;
    if (trials >= SEAT_TRIALS) { cut.push(fact); continue; }
    const candidates: Seat[] = [];
    for (const [own, other] of [[fact.one, fact.two], [fact.two, fact.one]] as const) {
      const link = links[own.path]!, end = own.run === 0 ? 'from' : 'to', port = portOf(link, end);
      // A straight overlay keeps its port: it publishes as one segment (the published path, not the base path: with `overlayOverBodies` a
      // base detour can publish straight).
      if (port === undefined || !free(port) || measured.straight.has(own.path)) continue;
      const node = model.nodes[port.ref.node]!, side = port.side!, along = side === 'top' || side === 'bottom';
      // The end run leaves the face square: across the run is along the face.
      if (own.horizontal === along) continue;
      const at = along ? port.anchor!.x : port.anchor!.y;
      if (Math.abs(at - own.at) > PLACEMENT_EPS) continue;
      const pitch = overlayTrackPitch(strokes[own.path]!, strokes[other.path]!);
      for (const target of [other.at - pitch, other.at + pitch]) {
        const moves = seatMoves(model, node.id, port, target, free);
        if (moves !== undefined) candidates.push({ node: node.id, along, from: at, to: target, moves });
      }
    }
    // Last key: the direction of the move.
    candidates.sort((a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from) || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0) || a.from - b.from || a.to - b.to);
    for (const seat of candidates) {
      if (trials >= SEAT_TRIALS) { cut.push(fact); break; }
      trials++; tried = true;
      const anchors = seat.moves.map(({ port }) => port.anchor!);
      for (const { port, to } of seat.moves) port.anchor = seat.along ? { x: to, y: port.anchor!.y } : { x: port.anchor!.x, y: to };
      rebuildNodeGeometry(model, [seat.node], 'current');
      const next = facts(), after = next.length < current.length && !next.some(item => item.key === fact.key) ? measure() : undefined;
      // No key of the layer rises, and every link that published straight still does (a pushed port may carry one).
      if (after !== undefined && after.keys.every((value, index) => value <= measured.keys[index]!) && [...measured.straight].every(index => after.straight.has(index))
        && holds(model)) {
        current = next; measured = after;
        for (const { port } of seat.moves) moved.add(portId(port.ref));
        break;
      }
      for (const [index, { port }] of seat.moves.entries()) port.anchor = anchors[index]!;
      rebuildNodeGeometry(model, [seat.node], 'current');
    }
  }
  // A seat rebuilt one node's pills and labels; the whole sheet is rebuilt in document order, as every other rebuild leaves it.
  if (tried) rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  if (cut.length) {
    const ids = [...new Set(cut.flatMap(fact => [links[fact.one.path]!.id, links[fact.two.path]!.id]))].sort();
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: OVERLAY_SEAT_CUT, owners: ids.map(id => ({ kind: 'link', id })),
      message: `The overlay port seat stopped at ${SEAT_TRIALS} trials; these pairs of end runs still share a track, and their seats were not all tried: ${cut.map(fact => fact.key.replace('|', ' and ')).join(', ')}.` });
  }
  return [...moved].sort();
}

/** The seats tried per attempt (R4: bounded by count); each one derives the base paths of the overlay layer again. */
export const SEAT_TRIALS = 16;
/** The seat ran out of trials with pairs left untried (R6): it names them. */
export const OVERLAY_SEAT_CUT = 'OVERLAY_SEAT_CUT';

interface EndRun { readonly path: number; readonly run: number; readonly horizontal: boolean; readonly at: number; readonly points: readonly Point[] }
interface Fact { readonly key: string; readonly one: EndRun; readonly two: EndRun }
interface Seat { readonly node: string; readonly along: boolean; readonly from: number; readonly to: number; readonly moves: readonly { port: LayoutPort; to: number }[] }

/**
 * The pairs of end runs of two overlay paths that share a track (`sharedTrackPairs`) and end at different nodes, in the order of the
 * track (axis, position across, position along), then the ids of the end nodes. A path of one run ends at both its nodes.
 */
function endShares(links: readonly LayoutLink[], paths: readonly Point[][], strokes: readonly number[]): Fact[] {
  const found: (Fact & { order: number[]; nodes: string })[] = [];
  for (const [[a, runA], [b, runB]] of sharedTrackPairs(paths.map((points, index) => ({ points, strokeWidth: strokes[index]! })))) {
    const last = (path: number): number => paths[path]!.length - 2;
    if ((runA !== 0 && runA !== last(a)) || (runB !== 0 && runB !== last(b))) continue;
    const nodes = (path: number, run: number): string[] => {
      const ends = links[path]!.attachments!;
      return [...(run === 0 ? [ends.from.node] : []), ...(run === last(path) ? [ends.to.node] : [])];
    };
    const one = nodes(a, runA), two = nodes(b, runB);
    if (one.some(node => two.includes(node))) continue;
    const runOf = (path: number, run: number): EndRun => {
      const item = trackRuns(paths[path]!, path).find(entry => entry.index === run)!;
      return { path, run, horizontal: item.horizontal, at: item.at, points: paths[path]! };
    };
    const first = trackRuns(paths[a]!, a).find(entry => entry.index === runA)!, second = trackRuns(paths[b]!, b).find(entry => entry.index === runB)!;
    found.push({ key: `${links[a]!.id}#${runA}|${links[b]!.id}#${runB}`, one: runOf(a, runA), two: runOf(b, runB),
      order: [first.horizontal ? 0 : 1, Math.min(first.at, second.at), Math.max(first.low, second.low)], nodes: [...one, ...two].sort().join('|') });
  }
  // Last key: the end nodes of the pair, by id.
  return found.sort((x, y) => x.order[0]! - y.order[0]! || x.order[1]! - y.order[1]! || x.order[2]! - y.order[2]! || (x.nodes < y.nodes ? -1 : x.nodes > y.nodes ? 1 : 0))
    .map(({ key, one, two }) => ({ key, one, two }));
}

/**
 * The moves that seat `port` at `target` along its face, or undefined when there is none. The neighbours on the side it moves to that would
 * stand nearer than their neighbour pitch (`neighbourPitch`: the face pitch, or a stored pair pitch above it; the spacing the node geometry
 * check reads, R1) move on by just that pitch, in face order, so the face order holds; each of them must be free too. The last port that
 * moves stays inside the face's end insets (`portEndInsets`). The ports behind the move only gain room.
 */
export function seatMoves(model: LayoutModel, nodeId: string, port: LayoutPort, target: number, free: (port: LayoutPort) => boolean): { port: LayoutPort; to: number }[] | undefined {
  const node = model.nodes[nodeId]!, side = port.side!, along = side === 'top' || side === 'bottom', box = node.bounds!;
  const low = along ? box.x : box.y, high = low + (along ? box.width : box.height), inset = portEndInsets(node, side);
  const at = (item: LayoutPort): number => (along ? item.anchor!.x : item.anchor!.y);
  const face = node.ports.filter(item => item.side === side).sort((a, b) => a.engineOrder! - b.engineOrder!);
  if (face.some(item => item.anchor === undefined)) return undefined;
  const step = Math.sign(target - at(port));
  const moves = [{ port, to: target }];
  for (let index = face.indexOf(port) + step; index >= 0 && index < face.length; index += step) {
    const prior = moves[moves.length - 1]!, next = face[index]!;
    const pitch = step > 0 ? neighbourPitch(node, side, prior.port.ref, next.ref) : neighbourPitch(node, side, next.ref, prior.port.ref);
    const to = step > 0 ? Math.max(at(next), prior.to + pitch) : Math.min(at(next), prior.to - pitch);
    if (Math.abs(to - at(next)) <= PLACEMENT_EPS) break;
    if (!free(next)) return undefined;
    moves.push({ port: next, to });
  }
  const last = moves[moves.length - 1]!.to;
  if (last < low + inset.low - PLACEMENT_EPS || last > high - inset.high + PLACEMENT_EPS) return undefined;
  return moves;
}
