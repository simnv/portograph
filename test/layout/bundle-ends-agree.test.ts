import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture 2, ticket 08: the two ends of a bundle take one order, and centring does not grow a box that it cannot align. */
const run = async (name: string) => {
  const text = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
  return layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
};
const CONTROL = 72.5;
const quiet = (codes: string[]): void => {
  expect(codes).not.toContain('CENTRE_ALIGNMENT_INFEASIBLE');
  expect(codes).not.toContain('PLACEMENT_NON_CONVERGENCE');
};

it.each([
  ['a-bundle-of-three-ports-agrees-at-both-ends', 'r1'],
  ['a-bundle-of-named-ports-agrees-at-both-ends', 'r'],
])('%s: the child stays at the control width and centring is quiet', async (name, child) => {
  const model = await run(name);
  expect(model.nodes[child]!.bounds!.width).toBeCloseTo(CONTROL, 0);
  quiet(model.diagnostics.map(item => item.code));
}, 60000);

it('a bundle of four ports stays narrow, inside the canvas, and centring is quiet', async () => {
  const model = await run('a-bundle-of-four-ports-agrees-at-both-ends');
  const box = model.nodes.r1!.bounds!;
  expect(box.width).toBeLessThan(100);
  expect(box.x).toBeGreaterThanOrEqual(0);
  quiet(model.diagnostics.map(item => item.code));
}, 60000);

it('both ends of a bundle list its links in one order', async () => {
  const model = await run('a-bundle-of-three-ports-agrees-at-both-ends');
  const order = (node: string): string[] => model.nodes[node]!.ports.filter(port => port.side !== undefined)
    .sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => `${port.ref.ordinal}`);
  expect(order('r1')).toEqual(order('edge'));
}, 60000);

it.each([
  ['an-authored-order-on-the-first-node-leads-the-bundle', 'r'],
  ['an-authored-order-on-the-second-node-leads-the-bundle', 'r'],
])('%s: the child stays narrow, inside the canvas, and centring is quiet', async (name, child) => {
  const model = await run(name);
  const box = model.nodes[child]!.bounds!;
  expect(box.width).toBeLessThan(100);
  expect(box.x).toBeGreaterThanOrEqual(0);
  quiet(model.diagnostics.map(item => item.code));
}, 60000);

it('a bundle port with a link beyond the bundle is ordered with the bundle at both ends', async () => {
  const model = await run('a-bundle-port-with-a-link-beyond-the-bundle-follows-the-bundle');
  const order = (node: string): string[] => model.nodes[node]!.ports.filter(port => port.side === 'top' || port.side === 'bottom')
    .sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.ref.name ?? `${port.ref.ordinal}`);
  // Link wN joins r.pN and e#N, so the same order of N at both ends is agreement.
  expect(order('r')).toEqual(['p2', 'p1', 'p3']);
  expect(model.nodes.e!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.ref.ordinal)).toEqual([2, 1, 3]);
}, 60000);
