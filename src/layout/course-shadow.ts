import type { Side } from '../model/geometry.js';
import type { LayoutModel } from '../model/layout.js';
import { candidatesFor, naturalCourse, planContext, polylineCrossings, type CandidateKind } from './course-plan.js';
import type { Trigger } from './read/courses.js';

/**
 * The shadow course plan (architecture ticket 15, phase 3). `shadowCourses` reads a model as stage 5 leaves it and reports, for every routed link that
 * can have a course, the turns its natural course would have and the course it would pick. It applies nothing: no port side, no lane, no model field.
 * The report goes to the attempt counters when the ledger or a trace is on, and nowhere else (the pipeline asks `ledgerOn` first, so production pays nothing).
 */

/** The verdict of one candidate: the polyline's own turns, and its crossings with the natural courses of the other links. */
export interface ShadowCandidate { kind: CandidateKind; turns: number; crossings: number; from: Side; to: Side }

export interface ShadowLink {
  link: string;
  triggers: Trigger[];
  /** The natural course: the estimated turns, and what the estimate assumed (a chord, an expected alignment, a lane that cannot stand under its source). */
  natural: { turns: number; crossings: number; chord: boolean; aligned: boolean; lane: boolean };
  candidates: ShadowCandidate[];
  /** What the plan would pick. It equals `natural` unless a candidate has fewer turns, or the same turns and fewer crossings. */
  chosen: ShadowCandidate;
}

export interface ShadowPlan { links: ShadowLink[] }

export function shadowCourses(model: LayoutModel): ShadowPlan {
  const context = planContext(model);
  const naturals = new Map([...context.facts].map(([id, facts]) => [id, naturalCourse(context, facts)] as const));
  const crossingsOf = (id: string, points: readonly { x: number; y: number }[]): number => {
    let count = 0;
    for (const [other, course] of naturals) if (other !== id) count += polylineCrossings(points, course.points);
    return count;
  };
  const links: ShadowLink[] = [];
  for (const [id, facts] of context.facts) {
    const natural = naturals.get(id)!;
    const candidates = candidatesFor(context, facts, natural).map((candidate): ShadowCandidate =>
      ({ kind: candidate.kind, turns: candidate.turns, crossings: crossingsOf(id, candidate.points), from: candidate.from, to: candidate.to }));
    const base = candidates[0]!;
    // The judge in miniature: fewer turns, then fewer crossings; the natural course stands unless a candidate is strictly better.
    const chosen = candidates.slice(1).reduce((best, item) => item.turns < best.turns || (item.turns === best.turns && item.crossings < best.crossings) ? item : best, base);
    links.push({ link: id, triggers: facts.triggers, natural: { turns: natural.turns, crossings: base.crossings, chord: natural.chord, aligned: natural.aligned, lane: natural.lane }, candidates, chosen });
  }
  return { links };
}
