import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { centreDraft, createCentreBudget, refreshAlignmentDeclines } from '../../src/layout/centre.js';
import { recentreSeatedFaces } from '../../src/layout/face-centre.js';
import { parentSpread } from '../../src/layout/read/parent-spread.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const NAME = 'a-parent-below-the-anchor-spreads-its-ports-over-its-children';
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: { x: number; width: number }): number => box.x + box.width;
/** The x of each end of a link, upper end first. */
const ends = (model: LayoutModel, id: string): [number, number] => {
  const link = model.links.find(item => item.id === id)!, x = (ref: { node: string; ordinal: number }): number =>
    model.nodes[ref.node]!.ports.find(port => port.ref.ordinal === ref.ordinal)!.anchor!.x;
  return [x(link.attachments!.from), x(link.attachments!.to)];
};
const dx = (model: LayoutModel, id: string): number => { const [one, two] = ends(model, id); return Math.abs(one - two); };
const codes = (model: LayoutModel, code: string) => model.diagnostics.filter(item => item.code === code);

// Architecture-2 ticket 32 (Q120): a parent below the anchor tier spreads its fed bottom ports to the spacing of its children, once, before the
// first step of the centre rule; its body grows by the deficit and its row neighbours move away by the same amount (`parentSpreads`).
describe('a parent below the anchor tier spreads its ports over its children (architecture-2 ticket 32)', () => {
  it('both drops stand vertical, and the child row stands under its parent', async () => {
    const model = await run(fixture(NAME));
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.anchorTier).toBe(0);
    // link-4 and link-5 are the two drops of `sw`: before the rule they slanted 29.6 and 48.7 px (main 52fc7408).
    expect([dx(model, 'link-4'), dx(model, 'link-5')].every(value => value <= 0.5)).toBe(true);
    expect(codes(model, 'CENTRE_ALIGNMENT_INFEASIBLE')).toEqual([]);
    // The child row stands under the span of its parent: the centre of each child body lies inside the body of `sw`.
    const sw = model.nodes['sw']!.bounds!;
    for (const id of ['vm-host', 'ap']) {
      const box = model.nodes[id]!.bounds!, centre = box.x + box.width / 2;
      expect(centre).toBeGreaterThan(sw.x);
      expect(centre).toBeLessThan(right(sw));
    }
    // The neighbours keep their row order and their row gap to the grown body.
    expect(right(model.nodes['west']!.bounds!)).toBeLessThan(sw.x);
    expect(right(sw)).toBeLessThan(model.nodes['east']!.bounds!.x);
  }, 60000);

  it('the parent port moves to its child, and the body grows by the deficit alone (one stored decision)', async () => {
    const model = await run(fixture(NAME));
    expect(Object.keys(model.parentSpreads ?? {})).toEqual(['sw']);
    const spread = parentSpread(model, 'sw')!, node = model.nodes['sw']!, pitch = node.sidePitch!.bottom!, inset = 10 + pitch / 2;
    // Each fed port stands at the x of the top port of its child.
    expect(ends(model, 'link-4')[0]).toBeCloseTo(ends(model, 'link-4')[1], 6);
    expect(ends(model, 'link-5')[0]).toBeCloseTo(ends(model, 'link-5')[1], 6);
    // The record holds the face the spread made: the outer ports stand at the end insets of the grown body, so the body is no wider than the ports need.
    const offsets = spread.ports.map(item => item.offset).sort((a, b) => a - b);
    expect(offsets[0]).toBeCloseTo(inset, 6);
    expect(offsets[offsets.length - 1]).toBeCloseTo(spread.width - inset, 6);
    // Grown by the deficit, half on each side: the body was 50 px wide when the centre rule began (measured), and the row neighbours moved apart by
    // the same amounts.
    expect(spread.width - spread.shift.low - spread.shift.high).toBeCloseTo(50, 1);
    expect(spread.shift.low).toBeCloseTo(spread.shift.high, 6);
    expect(spread.shift.low).toBeGreaterThan(0);
    // The geometry that publishes is the decision: the body keeps the width and the face the record holds.
    expect(node.bounds!.width).toBeCloseTo(spread.width, 6);
    for (const item of spread.ports) {
      expect(node.ports.find(port => port.ref.ordinal === item.port.ordinal)!.anchor!.x - node.bounds!.x).toBeCloseTo(item.offset, 6);
    }
  }, 60000);

  it('a child that another parent also feeds is skipped: the parent keeps its ports at pitch', async () => {
    // `west` feeds `ap` too: `sw` has one child of its own left, and spreads over none.
    const shared = await run(fixture(NAME).trimEnd() + '\n  - [west, ap]\n');
    expect(shared.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(shared.parentSpreads).toEqual({});
    // The complete block, the X: `west` and `sw` both feed both children.
    const block = await run(fixture(NAME).trimEnd() + '\n  - [west, ap]\n  - [west, vm-host]\n');
    expect(block.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(block.parentSpreads).toEqual({});
  }, 60000);

  it('a spread past the alignment allowance is declined whole and named', async () => {
    // Two children so wide that their ports stand further apart than twelve times the width `sw` needs.
    const wide = 'Access point with a label long enough to stand far beyond twelve times the width of the narrow switch that feeds it and more';
    const model = await run(fixture(NAME).replace('label: Access point', `label: ${wide} ${wide}`).replace('label: Virtual host', `label: ${wide}`));
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.parentSpreads).toEqual({});
    const declined = codes(model, 'PARENT_SPREAD_DECLINED');
    expect(declined.length).toBe(1);
    expect(declined[0]!.owners).toEqual([{ kind: 'node', id: 'sw' }, { kind: 'link', id: 'link-4' }, { kind: 'link', id: 'link-5' }]);
  }, 60000);

  it('the decision is the centre rule\'s alone: a replay that finds no record spreads nothing and says so; a sheet with no parent tier below the anchor has none', async () => {
    const model = structuredClone(await run(fixture(NAME))) as LayoutModel;
    const width = model.nodes['sw']!.bounds!.width;
    delete model.parentSpreads;
    centreDraft(model, createCentreBudget());
    expect(model.parentSpreads).toBeUndefined();
    expect(codes(model, 'PARENT_SPREADS_UNDECIDED').length).toBe(1);
    expect(model.nodes['sw']!.bounds!.width).toBeCloseTo(width, 6);
    // Tier 0 is the anchor and tier 1 the lowest: no parent stands below the anchor tier.
    const two = 'portograph: 2\ngroups:\n  top: { tier: 0, label: Top }\n  low: { tier: 1, label: Low }\nnodes:\n'
      + '  t1: { group: top, label: T1 }\n  t2: { group: top, label: T2 }\n  c1: { group: low, label: C1 }\n  c2: { group: low, label: C2 }\n'
      + 'links:\n  - [t1, c1]\n  - [t1, c2]\n';
    expect((await run(two)).parentSpreads).toBeUndefined();
  }, 60000);

  it('the face recentring holds a spread face where the spread put it (parentSpread is its reader)', async () => {
    const model = structuredClone(await run(fixture(NAME))) as LayoutModel;
    const node = model.nodes['sw']!, bottom = node.ports.filter(port => port.side === 'bottom');
    // Move the spread block off the middle of its face, as a later move could, and record the face as seated on a narrower body.
    for (const port of bottom) port.anchor!.x += 5;
    const xs = bottom.map(port => port.anchor!.x), first = Math.min(...xs);
    const face = { node: 'sw', side: 'bottom' as const, width: node.bounds!.width - 10, first, low: first - node.bounds!.x };
    recentreSeatedFaces(model, [face]);
    expect(bottom.map(port => port.anchor!.x)).toEqual(xs);
    // Without the record the same face is recentred: the reader, not the geometry, holds it.
    const bare = structuredClone(model) as LayoutModel;
    delete bare.parentSpreads;
    recentreSeatedFaces(bare, [face]);
    expect(bare.nodes['sw']!.ports.filter(port => port.side === 'bottom').map(port => port.anchor!.x)).not.toEqual(xs);
  }, 60000);

  it('a CENTRE_ALIGNMENT_INFEASIBLE is withdrawn when its link stands vertical, and kept while it slants', async () => {
    const model = structuredClone(await run(fixture(NAME))) as LayoutModel;
    const warn = (link: string) => ({ stage: 'placement' as const, severity: 'warning' as const, code: 'CENTRE_ALIGNMENT_INFEASIBLE',
      message: `${link} cannot align within its child's available row span; routing completes it.`, owners: [{ kind: 'link' as const, id: link }] });
    // link-4 stands vertical; link-1 is made to slant by moving the top port of `west`.
    model.nodes['west']!.ports.find(port => port.side === 'top')!.anchor!.x += 7;
    model.diagnostics.push(warn('link-4'), warn('link-1'));
    refreshAlignmentDeclines(model);
    expect(codes(model, 'CENTRE_ALIGNMENT_INFEASIBLE').map(item => item.message.split(' ')[0])).toEqual(['link-1']);
  }, 60000);

  it('the spread does not follow the order of the links or of the nodes (R3)', async () => {
    const base = await run(fixture(NAME));
    const [head, links] = fixture(NAME).split('links:\n');
    const reversed = await run(`${head}links:\n${links!.trimEnd().split('\n').reverse().join('\n')}\n`);
    // The link ids and the ordinals of anonymous ports follow the link list; the geometry may not.
    const picture = (model: LayoutModel) => Object.fromEntries(Object.entries(model.nodes).map(([id, node]) =>
      [id, { bounds: node.bounds, xs: node.ports.map(port => port.anchor!.x).sort((a, b) => a - b) }]));
    expect(picture(reversed)).toEqual(picture(base));
    const spread = (model: LayoutModel) => { const item = parentSpread(model, 'sw')!; return { width: item.width, shift: item.shift, offsets: item.ports.map(port => port.offset).sort((a, b) => a - b) }; };
    expect(spread(reversed)).toEqual(spread(base));
  }, 60000);
});
