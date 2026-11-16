import type { Side } from '../model/geometry.js';
import type { Diagnostic, LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { EPS, segmentDistance } from '../geometry/planar.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { chordClearances, chordKind, isRoutedChord, routedChordCandidate, standaloneChord } from './frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { strictCrossing } from './read/crossings.js';
import { portId } from './skeleton-graph.js';
import { PLACEMENT_EPS } from './tolerance.js';
import { endPitch, neighbourPitch } from './pair-pitch.js';
import { holds, profiles, reading, straightOf, tapVerdict } from './objective.js';

/**
 * The widest port pitch a fan may be given (ticket 89): five times the 12 px base pitch. A face that would need more is
 * declined, because a body that wide would break the width a column or a frame reserves for it.
 */
export const FAN_PITCH_CAP = 60;

/** Extra clearance a fan is measured for, so that the drift of 7f (columns move in x after the freeze) does not close a pair under 10 px.
 * Measured on the private sheet: 0 gave 3 G6 pairs, 3 gave 1, 4 gave none, 5 none (wider), 8 fell back on a declined face and 2 new G6 pairs. */
export const FAN_SLACK = 4;

/** One neighbour-pair floor of a fan (dense-16x9 ticket 04): the two ports (`portId`, sorted) of a face keep `min` when they stand side by side. */
export interface FanPairFloor { node: string; side: 'top' | 'bottom'; ports: [string, string]; min: number }

/** The neighbour-pair floors the fans need, and the faces with a pair that would need more than the cap. */
export interface FanMeasure {
  floors: FanPairFloor[];
  declined: { node: string; side: Side; links: string[] }[];
}

/**
 * Placement's answer to a fan (ticket 89). In a published placement, walk the faces (top and bottom) that carry two or more
 * ports of frame-chord candidates, and for each pair of neighbouring chord ports ask how far the second must move along the face
 * for the two chords to keep the chord clearance (10 px and both strokes) without crossing. `layout` runs the placement again with
 * those floors, so that the ports stand at the pitch, the body has grown around them, and nothing is left for routing to discover.
 * Ports keep the order the placement gave them, which is the order of the far ends on every fan the crossing reduction has already sorted.
 *
 * Dense-16x9 ticket 04 (slice 1): the floor is stored as neighbour-pair pitches (`LayoutNode.pairPitch`, rule `fan`), and the face holds their
 * sum. The slide a chord pair needs is shared by the gaps between its two ports; the largest such pitch of the face is written on every
 * pair of its ports, so that a later order of the face keeps it too (see below). A chord pair that would need more than `FAN_PITCH_CAP` is declined alone (the cap is per pair).
 */
export function measureFans(model: LayoutModel): FanMeasure {
  const floors = new Map<string, FanPairFloor>(), declined: FanMeasure['declined'] = [];
  // A link whose chord no other link can free (a tier transit, a title strip, a corridor, a body) is no reason to widen a face.
  const candidates = model.links.filter(link => !link.solidBlock && link.attachments && routedChordCandidate(model, link) && standaloneChord(model, link) !== undefined);
  const byPort = new Map<string, LayoutLink[]>();
  for (const link of candidates) for (const end of [link.attachments!.from, link.attachments!.to]) {
    byPort.set(portId(end), [...(byPort.get(portId(end)) ?? []), link]);
  }
  const clearance = STRAIGHT_PATH_CLEARANCE.path + FAN_SLACK;
  const held = (a: PathSegment, b: PathSegment, la: LayoutLink, lb: LayoutLink): boolean =>
    strictCrossing(a, b) || segmentDistance(a, b) - (linkStrokeWidth(la) + linkStrokeWidth(lb)) / 2 >= clearance - EPS;
  for (const node of Object.values(model.nodes)) {
    for (const side of ['top', 'bottom'] as const) {
      // The face by x: the gaps between two chord ports are the gaps of every port between them.
      const face = node.ports.filter((port): port is LayoutPort & { anchor: NonNullable<LayoutPort['anchor']> } => port.side === side && port.anchor !== undefined)
        .sort((a, b) => a.anchor.x - b.anchor.x);
      const ports = face.filter(port => (byPort.get(portId(port.ref))?.length ?? 0) > 0);
      if (ports.length < 2) continue;
      let most = 0;
      for (let i = 1; i < ports.length; i++) {
        const p = ports[i - 1]!, q = ports[i]!, gap = q.anchor.x - p.anchor.x;
        // The two ports may stand k pitch steps apart (a port between them that carries no chord, or a spread centring made); a slide of t px
        // over k steps is t / k on each, so each gap between them takes its pitch plus that share, never the gap.
        // The steps are counted at the face's largest pitch (`endPitch`: the face pitch, or its largest pair pitch), as the face pitch of
        // ticket 89 counted them; each pair then takes its own pitch plus the share.
        const pitch = node.sidePitch?.[side] ?? 12, steps = Math.max(1, Math.round(gap / endPitch(node, side, pitch)));
        let share = 0, over = false;
        const tooClose: string[] = [];
        for (const la of byPort.get(portId(p.ref))!) for (const lb of byPort.get(portId(q.ref))!) {
          if (la.id === lb.id) continue;
          const a = standaloneChord(model, la), b = standaloneChord(model, lb);
          if (!a || !b || held(a, b, la, lb)) continue;
          // The chord of `lb` leaves this face at its own end; that end slides along the face.
          const start = lb.attachments!.from.node === node.id && portId(lb.attachments!.from) === portId(q.ref) ? 'from' : 'to';
          let need: number | undefined;
          for (let t = 1; t <= FAN_PITCH_CAP * steps; t++) {
            const moved: PathSegment = { ...b, [start]: { x: b[start].x + t, y: b[start].y } };
            if (held(a, moved, la, lb)) { need = Math.ceil(t / steps); break; }
          }
          if (need === undefined) over = true; else share = Math.max(share, need);
          tooClose.push(la.id, lb.id);
        }
        if (!over && share === 0) continue;
        const from = face.indexOf(p), to = face.indexOf(q);
        const pairs = face.slice(from, to).map((u, k) => {
          const v = face[from + k + 1]!;
          return { ports: [portId(u.ref), portId(v.ref)].sort() as [string, string], min: neighbourPitch(node, side, u.ref, v.ref, pitch) + share };
        });
        // The cap is per pair: a pair over it keeps its pitch, and its links may keep the orthogonal route.
        if (over || pairs.some(pair => pair.min > FAN_PITCH_CAP)) {
          declined.push({ node: node.id, side, links: [...new Set(tooClose)] });
          continue;
        }
        most = Math.max(most, ...pairs.map(pair => pair.min));
      }
      // Slice 1 writes the largest need of the face on every pair of its ports, as main's face pitch did. Slice 2 of ticket 04 changes this
      // one place to the exact need of each pair, together with the isolated fallback. Exact floors leave no margin: the drift of 7f crowds one
      // direct member, the sequential family decision and the leg cascade then refuse the rest (traced on
      // `a-fan-spreads-its-ports-so-its-chords-hold-clearance`, 10 of 10 straight on main, 4 of 10 with exact floors; five corpus sheets worse).
      // Every two ports of the face, not only the neighbours of this order: a later rule may stand any two of them side by side (a course
      // that takes a port to a lateral face, a bundle that reorders its block), and each such pair keeps the face's pitch, as main's did.
      if (most === 0) continue;
      for (let k = 0; k < face.length; k++) for (let l = k + 1; l < face.length; l++) {
        const ports = [portId(face[k]!.ref), portId(face[l]!.ref)].sort() as [string, string];
        floors.set(`${node.id}\u0000${side}\u0000${ports.join('|')}`, { node: node.id, side, ports, min: most });
      }
    }
  }
  // One entry per declined face, its links merged: the faces in walk order, the links in their order of first refusal.
  const faces = new Map<string, FanMeasure['declined'][number]>();
  for (const item of declined) {
    const key = `${item.node}\u0000${item.side}`, old = faces.get(key);
    faces.set(key, old === undefined ? item : { ...old, links: [...new Set([...old.links, ...item.links])] });
  }
  return { floors: [...floors.values()], declined: [...faces.values()] };
}

/** One diagnostic per declined face: the pairs over the cap keep their pitch and their links may keep the orthogonal route. */
export function declinedFanDiagnostics(declined: FanMeasure['declined']): Diagnostic[] {
  return declined.map(item => ({ stage: 'placement', severity: 'warning', code: 'FAN_SPREAD_DECLINED',
    message: `Neighbouring ${item.side} ports of ${item.node} would need a pitch beyond ${FAN_PITCH_CAP} px to hold the chord clearance; those pairs keep their pitch and their links may keep the orthogonal route.`,
    owners: item.links.map(id => ({ kind: 'link' as const, id })) }));
}

/** The held chords of a model by link id, with their kind. */
function heldChords(model: LayoutModel): Map<string, ReturnType<typeof chordKind>> {
  return new Map(model.links.filter(link => isRoutedChord(model, link)).map(link => [link.id, chordKind(model, link)]));
}

/** What a fan re-run did to the held chords: the ids it lost and the ids it gained. */
export function fanRoundChords(before: LayoutModel, after: LayoutModel): { lost: string[]; gained: string[] } {
  const was = heldChords(before), now = heldChords(after);
  return { lost: [...was.keys()].filter(id => !now.has(id)), gained: [...now.keys()].filter(id => !was.has(id)) };
}

/**
 * Whether a fan re-run may replace the placement it was measured on. It is dropped when the number of held chords of both kinds falls (main's rule, tickets 89
 * and 102: a swap that keeps the count is kept, because the re-run may straighten far more links than it swaps). One exception: the kept placement has a chord
 * pair under the parallel clearance that the re-run clears, and the re-run loses no frame chord; a cross-frame chord may then be given up for the gate.
 */
export function fanRoundHolds(before: LayoutModel, after: LayoutModel): boolean {
  const result = fanRoundHoldsRaw(before, after);
  tapVerdict('fanRoundHolds', () => `${result}`);
  return result;
}
function fanRoundHoldsRaw(before: LayoutModel, after: LayoutModel): boolean {
  const was = heldChords(before), now = heldChords(after);
  if (holds(reading({ routed: straightOf(new Set(now.keys())) }), reading({ routed: straightOf(new Set(was.keys())) }), profiles.fanRound)) return true;
  const frames = (chords: typeof was): number => [...chords.values()].filter(kind => kind === 'frame').length;
  if (frames(now) < frames(was)) return false;
  const clearance = STRAIGHT_PATH_CLEARANCE.path - PLACEMENT_EPS, then = chordClearances(after);
  for (const [pair, gap] of chordClearances(before)) {
    if (gap >= clearance) continue;
    const cleared = then.get(pair);
    if (pair.split('|').every(id => now.has(id)) && (cleared === undefined || cleared >= clearance)) return true;
  }
  return false;
}

/** The info note for a dropped fan re-run, so that a dropped round is never silent. */
export function fanRoundDropped(before: LayoutModel, after: LayoutModel): Diagnostic {
  const { lost, gained } = fanRoundChords(before, after);
  return { stage: 'placement', severity: 'info', code: 'FAN_ROUND_DROPPED',
    message: `A fan re-run was dropped: it lost ${lost.length} held chord${lost.length === 1 ? '' : 's'} (${lost.join(', ') || 'none'}) and gained ${gained.length} (${gained.join(', ') || 'none'}). The fans keep the pitch of the last kept placement.` };
}
