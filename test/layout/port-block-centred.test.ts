import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
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
