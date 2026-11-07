import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Lane, LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { centreDraft, createCentreBudget, refreshAlignmentDeclines } from '../../src/layout/centre.js';
import { recentreSeatedFaces } from '../../src/layout/face-centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { resizeEvidence, resizeHolds } from '../../src/layout/move-reservations.js';
import { parentSpread } from '../../src/layout/read/parent-spread.js';
import { rows } from '../../src/layout/rows.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';

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
/** The model the centre rule reads (stage `flanks`), as a plain copy a test may change. */
const input = async (yaml: string): Promise<LayoutModel> => JSON.parse(JSON.stringify(flanks(lanes(rows(await placed(yaml)))))) as LayoutModel;
/** A forged routed lane of `tier`, centred on `x`, owned by `link`, across the band of the tier. */
const lane = (model: LayoutModel, id: string, link: string, tier: number, group: string, side: 'left' | 'right', x: number, extra: Partial<Lane> = {}): Lane => {
  const band = model.tierBands.find(item => item.tier === tier)!.bounds!;
  return { id, owner: { kind: 'link', id: link }, layer: 'routed', kind: 'transit', group, tier, side, x, bounds: { x: x - 17, y: band.y, width: 34, height: band.height }, ...extra };
};
/** The geometry of every node: its box and the x of its ports. */
const picture = (model: LayoutModel) => Object.fromEntries(Object.entries(model.nodes).map(([id, node]) =>
  [id, { bounds: node.bounds, xs: node.ports.map(port => port.anchor!.x).sort((a, b) => a - b) }]));

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
    expect(shared.parentSpreads).toBeUndefined();
    // The complete block, the X: `west` and `sw` both feed both children.
    const block = await run(fixture(NAME).trimEnd() + '\n  - [west, ap]\n  - [west, vm-host]\n');
    expect(block.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(block.parentSpreads).toBeUndefined();
  }, 60000);

  it('a parent whose children stand in two groups keeps its ports and is named (R6)', async () => {
    const yaml = fixture(NAME).replace('  low: { tier: 2, label: Low }\n', '  low: { tier: 2, label: Low }\n  low-two: { tier: 2, label: Low two }\n')
      .replace('ap: { group: low,', 'ap: { group: low-two,');
    const model = await run(yaml);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.parentSpreads).toBeUndefined();
    expect(codes(model, 'PARENT_SPREAD_DECLINED').map(item => item.message))
      .toEqual(['sw keeps its ports at pitch over its children: its children stand in more than one group; link-4, link-5 align on the child side.']);
  }, 60000);

  it('a spread past the alignment allowance is declined whole and named', async () => {
    // Two children so wide that their ports stand further apart than twelve times the width `sw` needs.
    const wide = 'Access point with a label long enough to stand far beyond twelve times the width of the narrow switch that feeds it and more';
    const model = await run(fixture(NAME).replace('label: Access point', `label: ${wide} ${wide}`).replace('label: Virtual host', `label: ${wide}`));
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.parentSpreads).toBeUndefined();
    const declined = codes(model, 'PARENT_SPREAD_DECLINED');
    expect(declined.length).toBe(1);
    expect(declined[0]!.owners).toEqual([{ kind: 'node', id: 'sw' }, { kind: 'link', id: 'link-4' }, { kind: 'link', id: 'link-5' }]);
  }, 60000);

  it('the decision is the centre rule\'s alone: a replay spreads nothing, and a sheet that spreads nothing keeps no record', async () => {
    const model = structuredClone(await run(fixture(NAME))) as LayoutModel;
    const width = model.nodes['sw']!.bounds!.width, xs = model.nodes['sw']!.ports.map(port => port.anchor!.x);
    // A replay after the centre rule (stage `link-labels` here) reads the geometry the spread left: with or without the record it decides nothing.
    for (const record of [true, false]) {
      const copy = structuredClone(model) as LayoutModel;
      if (!record) delete copy.parentSpreads;
      centreDraft(copy, createCentreBudget());
      expect(copy.parentSpreads).toEqual(record ? model.parentSpreads : undefined);
      expect(copy.nodes['sw']!.bounds!.width).toBeCloseTo(width, 6);
      expect(copy.nodes['sw']!.ports.map(port => port.anchor!.x)).toEqual(xs);
    }
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
    // The decision: the grown width, the face and the two shifts (as a pair: a mirrored row swaps them).
    const spread = (model: LayoutModel) => {
      const item = parentSpread(model, 'sw')!;
      return { width: item.width.toFixed(6), shifts: [item.shift.low, item.shift.high].map(value => value.toFixed(6)).sort(), offsets: item.ports.map(port => port.offset.toFixed(6)).sort() };
    };
    // Links reversed: the link ids and the ordinals of anonymous ports follow the link list; the geometry may not.
    const links2 = await run(reversed(fixture(NAME), 'links'));
    expect(picture(links2)).toEqual(picture(base));
    expect(spread(links2)).toEqual(spread(base));
    // Nodes reversed: the declaration order is the order of the row (a meaningful order, R3), so the row is mirrored. The decision is the same, and
    // both drops stand vertical.
    for (const yaml of [reversed(fixture(NAME), 'nodes'), reversed(reversed(fixture(NAME), 'links'), 'nodes')]) {
      const flipped = await run(yaml);
      expect(spread(flipped)).toEqual(spread(base));
      const drops = flipped.links.filter(link => link.attachments!.from.node === 'sw' || link.attachments!.to.node === 'sw').filter(link => link.attachments!.to.node !== 'sw');
      expect(drops.length).toBe(2);
      for (const link of drops) expect(dx(flipped, link.id)).toBeLessThanOrEqual(0.5);
    }
  }, 60000);

  it('a {} record stops a second decision inside the centre rule, and a second run on a spread model spreads nothing more (R1)', async () => {
    // The first run decides: `sw` spreads.
    const model = await input(fixture(NAME));
    expect(model.stage).toBe('flanks');
    centreDraft(model, createCentreBudget());
    const record = structuredClone(model.parentSpreads), width = model.nodes['sw']!.bounds!.width;
    expect(Object.keys(record ?? {})).toEqual(['sw']);
    // A later run of the passes at the same stage (as after a wall move is given back) reads the record and does not spread again.
    centreDraft(model, createCentreBudget());
    expect(model.parentSpreads).toEqual(record);
    expect(model.nodes['sw']!.bounds!.width).toBeCloseTo(width, 6);
    // `{}` is a decision too: a run that finds it at the centre rule's own stage spreads nothing, and the drops keep their slant.
    const none = await input(fixture(NAME));
    none.parentSpreads = {};
    centreDraft(none, createCentreBudget());
    expect(none.parentSpreads).toEqual({});
    expect(Math.max(dx(none, 'link-4'), dx(none, 'link-5'))).toBeGreaterThan(0.5);
  }, 60000);

  it('a spread its window cannot hold is undone after it was made: the layout is the one with no spread', async () => {
    // Two lanes of tier 1 close the group of `sw` in: the spread makes the group wider than the room between them.
    const fenced = async (decided?: Record<string, never>): Promise<LayoutModel> => {
      const model = await input(fixture(NAME)), box = model.groups['middle']!.bounds!;
      model.lanes.push(lane(model, 'lane:test-left', 'link-1', 1, 'middle', 'left', box.x - 20), lane(model, 'lane:test-right', 'link-3', 1, 'middle', 'right', box.x + box.width + 20));
      if (decided) model.parentSpreads = decided;
      centreDraft(model, createCentreBudget());
      return model;
    };
    const declined = await fenced(), plain = await fenced({});
    expect(declined.parentSpreads).toEqual({});
    const named = codes(declined, 'PARENT_SPREAD_DECLINED');
    expect(named.length).toBe(1);
    expect(named[0]!.message).toMatch(/^sw keeps its ports at pitch over its children: spread it is [0-9.]+ px wide and the window of its group holds [0-9.]+ px; link-4, link-5 align on the child side\.$/);
    // The undo restores every box and port the spread moved: the passes then run on the model a run with no spread has.
    expect(picture(declined)).toEqual(picture(plain));
  }, 60000);

  it('a spread whose children cannot stand under its ports is declined: the child side is checked (a lane fences the child group)', async () => {
    const model = await input(fixture(NAME)), low = model.groups['low']!;
    // The child row stands far to the left, and a lane of its tier stands just right of it: the row cannot move under `sw`.
    moveGroup(model, low, -200, 0);
    model.lanes.push(lane(model, 'lane:test-child', 'link-1', 2, 'low', 'right', low.bounds!.x + low.bounds!.width + 20));
    const width = model.nodes['sw']!.bounds!.width;
    centreDraft(model, createCentreBudget());
    expect(model.parentSpreads).toEqual({});
    const named = codes(model, 'PARENT_SPREAD_DECLINED');
    expect(named.length).toBe(1);
    expect(named[0]!.message).toMatch(/^sw keeps its ports at pitch over its children: its children cannot stand under the spread ports: low would stand at /);
    expect(model.nodes['sw']!.bounds!.width).toBeCloseTo(width, 6);
  }, 60000);

  it('a resize is judged where its nodes stand: a far port the row move takes off its side lane refuses it, though the group box keeps its x', async () => {
    const model = await input(fixture(NAME)), group = model.groups['middle']!;
    // `east` is the right neighbour of `sw`; its top port is the far end of a side lane of link-3 (t5 to east), seated on the port's x.
    const link = model.links.find(item => item.id === 'link-3')!, far = model.nodes['east']!.ports.find(port => port.side === 'top')!;
    const side = lane(model, 'side-lane:link-3', 'link-3', 1, 'middle', 'right', far.anchor!.x, { kind: 'side', port: { ...link.attachments!.from } });
    const resize = (target: LayoutModel): boolean => {
      const evidence = resizeEvidence(target, target.groups['middle']!), box = { ...target.groups['middle']!.bounds! };
      // The spread: `sw` grows 30 px to the right, `east` moves right by the same 30 px; the group box keeps its left edge.
      target.nodes['sw']!.bounds!.width += 30;
      for (const port of target.nodes['east']!.ports) port.anchor!.x += 30;
      target.nodes['east']!.bounds!.x += 30;
      target.groups['middle']!.bounds = { ...box, width: box.width + 30 };
      expect(target.groups['middle']!.bounds!.x).toBe(box.x);
      return resizeHolds(target, target.groups['middle']!, evidence);
    };
    expect(resize(structuredClone(model) as LayoutModel)).toBe(true);
    model.lanes.push(side);
    expect(group.nodes).toContain('east');
    expect(resize(model)).toBe(false);
  }, 60000);
});
