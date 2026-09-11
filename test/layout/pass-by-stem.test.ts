import { APPROVED_Q } from '../golden-baseline.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, parseWithDiagnostics, restoreLayoutModel, score, serializeLayoutModel } from '../../src/index.js';
import type { GateId, LayoutModel } from '../../src/index.js';
import { rowGap } from '../../src/layout/sides-two.js';
import { nodeGap } from '../../src/layout/skeleton-graph.js';
import { nodeObstacleReach, stemReach } from '../../src/layout/bands.js';
import { nodeObstacle } from '../../src/route/obstacles.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** A model at the size stage, so `rowGap` can be asked about hand-placed boxes. */
const placed = (yaml: string): LayoutModel => sizeNodes(sidesOne(resolve(parse(yaml))));

async function pipeline(yaml: string): Promise<LayoutModel> {
  const parsed = parseWithDiagnostics(yaml);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${JSON.stringify(parsed.diagnostics)}`);
  return layout(parsed.document, {
    diagnostics: parsed.diagnostics, createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
  });
}

const gap = (model: LayoutModel, left: string, right: string): number =>
  model.nodes[right]!.bounds!.x - (model.nodes[left]!.bounds!.x + model.nodes[left]!.bounds!.width);

/**
 * A port whose link does not end at the row neighbour it faces still gets a perpendicular stem from
 * stage 8, and that stem has to clear the neighbour's routing obstacle. Before this reservation the
 * whole pipeline threw `Routed gap … does not meet its reserved endpoints` on the approved
 * `flank-two-peers` counter-example: libavoid had no legal route and returned one that stopped at
 * the checkpoint. See `.superpowers/sdd/spec/task-17-flank-secondary-diagnosis.md`.
 */
describe('a port that passes its row neighbour by keeps its stem', () => {
  it('reserves stem plus neighbour clearance, and the whole pipeline then routes the link', async () => {
    const model = await pipeline(fixture('flank-two-peers'));
    const secondary = model.nodes.secondary!, primary = model.nodes.primary!;
    const required = stemReach(model, secondary) + nodeObstacleReach(model, primary);
    expect(required).toBe(26.75);
    expect(gap(model, 'primary', 'secondary')).toBeGreaterThanOrEqual(required);
    expect(gap(model, 'primary', 'secondary')).toBeGreaterThan(nodeGap(model, 'primary', 'secondary'));

    // The link really is routed end to end, from the flank's third port into secondary's pin.
    const link = model.links.find(item => item.id === 'link-3')!;
    expect(link.path).toBeDefined();
    const points = link.path!.segments;
    expect(points.at(-1)!.to).toEqual({ ...secondary.ports[0]!.anchor! });
    // Its last 15 px is the stem, and the turn before it is outside primary's obstacle.
    const stem = points.at(-1)!;
    expect(stem.to.x - stem.from.x).toBe(15);
    expect(stem.from.x).toBeGreaterThanOrEqual(nodeObstacle(model, 'primary').x + nodeObstacle(model, 'primary').width);
    expect(restoreLayoutModel(serializeLayoutModel(model))).toEqual(model);
  }, 120000);

  it('reserves nothing when the neighbour is not in front of the port', () => {
    // `b`'s left port links past `a`, but `a` sits far above it, so the stem is already clear.
    const model = placed(`portograph: 2
groups: {g: {tier: 0}, f: {align: left, of: g}}
nodes:
  a: {group: g, ports: [{name: p, side: top}]}
  b: {group: g, ports: [{name: p, side: left}]}
  far: {group: f, ports: [{name: p, side: right}]}
links: [[far.p, b.p]]`);
    model.nodes.a!.bounds = { x: 0, y: 0, width: 50, height: 20 };
    model.nodes.b!.bounds = { x: 72, y: 400, width: 50, height: 35 };
    model.nodes.b!.ports[0]!.anchor = { x: 72, y: 417.5 };
    expect(rowGap(model, 'a', 'b')).toBe(nodeGap(model, 'a', 'b'));
    // Move the port into the neighbour's row and the reservation appears.
    model.nodes.b!.ports[0]!.anchor = { x: 72, y: 10 };
    expect(rowGap(model, 'a', 'b')).toBe(stemReach(model, model.nodes.b!) + nodeObstacleReach(model, model.nodes.a!));
  });

  it('reserves nothing for a bundle member, whose space stage 7e reserves instead', async () => {
    // The approved golden is exactly this case: EBR-01's four left ports pass EAC-01 by, and every
    // one of them belongs to the TBR-001 bundle. Its gap must stay at the plain node clearance.
    const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');
    const model = await pipeline(goldenYaml);
    const left = model.nodes['EBR-01']!.ports.filter(port => port.side === 'left');
    expect(left.length).toBeGreaterThan(0);
    expect(left.every(port => model.links.some(link =>
      link.attachments!.to.node === port.ref.node && link.bundle !== undefined))).toBe(true);
    expect(gap(model, 'EAC-01', 'EBR-01')).toBe(nodeGap(model, 'EAC-01', 'EBR-01'));

    const report = score(model, { golden: true }).snapshot;
    for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as GateId[]) {
      expect([id, report.gates[id].violations]).toEqual([id, []]);
    }
    expect(report.Q).toBeCloseTo(APPROVED_Q, 12);
  }, 120000);
});
