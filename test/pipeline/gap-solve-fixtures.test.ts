import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, restoreFinalLayout } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { reserveLinkLabelRoom, tierGapShortfall, type LinkLabelShortfall } from '../../src/layout/bands.js';
import { gapBandDemand } from '../../src/layout/gap-band.js';
import { tierGapPlans } from '../../src/layout/gap-plan.js';
import { rebuildRegions } from '../../src/layout/regions.js';
import { stemDepthsFault } from '../../src/layout/sides-two.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 57: a tier gap is as high as its reservations need, computed once. The four fixtures of the ticket, each
 * through the real pipeline: a nested stem decided before its gap opens, a canton band seated in stage 6, a label that sets its gap,
 * and a held chord over a gap the solve grows. Then R3 (input order) and R5 (a restore refuses a forged gap or band).
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

const NESTED = 'a-nested-stem-is-decided-before-its-gap-opens';
const CANTON = 'a-canton-band-seats-its-gap-in-stage-six';
const LABELLED = 'a-labelled-drop-sets-its-tier-gap';
const CHORD = 'a-chord-spans-a-gap-the-solve-grows';

/** The height of the gap above each tier band, keyed by that tier: the top of the band less the bottom of the band above it. */
function gapHeights(model: LayoutModel): Map<number, number> {
  const bands = model.tierBands.filter(band => band.bounds).sort((a, b) => a.bounds!.y - b.bounds!.y);
  return new Map(bands.slice(1).map((band, at) => [band.tier, band.bounds!.y - bands[at]!.bounds!.y - bands[at]!.bounds!.height]));
}
/** Every `TIER_GAP_GROWN` of the model: the tier below the gap, the growth and the setter its message names. */
const grown = (model: LayoutModel): { below: number; px: number; setBy: string }[] => model.diagnostics.filter(item => item.code === 'TIER_GAP_GROWN')
  .map(item => /above tier (\d+) grew ([\d.]+) px .*\(set by (.+)\)\.$/.exec(item.message)!)
  .map(match => ({ below: Number(match[1]), px: Number(match[2]), setBy: match[3]! }));
/**
 * The model as 7f publishes it, before routing (stages 4 to 7f by hand). The tier-gap plan is read here: on a routed model it plans no
 * part (the routed links are the router's), so a check there would ask 0 of every gap whatever its height.
 */
const atBands = async (yaml: string): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
/** Every plan of a model at the end of 7f asks nothing, and at least one of them plans a part (so the check is not empty). */
function solved(model: LayoutModel): void {
  const plans = tierGapPlans(model);
  expect(plans.reduce((sum, { plan }) => sum + plan.parts.length, 0)).toBeGreaterThan(0);
  for (const { plan } of plans) expect(plan.growth).toBeLessThanOrEqual(1e-6);
}

describe('the four fixtures of ticket 57', () => {
  it('decides the nested stems of `t` before its gap opens, and the solve grows the gap once', async () => {
    const model = await run(fixture(NESTED));
    // The record nests the three legs of the top side of `t`: each deeper than the plain 15 px stem but the first.
    const t = model.stemDepths!.find(item => item.node === 't' && item.side === 'top')!;
    expect(t.ports.map(item => item.depth).sort((a, b) => a - b)).toEqual([15, 32.5, 50]);
    expect(stemDepthsFault(model)).toBeUndefined();
    // The nested stems and the stems of the access row ask more than the 60 px floor: one growth, set by a part of the plan.
    expect(grown(model)).toEqual([{ below: 1, px: 7.5, setBy: 'link-2#0' }]);
    expect(gapHeights(model).get(1)).toBeCloseTo(67.5, 6);
    // After the solve no plan asks for anything: the checker asks 0, read where 7f leaves the model.
    const placedModel = await atBands(fixture(NESTED));
    expect(grown(placedModel)).toEqual(grown(model));
    solved(placedModel);
    expect(model.diagnostics.filter(item => item.code === 'TIER_GAP_PART_UNFIT')).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 120000);

  it('seats the gap below the canton band in stage 6, and 7f grows it by nothing', async () => {
    const yaml = fixture(CANTON);
    const atRows = rows(await placed(yaml));
    const demand = gapBandDemand(atRows, 1, 2);
    const model = await run(yaml);
    const band = model.labelBands.find(item => item.group === 'west')!;
    expect(band.side).toBe('bottom');
    // 20 + band + 20: the frame margin, the title band and a margin more.
    expect(demand).toBeCloseTo(20 + band.bounds.height + 20, 6);
    expect(demand).toBeGreaterThan(60);
    expect(gapHeights(atRows).get(2)).toBeCloseTo(demand, 6);
    // 7f moves no tier for it: no growth above tier 2, and the published gap is the one stage 6 seated.
    expect(grown(model).filter(item => item.below === 2)).toEqual([]);
    expect(gapHeights(model).get(2)).toBeCloseTo(demand, 6);
  }, 120000);

  it('lets the label of the drop set its tier gap, and the replay reserves nothing more', async () => {
    const model = await run(fixture(LABELLED));
    expect(grown(model)).toHaveLength(1);
    expect(grown(model)[0]!.setBy).toBe('the label of link-1');
    // The message rounds the growth to 0.01 px.
    expect(grown(model)[0]!.px).toBeGreaterThan(60);
    expect(gapHeights(model).get(1)!).toBeCloseTo(60 + grown(model)[0]!.px, 1);
    const label = model.labels.find(item => item.id === 'label:link:link-1')!;
    expect(label.omitted).toBeUndefined();
    expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER' || item.code === 'LINK_LABEL_ROOM_UNRESERVED'
      || item.code === 'LINK_LABEL_ROOM_UNSETTLED')).toEqual([]);
    // The validator replay reserves nothing, across the gap or elsewhere.
    const shortfalls: LinkLabelShortfall[] = [];
    expect(reserveLinkLabelRoom(structuredClone(model), shortfalls)).toBe(false);
    expect(shortfalls.filter(tierGapShortfall)).toEqual([]);
    expect(shortfalls).toEqual([]);
  }, 120000);

  it('keeps the held chords of a gap the solve grows by more than a row, with no body on them', async () => {
    const model = await run(fixture(CHORD));
    const growth = grown(model);
    expect(growth.map(item => item.below)).toEqual([1]);
    // More than one row (the run clearance of 11.5 px).
    expect(growth[0]!.px).toBeGreaterThanOrEqual(11.5);
    const gap = tierGaps(model);
    for (const id of ['link-1', 'link-4']) {
      expect(model.frozenChords).toContain(id);
      const link = model.links.find(item => item.id === id)!;
      expect(link.technique).toBe('straight');
      expect(link.path!.segments).toHaveLength(1);
      // The chord spans the grown gap.
      const segment = link.path!.segments[0]!;
      expect(Math.min(segment.from.y, segment.to.y)).toBeLessThan(gap.low);
      expect(Math.max(segment.from.y, segment.to.y)).toBeGreaterThan(gap.high);
    }
    expect(model.diagnostics.filter(item => item.code === 'STRAIGHT_LINK_BLOCKED')).toEqual([]);
    solved(await atBands(fixture(CHORD)));
    expect(model.removedLinks ?? []).toEqual([]);
  }, 120000);
});

/** The one tier gap of a two-tier sheet, between the bands. */
function tierGaps(model: LayoutModel): { low: number; high: number } {
  const [upper, lower] = model.tierBands.filter(band => band.bounds).sort((a, b) => a.bounds!.y - b.bounds!.y);
  return { low: upper!.bounds!.y + upper!.bounds!.height, high: lower!.bounds!.y };
}

/**
 * The YAML with the lines of one block (`nodes:` or `links:`) in reverse order. With `keepRows`, the nodes are reversed group by group:
 * the groups come in reverse order and the nodes of one group keep theirs, since that order is the row order (meaningful, R3).
 */
function reversed(yaml: string, block: 'nodes' | 'links', keepRows = false): string {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${block}:`);
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('  ')) end++;
  const body = lines.slice(start + 1, end);
  const groups = new Map<string, string[]>();
  for (const line of body) {
    const group = keepRows ? /group: ([\w-]+)/.exec(line)![1]! : String(groups.size);
    groups.set(group, [...(groups.get(group) ?? []), line]);
  }
  return [...lines.slice(0, start + 1), ...[...groups.values()].reverse().flat(), ...lines.slice(end)].join('\n');
}

/**
 * The layout JSON without `runtime`, the input it echoes (`document`) and the legend, for two runs that differ only in the order of the
 * input. The identities that order assigns are renamed by what they join: a link by its ends (`link-N` is its declaration index), an anonymous
 * port by the link end it carries (its ordinal is assigned in link order). Every list of objects and of link names is compared as a set:
 * the drawing is the same when the same items stand at the same places.
 */
function canonical(model: LayoutModel): unknown {
  const ends = (link: LayoutModel['links'][number]): string => `${link.attachments!.from.node}>${link.attachments!.to.node}`;
  const names = new Map(model.links.map(link => [link.id, ends(link)]));
  const ports = new Map<string, string>(model.links.flatMap(link => (['from', 'to'] as const).filter(end => link.attachments![end].anonymous)
    .map(end => [`${link.attachments![end].node}#${String(link.attachments![end].ordinal)}`, `${ends(link)}@${end}`])));
  // The legend lists the classes in the order the nodes first show them (a declaration order the author sets): it is left out.
  const copy: Partial<LayoutModel> = { ...model, labels: model.labels.filter(label => !label.id.startsWith('label:legend:')) };
  delete copy.runtime;
  delete copy.document;
  delete copy.legend;
  const text = JSON.stringify(copy).replace(/link-(\d+)(?!\d)/g, id => names.get(id) ?? id)
    .replace(/([\w-]+)\.#(\d+)/g, (whole, node: string, ordinal: string) => ports.get(`${node}#${ordinal}`) ?? whole);
  const byText = (a: unknown, b: unknown): number => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  const order = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\(([^()]*>[^()]*)\)/g, (_, list: string) => `(${list.split(', ').sort().join(', ')})`);
    if (Array.isArray(value)) {
      const items = value.map(order);
      return items.every(item => (item !== null && typeof item === 'object') || (typeof item === 'string' && item.includes('>'))) ? items.sort(byText) : items;
    }
    if (value === null || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    if (object.anonymous === true && typeof object.node === 'string' && typeof object.ordinal === 'number') {
      return order({ ...object, ordinal: ports.get(`${object.node}#${object.ordinal}`) ?? object.ordinal });
    }
    return Object.fromEntries(Object.entries(object).filter(([name]) => name !== 'sourceIndex').sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, item]) => [name, order(item)]));
  };
  return order(JSON.parse(text));
}

describe('the gap solve does not depend on the order of the input (R3)', () => {
  it('lays the labelled drop out the same with its links and its nodes reversed', async () => {
    const yaml = fixture(LABELLED), base = canonical(await run(yaml));
    expect(canonical(await run(reversed(yaml, 'links')))).toEqual(base);
    expect(canonical(await run(reversed(yaml, 'nodes')))).toEqual(base);
  }, 240000);

  it('lays the nested stems out the same with the links reversed and with the groups of the nodes reversed', async () => {
    const yaml = fixture(NESTED), model = await run(yaml);
    expect(canonical(await run(reversed(yaml, 'links')))).toEqual(canonical(model));
    // Node order within a group is the row order (meaningful, R3), so the rows keep it; the order of the groups in the list is incidental.
    const regrouped = reversed(yaml, 'nodes', true);
    expect(regrouped).not.toBe(yaml);
    expect(canonical(await run(regrouped))).toEqual(canonical(model));
  }, 360000);
});

describe('a restore refuses a forged tier gap (R5)', () => {
  it('refuses a tier gap shorter than the solve made it', async () => {
    const model = await run(fixture(NESTED));
    const { low, high } = tierGaps(model);
    const short = grown(model)[0]!.px;
    // Everything at or below the lower band moves up by the growth the solve took, the freeze snapshot with it, and the regions are
    // derived again: the gap is as high as it was before the solve, and only the rows of its parts stand where the solve put them.
    const forged = JSON.parse(JSON.stringify(model), (key, value: unknown) => (key === 'y' && typeof value === 'number' && value >= high - 1e-6 ? value - short : value)) as LayoutModel;
    rebuildRegions(forged);
    forged.freeze!.placement!.regions = structuredClone(forged.regions);
    expect(tierGaps(forged).high - tierGaps(forged).low).toBeCloseTo(high - low - short, 6);
    // The restore does not read the plan (a routed model plans no part); the rows the short gap no longer holds stand in the band below.
    expect(() => restoreFinalLayout(JSON.stringify(forged))).toThrow(/Routed path on link-\d+ enters reserved group:/);
  }, 120000);

  it('refuses a canton label band with a wrong height', async () => {
    const model = await run(fixture(CANTON));
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
    for (const delta of [-5, 5]) {
      // The band alone: the freeze snapshot of the final placement refuses it.
      const band = structuredClone(model);
      band.labelBands.find(item => item.group === 'west')!.bounds.height += delta;
      expect(() => restoreFinalLayout(JSON.stringify(band)), String(delta)).toThrow(/Final placement changed/);
      // The band and the snapshot forged together: the band validator refuses it.
      const both = structuredClone(band);
      both.freeze!.placement!.labelBands.find(item => item.group === 'west')!.bounds.height += delta;
      expect(() => restoreFinalLayout(JSON.stringify(both)), String(delta)).toThrow(/Group label bands contradict final group geometry/);
    }
  }, 120000);
});
