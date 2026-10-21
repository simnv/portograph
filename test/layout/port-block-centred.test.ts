import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { recentreSeatedFaces, seatedFaces } from '../../src/layout/face-centre.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const NAME = 'a-widened-node-keeps-its-overlay-ports-centred-on-the-face';
const EPS = 1e-6;
const run = (): Promise<LayoutModel> =>
  layout(parse(readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('the port block of a face (architecture ticket 10, defect D3)', () => {
  it('stands centred on a face that centring left alone while it widened the body', async () => {
    const model = await run();
    const hub = model.nodes['hub']!, box = hub.bounds!, pitch = hub.sidePitch!.top!;
    // The body was widened for the two bottom ports; the top face holds three overlay ports.
    expect(box.width).toBeGreaterThan(20 + 3 * pitch + 10);
    const top = hub.ports.filter(port => port.side === 'top').map(port => port.anchor!.x).sort((a, b) => a - b);
    expect(top).toHaveLength(3);
    // The pitch is kept, and the room before the first port equals the room after the last.
    expect(Math.abs(top[1]! - top[0]! - pitch)).toBeLessThanOrEqual(EPS);
    expect(Math.abs(top[2]! - top[1]! - pitch)).toBeLessThanOrEqual(EPS);
    expect(Math.abs((top[0]! - box.x) - (box.x + box.width - top[2]!))).toBeLessThanOrEqual(EPS);
  }, 60000);

  it('keeps the ports a rule aligned to a peer where they stand', async () => {
    const model = await run();
    const bottom = model.nodes['hub']!.ports.filter(port => port.side === 'bottom').map(port => port.anchor!.x).sort((a, b) => a - b);
    const feeds = ['h3', 'h4'].map(id => model.nodes[id]!.ports[0]!.anchor!.x).sort((a, b) => a - b);
    expect(bottom).toHaveLength(2);
    bottom.forEach((x, index) => expect(Math.abs(x - feeds[index]!)).toBeLessThanOrEqual(EPS));
  }, 60000);
});

describe('recentreSeatedFaces skips a face held on purpose', () => {
  // A model reduced to what the rule reads: nodes of two top ports each, centred on a 56 px body, then widened to 156 px.
  const build = (): LayoutModel => {
    const node = (id: string, x: number) => ({ id, bounds: { x, y: 0, width: 56, height: 35 },
      ports: [x + 22, x + 34].map((px, i) => ({ side: 'top', ref: { node: id, name: `p${i}`, ordinal: 0 }, anchor: { x: px, y: 0 } })) });
    const nodes = Object.fromEntries([node('peered', 0), node('laned', 300), node('free', 600), node('peer', 1000)].map(n => [n.id, n]));
    return {
      nodes,
      document: { nodes: { peered: { group: 'g' }, laned: { group: 'g' }, free: { group: 'g' }, peer: { group: 'g' } }, groups: { g: {} } },
      links: [
        { id: 'a', attachments: { from: nodes['peered']!.ports[0]!.ref, to: nodes['peer']!.ports[0]!.ref } },
        { id: 'b', attachments: { from: nodes['laned']!.ports[0]!.ref, to: nodes['peer']!.ports[1]!.ref } },
      ],
      lanes: [{ owner: { kind: 'link', id: 'b' }, x: 322.2 }],
    } as unknown as LayoutModel;
  };
  it('moves a free face, and keeps a face with a peer-aligned port and a face with a lane-aligned port', () => {
    const model = build();
    // The peer of link a stands within 0.5 px of the first port of `peered`; the lane of link b within 0.5 px of the first port of `laned`.
    const seated = seatedFaces(model);
    expect(seated).toHaveLength(4);
    model.nodes['peer']!.ports[0]!.anchor!.x = 22.3;
    for (const id of ['peered', 'laned', 'free']) model.nodes[id]!.bounds!.width = 156;
    const before = Object.fromEntries(['peered', 'laned', 'free'].map(id => [id, model.nodes[id]!.ports.map(p => p.anchor!.x)]));
    recentreSeatedFaces(model, seated);
    const after = (id: string): number[] => model.nodes[id]!.ports.map(p => p.anchor!.x);
    expect(after('peered')).toEqual(before['peered']);
    expect(after('laned')).toEqual(before['laned']);
    // A port that centring owes a feed x (a child port, or the parent port whose x is the feed; the 100-node fan of bundle-scale.test.ts) pins its face.
    const again = build();
    const seatedAgain = seatedFaces(again);
    again.nodes['free']!.bounds!.width = 156;
    const kept = again.nodes['free']!.ports.map(p => p.anchor!.x);
    recentreSeatedFaces(again, seatedAgain, new Set([portId(again.nodes['free']!.ports[1]!.ref)]));
    expect(again.nodes['free']!.ports.map(p => p.anchor!.x)).toEqual(kept);
    const free = after('free');
    expect(Math.abs((free[0]! - 600) - (756 - free[1]!))).toBeLessThanOrEqual(EPS);
  });
});
