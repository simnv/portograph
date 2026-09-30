import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('scratch', () => {
  for (const name of (process.env.FX ?? 'a-full-mesh-on-one-row-draws-as-one-bus').split(',')) it(`prints ${name}`, async () => {
    const model = await run(fixture(name));
    const r = (n: number) => Math.round(n * 10) / 10;
    const box = (b: { x: number; y: number; width: number; height: number } | undefined) => b && [r(b.x), r(b.y), r(b.width), r(b.height)];
    for (const bus of model.meshBuses ?? []) {
      console.log(bus.id, bus.placement, bus.side, JSON.stringify(bus.bar), JSON.stringify(bus.stubs?.map(s => [s.node, r(s.from.x), r(s.from.y), r(s.to.y)])), JSON.stringify(bus.labelRoom));
    }
    console.log('nodes', JSON.stringify(Object.values(model.nodes).map(n => [n.id, r(n.bounds!.x), r(n.bounds!.y)])));
    console.log('busBands', JSON.stringify((model.busBands ?? []).map(b => [b.id, b.group, b.side, box(b.bounds)])));
    console.log('groups', JSON.stringify(Object.values(model.groups).map(g => [g.id, g.tier, box(g.bounds)])));
    console.log('frames', JSON.stringify((model.frames ?? []).map(f => [f.id, box(f.box)])));
    console.log('bands', JSON.stringify(model.labelBands.map(b => [b.group, b.side, box(b.bounds), r(b.clearance)])));
    console.log('labels', JSON.stringify(model.labels.filter(l => l.role === 'group').map(l => [l.text, box(l.bounds)])));
    console.log('tiers', JSON.stringify(model.tierBands.map(t => [t.tier, box(t.bounds)])), 'canvas', JSON.stringify(box(model.canvas)));
    console.log('diag', JSON.stringify(model.diagnostics.filter(d => d.severity !== 'info').map(d => d.code)), JSON.stringify(model.diagnostics.filter(d => d.code.startsWith('MESH')).map(d => d.code)));
    const s = score(model).snapshot;
    console.log('gates', JSON.stringify(Object.entries(s.gates).filter(([, g]) => !g.passed).map(([id, g]) => [id, g.violations.length])), 'Q', s.Q);
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  }, 120000);
});
