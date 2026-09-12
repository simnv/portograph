import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { centre, flanks, lanes, layout, parse, restoreLayoutModel, rows, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { GROUP_EDGE_LINK_CLEARANCE } from '../../src/theme/geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string) => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const box = (model: LayoutModel, id: string) => model.groups[id]!.bounds!;

it('ADR-0012: linked groups share one x-extent within the cap and a much smaller group is left alone', async () => {
  const model = await run(fixture('one-px-sources'));
  const upper = box(model, 'upper'), bars = box(model, 'bars'), lower = box(model, 'lower');
  expect([upper.x, upper.width]).toEqual([bars.x, bars.width]);
  expect([lower.x, lower.width]).toEqual([bars.x, bars.width]);
  expect(model.diagnostics.some(d => d.code === 'GROUP_GRID_NON_CONVERGENCE')).toBe(false);
  // Route-Reflector against Backbone in the golden is far beyond the 30 % cap and keeps its own width.
  const golden = await run(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8'));
  expect(box(golden, 'route-reflector').width).toBeLessThan(box(golden, 'backbone').width * 0.7);
  expect([box(golden, 'providers').x, box(golden, 'providers').width]).toEqual([box(golden, 'backbone').x, box(golden, 'backbone').width]);
}, 60000);

it('ADR-0013: no routed segment enters a foreign group and none runs along a group edge from outside', async () => {
  for (const name of ['both-margins-full', 'shared-peer-port']) {
    const model = await run(fixture(name));
    const report = score(model).snapshot;
    expect([name, report.gates.G2.violations.filter(v => v.code === 'through-group')]).toEqual([name, []]);
    expect([name, report.gates.G6.violations.filter(v => v.code === 'segment-group-edge')]).toEqual([name, []]);
  }
  const margins = await run(fixture('both-margins-full'));
  const detour = margins.links.find(link => link.attachments!.from.node === 'peer' && link.attachments!.to.node === 'flank-right')!;
  for (const id of ['upper', 'lower']) {
    const b = box(margins, id);
    for (const s of detour.path!.segments) {
      const inside = (p: { x: number; y: number }) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height;
      expect([id, inside(s.from) || inside(s.to)]).toEqual([id, false]);
    }
  }
  const shared = await run(fixture('shared-peer-port'));
  const tier = box(shared, 'tier-group');
  const vertical = shared.links.find(link => link.id === 'link-2')!.path!.segments.find(s => s.from.x === s.to.x)!;
  expect(vertical.from.x).toBeCloseTo(tier.x - GROUP_EDGE_LINK_CLEARANCE - 0.75, 9);
}, 60000);

it('ADR-0010: restore rejects a centred model whose child group was slid off its feeds', async () => {
  const model = centre(flanks(lanes(rows(await placed(`portograph: 2
groups: {up: {tier: 0}, low: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`)))));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  // Slide the child node 5 px inside its own box: every containment check still holds, only the
  // alignment 7c established is gone.
  const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
  forged.nodes.b!.bounds!.x += 5;
  for (const port of forged.nodes.b!.ports) port.anchor!.x += 5;
  rebuildNodeGeometry(forged, ['b'], 'current');
  expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/Centring invariant violated/);
  // Serialized diagnostics are not proof: exemptions derive from geometry and topology only.
  for (const code of ['CENTRE_ALIGNMENT_INFEASIBLE', 'CENTRE_FAN_REMAINDER']) {
    const excused = JSON.parse(JSON.stringify(forged)) as LayoutModel;
    excused.diagnostics.push({ stage: 'placement', severity: 'warning', code, message: 'forged', owners: [{ kind: 'link', id: 'link-1' }] });
    expect(() => restoreLayoutModel(JSON.stringify(excused)), code).toThrow(/Centring invariant violated/);
  }
  // A spent shared budget is the one state geometry cannot witness: such a model keeps its last
  // state, but the unverified alignment is recorded on it and the final gates judge the result.
  const spent = JSON.parse(JSON.stringify(forged)) as LayoutModel;
  spent.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'PLACEMENT_NON_CONVERGENCE', message: 'forged', owners: [{ kind: 'group', id: 'low' }] });
  const restored = restoreLayoutModel(JSON.stringify(spent));
  expect(restored.diagnostics.filter(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED').map(d => d.message)).toEqual([expect.stringMatching(/link-1/)]);
}, 60000);

it('ADR-0010: publication keeps a genuinely infeasible alignment and restore still rejects a forged one beside a blocked group', async () => {
  // Two ordered child ports whose parents sit in the opposite order: the producer's own alignSide
  // compatibility rule leaves one unaligned and diagnoses it. The published model must pass.
  const incompatible = centre(flanks(lanes(rows(await placed(`portograph: 2
groups: {up: {tier: 0}, low: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: up, ports: [{name: p, side: bottom}]}
  spare: {group: up}
  c:
    group: low
    ports:
      - {name: p, side: top, order: 0}
      - {name: q, side: top, order: 1}
links: [[a.p, c.q], [b.p, c.p]]`)))));
  expect(incompatible.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining(['CENTRE_ALIGNMENT_INFEASIBLE', 'PLACEMENT_NON_CONVERGENCE']));
  expect(restoreLayoutModel(JSON.stringify(incompatible))).toEqual(incompatible);
  // The infeasible port excuses only itself: sliding the node also moves its feasible sibling off b.p.
  // This model genuinely spent its budget, so the slide is recorded on it rather than rejected.
  const slid = JSON.parse(JSON.stringify(incompatible)) as LayoutModel;
  slid.nodes.c!.bounds!.x += 5;
  for (const port of slid.nodes.c!.ports) { port.anchor!.x += 5; if (port.pill) port.pill.bounds.x += 5; }
  for (const label of slid.labels) if (label.owner.kind === 'node' && label.owner.id === 'c' && label.bounds) label.bounds.x += 5;
  const recorded = restoreLayoutModel(JSON.stringify(slid));
  expect(recorded.diagnostics.filter(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED').map(d => d.message)).toEqual([expect.stringMatching(/link-2/)]);
  expect(recorded.diagnostics.filter(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED')[0]!.message).not.toMatch(/link-1/);

  // One child group legitimately blocked by its neighbour excuses nothing about the other group.
  const twoChildren = centre(flanks(lanes(rows(await placed(`portograph: 2
groups: {up: {tier: 0}, left: {tier: 1}, right: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  b: {group: up, ports: [{name: p, side: bottom}]}
  c: {group: left, ports: [{name: p, side: top}]}
  d: {group: right, ports: [{name: p, side: top}]}
links: [[a.p, c.p], [b.p, d.p]]`)))));
  expect(restoreLayoutModel(JSON.stringify(twoChildren))).toEqual(twoChildren);
  const forged = JSON.parse(JSON.stringify(twoChildren)) as LayoutModel;
  forged.nodes.c!.bounds!.x += 5;
  for (const port of forged.nodes.c!.ports) { port.anchor!.x += 5; if (port.pill) port.pill.bounds.x += 5; }
  for (const label of forged.labels) if (label.owner.kind === 'node' && label.owner.id === 'c' && label.bounds) label.bounds.x += 5;
  // d stays blocked every pass, so this model too spent its budget: the forged c is recorded, not
  // rejected, and the blocked d is excused on its own account and never named.
  const kept = restoreLayoutModel(JSON.stringify(forged));
  const notes = kept.diagnostics.filter(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED').map(d => d.message);
  expect(notes).toEqual([expect.stringMatching(/link-1/)]);
  expect(notes[0]).not.toMatch(/link-2/);
}, 60000);

it('ADR-0010: a bundle on the parent port excuses nothing about an ordinary sibling feed before stage 7e', async () => {
  const model = centre(flanks(lanes(rows(await placed(`portograph: 2
groups: {up: {tier: 0}, low: {tier: 1}, bundle: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  u1: {group: up}
  u2: {group: up}
  c: {group: low, ports: [{name: p, side: top}]}
  t: {group: bundle, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, c.p], [a.p, t.p], [a.p, t.q]]`)))));
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  const forged = JSON.parse(JSON.stringify(model)) as LayoutModel;
  forged.nodes.c!.bounds!.x += 5;
  for (const port of forged.nodes.c!.ports) { port.anchor!.x += 5; if (port.pill) port.pill.bounds.x += 5; }
  for (const label of forged.labels) if (label.owner.kind === 'node' && label.owner.id === 'c' && label.bounds) label.bounds.x += 5;
  expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/Centring invariant violated: link-1/);
}, 60000);
