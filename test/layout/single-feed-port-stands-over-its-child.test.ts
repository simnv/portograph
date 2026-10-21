import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { centreContext, centreViolations } from '../../src/layout/centre.js';
import { seatLaneSources } from '../../src/layout/parent-stand.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 15 (architecture-2): a port with one link stands over the port it feeds. The row repack pushed `leaf-c` right of the corridor of link-6; the
// source port `p11` stood where the corridor was, so the link jogged although the face had room. The fixture also holds the control: `p13` has no room
// for a move of that size, so link-7 keeps its jog and a diagnostic names it.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-single-feed-port-follows-its-child-over-a-pushed-row.yaml', import.meta.url), 'utf8');
const xs = (link: { path?: { segments: { from: { x: number }; to: { x: number } }[] } }): Set<string> =>
  new Set((link.path?.segments ?? []).flatMap(segment => [segment.from.x.toFixed(1), segment.to.x.toFixed(1)]));

it('draws the link of the pushed child as one vertical segment, with the port order and the publication check unchanged', async () => {
  const model = JSON.parse(JSON.stringify(await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }))) as Awaited<ReturnType<typeof layout>>;
  const link = model.links.find(item => item.id === 'link-6')!;
  expect(xs(link).size).toBe(1);
  const bottom = model.nodes['core-sw']!.ports.filter(port => port.side === 'bottom').sort((a, b) => a.engineOrder! - b.engineOrder!).map(port => port.anchor!.x);
  expect(bottom).toEqual([...bottom].sort((a, b) => a - b));
  expect(centreViolations(model)).toEqual([]);
}, 120000);

it('keeps the jog of a port that has no room and names the link', async () => {
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const link = model.links.find(item => item.id === 'link-7')!;
  expect(xs(link).size).toBeGreaterThan(1);
  expect(model.diagnostics.some(item => item.code === 'CENTRE_ALIGNMENT_INFEASIBLE' && item.owners?.some(owner => 'id' in owner && owner.id === 'link-7'))).toBe(true);
}, 120000);

it('decides a face the same way whatever the order of the links', async () => {
  const flipped = fixture.replace(/(\nlinks:\n)([\s\S]*)$/, (_, head: string, body: string) => `${head}${body.trim().split(/\n(?=- )/).reverse().join('\n')}\n`);
  expect(flipped).not.toBe(fixture);
  const [one, two] = await Promise.all([fixture, flipped].map(text => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt })));
  const face = (model: Awaited<ReturnType<typeof layout>>): string[] => model.nodes['core-sw']!.ports.filter(port => port.side === 'bottom').map(port => `${port.ref.name}@${port.anchor!.x.toFixed(1)}`).sort();
  expect(face(two!)).toEqual(face(one!));
}, 120000);

it('puts a source port back when the corridor of its link did not follow', async () => {
  const laid = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const model = JSON.parse(JSON.stringify(laid)) as typeof laid;
  const link = model.links.find(item => item.id === 'link-6')!;
  const lane = model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === 'link-6')!;
  const source = model.nodes['core-sw']!.ports.find(port => port.ref.name === 'p11')!;
  expect(link).toBeDefined();
  // The state 7f starts from: the corridor and the source port stand where 7a left them, 12 px off the child.
  lane.x -= 12; lane.bounds.x -= 12; source.anchor!.x -= 12;
  const before = source.anchor!.x;
  const seated = seatLaneSources(model, centreContext(model, model.anchorTier!).steps);
  expect(source.anchor!.x).toBeCloseTo(before + 12, 1);
  // The reseat skipped the link (its corridor is not free): the port must not stay at the child, or the link would jog at both ends.
  seated.reconcile();
  expect(source.anchor!.x).toBeCloseTo(before, 1);
  expect(source.anchor!.x).toBeCloseTo(lane.x, 1);
}, 120000);

it('adopts the reseat of a free corridor and takes back the port of a blocked one', async () => {
  const laid = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  const model = JSON.parse(JSON.stringify(laid)) as typeof laid;
  const portOf = (link: string): NonNullable<typeof model.links[number]['attachments']>['from'] => model.links.find(item => item.id === link)!.attachments!.from;
  const sourceOf = (link: string) => model.nodes[portOf(link).node]!.ports.find(port => port.ref.name === portOf(link).name)!;
  const laneOf = (link: string) => model.lanes.find(item => item.owner.kind === 'link' && item.owner.id === link)!;
  // link-6 is the blocked one (its corridor stays); link-5 is free (the reseat moves its corridor).
  for (const link of ['link-6', 'link-5']) { laneOf(link).x -= 12; laneOf(link).bounds.x -= 12; sourceOf(link).anchor!.x -= 12; }
  const free = sourceOf('link-5').anchor!.x, blocked = sourceOf('link-6').anchor!.x;
  const seated = seatLaneSources(model, centreContext(model, model.anchorTier!).steps);
  expect(sourceOf('link-5').anchor!.x).toBeCloseTo(free + 12, 1);
  expect(sourceOf('link-6').anchor!.x).toBeCloseTo(blocked + 12, 1);
  // What `reseatLanes` does for the free link.
  laneOf('link-5').x += 12; laneOf('link-5').bounds.x += 12;
  seated.reconcile();
  expect(sourceOf('link-5').anchor!.x).toBeCloseTo(laneOf('link-5').x, 1);
  expect(sourceOf('link-6').anchor!.x).toBeCloseTo(blocked, 1);
  expect(sourceOf('link-6').anchor!.x).toBeCloseTo(laneOf('link-6').x, 1);
}, 120000);
