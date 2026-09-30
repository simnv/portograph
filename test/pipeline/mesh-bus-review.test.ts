import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id);

describe('the review of ticket 83: named and authored bus ports', () => {
  const base = fixture('a-full-mesh-on-one-row-draws-as-one-bus');
  /** The full-mesh fixture with n1 declaring `ports`, and its sync links naming `e0`. */
  const withPort = (ports: string): string => base
    .replace('  n1: { group: row, class: router, label: N1 }', `  n1: { group: row, class: router, label: N1, ports: [${ports}] }`)
    .replace(/from: n1, to: (n\d), class: sync/g, (_all, to: string) => `from: n1.e0, to: ${to}, class: sync`);
  const declined = (model: LayoutModel): string => model.diagnostics.filter(item => item.code === 'MESH_BUS_DECLINED').map(item => item.message).join('\n');

  it('declines a bus whose named port also carries a routed link (shared-port), and the routed link routes', async () => {
    const model = await run(withPort('{ name: e0 }').replace('  - [core, n1]', '  - [core, n1.e0]'));
    expect(model.meshBuses).toBeUndefined();
    expect(declined(model)).toContain('shared-port');
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.links.find(link => link.id === 'link-1')!.path!.segments.length).toBeGreaterThan(0);
  }, 60000);

  it('declines a bus port with an authored side left or right (side)', async () => {
    const model = await run(withPort('{ name: e0, side: left }'));
    expect(model.meshBuses).toBeUndefined();
    expect(declined(model)).toContain('side');
    expect(model.removedLinks ?? []).toEqual([]);
  }, 60000);

  it('lets an authored top or bottom on a bus port fix the bus side, against the leg count', async () => {
    // Without the authored side the bus stands at the bottom: the title edge, and no leg there.
    expect((await run(withPort('{ name: e0 }'))).meshBuses![0]!.side).toBe('bottom');
    const model = await run(withPort('{ name: e0, side: top }'));
    const bus = model.meshBuses![0]!;
    expect(bus.side).toBe('top');
    for (const ref of bus.ports) {
      const port = model.nodes[ref.node]!.ports.find(item => item.ref.ordinal === ref.ordinal && item.ref.name === ref.name)!;
      expect(port.side).toBe('top');
    }
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('puts the bus port after a peerless port on its side', async () => {
    const model = await run(withPort('{ name: e0 }, { name: spare, side: bottom }'));
    const bus = model.meshBuses![0]!;
    expect(bus.side).toBe('bottom');
    const ports = model.nodes['n1']!.ports.filter(port => port.side === 'bottom');
    const spare = ports.find(port => port.ref.name === 'spare')!, busPort = ports.find(port => port.ref.name === 'e0')!;
    expect(busPort.engineOrder!).toBeGreaterThan(spare.engineOrder!);
  }, 60000);

  it('accepts a title that 7f reports as staying on a stub, and restores the layout', async () => {
    const model = JSON.parse(JSON.stringify(await run(fixture('a-mesh-of-one-node-groups-draws-one-bus')))) as LayoutModel;
    model.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'MESH_BUS_TITLE_ON_STUB', message: 'x', owners: [{ kind: 'group', id: 'west' }] });
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 60000);
});
