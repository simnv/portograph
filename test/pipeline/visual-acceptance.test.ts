import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

let model: LayoutModel;
beforeAll(async () => {
  model = await layout(parse(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8')), {
    createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
  });
});

it('leaves a visible group gutter beyond the complete flank node and its pills', () => {
  for (const id of ['tbr-left', 'tbr-right']) {
    const group = model.groups[id]!, box = group.bounds!;
    const content = group.nodes.flatMap(id => {
      const node = model.nodes[id]!;
      return [node.bounds!, ...node.ports.flatMap(port => port.pill ? [port.pill.bounds] : [])];
    });
    expect(Math.min(...content.map(b => b.x)) - box.x).toBeGreaterThanOrEqual(10);
    expect(box.x + box.width - Math.max(...content.map(b => b.x + b.width))).toBeGreaterThanOrEqual(10);
    expect(box.y + box.height - Math.max(...content.map(b => b.y + b.height))).toBeGreaterThanOrEqual(10);
  }
});

it('centres the Datacenter label and leaves both aligned provider feeds straight', () => {
  const group = model.groups['datacenter']!.bounds!;
  const label = model.labels.find(label => label.owner.kind === 'group' && label.owner.id === 'datacenter')!.bounds!;
  expect(label.x + label.width / 2).toBeCloseTo(group.x + group.width / 2, 6);
  for (const link of model.links.filter(link => link.attachments!.from.node.startsWith('provider-'))) {
    expect(link.path!.segments.every(segment => segment.from.x === segment.to.x)).toBe(true);
  }
});

it('keeps EBR feeds directly above their Backbone ports without lane approach jogs', () => {
  const feeds = model.links.filter(link => link.attachments!.from.node.startsWith('EBR') && link.attachments!.to.node.startsWith('EBB'));
  expect(feeds).toHaveLength(4);
  for (const link of feeds) {
    expect(link.path!.segments.every(segment => segment.from.x === segment.to.x), link.id).toBe(true);
  }
});

it('fits the Backbone group to its final bars instead of accumulated movement extents', () => {
  const group = model.groups['backbone']!, boxes = group.nodes.map(id => model.nodes[id]!.bounds!);
  const contentWidth = Math.max(...boxes.map(box => box.x + box.width)) - Math.min(...boxes.map(box => box.x));
  expect(group.bounds!.width - contentWidth).toBeLessThanOrEqual(60);
  const result = score(model, { golden: true }).snapshot;
  expect(result.passed).toBe(true);
  expect(result.metrics.crossings.count).toBe(0);
});

it('retains transit port capacity when shaping a bar used as an upward source', async () => {
  const result = await layout(parse(`portograph: 2
groups: {up: {tier: 0}, mid: {tier: 1}, low: {tier: 2, shape: bar}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  m: {group: mid}
  n: {group: mid}
  b: {group: low, ports: [{name: long-port-name, side: top}]}
links: [[b.long-port-name, a.p]]`), {
    createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
  });
  // mid is the anchor tier, so both ends are equidistant and the authored source, the bar, is the
  // end the lane aligns to and reserves capacity on (ticket 19).
  expect(result.anchorTier).toBe(1);
  const bar = result.nodes.b!;
  expect(bar.sidePitch!.top).toBeGreaterThan(40);
  expect(bar.bounds!.width).toBeGreaterThanOrEqual(bar.sidePitch!.top! + 20);
  expect(score(result).snapshot.passed).toBe(true);
  expect(restoreFinalLayout(JSON.stringify(result))).toEqual(result);
});
