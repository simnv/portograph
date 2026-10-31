import { goldenWithRemainders } from '../golden-remainders.js';
import { describe, expect, it } from 'vitest';
import type { PortRef } from '../../src/model/document.js';
import type { LayoutModel, PathSegment } from '../../src/model/layout.js';
import { orderedNodeIds, serializeLayoutModel, serializeLayoutSnapshot } from '../../src/model/model.js';
import { freezePortTopology, restoreLayoutModel, withLayoutMutation, type PlacementRule } from '../../src/layout/mutation.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { rebuildBands } from '../../src/layout/skeleton-geometry.js';
import { nodeGap } from '../../src/layout/skeleton-graph.js';
import { rows } from '../../src/layout/rows.js';
import { GROUP_PADDING } from '../../src/layout/regions.js';
import { expectedRowPath, rowPathCandidate, straightCorridorClear } from '../../src/layout/row-paths.js';
import { rowGap } from '../../src/layout/sides-two.js';
import { placed, simple } from './phase-two-fixture.js';

const advance = (model: LayoutModel, rules: PlacementRule[]) => rules.reduce((m, rule) => withLayoutMutation(m, rule, () => {}), model);
const copy = (model: LayoutModel): LayoutModel => JSON.parse(serializeLayoutModel(model));
const moveNode = (model: LayoutModel, id: string, dx: number, dy: number) => {
  const node = model.nodes[id]!; node.bounds!.x += dx; node.bounds!.y += dy;
  for (const port of node.ports) { port.anchor!.x += dx; port.anchor!.y += dy; }
};
const fitGroup = (model: LayoutModel, id: string) => {
  const group = model.groups[id]!, boxes = group.nodes.map(n => model.nodes[n]!.bounds!);
  const x = Math.min(...boxes.map(b => b.x)) - 12, y = Math.min(...boxes.map(b => b.y)) - 12;
  group.bounds = { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) + 12 - x, height: Math.max(...boxes.map(b => b.y + b.height)) + 12 - y };
};
/** Forced skeleton arrangement: edit a sides-two copy, rebuild derived geometry and freeze it again. */
const stageInput = (model: LayoutModel, edit: (draft: LayoutModel) => void): LayoutModel => {
  const draft = copy(model); delete draft.freeze; edit(draft);
  rebuildNodeGeometry(draft, orderedNodeIds(draft.document), 'current'); rebuildBands(draft);
  const groups = Object.values(draft.groups).map(g => g.bounds!);
  draft.canvas = { x: 0, y: 0, width: Math.max(...groups.map(b => b.x + b.width)) + 12, height: Math.max(...groups.map(b => b.y + b.height)) + 12 };
  return freezePortTopology(draft);
};
const anchorOf = (model: LayoutModel, id: string, index: number) => model.nodes[id]!.ports[index]!.anchor!;
const endpoints = (model: LayoutModel, linkId: string) => {
  const link = model.links.find(l => l.id === linkId)!;
  const port = (ref: PortRef) => model.nodes[ref.node]!.ports.find(p => JSON.stringify(p.ref) === JSON.stringify(ref))!;
  return { link, from: port(link.attachments!.from), to: port(link.attachments!.to) };
};
const pairYaml = `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
links: [[a.p, b.q]]`;
const tallYaml = `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, size: {width: 50, height: 120}, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
links: [[a.p, b.q]]`;
const anchoredPairYaml = `portograph: 2
groups: {upper: {tier: 0}, g: {tier: 1}}
nodes:
  u1: {group: upper}
  u2: {group: upper}
  u3: {group: upper}
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
links: [[a.p, b.q]]`;

describe('stage 6 rows on the golden', () => {
  it('flattens tiers, aligns both EBR bundle endpoints and pins nothing', async () => {
    // The two provider links hold their chord on the golden (ticket 100), and this test pins that no link has a path: read them orthogonal.
    const input = await placed(goldenWithRemainders()), before = serializeLayoutModel(input);
    const model = rows(input);
    expect(model.stage).toBe('rows');
    expect(serializeLayoutModel(input)).toBe(before);
    expect(Object.isFrozen(model.links)).toBe(true);
    for (const id of ['link-3', 'link-4']) {
      const { link, from, to } = endpoints(model, id);
      expect(link.bundle).toBe('bundle-1');
      expect(from.side).toBe('right'); expect(to.side).toBe('left');
      expect(from.anchor!.y).toBe(to.anchor!.y);
      expect(link.path).toBeUndefined();
    }
    expect(model.links.every(link => link.path === undefined)).toBe(true);
    expect(model.bundles.map(b => Object.keys(b).sort())).toEqual(input.bundles.map(b => Object.keys(b).sort()));
    expect(model.obstacles).toEqual([]);
    for (const band of model.tierBands) {
      const tops = new Set(band.groups.map(id => model.groups[id]!).filter(g => !g.flank && model.document.groups[g.id]!.shape === 'row')
        .flatMap(g => g.nodes.map(n => model.nodes[n]!.bounds!.y)));
      expect(tops.size).toBeLessThanOrEqual(1);
    }
    for (const id of ['tbr-left', 'tbr-right', 'backbone']) expect(model.groups[id]).toEqual(input.groups[id]);
    for (const id of ['TBR-001', 'TBR-002', 'EBB-01', 'EBB-02']) expect(model.nodes[id]).toEqual(input.nodes[id]);
    expect(() => withLayoutMutation(input, 'rows', draft => { draft.groups.backbone!.bounds!.width += 1; })).toThrow(/non-row group/);
    expect(model.freeze).toEqual(input.freeze);
    for (const group of Object.values(model.groups)) {
      const box = group.bounds!;
      for (const id of group.nodes) {
        const node = model.nodes[id]!.bounds!;
        expect(node.x).toBeGreaterThanOrEqual(box.x); expect(node.y).toBeGreaterThanOrEqual(box.y);
        expect(node.x + node.width).toBeLessThanOrEqual(box.x + box.width); expect(node.y + node.height).toBeLessThanOrEqual(box.y + box.height);
      }
    }
    expect(restoreLayoutModel(serializeLayoutModel(model)).stage).toBe('rows');
  });
});

describe('flatten and repack', () => {
  it('separates nodes stacked at one x after flattening and keeps containment', async () => {
    const stacked = stageInput(await placed(pairYaml), draft => {
      const a = draft.nodes.a!.bounds!, b = draft.nodes.b!.bounds!;
      moveNode(draft, 'b', a.x - b.x, a.y + a.height + 40 - b.y);
      draft.groups.g!.rowOrder = ['a', 'b'];
      fitGroup(draft, 'g');
    });
    expect(stacked.nodes.b!.bounds!.x).toBe(stacked.nodes.a!.bounds!.x);
    const model = rows(stacked);
    const a = model.nodes.a!.bounds!, b = model.nodes.b!.bounds!;
    expect(b.y).toBe(a.y);
    expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(Math.max(nodeGap(model, 'a', 'b'), rowGap(model, 'a', 'b')) - 1e-9);
    const box = model.groups.g!.bounds!;
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
    expect(box.height).toBe(a.height + 2 * GROUP_PADDING);
    expect(model.tierBands[0]!.bounds).toEqual(box);
    expect(anchorOf(model, 'b', 0)).toEqual({ x: b.x, y: anchorOf(model, 'a', 0).y });
    expect(model.links[0]!.path?.segments).toEqual([{ from: anchorOf(model, 'a', 0), to: anchorOf(model, 'b', 0), owner: { kind: 'link', id: 'link-1' } }]);
  });
  it('pushes a displaced row group rightwards but never a flank', async () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 0}, f: {align: right, of: h}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
  c: {group: h}
  d: {group: f}
links: [[a.p, b.q]]`;
    const base = await placed(yaml);
    const shiftGroup = (draft: LayoutModel, id: string, x: number) => {
      const dx = x - draft.groups[id]!.bounds!.x;
      draft.groups[id]!.bounds!.x = x;
      for (const n of draft.groups[id]!.nodes) moveNode(draft, n, dx, 0);
    };
    // Stack g's nodes so g narrows, then park h right beside the narrow g; f keeps its original place.
    const stack = (draft: LayoutModel) => {
      const a = draft.nodes.a!.bounds!, b = draft.nodes.b!.bounds!;
      moveNode(draft, 'b', a.x - b.x, a.y + a.height + 40 - b.y);
      draft.groups.g!.rowOrder = ['a', 'b'];
      fitGroup(draft, 'g');
      shiftGroup(draft, 'h', draft.groups.g!.bounds!.x + draft.groups.g!.bounds!.width + 60);
    };
    const parked = stageInput(base, stack);
    expect(parked.groups.h!.bounds!.x).toBeLessThan(base.groups.h!.bounds!.x);
    const model = rows(parked);
    expect(model.groups.h!.bounds!.x).toBe(base.groups.h!.bounds!.x);
    expect(model.groups.f!.bounds).toEqual(base.groups.f!.bounds);
    const flank = model.groups.f!.bounds!, h = model.groups.h!.bounds!;
    expect(h.x + h.width).toBeLessThanOrEqual(flank.x);
    const tight = stageInput(base, draft => {
      stack(draft);
      shiftGroup(draft, 'f', draft.groups.h!.bounds!.x + draft.groups.h!.bounds!.width + 60);
    });
    expect(() => rows(tight)).toThrow(/flank/);
  });
  it('reports a collision with a bar group instead of pushing it', async () => {
    const base = await placed(`portograph: 2
groups: {g: {tier: 0}, h: {tier: 0, shape: bar}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  b: {group: g, ports: [{name: q, side: left}]}
  c: {group: h}
links: [[a.p, b.q]]`);
    const parked = stageInput(base, draft => {
      const a = draft.nodes.a!.bounds!, b = draft.nodes.b!.bounds!;
      moveNode(draft, 'b', a.x - b.x, a.y + a.height + 40 - b.y);
      draft.groups.g!.rowOrder = ['a', 'b'];
      fitGroup(draft, 'g');
      const dx = draft.groups.g!.bounds!.x + draft.groups.g!.bounds!.width + 60 - draft.groups.h!.bounds!.x;
      draft.groups.h!.bounds!.x += dx; moveNode(draft, 'c', dx, 0);
    });
    expect(() => rows(parked)).toThrow(/non-row group h/);
  });
  it('rejects a flank box the generic rebuild would have to grow instead of resizing it', async () => {
    const input = stageInput(await placed(`portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  c: {group: g, ports: [{name: q, side: left}]}
  b: {group: f}
links: [[a.p, c.q]]`), draft => {
      const a = draft.nodes.a!.bounds!, c = draft.nodes.c!.bounds!;
      moveNode(draft, 'c', a.x - c.x, a.y + a.height + 40 - c.y);
      draft.groups.g!.rowOrder = ['a', 'c'];
      fitGroup(draft, 'g');
      // A valid stage-5 input whose flank box has no padding: rows must not silently grow it.
      draft.groups.f!.bounds = { ...draft.nodes.b!.bounds! };
    });
    expect(() => rows(input)).toThrow(/flank/);
  });
});

describe('corridor predicate', () => {
  const owner = { kind: 'link', id: 'link-1' } as const;
  const setup = async () => {
    const model = copy(rows(await placed(pairYaml)));
    const segment = model.links[0]!.path!.segments[0]!;
    return { model, segment, x: (segment.from.x + segment.to.x) / 2, y: segment.from.y };
  };
  const probe = (model: LayoutModel, edit: (m: LayoutModel) => void) => { const m = copy(model); edit(m); return m; };
  it('rejects every kind of foreign geometry inside the gate clearance and ignores owned reservations', async () => {
    const { model, segment, x, y } = await setup();
    const foreign = { kind: 'link', id: 'other' } as const;
    const box = { x: x - 5, y: y - 5, width: 10, height: 10 };
    const blockers: [string, (m: LayoutModel) => void][] = [
      ['foreign node', m => { m.nodes.z = { id: 'z', owner: { kind: 'group', id: 'g' }, layer: 'routed', ports: [], bounds: { x: x - 5, y: y + 11.4, width: 10, height: 20 } }; }],
      ['foreign pill', m => { m.nodes.z = { id: 'z', owner: { kind: 'group', id: 'g' }, layer: 'routed', bounds: { x, y: y + 200, width: 10, height: 10 },
        ports: [{ ref: { node: 'z', name: 'p', ordinal: 1 }, owner: { kind: 'node', id: 'z' }, layer: 'routed', pill: { owner: { kind: 'node', id: 'z' }, layer: 'routed', size: { width: 24, height: 10 }, bounds: box, textRotation: 0, radius: 2 } }] }; }],
      ['label', m => { m.labels.push({ id: 'x', owner: { kind: 'group', id: 'g' }, layer: 'routed', text: 't', role: 'group', bounds: box }); }],
      ['lane', m => { m.lanes.push({ id: 'lane', owner: foreign, layer: 'routed', group: 'g', tier: 0, side: 'left', x, bounds: { x: x - 17, y: y - 50, width: 34, height: 100 } }); }],
      ['fixed segment', m => { m.links.push({ ...m.links[0]!, id: 'other', owner: foreign, path: { owner: foreign, layer: 'routed', fixed: true, segments: [{ from: { x, y: y + 11 }, to: { x: x + 1, y: y + 11 }, owner: foreign }] } }); }],
      ['bundle envelope', m => { m.bundles.push({ id: 'bundle-x', owner: { kind: 'bundle', id: 'bundle-x' }, layer: 'routed', nodes: ['a', 'b'], members: [], envelope: box }); }],
      ['bundle rows', m => { m.bundles.push({ id: 'bundle-x', owner: { kind: 'bundle', id: 'bundle-x' }, layer: 'routed', nodes: ['a', 'b'], members: [], rows: box }); }],
      ['obstacle', m => { m.obstacles.push({ id: 'ob', owner: { kind: 'group', id: 'g' }, layer: 'routed', bounds: box }); }],
    ];
    const emptyBand = probe(model, m => { m.labelBands.push({ id: 'band', owner: { kind: 'group', id: 'g' },
      layer: 'routed', group: 'g', side: 'top', bounds: box, clearance: 12 }); });
    expect(straightCorridorClear(emptyBand, emptyBand.links[0]!, segment)).toBe(true);
    for (const [name, edit] of blockers) {
      const blocked = probe(model, edit);
      expect(straightCorridorClear(blocked, blocked.links[0]!, segment), name).toBe(false);
      expect(expectedRowPath(blocked, blocked.links[0]!), name).toBeUndefined();
    }
    const owned = probe(model, m => {
      m.lanes.push({ id: 'lane', owner, layer: 'routed', group: 'g', tier: 0, side: 'left', x, bounds: { x: x - 17, y: y - 50, width: 34, height: 100 } });
      m.obstacles.push({ id: 'ob', owner, layer: 'routed', bounds: box });
      m.nodes.z = { id: 'z', owner: { kind: 'group', id: 'g' }, layer: 'routed', ports: [], bounds: { x: x - 5, y: y + 11.5, width: 10, height: 20 } };
    });
    expect(straightCorridorClear(owned, owned.links[0]!, segment)).toBe(true);
    expect(expectedRowPath(owned, owned.links[0]!)).toEqual(model.links[0]!.path);
  });
  it('applies the 15 px stem and the 2 × dimension length limits at their boundaries', async () => {
    const { model } = await setup();
    const withGap = (gap: number) => probe(model, m => {
      const a = m.nodes.a!.bounds!, b = m.nodes.b!;
      moveNode(m, 'b', a.x + a.width + gap - b.bounds!.x, 0);
      rebuildNodeGeometry(m, ['b'], 'current');
    });
    const limit = 2 * Math.max(model.nodes.a!.bounds!.width, model.nodes.a!.bounds!.height, model.nodes.b!.bounds!.width, model.nodes.b!.bounds!.height);
    // A pair inside one frame that the level rule declines takes the frame rule's chord instead (ticket 34),
    // which is a declared straight segment between the two faces; the level rule's own path is not it.
    const level = (gap: number) => { const m = withGap(gap), path = expectedRowPath(m, m.links[0]!); return path?.segments[0]?.straight === true ? undefined : path; };
    expect(level(14.9)).toBeUndefined();
    expect(level(15)?.segments).toHaveLength(1);
    expect(level(limit - 0.5)?.segments).toHaveLength(1);
    expect(level(limit)).toBeUndefined();
  });
  it('keeps an authored straight route and excludes group-link members', async () => {
    const pinned = rows(await placed(pairYaml.replace('[a.p, b.q]', '[a.p, b.q, {route: straight}]')));
    expect(pinned.links[0]!.technique).toBe('straight');
    expect(pinned.links[0]!.path!.segments).toHaveLength(1);
    const unpinned = rows(await placed(tallYaml.replace('[a.p, b.q]', '[a.p, b.q, {route: straight}]')));
    expect(unpinned.links[0]!.technique).toBe('straight');
    // The level rule declines it (unequal heights); the frame rule draws the chord between the two faces (ticket 34).
    expect(unpinned.links[0]!.path!.segments).toHaveLength(1);
    expect(unpinned.links[0]!.path!.segments[0]!.straight).toBe(true);
    const grouped = rows(await placed(`portograph: 2
groups: {g: {tier: 0}, h: {tier: 0}}
nodes: {a: {group: g}, b: {group: g}, c: {group: h}, d: {group: h}}
links: [{from: {group: g}, to: {group: h}, route: group-link}]`));
    expect(grouped.links.length).toBe(4);
    for (const link of grouped.links) {
      expect(link.groupLink).toBeDefined();
      expect(rowPathCandidate(grouped, link)).toBe(false);
      expect(link.path).toBeUndefined();
      expect(link.technique).toBe('orthogonal');
    }
    // An inferred complete bipartite group-link has no authored route; only the membership guard excludes it.
    const inferred = rows(await placed(`portograph: 2
groups: {g: {tier: 0}, h: {tier: 0}}
nodes: {a: {group: g}, b: {group: g}, c: {group: h}, d: {group: h}}
links: [{from: {group: g}, to: {group: h}}]`));
    expect(inferred.links.length).toBe(4);
    for (const [index, link] of inferred.links.entries()) {
      expect(inferred.document.links[link.sourceIndex]!.route).toBeUndefined();
      expect(link.groupLink).toBeDefined();
      expect(rowPathCandidate(inferred, link)).toBe(false);
      expect(link.path).toBeUndefined();
      const stripped = copy(inferred); delete stripped.links[index]!.groupLink;
      expect(rowPathCandidate(stripped, stripped.links[index]!)).toBe(true);
    }
  });
});

describe('levelling and straight eligibility', () => {
  it('pins an unobstructed level pair as one source-to-target segment and records the technique', async () => {
    const model = rows(await placed(pairYaml));
    const { link, from, to } = endpoints(model, 'link-1');
    expect(link.technique).toBe('straight');
    expect(link.path).toEqual({ owner: { kind: 'link', id: 'link-1' }, layer: 'routed', fixed: true,
      segments: [{ from: from.anchor, to: to.anchor, owner: { kind: 'link', id: 'link-1' } }] });
    expect(from.anchor!.y).toBe(to.anchor!.y);
    const later = advance(model, ['lanes', 'flanks', 'centre', 'bars', 'bundles', 'bands']);
    const after = endpoints(later, 'link-1');
    expect(later.links[0]!.path).toEqual({ owner: { kind: 'link', id: 'link-1' }, layer: 'routed', fixed: true,
      segments: [{ from: after.from.anchor, to: after.to.anchor, owner: { kind: 'link', id: 'link-1' } }] });
    expect(after.from.anchor!.y - from.anchor!.y).toBe(23); // Verdana metrics (snack-theme ticket 157): 22 with Arial.
    expect(restoreLayoutModel(serializeLayoutModel(later)).links[0]!.path).toEqual(later.links[0]!.path);
  });
  it('orients a pinned path from the authored source even when it runs right to left', async () => {
    const model = rows(await placed(pairYaml.replace('links: [[a.p, b.q]]', 'links: [[b.q, a.p]]')));
    const { link, from, to } = endpoints(model, 'link-1');
    expect(from.ref.node).toBe('b');
    expect(link.path!.segments[0]!.from).toEqual(from.anchor);
    expect(link.path!.segments[0]!.to).toEqual(to.anchor);
    expect(link.path!.segments[0]!.from.x).toBeGreaterThan(link.path!.segments[0]!.to.x);
  });
  it('leaves a blocked corridor unpinned and orthogonal', async () => {
    const yaml = `portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}]}
  between: {group: g}
  c: {group: g, ports: [{name: q, side: left}]}
links: [[a.p, c.q]]`;
    const blocked = stageInput(await placed(yaml), draft => {
      const a = draft.nodes.a!.bounds!;
      let x = a.x + a.width;
      for (const id of ['between', 'c']) {
        x += 40;
        const node = draft.nodes[id]!;
        moveNode(draft, id, x - node.bounds!.x, a.y - node.bounds!.y);
        x += node.bounds!.width;
      }
      draft.groups.g!.rowOrder = ['a', 'between', 'c'];
      fitGroup(draft, 'g');
    });
    const model = rows(blocked);
    const { link, from, to } = endpoints(model, 'link-1');
    expect(from.anchor!.y).toBe(to.anchor!.y);
    expect(link.path).toBeUndefined();
    expect(link.technique).toBe('orthogonal');
    const clear = stageInput(await placed(yaml), draft => {
      const a = draft.nodes.a!.bounds!, c = draft.nodes.c!;
      moveNode(draft, 'c', a.x + a.width + 40 - c.bounds!.x, a.y - c.bounds!.y);
      const between = draft.nodes.between!;
      moveNode(draft, 'between', c.bounds!.x + c.bounds!.width + 40 - between.bounds!.x, a.y - between.bounds!.y);
      draft.groups.g!.rowOrder = ['a', 'c', 'between'];
      fitGroup(draft, 'g');
    });
    expect(rows(clear).links[0]!.path?.segments).toHaveLength(1);
  });
  it('moves the ports of the side with fewer ports and keeps the other side fixed', async () => {
    const model = rows(await placed(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}, {name: r, side: right}]}
  b: {group: g, size: {width: 50, height: 90}, ports: [{name: q, side: left}]}
links: [[a.r, b.q]]`));
    const { link, from, to } = endpoints(model, 'link-1');
    expect(from.ref.name).toBe('r');
    expect(to.anchor!.y).toBe(from.anchor!.y);
    expect(to.anchor!.y).not.toBe(model.nodes.b!.bounds!.y + 45);
    expect(link.path!.segments).toHaveLength(1);
    expect(model.nodes.a!.ports.map(p => p.anchor!.y)).toEqual([model.nodes.a!.bounds!.y + 31, model.nodes.a!.bounds!.y + 17]);
  });
  it('levels the shorter simple fixture inside its padding and pins it', async () => {
    const input = await placed(simple), model = rows(input);
    expect(model.nodes.b!.bounds!.y).toBe(model.nodes.a!.bounds!.y);
    const { from, to } = endpoints(model, 'link-1');
    expect(to.anchor!.y).toBe(from.anchor!.y);
    expect(to.anchor!.y - model.nodes.b!.bounds!.y).toBeGreaterThanOrEqual(16);
    expect(model.links[0]!.path!.segments).toHaveLength(1);
  });
  it('skips an infeasible target instead of leaving the capacity padding', async () => {
    const input = await placed(tallYaml), model = rows(input);
    const offset = (m: LayoutModel) => m.nodes.b!.ports[0]!.anchor!.y - m.nodes.b!.bounds!.y;
    expect(offset(model)).toBe(offset(input));
    expect(model.nodes.a!.ports[0]!.anchor!.y - model.nodes.a!.bounds!.y).toBe(60);
    expect(model.nodes.b!.ports[0]!.anchor!.y).not.toBe(model.nodes.a!.ports[0]!.anchor!.y);
    // Not level, so the level rule declines; inside one frame the chord between the two faces answers (ticket 34).
    expect(model.links[0]!.path!.segments).toHaveLength(1);
    expect(model.links[0]!.path!.segments[0]!.straight).toBe(true);
    expect(model.links[0]!.technique).toBe('straight');
  });
  it('levels both bundle endpoints without creating a member path and keeps an authored route', async () => {
    const model = rows(await placed(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right, order: 1}, {name: r, side: right, order: 2}]}
  b: {group: g, size: {width: 50, height: 90}, ports: [{name: q, side: left, order: 1}, {name: s, side: left, order: 2}]}
links: [[a.p, b.q], [a.r, b.s]]`));
    expect(model.bundles).toHaveLength(1);
    for (const id of ['link-1', 'link-2']) {
      const { link, from, to } = endpoints(model, id);
      expect(from.anchor!.y).toBe(to.anchor!.y);
      expect(link.path).toBeUndefined();
      expect(link.technique).toBe('bundle');
    }
    expect(model.nodes.b!.ports.map(p => p.anchor!.y)).toEqual(model.nodes.a!.ports.map(p => p.anchor!.y));
    const authored = rows(await placed(pairYaml.replace('[a.p, b.q]', '[a.p, b.q, {route: orthogonal}]')));
    expect(authored.links[0]!.path!.segments).toHaveLength(1);
    expect(authored.links[0]!.technique).toBe('orthogonal');
    const overlay = rows(await placed(pairYaml.replace('[a.p, b.q]', '[a.p, b.q, {route: overlay}]')));
    expect(overlay.links[0]!.path).toBeUndefined();
    expect(overlay.links[0]!.technique).toBe('overlay');
  });
  it('levels only one member of an engine-inverted bundle and leaves the reorder to the bundles rule', async () => {
    // Without author keys the skeleton may order the two facing sides inversely; rows cannot reorder ports.
    const model = rows(await placed(`portograph: 2
groups: {g: {tier: 0}}
nodes:
  a: {group: g, ports: [{name: p, side: right}, {name: r, side: right}]}
  b: {group: g, size: {width: 50, height: 90}, ports: [{name: q, side: left}, {name: s, side: left}]}
links: [[a.p, b.q], [a.r, b.s]]`));
    const level = ['link-1', 'link-2'].map(id => endpoints(model, id)).filter(({ from, to }) => from.anchor!.y === to.anchor!.y);
    expect(level.length).toBeGreaterThanOrEqual(1);
    expect(model.links.every(link => link.path === undefined)).toBe(true);
    const ys = model.nodes.b!.ports.map(p => p.anchor!.y).sort((u, v) => u - v);
    expect(ys[1]! - ys[0]!).toBeGreaterThanOrEqual(model.nodes.b!.sidePitch!.left!);
  });
});

describe('row paths inside later transactions', () => {
  it('replaces a pinned path after translation and drops it when eligibility ends', async () => {
    // Centring may move tier 1 here: the anchor tier is unset until ticket 09 and tier 0 holds more nodes anyway.
    const model = advance(rows(await placed(anchoredPairYaml)), ['lanes', 'flanks']);
    const original = model.links[0]!.path!;
    const moved = withLayoutMutation(model, 'centre', draft => { for (const id of ['a', 'b']) moveNode(draft, id, 30, 0); });
    const shifted = moved.links[0]!.path!;
    expect(shifted.segments).toHaveLength(1);
    expect(shifted.segments[0]!.from.x).toBe(original.segments[0]!.from.x + 30);
    expect(shifted.segments[0]!.to).toEqual(anchorOf(moved, 'b', 0));
    expect(moved.links.filter(link => link.path).length).toBe(1);
    const far = withLayoutMutation(model, 'centre', draft => { moveNode(draft, 'b', 300, 0); });
    // Too long for the level rule, the pair takes the frame rule's chord between the two faces (ticket 34).
    expect(far.links[0]!.path!.segments).toHaveLength(1);
    expect(far.links[0]!.path!.segments[0]!.straight).toBe(true);
    expect(far.links[0]!.technique).toBe('straight');
    const back = withLayoutMutation(far, 'bars', () => {});
    expect(back.links[0]!.path!.segments[0]!.straight).toBe(true);
  });
  it('rejects a callback that contradicts or invents a claim and leaves the input unchanged', async () => {
    const model = await placed(anchoredPairYaml), before = serializeLayoutModel(model);
    const owner = { kind: 'link', id: 'link-1' } as const;
    expect(() => withLayoutMutation(model, 'rows', draft => { draft.links[0]!.path = { owner, layer: 'routed', fixed: true, segments: [] }; })).toThrow(/derived by the transaction/);
    const pinned = rows(model);
    expect(() => withLayoutMutation(pinned, 'lanes', draft => { delete draft.links[0]!.path; })).toThrow(/derived by the transaction/);
    expect(() => withLayoutMutation(pinned, 'lanes', draft => { draft.links[0]!.technique = 'orthogonal'; })).toThrow(/derived by the transaction/);
    expect(() => withLayoutMutation(pinned, 'lanes', draft => { draft.links[0]!.path!.segments[0]!.to.y += 1; })).toThrow(/derived by the transaction/);
    expect(serializeLayoutSnapshot(pinned)).toBe(serializeLayoutSnapshot(rows(model)));
    const cross = `portograph: 2
groups: {g: {tier: 0}, h: {tier: 1}}
nodes: {a: {group: g, ports: [p]}, b: {group: h, ports: [q]}}
links: [[a.p, b.q, {route: orthogonal}]]`;
    const tiers = await placed(cross);
    expect(() => withLayoutMutation(tiers, 'rows', draft => {
      draft.links[0]!.path = { owner, layer: 'routed', fixed: true, segments: [{ from: anchorOf(draft, 'a', 0), to: anchorOf(draft, 'b', 0), owner }] };
    })).toThrow(/not implemented/);
    expect(serializeLayoutModel(model)).toBe(before);
  });
  it('rejects a geometry-selected technique on a link no rule validates', async () => {
    const cross = advance(await placed(`portograph: 2
groups: {g: {tier: 0}, m: {tier: 1}, h: {tier: 2}}
nodes: {a: {group: g, ports: [p]}, mid: {group: m}, b: {group: h, ports: [q]}}
links: [[a.p, b.q]]`), ['rows']);
    // Two tiers apart: no chord rule takes it (Q108 takes consecutive document tiers only).
    // The resolver leaves an automatic routed technique unset; only a rule validator may select one.
    expect(cross.links[0]!.technique).toBeUndefined();
    expect(rowPathCandidate(cross, cross.links[0]!)).toBe(false);
    const forged = copy(cross); forged.links[0]!.technique = 'straight';
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/technique/i);
    expect(() => withLayoutMutation(cross, 'lanes', draft => { draft.links[0]!.technique = 'straight'; })).toThrow(/technique|not implemented/i);
  });
  it('restore rechecks pinned paths against the stored geometry', async () => {
    const pinned = rows(await placed(pairYaml));
    const corrupted = (edit: (m: LayoutModel) => void) => { const m = copy(pinned); edit(m); return JSON.stringify(m); };
    expect(() => restoreLayoutModel(corrupted(m => { delete m.links[0]!.path; }))).toThrow(/Row path/);
    expect(() => restoreLayoutModel(corrupted(m => { m.links[0]!.path!.segments[0]!.from.y += 1; }))).toThrow(/Row path/);
    expect(() => restoreLayoutModel(corrupted(m => { m.links[0]!.path!.fixed = false; }))).toThrow(/Row path/);
    expect(() => restoreLayoutModel(corrupted(m => { m.links[0]!.technique = 'orthogonal'; }))).toThrow(/technique/);
    const stale: PathSegment = { ...pinned.links[0]!.path!.segments[0]!, from: { x: 0, y: 0 } };
    expect(() => restoreLayoutModel(corrupted(m => { m.links[0]!.path!.segments.push(stale); }))).toThrow(/Row path/);
    expect(restoreLayoutModel(serializeLayoutModel(pinned)).links[0]!.path).toEqual(pinned.links[0]!.path);
  });
});
