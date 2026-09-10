import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';
import { freezePortTopology, restoreLayoutModel, withLayoutMutation } from '../../src/layout/mutation.js';
import { rows } from '../../src/layout/rows.js';
import { serializeLayoutModel } from '../../src/model/model.js';
import { placed, simple } from './phase-two-fixture.js';
const copy = (model: LayoutModel): LayoutModel => JSON.parse(serializeLayoutModel(model));
const publish = {
  freeze(model: LayoutModel, edit: (draft: LayoutModel) => void) { const draft = copy(model); delete draft.freeze; edit(draft); return freezePortTopology(draft); },
  restore(model: LayoutModel, edit: (draft: LayoutModel) => void) { const draft = copy(model); edit(draft); return restoreLayoutModel(JSON.stringify(draft)); },
  transaction(model: LayoutModel, edit: (draft: LayoutModel) => void) { return withLayoutMutation(model, 'rows', edit); },
};
const diagnose = (model: LayoutModel) => { model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE', message: 'Retain last coherent geometry' }); };
const flankYaml = `portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, ports: [{name: p, side: left}]}
  b: {group: f, ports: [{name: p, side: right}]}
links: [[a.p, b.p]]`;
const moveNode = (model: LayoutModel, id: string, dx: number, dy: number) => {
  const node = model.nodes[id]!; node.bounds!.x += dx; node.bounds!.y += dy;
  for (const port of node.ports) { port.anchor!.x += dx; port.anchor!.y += dy; }
};
describe('all public publication boundaries', () => {
  for (const [boundary, apply] of Object.entries(publish)) {
    it(`${boundary} rejects incomplete and nonnumeric canvas fields even with non-convergence`, async () => {
      const model = await placed(simple);
      for (const field of ['x', 'y', 'width', 'height']) {
        expect(() => apply(model, draft => { Reflect.deleteProperty(draft.canvas!, field); diagnose(draft); })).toThrow(/canvas/i);
        expect(() => apply(model, draft => { Object.assign(draft.canvas!, { [field]: 'invalid' }); diagnose(draft); })).toThrow(/canvas/i);
      }
      expect(() => apply(model, draft => { Object.assign(draft, { canvas: {} }); })).toThrow(/canvas/i);
    });
    it(`${boundary} rejects unsupported regions, bare junctions and fixed paths`, async () => {
      const model = await placed(simple), before = serializeLayoutModel(model);
      const edits: ((draft: LayoutModel) => void)[] = [
        draft => { draft.regions.push({ id: 'invented', kind: 'tiers', upperTier: 99, lowerTier: 100, bounds: { x: 0, y: 0, width: -1, height: -1 } }); },
        draft => { draft.junctions.push({ id: 'invented', owner: { kind: 'shared-stem', id: 'invented' }, layer: 'routed', port: { node: 'missing', name: 'p', ordinal: 1 }, links: ['missing'] }); },
        draft => { draft.links[0]!.path = { owner: { kind: 'link', id: 'missing' }, layer: 'routed', fixed: true, segments: [] }; },
      ];
      // The transaction boundary reports a row candidate's path as derived; the other boundaries report the missing validator.
      for (const edit of edits) expect(() => apply(model, draft => { edit(draft); diagnose(draft); })).toThrow(/not implemented|derived by the transaction|Callback regions contradict/);
      expect(serializeLayoutModel(model)).toBe(before);
    });
    it(`${boundary} rejects techniques that contradict an authored override`, async () => {
      const model = await placed(simple.replace('links: [[a.q, b.p]]', 'links: [[a.q, b.p, {route: orthogonal}]]'));
      expect(() => apply(model, draft => { draft.links[0]!.technique = 'overlay'; })).toThrow();
      expect(() => apply(model, draft => { delete draft.links[0]!.technique; })).toThrow();
    });
  }
  it('rejects invalid supported-layer and M1-fallback technique combinations', async () => {
    for (const route of ['overlay', 'stub'] as const) {
      const model = await placed(simple.replace('links: [[a.q, b.p]]', `links: [[a.q, b.p, {route: ${route}}]]`));
      expect(restoreLayoutModel(serializeLayoutModel(model)).links[0]!.technique).toBe(route === 'overlay' ? 'overlay' : 'orthogonal');
      expect(() => publish.restore(model, draft => { draft.links[0]!.technique = route === 'overlay' ? 'orthogonal' : route; })).toThrow(/technique/i);
    }
    const groupLink = await placed(`portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes: {a: {group: g}, b: {group: g}, c: {group: h}, d: {group: h}}
links: [{from: {group: g}, to: {group: h}, route: group-link}]`);
    expect(restoreLayoutModel(serializeLayoutModel(groupLink)).links[0]!.technique).toBe('orthogonal');
    expect(() => publish.restore(groupLink, draft => { draft.links[0]!.technique = 'group-link'; })).toThrow(/technique/i);
    const model = await placed(simple);
    expect(() => publish.restore(model, draft => { Object.assign(draft.links[0]!, { technique: 'invented' }); })).toThrow(/technique/i);
  });
  it('validates geometry-selected straight/orthogonal through the rows rule without weakening an override', async () => {
    const pinned = rows(await placed(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
links: [[a.p, b.q]]`));
    expect(pinned.links[0]!.technique).toBe('straight');
    expect(publish.restore(pinned, () => {}).links[0]!.technique).toBe('straight');
    expect(withLayoutMutation(pinned, 'lanes', () => {}).links[0]!.technique).toBe('straight');
    expect(() => publish.restore(pinned, draft => { draft.links[0]!.technique = 'orthogonal'; })).toThrow(/technique/i);
    // Too short to level against a tall peer: the rule leaves this automatic link orthogonal, and restore cannot claim straight.
    const unpinned = rows(await placed(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, size: {width: 50, height: 120}, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
links: [[a.p, b.q]]`));
    expect(unpinned.links[0]!.technique).toBe('orthogonal');
    expect(unpinned.links[0]!.path).toBeUndefined();
    expect(() => publish.restore(unpinned, draft => { draft.links[0]!.technique = 'straight'; })).toThrow(/technique/i);
    const early = await placed(simple);
    expect(() => publish.freeze(early, draft => { draft.links[0]!.technique = 'straight'; })).toThrow(/technique/i);
  });
});

it('rejects physical row reversal independently of diagnosed clearance failures', async () => {
  const model = await placed(simple), before = serializeLayoutModel(model);
  expect(() => withLayoutMutation(model, 'rows', draft => {
    const [first, second] = draft.groups.g!.rowOrder!;
    const a = draft.nodes[first!]!, b = draft.nodes[second!]!;
    const bx = a.bounds!.x, ax = bx + b.bounds!.width + 200;
    moveNode(draft, first!, ax - a.bounds!.x, 0); moveNode(draft, second!, bx - b.bounds!.x, 0);
    diagnose(draft);
  })).toThrow(/row order/i);
  expect(serializeLayoutModel(model)).toBe(before);
});

it('keeps flank placement unchanged in the rows rule', async () => {
  const model = await placed(flankYaml);
  expect(() => withLayoutMutation(model, 'rows', draft => { moveNode(draft, 'b', 0, 10); diagnose(draft); })).toThrow(/flank/i);
  expect(() => withLayoutMutation(model, 'rows', draft => { draft.groups.f!.bounds!.x++; diagnose(draft); })).toThrow(/flank/i);
});

it('rejects every horizontal flank translation and preserves its authored side on restore', async () => {
  let model = await placed(flankYaml);
  model = withLayoutMutation(model, 'rows', () => {}); model = withLayoutMutation(model, 'lanes', () => {});
  for (const dx of [-10, 10, 1000]) {
    expect(() => withLayoutMutation(model, 'flanks', draft => {
      draft.groups.f!.bounds!.x += dx; moveNode(draft, 'b', dx, 0); diagnose(draft);
    })).toThrow(/horizontal|flank/i);
  }
  expect(() => publish.restore(model, draft => {
    draft.groups.f!.bounds!.x += 1000; moveNode(draft, 'b', 1000, 0); diagnose(draft);
  })).toThrow(/flank/i);
});

it('retains legal vertical flank translation and zero-area empty canvas', async () => {
  let model = await placed(flankYaml);
  model = withLayoutMutation(model, 'rows', () => {}); model = withLayoutMutation(model, 'lanes', () => {});
  const moved = withLayoutMutation(model, 'flanks', draft => { draft.groups.f!.bounds!.y += 10; moveNode(draft, 'b', 0, 10); });
  expect(moved.nodes.b!.bounds!.x).toBe(model.nodes.b!.bounds!.x);
  expect(moved.nodes.b!.bounds!.y).toBe(model.nodes.b!.bounds!.y + 10);
  const empty = await placed('portograph: 2\ngroups: {}\nnodes: {}\nlinks: []');
  for (const apply of [publish.freeze, publish.restore]) {
    expect(apply(empty, draft => { draft.canvas = { x: 0, y: 0, width: 0, height: 0 }; diagnose(draft); }).canvas!.width).toBe(0);
  }
});

it.each([Infinity, -Infinity, NaN])('direct freeze rejects runtime %s before cloning and leaves input unchanged', async durationMs => {
  const draft = copy(await placed(simple));
  delete draft.freeze;
  draft.runtime.stages = [{ stage: 'skeleton', durationMs }];
  const before = structuredClone(draft);
  expect(() => freezePortTopology(draft)).toThrow(/finite/);
  expect(draft).toEqual(before);
  expect(draft.runtime.stages[0]!.durationMs).toBe(durationMs);
  expect(Object.hasOwn(draft, 'freeze')).toBe(false);
});
