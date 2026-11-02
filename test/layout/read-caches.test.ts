import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/model/layout.js';
import { groupConsumers } from '../../src/score/model.js';
import { riserPenetrations } from '../../src/layout/lanes.js';
import { groupPadding } from '../../src/layout/regions.js';
import { checkReadCaches } from '../../src/model/read-cache.js';

// Architecture-2 ticket 60: a read cache is keyed by the identity of what it reads. A new array of the same length and other content
// (the length trap of the perf review) must give the new answer, and an in-place write under the check must throw.
const ref = (node: string, name: string) => ({ node, name, ordinal: 1 });
const link = (id: string, from: string, to: string) => ({ id, layer: 'routed', technique: 'orthogonal', attachments: { from: ref(from, 'p'), to: ref(to, 'p') } });

function consumerModel(): LayoutModel {
  return {
    document: { frames: {} },
    groups: { g: { id: 'g', nodes: ['a'] }, h: { id: 'h', nodes: ['c'] } },
    links: [link('l1', 'a', 'b')],
    lanes: [{ id: 'lane', group: 'g', kind: 'transit', owner: { kind: 'link', id: 'l9' } }],
    barDrops: [{ link: 'd1', barCross: ['a'] }],
    bundles: [],
  } as unknown as LayoutModel;
}

describe('groupConsumers', () => {
  it('reads a new links, lanes or bar-drops array of the same length again', () => {
    const model = consumerModel();
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1', 'l9']);
    model.links = [link('l2', 'x', 'y')] as unknown as LayoutModel['links'];
    expect(groupConsumers(model, 'g')).toEqual(['d1', 'l9']);
    model.lanes = [{ id: 'lane', group: 'h', kind: 'transit', owner: { kind: 'link', id: 'l9' } }] as unknown as LayoutModel['lanes'];
    expect(groupConsumers(model, 'g')).toEqual(['d1']);
    model.barDrops = [{ link: 'd2', barCross: ['z'] }] as unknown as LayoutModel['barDrops'];
    expect(groupConsumers(model, 'g')).toEqual([]);
  });

  it('reads a replaced group object again, and returns a frozen answer', () => {
    const model = consumerModel();
    const first = groupConsumers(model, 'g');
    expect(Object.isFrozen(first)).toBe(true);
    expect(groupConsumers(model, 'g')).toBe(first);
    model.groups.g = { ...model.groups.g!, nodes: ['c'] };
    expect(groupConsumers(model, 'g')).toEqual(['l9']);
  });

  it('throws under the check when a keyed array is written in place', async () => {
    const model = consumerModel();
    groupConsumers(model, 'g');
    model.links[0]!.attachments!.from = ref('x', 'p');
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1', 'l9']); // stale without the check: the reason the check exists
    await expect(checkReadCaches(async () => groupConsumers(model, 'g'))).rejects.toThrow(/Stale read cache groupConsumers on model [0-9a-f]{8}: item 0/);
  });
});

describe('facingRoutedPorts', () => {
  const model = (): LayoutModel => ({
    document: { frames: {} },
    meshBuses: [{ id: 'u', row: 1, riser: { x: 100 }, cross: ['x'] }],
    groups: { g: { id: 'g', tier: 1, nodes: ['a'] } },
    nodes: { a: { ports: [{ ref: ref('a', 'p'), side: 'bottom', anchor: { x: 100, y: 0 } }, { ref: ref('a', 'q'), side: 'bottom', anchor: { x: 400, y: 0 } }] } },
    links: [link('l1', 'a', 'b')],
  } as unknown as LayoutModel);

  it('reads a new links array of the same length again', () => {
    const sheet = model();
    expect([...riserPenetrations(sheet, sheet.groups.g!).keys()]).toEqual(['a:1']);
    sheet.links = [{ ...link('l1', 'a', 'b'), attachments: { from: ref('a', 'q'), to: ref('b', 'p') } }] as unknown as LayoutModel['links'];
    expect([...riserPenetrations(sheet, sheet.groups.g!).keys()]).toEqual([]);
  });

  it('throws under the check when a link is written in place', async () => {
    const sheet = model();
    riserPenetrations(sheet, sheet.groups.g!);
    sheet.links[0]!.technique = 'stub';
    await expect(checkReadCaches(async () => riserPenetrations(sheet, sheet.groups.g!))).rejects.toThrow(/Stale read cache facingRoutedPorts/);
  });
});

describe('cellPadding', () => {
  const model = (cells: string[]): LayoutModel => ({
    document: { frames: { f: { label: 'f', cells } } },
    groups: {
      c1: { id: 'c1', frame: 'f', tier: 1, nodes: [] },
      c2: { id: 'c2', frame: 'f', tier: 2, nodes: [] },
      c3: { id: 'c3', frame: 'f', tier: 1, nodes: [] },
    },
    nodes: {}, links: [], lanes: [], labelBands: [],
  } as unknown as LayoutModel);

  it('reads a new document with a frame of the same cell count again', () => {
    const sheet = model(['c1', 'c2']);
    expect(groupPadding(sheet, sheet.groups.c1!).bottom).toBe(0);
    sheet.document = model(['c1', 'c3']).document;
    expect(groupPadding(sheet, sheet.groups.c1!).bottom).toBeGreaterThan(0);
  });

  it('throws under the check when a cell group tier is written in place', async () => {
    const sheet = model(['c1', 'c2']);
    groupPadding(sheet, sheet.groups.c1!);
    sheet.groups.c2!.tier = 1;
    await expect(checkReadCaches(async () => groupPadding(sheet, sheet.groups.c1!))).rejects.toThrow(/Stale read cache cellPadding/);
  });
});

describe('the keys beyond array identity', () => {
  it('groupConsumers reads an array appended in place again (the length key)', () => {
    const model = consumerModel();
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1', 'l9']);
    model.barDrops.push({ link: 'd3', barCross: ['a'] } as unknown as LayoutModel['barDrops'][number]);
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1', 'd3', 'l9']);
    model.links.push(link('l4', 'x', 'a') as unknown as LayoutModel['links'][number]);
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'l4', 'd1', 'd3', 'l9']);
  });

  it('groupConsumers reads a new document or bundles array again', () => {
    const model = consumerModel();
    model.lanes = [{ id: 'lane', group: 'g', kind: 'transit', owner: { kind: 'bundle', id: 'b' } }] as unknown as LayoutModel['lanes'];
    model.bundles = [{ id: 'b', members: ['m1'] }] as unknown as LayoutModel['bundles'];
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1', 'm1']);
    model.bundles = [{ id: 'b', members: ['m2'] }] as unknown as LayoutModel['bundles'];
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1', 'm2']);
    // As a frame of one cell, `g` keeps only the lane links that end in it: m2 does not.
    model.document = { frames: { g: { label: 'g', cells: ['g'] } } } as unknown as LayoutModel['document'];
    expect(groupConsumers(model, 'g')).toEqual(['l1', 'd1']);
  });

  it('facingRoutedPorts reads a links array appended in place again', () => {
    const sheet = {
      document: { frames: {} },
      meshBuses: [{ id: 'u', row: 1, riser: { x: 100 }, cross: ['x'] }],
      groups: { g: { id: 'g', tier: 1, nodes: ['a'] } },
      nodes: { a: { ports: [{ ref: ref('a', 'p'), side: 'bottom', anchor: { x: 100, y: 0 } }] } },
      links: [link('l1', 'x', 'y')],
    } as unknown as LayoutModel;
    expect([...riserPenetrations(sheet, sheet.groups.g!).keys()]).toEqual([]);
    sheet.links.push(link('l2', 'a', 'b') as unknown as LayoutModel['links'][number]);
    expect([...riserPenetrations(sheet, sheet.groups.g!).keys()]).toEqual(['a:1']);
  });

  it('cellPadding does not store the span of a frame with a missing cell group', () => {
    const sheet = {
      document: { frames: { f: { label: 'f', cells: ['c1', 'gone'] } } },
      groups: { c1: { id: 'c1', frame: 'f', tier: 1, nodes: [] }, c2: { id: 'c2', frame: 'f', tier: 2, nodes: [] } },
      nodes: {}, links: [], lanes: [], labelBands: [],
    } as unknown as LayoutModel;
    // The missing cell reads the asking group's tier: asked by c2 the frame spans 1..2, asked by c1 it spans 1..1. A stored 1..2 would
    // leave c1 without its bottom margin.
    expect(groupPadding(sheet, sheet.groups.c2!).top).toBe(0);
    expect(groupPadding(sheet, sheet.groups.c2!).bottom).toBeGreaterThan(0);
    expect(groupPadding(sheet, sheet.groups.c1!).bottom).toBeGreaterThan(0);
  });
});
