import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { comparable, firstDifference, reversed } from '../../scripts/r3-lib.mjs';
import { gateFailures } from './open-min-separation.js';
import { pathBends } from '../../src/layout/objective.js';
import { compareId } from '../../src/layout/skeleton-graph.js';

/**
 * Field-2026-11 ticket 05: child groups inside the members of a canton. Stage 7a reserved a lane the canton holds (and that is foreign to a
 * member) before a lane the member holds, so the member grew over it and `validateLanes` threw `Lane ... crosses occupied group ...`. The
 * held/foreign order of the transit lanes is now read per frame, on its strongly connected components, and a link moves only as early as a
 * frame needs (pull forward; `pullForwardOrder`, unit test `test/layout/reservation-order.test.ts`). Two cycles that share a link still fail
 * (known open, follow-up ticket 12). A link that stage 8 rejects because it runs through a foreign rank cell of its own frame is routed once
 * more, alone, after every batch, with the cells as walls (the cell retry, `retryCellRejections`; last block).
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const drawnAll = (model: LayoutModel): void => {
  expect(model.removedLinks).toBeUndefined();
  for (const link of model.links) expect(link.path, link.id).toBeDefined();
};

describe('a lane a frame holds is reserved before a lane foreign to that frame, read per frame (field-2026-11 ticket 05)', () => {
  const NAME = 'a-member-holds-its-lane-before-a-canton-lane';

  it('lays the canton out with every link drawn, no gate failing, and the foreign lane outside the member it crosses', async () => {
    const model = await run(fixture(NAME));
    drawnAll(model);
    expect(gateFailures(score(model).snapshot)).toEqual([]);
    // link-5 (isp-2 -> r3a) ends in the canton and is foreign to m-2: in every sub-tier it crosses, its lane stands outside m-2 as m-2 grew.
    const member = model.frames!.find(frame => frame.id === 'm-2')!.box;
    const foreign = model.lanes.filter(lane => lane.owner.kind === 'link' && lane.owner.id === 'link-5' && lane.bounds.y < member.y + member.height && lane.bounds.y + lane.bounds.height > member.y);
    expect(foreign.length).toBeGreaterThan(0);
    for (const lane of foreign) expect(lane.bounds.x + lane.bounds.width <= member.x || lane.bounds.x >= member.x + member.width, lane.id).toBe(true);
  }, 60000);

  it('keeps the layout when the links are written in reverse (R3)', async () => {
    // The order reads the frames and the old tie rule only, never the document order of the links. With the nodes reversed the tier
    // order of the groups changes upstream of the lanes, also on main and on this sheet without the canton or without the child
    // (2026-11-22), so that reversal does not judge this rule.
    const text = fixture(NAME), api = { serializeLayoutModel };
    const written = comparable(api, await run(text));
    expect(firstDifference(written, comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);

  it('publishes the reduced field sheet with every link drawn; one G9 finding stays open (known residual, follow-up ticket of ticket 05)', async () => {
    // A lane the canton holds grows `site` to the left, toward `far`, and `far` cannot move: it is the source of the lane of `fw-1 -> isp-1`
    // (`LANE_FRAME_GAP_HELD`). The slot choice reads that shortfall only for a lane with a held gap. The coordinator opens the follow-up;
    // when it is fixed, this list is empty and the test fails: delete the entry.
    const model = await run([
      'portograph: 2', 'groups:', '  site: { label: Site }', '  m-1: { tier: 1, canton: site, label: M1 }', '  m-2: { tier: 2, canton: site, label: M2 }',
      '  m-3: { tier: 3, canton: site, label: M3 }', '  pod-1: { parent: m-2, label: Pod 1 }', '  far: { tier: 2, label: Far }', '  top: { tier: 0, label: Top }',
      'nodes:', '  isp-1: { group: top, class: cloud }', '  leaf-1a: { group: pod-1, class: switch }', '  leaf-1b: { group: pod-1, class: switch }',
      '  h-1: { group: m-2, class: server }', '  r1a: { group: m-1, class: router }', '  r1b: { group: m-1, class: router }', '  r3a: { group: m-3, class: router }',
      '  fw-1: { group: far, class: firewall }',
      'links:', '  - [leaf-1a, r1a]', '  - [leaf-1b, r1b]', '  - [isp-1, leaf-1b]', '  - [isp-1, r1a]', '  - [isp-1, r3a]', '  - [h-1, r1b]', '  - [fw-1, isp-1]', '',
    ].join('\n'));
    drawnAll(model);
    expect(gateFailures(score(model).snapshot)).toEqual(['G9:min-separation:group:far,frame:site']);
    expect(model.diagnostics.some(item => item.code === 'LANE_FRAME_GAP_HELD')).toBe(true);
  }, 60000);
});

describe('the frame order is read on its strongly connected components, and a link moves only as early as a frame needs (field-2026-11 ticket 05, review 1)', () => {
  const sheet = (name: string): string => readFileSync(new URL(`../fixtures/nested-frames/${name}.yaml`, import.meta.url), 'utf8');

  it('a cycle between two child frames: stage 7a passes and every link is drawn; the G2, G4 and G6 findings stay open', async () => {
    const text = sheet('two-child-frames-hold-lanes-foreign-to-each-other');
    const model = await run(text);
    drawnAll(model);
    // Known open (review 1 of ticket 05): the routes the cycle leaves pass a child frame and run along each other. A fix empties this list.
    expect(gateFailures(score(model).snapshot).sort()).toEqual([
      'G2:through-group', 'G2:through-group', 'G4:collinear-overlap', 'G4:collinear-overlap',
      'G6:parallel-clearance', 'G6:parallel-clearance', 'G6:parallel-clearance', 'G6:parallel-clearance', 'G6:parallel-clearance',
    ]);
    const api = { serializeLayoutModel };
    expect(firstDifference(comparable(api, model), comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);

  it('one frame edge moves one link: the lanes, the turns, the removed links and the gate findings are those of main (d8d846ae)', async () => {
    const text = sheet('one-frame-edge-moves-one-link');
    const model = await run(text);
    const lanes = model.lanes.map(lane => [lane.id, Math.round(lane.x * 100) / 100] as const).sort((a, b) => compareId(a[0], b[0]));
    expect(lanes).toEqual(([['lane:"link-13":1', 83.76], ['lane:"link-16":1', 460.19], ['lane:"link-17":1', 674.19], ['lane:"link-6":2', 285.1], ['lane:"link-6":3', 285.1],
      ['lane:"link-9":1', 117.76], ['lane:"link-9":2', 15], ['lane:"link-9":3', 15], ['lane:"link-9":4', 15]] as const).slice().sort((a, b) => compareId(a[0], b[0])));
    expect(Object.fromEntries(model.links.map(link => [link.id, pathBends(link) ?? null]))).toEqual({
      'link-1': 2, 'link-2': 2, 'link-3': 2, 'link-4': 2, 'link-5': 0, 'link-6': null, 'link-7': null, 'link-8': 0, 'link-9': null,
      'link-10': 0, 'link-11': 6, 'link-12': 0, 'link-13': null, 'link-14': 0, 'link-15': 0, 'link-16': 0, 'link-17': 0,
    });
    expect(model.removedLinks).toEqual(['link-6', 'link-7', 'link-9', 'link-13']);
    expect(gateFailures(score(model).snapshot).sort()).toEqual(['G4:collinear-overlap', 'G5:port-order', 'G6:parallel-clearance']);
    const api = { serializeLayoutModel };
    expect(firstDifference(comparable(api, model), comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);
});

describe('known open: two cycles that share a link (field-2026-11 ticket 05, re-check of review 1; follow-up ticket 12)', () => {
  it('still stops at stage 7a: a later held lane of the component grows west across the earlier lane of link-8', async () => {
    // Inside one component the base order reserves link-8, then link-10 and link-11, which west holds; either grows west across link-8.
    // Main fails on this sheet too (at link-1). Ticket 12 reserves room for the other held lanes of a cyclic component; when it lands, this
    // test fails: turn it into a test that every link is drawn.
    const text = readFileSync(new URL('../fixtures/nested-frames/two-cycles-share-a-link.yaml', import.meta.url), 'utf8');
    await expect(run(text)).rejects.toThrow('Lane lane:"link-8":2 crosses occupied group west#1');
    await expect(run(reversed(text, 'links'))).rejects.toThrow('Lane lane:"link-8":2 crosses occupied group west#1');
  }, 60000);
});

describe('a link a foreign rank cell of its own frame rejects is routed once more, alone, after every batch (field-2026-11 ticket 05, cell retry)', () => {
  const sheet = (name: string): string => readFileSync(new URL(`../fixtures/nested-frames/${name}.yaml`, import.meta.url), 'utf8');
  const api = { serializeLayoutModel };
  const restored = (model: LayoutModel): LayoutModel => restoreFinalLayout(serializeLayoutModel(model));
  /** Every gate finding with its elements, sorted; a fix or a new finding changes the list. */
  const findings = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates)
    .flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}:${item.elements.join(',')}`)).sort();
  const turns = (model: LayoutModel): Record<string, number | null> => Object.fromEntries(model.links.map(link => [link.id, link.path ? pathBends(link) ?? null : null]));

  it('draws fw-1 -> leaf-1a around the cell pod-1#1: every link drawn, no gate failing, and the restored model is the same', async () => {
    const model = await run(fixture('a-link-keeps-out-of-a-foreign-cell-of-its-own-frame'));
    drawnAll(model);
    expect(gateFailures(score(model).snapshot)).toEqual([]);
    expect(pathBends(model.links.find(link => link.id === 'link-6')!)).toBe(4);
    const back = restored(model);
    expect(back.removedLinks).toBeUndefined();
    expect(firstDifference(comparable(api, model), comparable(api, back))).toBeUndefined();
  }, 60000);

  it('two retried links into one node: one at a time, the first reserves the stem of the second; the same in both link orders', async () => {
    // Main removes link-6 (fw-1 -> leaf-1a) and link-7 (fw-2 -> leaf-1a). Without the stem reservation the first retried route ran over the
    // stem tip of the second, and the second answer did not meet its port.
    const text = fixture('two-links-retry-into-one-node-one-at-a-time');
    const model = await run(text);
    drawnAll(model);
    expect(gateFailures(score(model).snapshot)).toEqual([]);
    expect([pathBends(model.links.find(link => link.id === 'link-6')!), pathBends(model.links.find(link => link.id === 'link-7')!)]).toEqual([4, 4]);
    expect(restored(model).removedLinks).toBeUndefined();
    expect(firstDifference(comparable(api, model), comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);

  it('route-441: link-4 and link-5 return; their new findings are pinned; link-8 (a bundle envelope, no cell) stays removed and restore agrees', async () => {
    // Main removes link-4, link-5 and link-8 and has the two G6 findings of link-10 and link-11. Known regressions of the retry: link-5 runs
    // too near link-12 and too near itself, and the crossings go from 0 to 3. Known open: link-8 (no retry; its rejection names no cell).
    const text = sheet('two-links-retry-around-a-foreign-cell');
    const model = await run(text);
    expect(model.removedLinks).toEqual(['link-8']);
    expect([pathBends(model.links.find(link => link.id === 'link-4')!), pathBends(model.links.find(link => link.id === 'link-5')!)]).toEqual([4, 6]);
    expect(findings(model)).toEqual([
      'G6:parallel-clearance:link-10,link-11', 'G6:parallel-clearance:link-10,link-11', 'G6:parallel-clearance:link-5,link-12', 'G6:parallel-clearance:link-5,link-5',
    ]);
    expect(score(model).snapshot.metrics.crossings.count).toBe(3);
    expect(restored(model).removedLinks).toEqual(['link-8']);
    expect(firstDifference(comparable(api, model), comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);

  it('two retried links that stay removed: each stores the retry\'s answer, restore judges it again and agrees, in both link orders', async () => {
    // Main removes link-7 and link-8 for the cell pod-1#1 (and link-4 for a bundle envelope). Known open: each retry skips a stem checkpoint.
    const text = sheet('two-retried-links-stay-removed');
    const model = await run(text);
    expect(model.removedLinks).toEqual(['link-4', 'link-7', 'link-8']);
    expect(model.diagnostics.filter(item => item.code === 'ROUTE_CHECKPOINT_SKIPPED').map(item => item.message.split(' ')[0])).toEqual(['link-7', 'link-8']);
    for (const id of ['link-7', 'link-8']) expect(model.links.find(link => link.id === id)!.rejectedRoute?.length, id).toBeGreaterThan(0);
    const back = restored(model);
    expect(back.removedLinks).toEqual(['link-4', 'link-7', 'link-8']);
    expect(firstDifference(comparable(api, model), comparable(api, back))).toBeUndefined();
    expect(firstDifference(comparable(api, model), comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);

  it('min-route (review 1, P1): the batches stay as they are, so the result is main\'s (fa3b48d3)', async () => {
    const model = await run(sheet('a-cell-splits-no-batch'));
    expect(model.removedLinks).toEqual(['link-9']);
    expect(turns(model)).toEqual({
      'link-1': 0, 'link-2': 2, 'link-3': 2, 'link-4': 2, 'link-5': 4, 'link-6': 4, 'link-7': 0, 'link-8': 4, 'link-9': null, 'link-10': 0, 'link-11': 0,
    });
    expect(gateFailures(score(model).snapshot).sort()).toEqual(['G4:collinear-overlap', 'G6:parallel-clearance', 'G6:parallel-clearance']);
    expect(score(model).snapshot.metrics.crossings.count).toBe(4);
  }, 60000);

  it('the course preflight routes as stage 8 (review re-check of 05b, P2): it names no link that the cell retry draws', async () => {
    // Before, the preflight ran the batches without the retry, named link-2 lost (its first answer enters pod-1#1) and refused the trial at
    // 7e (stage `bundles`). With the shared loop the trial reaches 7f (stage `bands`), and the guard after the route refuses it for link-6
    // and link-12, which it does lose.
    const trials: { reason?: string; stage?: string }[] = [];
    const model = await layout(parse(sheet('a-course-preflight-routes-as-stage-8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
      testSideTrace: event => {
        const item = event as { ev?: string; verdict?: { reason?: string }; trial?: { stage?: string } };
        if (item.ev === 'course-trial') trials.push({ ...(item.verdict?.reason ? { reason: item.verdict.reason } : {}), ...(item.trial?.stage ? { stage: item.trial.stage } : {}) });
      } });
    expect(trials.length).toBeGreaterThan(0);
    for (const trial of trials) {
      expect(trial.stage).toBe('bands');
      expect(trial.reason).toBe('the trial\'s route removes link-6, link-12, which the baseline\'s route keeps');
    }
    expect(model.removedLinks).toEqual(['link-13', 'link-14']);
  }, 60000);

  it('known regression: the returned link fw-1 -> leaf-1a runs too near leaf-1b -> leaf-1c (G6) and crosses one link', async () => {
    // Main removes link-7 and has the G9 finding only. When a fix keeps link-7 apart from link-8, this list loses the G6 entry: update it.
    const text = sheet('a-returned-link-runs-beside-its-neighbour');
    const model = await run(text);
    drawnAll(model);
    expect(pathBends(model.links.find(link => link.id === 'link-7')!)).toBe(8);
    expect(findings(model)).toEqual(['G6:parallel-clearance:link-7,link-8', 'G9:min-separation:frame:site,group:far']);
    expect(score(model).snapshot.metrics.crossings.count).toBe(1);
    expect(firstDifference(comparable(api, model), comparable(api, await run(reversed(text, 'links'))))).toBeUndefined();
  }, 60000);
});
