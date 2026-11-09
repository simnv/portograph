import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (name: string): Promise<LayoutModel> =>
  layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const portX = (model: LayoutModel, node: string, name: string): number => model.nodes[node]!.ports.find(port => port.ref.name === name)!.anchor!.x;
const remainders = (model: LayoutModel): string[] => model.diagnostics.filter(d => d.code === 'CENTRE_FAN_REMAINDER').map(d => d.message.split(' ')[0]!);

describe('a port with two parents has one seat (architecture ticket 12)', () => {
  it('does not widen a node for the feed beyond its bundle', async () => {
    const model = await run('a-bundle-port-with-a-link-beyond-the-bundle-follows-the-bundle');
    const r = model.nodes['r']!;
    // The three ports need 72.5 px (the ticket 08 control); main stood at 569 px.
    expect(Math.abs(r.bounds!.width - 72.5)).toBeLessThanOrEqual(1);
    expect(model.diagnostics.some(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toBe(false);
    expect(remainders(model)).toContain('link-1');
  }, 60000);

  it('keeps the width of a lone port fed by two parents and seats it under the first feed', async () => {
    const model = await run('a-port-with-two-parents-keeps-its-first-feed-and-its-width');
    const r = model.nodes['r']!;
    expect(r.bounds!.width).toBeLessThanOrEqual(72.5 + 1);
    expect(Math.abs(portX(model, 'r', 'p1') - model.nodes['a']!.ports.find(port => port.side === 'bottom')!.anchor!.x)).toBeLessThanOrEqual(0.5);
    expect(remainders(model)).toContain('link-2');
  }, 60000);

  it('seats under the bundle when the outside link is listed first', async () => {
    const model = await run('a-bundle-port-with-a-link-listed-first-follows-the-bundle');
    expect(Math.abs(model.nodes['r']!.bounds!.width - 72.5)).toBeLessThanOrEqual(1);
    expect(remainders(model)).toContain('link-1');
    expect(remainders(model)).not.toContain('link-4');
  }, 60000);
});
