import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { chooseReseat } from '../../src/layout/decide.js';
import { fixedPointRefusal, isRoutedChord, orthogonalLeg } from '../../src/layout/frame-paths.js';
import { spanBreaches } from '../../src/layout/lanes.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * The review checks of architecture ticket 22: the chord walls of `spanBreaches`, the span-breach check of `chooseReseat`, and the whole-leg check of a hinted link.
 * Each test fails without the code it names.
 */
const LABELLED = 'goldens/synthetic/a-labelled-chord-across-a-middle-tier-keeps-its-label-on-the-line.yaml';
const MESH_IDS = ['link-3', 'link-4', 'link-5', 'link-6', 'link-7', 'link-8', 'link-9', 'link-10', 'link-11'];
const source = (name: string): string => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const CASE04 = 'ref/hand-solves/04-mesh-across-a-tier.yaml';
const run = (file: string, extra: object): Promise<LayoutModel> => layout(parse(source(file)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...extra });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('span corridors against other walls', () => {
  let chords: LayoutModel;
  beforeAll(async () => { chords = await run(CASE04, { testSpanHints: MESH_IDS }); }, 120000);

  it('reads a chord that is no spanning chord as a wall in a corridor', async () => {
    const share = await run(LABELLED, {});
    const corridor = share.lanes.find(lane => lane.kind === 'span')!;
    const link = share.links.find(item => item.id === 'link-1')!;
    expect(link.spanHint).toBeUndefined();
    expect([...spanBreaches(share)].filter(key => key.endsWith('|link-1'))).toEqual([]);
    const model = clone(share);
    const mine = model.links.find(item => item.id === 'link-1')!;
    mine.technique = 'straight';
    mine.path = { owner: { ...mine.owner }, layer: 'routed', fixed: true, segments: [{ from: { x: corridor.x, y: corridor.bounds.y - 40 }, to: { x: corridor.x, y: corridor.bounds.y + corridor.bounds.height + 40 }, owner: { ...mine.owner }, straight: true }] } as never;
    expect(isRoutedChord(model, mine)).toBe(true);
    expect([...spanBreaches(model)]).toContain(`${corridor.id}|link-1`);
  }, 120000);

  it('refuses a reseat that puts a lane in a span corridor, and takes one that leaves the corridors clear', () => {
    const corridor = chords.lanes.find(lane => lane.kind === 'span')!;
    const intruder = (copy: LayoutModel): void => {
      const lane = clone(chords.lanes.find(item => item.kind === undefined || item.kind === 'perimeter') ?? corridor);
      lane.id = 'intruder'; lane.kind = 'transit'; lane.tier = corridor.tier; lane.x = corridor.x;
      lane.bounds = { ...corridor.bounds };
      copy.lanes.push(lane);
    };
    const before = spanBreaches(chords);
    const probe = clone(chords);
    intruder(probe);
    expect([...spanBreaches(probe)].some(key => !before.has(key))).toBe(true);
    expect(chooseReseat(clone(chords), clone(chords).lanes, [], () => undefined)).toBe(true);
    const draft = clone(chords);
    expect(chooseReseat(draft, draft.lanes, [], intruder)).toBe(false);
  });
});

describe('the whole leg of a hinted link', () => {
  it('refuses a chord that passes a neighbour leg far from its port', async () => {
    const plain = await run(CASE04, { testSpanHints: [], testCourses: [] });
    const other = plain.links.find(item => item.id === 'link-1')!;
    const leg = orthogonalLeg(plain, other, 'from');
    expect(leg).toBeDefined();
    const length = Math.hypot(leg!.to.x - leg!.from.x, leg!.to.y - leg!.from.y);
    expect(length).toBeGreaterThan(40);
    const t = 0.8, p = { x: leg!.from.x + (leg!.to.x - leg!.from.x) * t, y: leg!.from.y + (leg!.to.y - leg!.from.y) * t };
    const link = { ...plain.links.find(item => item.id === 'link-3')!, spanHint: true as const };
    const segment = { from: { x: p.x + 3, y: p.y - 4 }, to: { x: p.x + 60, y: p.y + 4 }, owner: { ...link.owner }, straight: true as const };
    const model = { ...plain, links: plain.links.map(item => item.id === link.id ? link : item) };
    expect(fixedPointRefusal(model, link, segment)).toBe('leg');
  }, 120000);
});
