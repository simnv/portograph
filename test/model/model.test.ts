import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createLayoutModel,
  orderedGroupIds,
  orderedNodeIds,
  serializeLayoutModel,
  serializeLayoutSnapshot,
  type LayoutModel,
  type NormalisedDocument,
} from '../../src/model';

const document: NormalisedDocument = {
  portograph: 2,
  profile: 'network',
  groups: {
    upper: { tier: 0, label: 'Upper', shape: 'row' },
    lower: { tier: 1, label: 'Lower', shape: 'bar' },
    flank: { align: 'left', of: 'upper', label: '', shape: 'row' },
  },
  nodes: {
    a: {
      group: 'upper', label: 'A', size: { width: 80, height: 45 },
      ports: [{ name: '100G', ordinal: 1, side: 'bottom', order: 2 }],
    },
    b: { group: 'lower', label: 'B', ports: [{ anonymous: true, ordinal: 1 }] },
  },
  links: [
    { from: { node: 'a', name: '100G', ordinal: 1 }, to: { node: 'b', anonymous: true, ordinal: 1 } },
    { from: { group: 'upper' }, to: { group: 'lower' }, route: 'group-link' },
  ],
};

function handBuiltModel(): LayoutModel {
  const model = createLayoutModel(document);
  model.stage = 'bands';
  model.canvas = { x: 0, y: 0, width: 300, height: 250 };
  model.nodes.a!.bounds = { x: 20, y: 5, width: 80, height: 45 };
  model.nodes.a!.ports[0]!.anchor = { x: 60, y: 50 };
  model.nodes.a!.ports[0]!.pill = {
    owner: { kind: 'node', id: 'a' }, layer: 'routed',
    size: { width: 24, height: 10 }, bounds: { x: 55, y: 38, width: 10, height: 24 },
    textRotation: -90, radius: 2,
  };
  model.links[0]!.attachments = {
    from: { node: 'a', name: '100G', ordinal: 1 },
    to: { node: 'b', anonymous: true, ordinal: 1 },
  };
  model.links.push({
    id: 'expanded-1', sourceIndex: 1, owner: { kind: 'link', id: 'expanded-1' },
    from: { node: 'a', name: '100G', ordinal: 1 }, to: { node: 'b', anonymous: true, ordinal: 1 },
    family: 'routed', layer: 'routed', bundle: 'bundle-1',
  });
  model.tierBands = [{ tier: 0, groups: ['upper'], bounds: { x: 0, y: 0, width: 200, height: 90 } }];
  model.labels.push({
    id: 'a-label', owner: { kind: 'node', id: 'a' }, layer: 'routed',
    text: 'A', bounds: { x: 20, y: 10, width: 8, height: 12 },
    role: 'node', fontFamily: 'Verdana', fontSize: 12, fontWeight: 700,
    lineHeight: 14, lines: ['A'], textRotation: 0,
  });
  model.labels.push({
    id: 'link-label', owner: { kind: 'link', id: 'link-1' }, layer: 'overlay',
    text: 'Full label', tooltip: 'Full label', omitted: true,
  });
  model.lanes.push({
    id: 'lane-1', owner: { kind: 'link', id: 'link-1' }, layer: 'routed',
    group: 'upper', tier: 0, side: 'right', x: 210,
    bounds: { x: 193, y: 0, width: 34, height: 150 },
  });
  model.bundles.push({
    id: 'bundle-1', owner: { kind: 'bundle', id: 'bundle-1' }, layer: 'routed',
    nodes: ['a', 'b'], members: ['link-1', 'expanded-1'], memberGap: 16,
    envelope: { x: 60, y: 50, width: 32, height: 100 }, inversions: 1,
  });
  model.junctions.push({
    id: 'stem-1', owner: { kind: 'shared-stem', id: 'stem-1' }, layer: 'routed',
    port: { node: 'a', name: '100G', ordinal: 1 }, links: ['link-1', 'expanded-1'],
    point: { x: 60, y: 65 },
    stem: { from: { x: 60, y: 50 }, to: { x: 60, y: 65 }, owner: { kind: 'shared-stem', id: 'stem-1' } },
  });
  model.links[0]!.path = {
    owner: { kind: 'link', id: 'link-1' }, layer: 'routed', fixed: true,
    segments: [
      { from: { x: 60, y: 50 }, to: { x: 60, y: 65 }, owner: { kind: 'shared-stem', id: 'stem-1' } },
      { from: { x: 60, y: 65 }, to: { x: 60, y: 150 }, owner: { kind: 'bundle', id: 'bundle-1' }, barCross: ['bar-upper'] },
    ],
  };
  model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'bundle-inversions', message: 'One author-order inversion.', owners: [{ kind: 'bundle', id: 'bundle-1' }] });
  model.runtime = { totalMs: 42, stages: [{ stage: 'skeleton', durationMs: 30 }] };
  return model;
}

describe('layout model', () => {
  it('wraps a document without inventing geometry or resolved techniques', () => {
    const model = createLayoutModel(document);
    expect(model.document).toEqual(document);
    expect(model.stage).toBe('normalised');
    expect(model.nodes.a).toMatchObject({ owner: { kind: 'group', id: 'upper' }, layer: 'routed', sizeFloor: { width: 80, height: 45 } });
    expect(model.nodes.a?.ports[0]).toEqual({ ref: { node: 'a', name: '100G', ordinal: 1 }, owner: { kind: 'node', id: 'a' }, layer: 'routed', side: 'bottom', authorOrder: 2 });
    expect(model.nodes.b?.ports[0]?.ref).toEqual({ node: 'b', anonymous: true, ordinal: 1 });
    expect(model.links[1]?.from).toEqual({ group: 'upper' });
    expect(model.links[0]).not.toHaveProperty('path');
    expect(model.links[0]).not.toHaveProperty('family');
    expect(model.nodes.b?.ports[0]).not.toHaveProperty('side');
    expect(model.nodes.a).not.toHaveProperty('bounds');
  });

  it('owns mutable state independently of the input and other instances', () => {
    const first = createLayoutModel(document);
    const second = createLayoutModel(document);
    first.document.nodes.a!.size!.width = 900;
    first.nodes.a!.sizeFloor!.width = 100;
    first.nodes.a!.ports[0]!.ref.ordinal = 5;
    first.links[0]!.from = { node: 'b', anonymous: true, ordinal: 1 };
    first.diagnostics.push({ stage: 'parse', severity: 'info', code: 'test', message: 'Test' });
    expect(document.nodes.a?.size?.width).toBe(80);
    expect(first.document.nodes.a?.ports[0]?.ordinal).toBe(1);
    expect(second.document).toEqual(document);
    expect(second.nodes.a?.sizeFloor?.width).toBe(80);
    expect(second.diagnostics).toEqual([]);
  });

  it('preserves the approved golden document projection and declaration order', () => {
    const expected: NormalisedDocument = JSON.parse(readFileSync(new URL('../../goldens/m1-sip-edge.expected.json', import.meta.url), 'utf8'));
    const model = createLayoutModel(expected);
    expect(JSON.parse(serializeLayoutModel(model)).document).toEqual(expected);
    expect(Object.keys(model.nodes)).toEqual(Object.keys(expected.nodes));
    expect(model.links.map(link => link.sourceIndex)).toEqual(expected.links.map((_, index) => index));
    expect(model.document).not.toHaveProperty('title');
    expect(model.document.nodes['EAC-01']?.ports[0]).not.toHaveProperty('side');
  });

  it('round-trips owned geometry, reservations, ordered segments and diagnostics through JSON', () => {
    const model = handBuiltModel();
    const restored: LayoutModel = JSON.parse(serializeLayoutModel(model));
    expect(restored).toEqual(model);
    expect(restored.links[0]?.path?.segments[1]?.barCross).toEqual(['bar-upper']);
    expect(restored.labels[1]?.layer).toBe('overlay');
    expect(restored.labels[1]?.tooltip).toBe('Full label');
    expect(serializeLayoutModel(restored)).toBe(serializeLayoutModel(model));
  });

  it('omits runtime only from snapshots without mutating the layout model', () => {
    const model = handBuiltModel();
    const snapshot = serializeLayoutSnapshot(model);
    expect(JSON.parse(snapshot)).not.toHaveProperty('runtime');
    expect(JSON.parse(snapshot).diagnostics).toEqual(model.diagnostics);
    expect(JSON.parse(serializeLayoutModel(model)).runtime.totalMs).toBe(42);
    model.runtime.totalMs = 999;
    expect(serializeLayoutSnapshot(model)).toBe(snapshot);
  });

  it('rejects non-finite geometry instead of silently changing it to JSON null', () => {
    const model = handBuiltModel();
    model.canvas!.width = Infinity;
    expect(() => serializeLayoutModel(model)).toThrow(/finite/);
    expect(() => serializeLayoutSnapshot(model)).toThrow(/finite/);
  });

  it('reports an unknown node group instead of creating an unowned layout node', () => {
    const invalid: NormalisedDocument = { ...document, groups: {} };
    expect(() => createLayoutModel(invalid)).toThrow('Node a references missing group upper');
  });

  it('preserves explicit declaration order for integer-like group and node IDs', () => {
    const numeric: NormalisedDocument = {
      portograph: 2, profile: 'network', groupOrder: ['20', '3'], nodeOrder: ['40', '7'],
      groups: {
        '20': { tier: 0, label: 'First', shape: 'row' },
        '3': { tier: 1, label: 'Second', shape: 'row' },
      },
      nodes: {
        '40': { group: '20', label: 'First node', ports: [] },
        '7': { group: '20', label: 'Second node', ports: [] },
      },
      links: [],
    };
    expect(Object.keys(numeric.groups)).toEqual(['3', '20']);
    expect(orderedGroupIds(numeric)).toEqual(['20', '3']);
    expect(orderedNodeIds(numeric)).toEqual(['40', '7']);
    const model = createLayoutModel(numeric);
    expect(model.groups['20']?.nodes).toEqual(['40', '7']);
    expect(model.document).toEqual(numeric);
    expect(JSON.parse(serializeLayoutSnapshot(model)).document.groupOrder).toEqual(['20', '3']);
    expect(JSON.parse(serializeLayoutSnapshot(model)).document.nodeOrder).toEqual(['40', '7']);
    orderedNodeIds(numeric).reverse();
    model.document.groupOrder!.reverse();
    expect(numeric.groupOrder).toEqual(['20', '3']);
    expect(numeric.nodeOrder).toEqual(['40', '7']);
  });

  it('uses map enumeration when order metadata is absent', () => {
    expect(orderedGroupIds(document)).toEqual(['upper', 'lower', 'flank']);
    expect(orderedNodeIds(document)).toEqual(['a', 'b']);
    const model = createLayoutModel(document);
    expect(model.document).not.toHaveProperty('groupOrder');
    expect(model.document).not.toHaveProperty('nodeOrder');
  });

  it.each([
    { groupOrder: ['upper', 'lower'] },
    { groupOrder: ['upper', 'lower', 'upper'] },
    { groupOrder: ['upper', 'lower', 'constructor'] },
    { nodeOrder: ['a'] },
    { nodeOrder: ['a', 'a'] },
    { nodeOrder: ['a', 'constructor'] },
  ])('rejects order metadata that is not a permutation of own IDs: %j', metadata => {
    const invalid = { ...document, ...metadata };
    expect(() => createLayoutModel(invalid)).toThrow(/permutation/);
    if ('groupOrder' in metadata) expect(() => orderedGroupIds(invalid)).toThrow(/permutation/);
    if ('nodeOrder' in metadata) expect(() => orderedNodeIds(invalid)).toThrow(/permutation/);
  });

  it('checks group membership against own keys, including the legal constructor ID', () => {
    const input: NormalisedDocument = {
      portograph: 2, profile: 'network', groups: {},
      nodes: { a: { group: 'constructor', label: 'A', ports: [] } }, links: [],
    };
    expect(() => createLayoutModel(input)).toThrow('Node a references missing group constructor');
    const groupId: string = 'constructor';
    input.groups[groupId] = { tier: 0, label: 'Constructor', shape: 'row' };
    expect(createLayoutModel(input).groups[groupId]?.nodes).toEqual(['a']);
  });
});
