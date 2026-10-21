import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { centreViolations } from '../../src/layout/centre.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Ticket 15 (architecture-2): a port with one link stands over the port it feeds. The row repack pushed `leaf-c` right of the corridor of link-6; the
// source port `p11` stood where the corridor was, so the link jogged although the face had room. The fixture also holds the control: `p13` has no room
// for a move of that size, so link-7 keeps its jog and a diagnostic names it.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-single-feed-port-follows-its-child-over-a-pushed-row.yaml', import.meta.url), 'utf8');
const xs = (link: { path?: { segments: { from: { x: number }; to: { x: number } }[] } }): Set<string> =>
  new Set((link.path?.segments ?? []).flatMap(segment => [segment.from.x.toFixed(1), segment.to.x.toFixed(1)]));

it('draws the link of the pushed child as one vertical segment, with the port order and the publication check unchanged', async () => {
  const model = await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
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
