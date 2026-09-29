import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { allocateGapRuns, bands, bars, bundles, centre, checkpointsHonoured, flanks, lanes, layout, parse, planRoute, rows } from '../../src/index.js';
import type { RouteBatch, RoutedConnector } from '../../src/index.js';
import { routedStroke, GROUP_LABEL_GEOMETRY } from '../../src/layout/bands.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { horizontal } from '../../src/score/geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// A gap the plan does not fit is left to the router as it was before the plan (`fittingPlans`): the allocation seats its residual runs,
// the holds and the bands apply, and libavoid routes the rest. 7f sizes every gap it can, so the state arises only after 7f (a corridor
// move, a later stage) or where the rounds do not settle. These tests publish the model with 7f's growth switched off, which is exactly
// that state: a gap that needs more room than it got is named `TIER_GAP_PART_UNFIT`, and its parts are the router's.
const growth = vi.hoisted(() => ({ tiers: new Map<number, number>() }));
vi.mock('../../src/layout/gap-room.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/layout/gap-room.js')>();
  // The gap above each tier grows by the amount a test sets, and by nothing else (the plan asks for more).
  return { ...original, growTierGaps: (model: Parameters<typeof original.moveBands>[0]): boolean => {
    if (!growth.tiers.size) return false;
    original.moveBands(model, growth.tiers);
    return true;
  } };
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const place = async (text: string) => bands(bundles(bars(centre(flanks(lanes(rows(await placed(text))))))));

describe('a gap the plan does not fit is left to the router with a diagnostic (ticket 51, ticket 50 todo)', () => {
  it('claims an approach a row stands exactly on the edge of: a residual run seated half a pitch inside the boundary', async () => {
    // Stress ticket 09 (`a-claim-lies-on-a-cover-edge`). The old allocation seats a run's first row one reserved-run clearance past the
    // approach it reserved for the run beside it, so the row lands exactly on that reservation's cover edge, clear of it by the 10 px G6
    // asks for and no more. The claim's cover scan must count that zero-area touch as clear, or the straight approach is declined and
    // libavoid answers with a route that never reaches the port.
    // The gap above tier 4 is 73 px, the height the old allocation measured for its three rows (the plan asks for 87.5).
    growth.tiers = new Map([[4, 34.5]]);
    const model = await place(fixture('a-claim-lies-on-a-cover-edge'));
    const unfit = tierGapPlans(model).filter(({ plan }) => plan.growth > 1e-6).map(({ gap }) => [gap.above, gap.below]);
    expect(unfit).toEqual([[3, 4], [4, 5]]);
    expect(tierGapPlans(model).find(item => item.gap.above === 3)!.plan.growth).toBeCloseTo(14.5, 6);
    const gap = tierGapPlans(model).find(item => item.gap.above === 3)!.gap;
    const runs = allocateGapRuns(model).filter(run => !run.planned);
    const seats = runs.flatMap(run => run.segments.filter(horizontal).map(segment => segment.from.y)).filter(y => y > gap.low && y < gap.high);
    // The first row stands one reserved-run clearance past the low boundary, on the cover's own edge.
    expect(Math.min(...seats)).toBeCloseTo(gap.low + GROUP_LABEL_GEOMETRY.nodeClearance + routedStroke(model), 9);

    const published = await layout(parse(fixture('a-claim-lies-on-a-cover-edge')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(published.removedLinks ?? []).toEqual([]);
    expect(published.diagnostics.filter(item => item.code === 'TIER_GAP_PART_UNFIT').map(item => item.message)).toEqual([
      'the tier gap above tier 4 asks 14.50 px more than it has; its parts are left to the router.',
      'the tier gap above tier 5 asks 22.50 px more than it has; its parts are left to the router.',
    ]);
    // The three rows stand at 11.5, 29 and 46.5 px below the low boundary (779.75, 797.25, 814.75), the first on the cover edge of link-17.
    expect(seats.map(y => y - gap.low).sort((a, b) => a - b)).toEqual([11.5, 29, 46.5]);
    // link-18 stands on the boundary at x 112.1, on the top edge of link-17's cover: its last piece is the stem claimed straight, not a
    // gap the router is asked to fill (and would answer without reaching the port).
    const pieces = planRoute(model).links.find(item => item.link === 'link-18')!.pieces.map(piece => piece.kind);
    expect(pieces.at(-1)).toBe('straight');
  }, 120000);

  it('routes link-22, whose near stem tip stood walled in by link-18, through its checkpoints', async () => {
    // Ticket 25 (`a-band-holds-the-group-that-set-its-edge`). Planned, link-22 is claimed tip to tip and never routed; in a gap left to the
    // router it is routed among the completed covers of its neighbours, and its answer must pass its checkpoints.
    // The gap above tier 3 grows the 23 px the old measure gave it (the plan asks for 198.5 more).
    growth.tiers = new Map([[3, 23]]);
    const requests: RouteBatch[] = [], replies: { routes?: RoutedConnector[] }[] = [];
    const attempt = () => {
      const made = createAvoidAttempt();
      const post = made.worker.postMessage.bind(made.worker), listen = made.worker.addEventListener.bind(made.worker);
      made.worker.postMessage = (message: unknown) => { requests.push((message as { batch: RouteBatch }).batch); post(message); };
      made.worker.addEventListener = (type: string, listener: (event: { data?: unknown; message?: string }) => void) =>
        listen(type, type === 'message' ? event => { replies.push(event.data as { routes?: RoutedConnector[] }); listener(event); } : listener);
      return made;
    };
    await layout(parse(fixture('a-band-holds-the-group-that-set-its-edge')), { createElkAttempt: createAttempt, createRouteAttempt: attempt }).catch(() => undefined);
    const batches = requests.map((batch, index) => ({ batch, routes: replies[index]?.routes ?? [] }));
    const held = batches.find(item => item.batch.connectors.some(connector => connector.id === 'link-22#0'));
    expect(held, 'link-22 is routed in a gap left to the router').toBeDefined();
    const connector = held!.batch.connectors.find(item => item.id === 'link-22#0')!;
    const points = held!.routes.find(item => item.connector === 'link-22#0')!.points;
    expect(checkpointsHonoured(points, connector.checkpoints)).toBe(true);
    expect(points.length).toBeGreaterThan(2);
  }, 120000);
});
