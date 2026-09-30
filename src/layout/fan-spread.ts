import type { Side } from '../model/geometry.js';
import type { Diagnostic, LayoutLink, LayoutModel, LayoutPort, PathSegment } from '../model/layout.js';
import { EPS, intersection, samePoint, segmentDistance } from '../score/geometry.js';
import { linkStrokeWidth } from '../theme/geometry.js';
import { chordKind, isRoutedChord, routedChordCandidate, standaloneChord } from './frame-paths.js';
import { STRAIGHT_PATH_CLEARANCE } from './row-paths.js';
import { portId } from './skeleton-graph.js';

/**
 * The widest port pitch a fan may be given (ticket 89): five times the 12 px base pitch. A face that would need more is
 * declined, because a body that wide would break the width a column or a frame reserves for it.
 */
export const FAN_PITCH_CAP = 60;

/** Extra clearance a fan is measured for, so that the drift of 7f (columns move in x after the freeze) does not close a pair under 10 px.
 * Measured on the private sheet: 0 gave 3 G6 pairs, 3 gave 1, 4 gave none, 5 none (wider), 8 fell back on a declined face and 2 new G6 pairs. */
export const FAN_SLACK = 4;

/** The faces whose ports need a wider pitch, and the faces that would need more than the cap. */
export interface FanMeasure {
  floors: Map<string, Partial<Record<Side, number>>>;
  declined: { node: string; side: Side; links: string[] }[];
}

/** Whether two chords cross strictly: crossing is allowed, closeness is not (G6). */
function strictCrossing(a: PathSegment, b: PathSegment): boolean {
  const point = intersection(a, b);
  return point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
}

/**
 * Placement's answer to a fan (ticket 89). In a published placement, walk the faces (top and bottom) that carry two or more
 * ports of frame-chord candidates, and for each pair of neighbouring ports ask how far the second must move along the face
 * for the two chords to keep the chord clearance (10 px and both strokes) without crossing. The face's pitch floor is the
 * gap that answers. `layout` runs the placement again with those floors, so that the ports stand at the pitch, the body has
 * grown around them, and nothing is left for routing to discover. Ports keep the order the placement gave them, which is
 * the order of the far ends on every fan the crossing reduction has already sorted.
 */
export function measureFans(model: LayoutModel): FanMeasure {
  const floors: FanMeasure['floors'] = new Map(), declined: FanMeasure['declined'] = [];
  // A link whose chord no other link can free (a tier transit, a title strip, a corridor, a body) is no reason to widen a face.
  const candidates = model.links.filter(link => link.attachments && routedChordCandidate(model, link) && standaloneChord(model, link) !== undefined);
  const byPort = new Map<string, LayoutLink[]>();
  for (const link of candidates) for (const end of [link.attachments!.from, link.attachments!.to]) {
    byPort.set(portId(end), [...(byPort.get(portId(end)) ?? []), link]);
  }
  const clearance = STRAIGHT_PATH_CLEARANCE.path + FAN_SLACK;
  const held = (a: PathSegment, b: PathSegment, la: LayoutLink, lb: LayoutLink): boolean =>
    strictCrossing(a, b) || segmentDistance(a, b) - (linkStrokeWidth(la) + linkStrokeWidth(lb)) / 2 >= clearance - EPS;
  for (const node of Object.values(model.nodes)) {
    for (const side of ['top', 'bottom'] as const) {
      const ports = node.ports.filter((port): port is LayoutPort & { anchor: NonNullable<LayoutPort['anchor']> } =>
        port.side === side && port.anchor !== undefined && (byPort.get(portId(port.ref))?.length ?? 0) > 0)
        .sort((a, b) => a.anchor.x - b.anchor.x);
      if (ports.length < 2) continue;
      let floor = 0;
      const tooClose: string[] = [];
      for (let i = 1; i < ports.length; i++) {
        const p = ports[i - 1]!, q = ports[i]!, gap = q.anchor.x - p.anchor.x;
        // The two ports may stand k pitch steps apart (a port between them that carries no chord, or a spread centring made); a slide of t px
        // over k steps is t / k on each, so the floor is the pitch the face has plus that share, never the gap.
        const pitch = node.sidePitch?.[side] ?? 12, steps = Math.max(1, Math.round(gap / pitch));
        for (const la of byPort.get(portId(p.ref))!) for (const lb of byPort.get(portId(q.ref))!) {
          if (la.id === lb.id) continue;
          const a = standaloneChord(model, la), b = standaloneChord(model, lb);
          if (!a || !b || held(a, b, la, lb)) continue;
          // The chord of `lb` leaves this face at its own end; that end slides along the face.
          const start = lb.attachments!.from.node === node.id && portId(lb.attachments!.from) === portId(q.ref) ? 'from' : 'to';
          let need: number | undefined;
          for (let t = 1; t <= FAN_PITCH_CAP * steps; t++) {
            const moved: PathSegment = { ...b, [start]: { x: b[start].x + t, y: b[start].y } };
            if (held(a, moved, la, lb)) { need = pitch + Math.ceil(t / steps); break; }
          }
          tooClose.push(la.id, lb.id);
          if (need === undefined || need > FAN_PITCH_CAP) floor = Infinity; else floor = Math.max(floor, need);
        }
      }
      if (floor === 0) continue;
      if (floor === Infinity) { declined.push({ node: node.id, side, links: [...new Set(tooClose)] }); continue; }
      floors.set(node.id, { ...floors.get(node.id), [side]: Math.max(floor, floors.get(node.id)?.[side] ?? 0) });
    }
  }
  return { floors, declined };
}

/** One diagnostic per declined face: the fan keeps the base pitch and its links may keep the orthogonal route. */
export function declinedFanDiagnostics(declined: FanMeasure['declined']): Diagnostic[] {
  return declined.map(item => ({ stage: 'placement', severity: 'warning', code: 'FAN_SPREAD_DECLINED',
    message: `The ${item.side} ports of ${item.node} would need a pitch beyond ${FAN_PITCH_CAP} px to hold the chord clearance; the fan keeps the base pitch and its links may keep the orthogonal route.`,
    owners: item.links.map(id => ({ kind: 'link' as const, id })) }));
}

/**
 * Whether a fan re-run may replace the placement it was measured on. It must not lose a frame chord: those hold the pitch floors of ticket 89, and a spread that
 * is dropped for a cross-frame chord it lost leaves a fan of frame chords narrower than the clearance needs (G6 `parallel-clearance`, measured on the private
 * sheet after ticket 102 counted both kinds). A cross-frame chord the spread loses is kept orthogonal; it is not worth a gate.
 */
export function fanRoundHolds(before: LayoutModel, after: LayoutModel): boolean {
  const frameChords = (model: LayoutModel): number => model.links.filter(link => isRoutedChord(model, link) && chordKind(model, link) === 'frame').length;
  return frameChords(after) >= frameChords(before);
}
