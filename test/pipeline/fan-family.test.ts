import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { segmentRect } from '../../src/geometry/planar.js';
import { fanAdmissionsFault } from '../../src/layout/fan-admission.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 40 (user rulings Q124 to Q126): the dashed links of two hubs to four sites are one fan family. Its members draw
 * straight where the joint admission holds them; the member that would pass the vault falls back alone, orthogonal, and names `body`; members
 * cross each other faintly; the Site D title stands beside the chord that enters on its edge.
 */
const FIXTURE = 'a-hub-tiers-fan-draws-straight-and-crosses-itself';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const lay = (source: string): Promise<LayoutModel> => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const ends = (model: LayoutModel, id: string): string => {
  const link = model.links.find(other => other.id === id)!;
  return [link.from.node, link.to.node].sort().join('|');
};
/**
 * The admission of each member keyed by where its path starts and ends, so a run with the links and nodes in another order compares by the
 * drawing: the reversed node order mirrors the names in each group (declaration order is meaningful), not the picture.
 */
const modes = (model: LayoutModel): string[] => (model.fanAdmissions ?? []).map(item => {
  const segments = model.links.find(link => link.id === item.link)!.path!.segments;
  const at = (point: { x: number; y: number }): string => `${Math.round(point.x)},${Math.round(point.y)}`;
  return `${[at(segments[0]!.from), at(segments[segments.length - 1]!.to)].sort().join(' ')} ${item.mode} ${item.reason ?? ''}`;
}).sort();
const clone = (model: LayoutModel): LayoutModel => structuredClone(model);

describe('a fan family draws straight and crosses itself faintly', () => {
  let model: LayoutModel;

  it('admits the members jointly: straight on one chord, and the member that passes the vault falls back alone with `body`', async () => {
    model = await lay(text);
    const record = model.fanAdmissions!;
    expect(record).toHaveLength(8);
    expect(fanAdmissionsFault(model)).toBeUndefined();
    const fallen = record.filter(item => item.mode === 'orthogonal');
    expect(fallen.map(item => [ends(model, item.link), item.reason])).toEqual([['d-1|hub-a', 'body']]);
    const straight = record.filter(item => item.mode === 'straight');
    expect(straight.length).toBeGreaterThanOrEqual(6);
    for (const item of straight) {
      const link = model.links.find(other => other.id === item.link)!;
      expect(link.path!.segments, item.link).toHaveLength(1);
    }
    const fallback = model.links.find(other => other.id === fallen[0]!.link)!;
    expect(fallback.path!.segments.length).toBeGreaterThan(1);
    expect(fallback.path!.segments.every(segment => segment.from.x === segment.to.x || segment.from.y === segment.to.y)).toBe(true);
  }, 120000);

  it('counts the crossings of members faint, keeps them out of X, and passes every gate', () => {
    const report = score(model);
    const crossings = report.snapshot.metrics.crossings;
    expect(crossings.faint).toBeGreaterThanOrEqual(1);
    expect(crossings.count).toBeGreaterThan(crossings.faint!);
    // The crossings metric is 1 - c / m over the routed links, with each faint crossing weighed 0.09 in c.
    const weighted = crossings.count - crossings.faint! + 0.09 * crossings.faint!;
    expect(crossings.value).toBeCloseTo(1 - Math.min(1, weighted / crossings.routedLinks), 9);
    const failed = Object.entries(report.snapshot.gates).filter(([, gate]) => gate.violations.length).map(([id]) => id);
    expect(failed).toEqual([]);
  });

  it('keeps the Site D title clear of the member that enters on its edge', () => {
    const title = model.labels.find(label => label.role === 'group' && label.owner.kind === 'group' && label.owner.id === 'site-d')!;
    const chord = model.links.find(link => ends(model, link.id) === 'd-1|hub-b')!;
    expect(chord.path!.segments).toHaveLength(1);
    expect(segmentRect(chord.path!.segments[0]!, title.bounds!)).toBe(false);
  });

  it('refuses a forged admission record (R5)', () => {
    const straight = model.fanAdmissions!.find(item => item.mode === 'straight')!;
    const asOrthogonal = clone(model);
    asOrthogonal.fanAdmissions!.find(item => item.link === straight.link)!.mode = 'orthogonal';
    expect(fanAdmissionsFault(asOrthogonal)).toMatch(/holds a chord its admission refused/);
    // A box that holds an end of the member is no foreign box: the record may not name it.
    const fromSiteA = model.fanAdmissions!.find(item => ends(model, item.link) === 'a-1|hub-a')!;
    expect(fromSiteA.mode).toBe('straight');
    const ownBox = clone(model);
    ownBox.fanAdmissions!.find(item => item.link === fromSiteA.link)!.crosses = ['site-a'];
    expect(fanAdmissionsFault(ownBox)).toMatch(/no foreign box/);
    const reordered = clone(model);
    reordered.fanAdmissions!.reverse();
    expect(fanAdmissionsFault(reordered)).toMatch(/in order/);
  });

  it('lets G2 excuse a straight member only in the boxes its admission names', () => {
    // A foreign group grown over the middle of a straight member: G2 fails until the record names that group.
    const straight = model.fanAdmissions!.find(item => item.mode === 'straight' && ends(model, item.link) === 'd-1|hub-b')!;
    const grown = clone(model);
    const segment = grown.links.find(link => link.id === straight.link)!.path!.segments[0]!;
    const middle = { x: (segment.from.x + segment.to.x) / 2, y: (segment.from.y + segment.to.y) / 2 };
    const box = grown.groups['site-c']!.bounds!;
    const right = Math.max(box.x + box.width, middle.x + 2), bottom = Math.max(box.y + box.height, middle.y + 2);
    grown.groups['site-c']!.bounds = { x: Math.min(box.x, middle.x - 2), y: Math.min(box.y, middle.y - 2), width: 0, height: 0 };
    const bounds = grown.groups['site-c']!.bounds!;
    bounds.width = right - bounds.x;
    bounds.height = bottom - bounds.y;
    const through = (candidate: LayoutModel): boolean => score(candidate).snapshot.gates.G2!.violations
      .some(violation => violation.code === 'through-group' && violation.elements.includes(straight.link) && violation.elements.includes('site-c'));
    expect(through(grown)).toBe(true);
    grown.fanAdmissions!.find(item => item.link === straight.link)!.crosses = ['site-c'];
    expect(through(grown)).toBe(false);
  });

  it('draws the same admissions with the links and the nodes in reverse order (R3)', async () => {
    const lines = text.split('\n');
    const at = (key: string): number => lines.indexOf(`${key}:`);
    const block = (from: number, to: number): string[] => lines.slice(from + 1, to).filter(line => line.trim() !== '');
    const nodes = block(at('nodes'), at('links')), links = block(at('links'), lines.length);
    const reversed = [...lines.slice(0, at('nodes') + 1), ...nodes.reverse(), 'links:', ...links.reverse()].join('\n');
    expect(modes(await lay(reversed))).toEqual(modes(model));
  }, 120000);
});
