import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { isRoutedChord } from '../../src/layout/frame-paths.js';
import { pathBends } from '../../src/layout/objective.js';
import { holdsMove } from '../../src/layout/move-reservations.js';
import { spanBreaches, validateLanes } from '../../src/layout/lanes.js';
import { spanCorridor } from '../../src/layout/span-lanes.js';
import { evaluate, xCatalogue } from '../../src/layout/constraints/index.js';
import { createColdAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture ticket 22, phase 2: the reservation without the round. The hints are forced by the test option `testSpanHints`; nothing else offers them.
 * Stage 5 gives a hinted end no lane pitch, 7a reserves one span corridor per transited band and no transit lane, the guard `holdsMove` keeps every
 * wall out of a corridor from 7a to 7f, and the chord is held as every cross-frame chord is.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const MESH = 'a-mesh-across-a-middle-tier-draws-straight-chords-beside-its-frame';
const THREE = 'a-chord-over-three-tier-gaps-passes-two-middle-tiers';
const LABEL = 'a-labelled-chord-across-a-middle-tier-keeps-its-label-on-the-line';
const MESH_LINKS = ['link-3', 'link-4', 'link-5', 'link-6', 'link-7', 'link-8', 'link-9', 'link-10', 'link-11'];
const forced = (name: string, hints: string[]): Promise<LayoutModel> =>
  layout(parse(source(name)), { createElkAttempt: createColdAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: hints });
const plain = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createColdAttempt, createRouteAttempt: createAvoidAttempt, testSpanHints: [] });

describe('case 04 with the nine mesh links forced as spanning chords', () => {
  let model: LayoutModel, baseline: LayoutModel;
  beforeAll(async () => { [model, baseline] = await Promise.all([forced(MESH, MESH_LINKS), plain(MESH)]); }, 60000);

  it('publishes nine chords and reserves no transit lane', () => {
    for (const id of MESH_LINKS) expect(isRoutedChord(model, model.links.find(item => item.id === id)!), id).toBe(true);
    expect(model.lanes.filter(lane => (lane.kind ?? 'transit') === 'transit')).toEqual([]);
    expect(model.lanes.filter(lane => lane.kind === 'span').map(lane => lane.id).sort()).toEqual(MESH_LINKS.map(id => `span:${id}:1`).sort());
    expect(model.freeze?.spans).toEqual(MESH_LINKS);
  }, 60000);

  it('names no blocked chord and loses no link', () => {
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_BLOCKED')).toEqual([]);
    expect(model.links.filter(item => item.removed === true)).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED' && MESH_LINKS.some(id => item.owners?.some(owner => owner.kind === 'link' && owner.id === id)))).toEqual([]);
  }, 60000);

  it('passes every gate the baseline passed, and G5 as well', () => {
    const was = score(baseline).snapshot, now = score(model).snapshot;
    for (const [name, gate] of Object.entries(was.gates) as [keyof typeof was.gates, (typeof was.gates)[keyof typeof was.gates]][]) if (gate.passed) expect(now.gates[name].passed, name).toBe(true);
    expect(now.gates.G5!.violations.length).toBeLessThanOrEqual(was.gates.G5!.violations.length);
  }, 60000);

  it('draws fewer bent links, turns and crossings, on a smaller canvas', () => {
    const was = score(baseline).snapshot, now = score(model).snapshot;
    const bent = (m: LayoutModel): number => m.links.filter(item => item.layer === 'routed' && (pathBends(item) ?? 0) > 0).length;
    expect(bent(model)).toBeLessThan(bent(baseline));
    expect(now.metrics.bends.total).toBeLessThan(was.metrics.bends.total);
    expect(now.metrics.crossings.count).toBeLessThan(was.metrics.crossings.count);
    expect(now.Q).toBeGreaterThan(was.Q);
    expect(model.canvas!.width).toBeLessThan(baseline.canvas!.width);
  }, 60000);

  it('restores as a final layout, and refuses a corridor whose x was moved', () => {
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
    const tampered = JSON.parse(JSON.stringify(model)) as LayoutModel;
    const lane = tampered.lanes.find(item => item.kind === 'span')!;
    lane.x += 3; lane.bounds.x += 3;
    expect(() => restoreFinalLayout(JSON.stringify(tampered))).toThrow(/placement changed|contradicts the chord/);
  }, 60000);

  it('derives each corridor from the two end anchors, and keeps every unit and lane out of it', () => {
    expect(() => validateLanes(model)).not.toThrow();
    for (const lane of model.lanes.filter(item => item.kind === 'span')) {
      const link = model.links.find(item => lane.owner.kind === 'link' && item.id === lane.owner.id)!;
      const box = spanCorridor(model, link, lane.tier)!;
      expect(lane.bounds.x).toBeCloseTo(box.x, 6);
      expect(lane.bounds.width).toBeCloseTo(box.width, 6);
    }
    expect([...spanBreaches(model)]).toEqual([]);
  }, 60000);

  it('lists a span-corridor entry in the constraint catalogue, unsupported, and violates no known contract', () => {
    const catalogue = xCatalogue(model);
    const entries = catalogue.filter(item => item.kind === 'span-corridor');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(item => item.strength === 'hard' && item.support === 'unsupported')).toBe(true);
    expect(evaluate(model, catalogue).filter(item => item.violated && item.constraint.contract === 'known' && item.constraint.kind.startsWith('separation'))).toEqual([]);
  }, 60000);

  it('holds each chord in the plan of both tier gaps, with the rows across it or clear', () => {
    expect(model.diagnostics.filter(item => ['TIER_GAP_CHORD_CROWDED', 'TIER_GAP_CHORD_EXPOSED'].includes(item.code) && MESH_LINKS.some(id => item.owners?.some(owner => owner.kind === 'link' && owner.id === id)))).toEqual([]);
  }, 60000);
});

describe('the spanCorridor move reservation', () => {
  let model: LayoutModel;
  beforeAll(async () => { model = await forced(MESH, MESH_LINKS); }, 60000);

  it('refuses a unit that moves into a corridor', () => {
    const core = model.groups.core!;
    const lane = model.lanes.find(item => item.kind === 'span')!;
    expect(holdsMove(model, [{ group: core, bounds: { ...core.bounds! } }], false, ['spanCorridor'])).toBe(true);
    const into = lane.x - core.bounds!.width / 2;
    expect(holdsMove(model, [{ group: core, bounds: { ...core.bounds!, x: into } }], false, ['spanCorridor'])).toBe(false);
  }, 60000);

  it('refuses an end that moves the corridor onto a body', () => {
    const north = model.groups.north!, core = model.groups.core!;
    // Sweep the whole North group towards the right until a corridor reaches the core body.
    const tried = [40, 80, 160, 320, 640].map(dx => holdsMove(model, [{ group: north, bounds: { ...north.bounds!, x: north.bounds!.x + dx } }], false, ['spanCorridor']));
    expect(tried.at(-1)).toBe(false);
    expect(core.bounds).toBeDefined();
  }, 60000);

  it('accepts a model with no span corridor without reading anything', async () => {
    const none = await plain(MESH);
    expect(holdsMove(none, [{ group: none.groups.core!, bounds: { ...none.groups.core!.bounds!, x: 0 } }], false, ['spanCorridor'])).toBe(true);
  }, 60000);
});

describe('a chord over three tier gaps', () => {
  it('reserves one corridor in each transited tier', async () => {
    const model = await forced(THREE, ['link-4']);
    const link = model.links.find(item => item.id === 'link-4')!;
    expect(isRoutedChord(model, link)).toBe(true);
    expect(model.lanes.filter(lane => lane.kind === 'span').map(lane => lane.id)).toEqual(['span:link-4:1', 'span:link-4:2']);
    expect(model.diagnostics.filter(item => item.code === 'SPAN_CHORD_BLOCKED')).toEqual([]);
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 60000);

  it('refuses a hint on a link that is no candidate, in the placement run', async () => {
    await expect(forced(THREE, ['link-1'])).rejects.toThrow(/no spanning-chord candidate/);
  }, 60000);
});

describe('a labelled chord', () => {
  it('is reserved and published as every other chord', async () => {
    const model = await forced(LABEL, ['link-4']);
    expect(isRoutedChord(model, model.links.find(item => item.id === 'link-4')!)).toBe(true);
    expect(score(model).snapshot.gates.G3!.passed).toBe(true);
  }, 60000);
});
