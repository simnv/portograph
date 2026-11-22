import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout, serializeLayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from './fixture.js';
import type { CreateRouteAttempt } from '../../src/route/worker.js';
import type { Point } from '../../src/model/geometry.js';
import { cellRetryCutMessage, rejectionMessage } from '../../src/route/paths.js';

/**
 * Field-2026-11 ticket 05, re-check of 05b (P1, restore). A link that stays removed after the cell retry of stage 8 stores both answers with
 * their roles: the first (`cellRejectedRoute`, it entered a foreign rank cell) and the retry's (`rejectedRoute`, its rejection). A retry
 * that the route session cut stores the first answer and `cellRetryCut`. Restore judges each role with `tryStitch`, and refuses a removal
 * whose only answer the retry routes again, with no retry answer and no cut mark. A cut mark needs its two warnings (round 2), and no retry
 * after a cut one in the retry's order records a completed retry (round 2). Limit: restore cannot prove that the router returned a stored
 * unusable answer, nor that the session ended; a warning is no proof of a deadline (the same limit as ticket 02; only routing again could
 * prove it).
 */
const nested = (name: string): string => readFileSync(new URL(`../fixtures/nested-frames/${name}.yaml`, import.meta.url), 'utf8');
type Answer = { connector: string; points: Point[] }[];
interface Session { asked: Map<number, string>; answers: Map<string, Answer> }

/** A router factory that records the answer of each request, per route session, by batch id. */
const recording = (): { createRouteAttempt: CreateRouteAttempt; sessions: Session[] } => {
  const sessions: Session[] = [];
  const createRouteAttempt: CreateRouteAttempt = () => {
    const attempt = createAvoidAttempt(), session: Session = { asked: new Map(), answers: new Map() }, wrapped = new Map<unknown, (event: { data?: unknown }) => void>();
    sessions.push(session);
    return { assets: attempt.assets, worker: {
      postMessage: message => { const { id, batch } = message as { id: number; batch: { id: string } }; session.asked.set(id, batch.id); attempt.worker.postMessage(message); },
      addEventListener: (type, listener) => {
        const inner = (event: { data?: unknown }): void => {
          const data = event.data as { id?: number; ok?: boolean; routes?: Answer } | undefined;
          if (type === 'message' && data?.ok === true && data.id !== undefined && session.asked.has(data.id)) session.answers.set(session.asked.get(data.id)!, data.routes!);
          listener(event);
        };
        wrapped.set(listener, inner);
        attempt.worker.addEventListener(type, inner);
      },
      removeEventListener: (type, listener) => attempt.worker.removeEventListener(type, wrapped.get(listener) ?? listener),
      terminate: () => attempt.worker.terminate(),
    } };
  };
  return { createRouteAttempt, sessions };
};
const restoreError = (model: LayoutModel): string => {
  try { restoreFinalLayout(serializeLayoutModel(model)); return 'ACCEPTED'; } catch (error) { return (error as Error).message; }
};
/** The model with `id` removed, storing `answer` (and the other records given) as its removal. */
const forged = (model: LayoutModel, id: string, answer: Answer, extra: Partial<LayoutModel['links'][number]> = {}): LayoutModel => {
  const copy = structuredClone(model), link = copy.links.find(item => item.id === id)!;
  delete link.path; delete link.stubCandidate; delete link.cellRejectedRoute; delete link.cellRetryCut;
  Object.assign(link, { removed: true, rejectedRoute: answer, ...extra });
  copy.removedLinks = copy.links.filter(item => item.removed === true).map(item => item.id);
  return copy;
};
const answerOf = (answers: Answer, id: string): Answer => answers.filter(item => item.connector.startsWith(`${id}#`));
/** The model with the two warnings of a cut retry of `id` added, as stage 8 writes them for a batch answer that entered `cell`. */
const cutWarnings = (model: LayoutModel, id: string, cell: string, which: ('removal' | 'cut')[] = ['removal', 'cut']): LayoutModel => {
  const copy = structuredClone(model), link = copy.links.find(item => item.id === id)!;
  const rejection = { link: id, code: 'ROUTE_GAP_REJECTED' as const, reason: `Routed path on ${id} enters reserved ${cell}`, answer: [] };
  if (which.includes('removal')) copy.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_GAP_REJECTED', message: rejectionMessage(link, rejection), owners: [{ ...link.owner }] });
  if (which.includes('cut')) copy.diagnostics.push({ stage: 'final-geometry', severity: 'warning', code: 'ROUTE_CELL_RETRY_CUT', message: cellRetryCutMessage(id), owners: [{ ...link.owner }] });
  return copy;
};

describe('restore judges the roles of a cell retry (field-2026-11 ticket 05, re-check of 05b)', () => {
  it('refuses a drawn retry forged as a removal that stores only the first answer; the genuine model restores', async () => {
    const { createRouteAttempt, sessions } = recording();
    const model = await layout(parse(nested('a-returned-link-runs-beside-its-neighbour')), { createElkAttempt: createAttempt, createRouteAttempt });
    expect(model.links.find(link => link.id === 'link-7')!.path).toBeDefined();
    expect(restoreError(model)).toBe('ACCEPTED');
    // The session of the published route: its retry answer for link-7 is the drawn route, so restore refuses it as a removal.
    const published = [...sessions].reverse().find(session => {
      const retry = session.answers.get('cell-retry:link-7');
      return retry !== undefined && restoreError(forged(model, 'link-7', answerOf(retry, 'link-7'))) === 'Removed link link-7 has a usable stored route; its removal is not reproduced';
    })!;
    expect(published).toBeDefined();
    const first = answerOf([...published.answers].filter(([batch]) => !batch.startsWith('cell-retry:')).flatMap(([, routes]) => routes), 'link-7');
    expect(restoreError(forged(model, 'link-7', first)))
      .toBe('Removed link link-7 stores only an answer that enters group:pod-1#1; the cell retry routes it again, and no retry answer is stored');
    // The first answer may stand as the first role only beside a retry answer that is a rejection: here the retry drew the link.
    expect(restoreError(forged(model, 'link-7', answerOf(published.answers.get('cell-retry:link-7')!, 'link-7'), { cellRejectedRoute: first })))
      .toBe('Removed link link-7 has a usable stored route; its removal is not reproduced');
    expect(restoreError(forged(model, 'link-7', first, { cellRejectedRoute: first })))
      .toBe('Removed link link-7 stores a retry answer that enters group:pod-1#1; the cell retry routes with the rank cells as walls');
    // Round 2, P2: a claimed cut keeps its two warnings, derived from the saved answer, so the removal is never silent.
    const claimed = forged(model, 'link-7', first, { cellRetryCut: true });
    expect(restoreError(claimed)).toBe('Removed link link-7 marks a cut cell retry without its ROUTE_GAP_REJECTED warning');
    expect(restoreError(cutWarnings(claimed, 'link-7', 'group:pod-1#1', ['removal']))).toBe('Removed link link-7 marks a cut cell retry without its ROUTE_CELL_RETRY_CUT warning');
    // The stated limit: with both warnings the claimed cut restores; a warning is no proof of a deadline.
    expect(restoreError(cutWarnings(claimed, 'link-7', 'group:pod-1#1'))).toBe('ACCEPTED');
  }, 120000);

  it('restores a genuine twice-rejected removal with both roles, and refuses it without the first role or with a wrong one', async () => {
    const model = await layout(parse(nested('two-retried-links-stay-removed')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.removedLinks).toEqual(['link-4', 'link-7', 'link-8']);
    const link7 = model.links.find(link => link.id === 'link-7')!, link4 = model.links.find(link => link.id === 'link-4')!;
    expect(link7.cellRejectedRoute?.length).toBeGreaterThan(0);
    expect(link4.cellRejectedRoute).toBeUndefined();
    expect(restoreError(model)).toBe('ACCEPTED');
    // The first role stores the batch answer, which entered the cell: stored alone, the retry would route it again.
    expect(restoreError(forged(model, 'link-7', link7.cellRejectedRoute!)))
      .toBe('Removed link link-7 stores only an answer that enters group:pod-1#1; the cell retry routes it again, and no retry answer is stored');
    // The first answer in both roles: the retry routes with the cells as walls, so its answer is no cell rejection.
    expect(restoreError(forged(model, 'link-7', link7.cellRejectedRoute!, { cellRejectedRoute: link7.cellRejectedRoute! })))
      .toBe('Removed link link-7 stores a retry answer that enters group:pod-1#1; the cell retry routes with the rank cells as walls');
    // A first role that enters no cell (link-4 entered a bundle envelope) is no first answer of a retry.
    expect(restoreError(forged(model, 'link-4', link4.rejectedRoute!, { cellRejectedRoute: link4.rejectedRoute! })))
      .toBe('Removed link link-4 stores a first answer that enters no rank cell; the cell retry does not route it again');
    // A cut mark needs an answer the retry would route again, and no retry answer beside it.
    expect(restoreError(forged(model, 'link-4', link4.rejectedRoute!, { cellRetryCut: true })))
      .toBe('Removed link link-4 marks a cut cell retry, but its answer enters no rank cell');
    expect(restoreError(forged(model, 'link-7', link7.rejectedRoute!, { cellRejectedRoute: link7.cellRejectedRoute!, cellRetryCut: true })))
      .toBe('Removed link link-7 stores a first answer and a cut cell retry; a cut retry has no answer of its own');
    // Round 2, P2: one route session ends at its cut. link-7 retries before link-8 (plan order), so a cut link-7 beside a completed retry of
    // link-8 is a history the loop cannot write, also with both warnings of the cut.
    expect(restoreError(cutWarnings(forged(model, 'link-7', link7.cellRejectedRoute!, { cellRetryCut: true }), 'link-7', 'group:pod-1#1')))
      .toBe('Removed link link-8 records a completed cell retry after the cut retry of link-7; one route session ends at its cut');
  }, 120000);
});
