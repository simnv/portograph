import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, render, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const yaml = readFileSync(new URL('../../goldens/synthetic/port-roles.yaml', import.meta.url), 'utf8');

/** Everything placement decides, with the legend and its labels left out. */
const geometry = (model: LayoutModel) => ({
  nodes: Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id, { bounds: node.bounds, pills: node.ports.map(port => port.pill?.bounds) }])),
  groups: Object.fromEntries(Object.entries(model.groups).map(([id, group]) => [id, group.bounds])),
  paths: model.links.map(link => link.path?.segments),
});

it('ticket 33: port roles paint pills and fill the legend without moving a single thing', async () => {
  const classed = await run(yaml);
  const report = score(classed).snapshot;
  expect(report.passed).toBe(true);
  expect(classed.legend!.entries.map(entry => entry.id)).toEqual([
    'symbol:router', 'symbol:tbr',
    'port:uplink', 'port:downlink', 'port:peer', 'port:mgmt', 'port:lag', 'port:loopback',
    'line:default', 'line:dotted', 'line:dashed']);
  // The same document without any port class places every node, pill and path identically; only
  // the legend differs, and it lives in space reserved below the diagram.
  const plain = await run(yaml.replace(/, class: [a-z -]+ \}/g, ' }'));
  expect(plain.legend!.entries.map(entry => entry.kind)).not.toContain('port');
  expect(geometry(classed)).toEqual(geometry(plain));
  const svg = render(classed);
  for (const token of ['tbr uplink up', 'router downlink degraded', 'router lag up', 'router loopback', 'router peer down', 'router mgmt unused', 'tbr peer admin-down']) {
    expect(svg).toContain(`class="port ${token}"`);
  }
});
