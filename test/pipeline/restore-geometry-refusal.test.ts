import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { centre, flanks, lanes, restoreLayoutModel, rows } from '../../src/internal.js';
import type { Diagnostic, LayoutModel } from '../../src/index.js';
import { rebuildRegions } from '../../src/layout/regions.js';
import { refitCanvas } from '../../src/layout/link-labels.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';

// Ticket DR-01 (audit T-07, M-1): the clearance, containment and band checks of publication hold for every model, whatever diagnostics it
// carries. Only the centring exemption reads PLACEMENT_NON_CONVERGENCE (ADR-0010).
const yaml = readFileSync(new URL('../../goldens/synthetic/a-restored-layout-with-a-non-convergence-code-keeps-every-geometry-check.yaml', import.meta.url), 'utf8');
const deep = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const code = 'PLACEMENT_NON_CONVERGENCE';
const warn = (message: string): Diagnostic => ({ stage: 'placement', severity: 'warning', code, message });
/** The five emitters' messages and one forged sentence; the code is what a restore reads. */
const codes: Record<string, Diagnostic> = {
  'flanks.ts': warn('Flank growth exceeds the available tier band; later placement must retain this conflict for final gates.'),
  'bands.ts': warn('Link-label room reservation exhausted the shared eight-pass budget; final gates decide the retained geometry.'),
  'placement-attempt.ts': warn('The cantons did not settle a band gap apart in 6 rounds of the close-up and the replay; final gates decide the retained geometry.'),
  'centre.ts': warn('Centering exhausted the shared eight-pass budget; unresolved alignments remain for routing and final gates.'),
  'sides-two.ts': warn('The sweep that seats the groups of a tier beside the frames did not settle in 16 rounds; final gates decide the retained geometry.'),
  forged: warn('forged'),
};

function moveNode(model: LayoutModel, id: string, dx: number, dy: number): void {
  const node = model.nodes[id]!;
  node.bounds!.x += dx; node.bounds!.y += dy;
  for (const port of node.ports) { if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; } if (port.pill) { port.pill.bounds.x += dx; port.pill.bounds.y += dy; } }
  if (node.icon) { node.icon.bounds.x += dx; node.icon.bounds.y += dy; }
  for (const label of model.labels) if (label.owner.kind === 'node' && label.owner.id === id && label.bounds) { label.bounds.x += dx; label.bounds.y += dy; }
}
function moveGroup(model: LayoutModel, id: string, dx: number, dy: number): void {
  const group = model.groups[id]!;
  group.bounds!.x += dx; group.bounds!.y += dy;
  for (const nodeId of group.nodes) moveNode(model, nodeId, dx, dy);
  for (const label of model.labels) if (label.role === 'group' && label.owner.kind === 'group' && label.owner.id === id && label.bounds) { label.bounds.x += dx; label.bounds.y += dy; }
  for (const band of model.labelBands) if (band.group === id) { band.bounds.x += dx; band.bounds.y += dy; }
}
/** A forger writes the whole file: the stored placement projection follows the model, so that only the checks under test decide. */
function refreeze(model: LayoutModel): void {
  const placement = model.freeze!.placement!;
  for (const [id, node] of Object.entries(model.nodes)) { placement.nodes[id]!.bounds = deep(node.bounds)!; placement.nodes[id]!.ports = deep(node.ports); }
  for (const [id, group] of Object.entries(model.groups)) placement.groups[id]!.bounds = deep(group.bounds)!;
  placement.labelBands = deep(model.labelBands); placement.regions = deep(model.regions)!; placement.tierBands = deep(model.tierBands)!;
  placement.labels = deep(model.labels.filter(label => ['node', 'description', 'pill', 'group'].includes(label.role ?? '')));
}
const groupLevel = (m: LayoutModel): void => { rebuildRegions(m); m.canvas = refitCanvas(m); };
const breaks: Record<string, { apply: (m: LayoutModel) => void; message: RegExp }> = {
  'node on its sibling': { apply: m => moveNode(m, 'spare', -(m.nodes.spare!.bounds!.x - m.nodes.b!.bounds!.x) + 10, 0), message: /Nodes b and spare violate clearance|Nodes spare and b violate clearance/ },
  'node outside its group': { apply: m => moveNode(m, 'spare', 30, 0), message: /Node spare is outside its group/ },
  'node in a foreign group': { apply: m => moveNode(m, 'spare', 136.5, 0), message: /Node spare is outside its group/ },
  'group overlap': { apply: m => { moveGroup(m, 'lonely', -70, 0); groupLevel(m); }, message: /Invalid group or tier geometry/ },
  'group in the previous band': { apply: m => { moveGroup(m, 'lonely', 0, -100); groupLevel(m); }, message: /Invalid group or tier geometry/ },
};

it('restore accepts the unbroken layout with and without a non-convergence code', async () => {
  const base = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(base.diagnostics.map(d => d.code)).not.toContain(code);
  for (const diagnostic of [undefined, ...Object.values(codes)]) {
    const model = deep(base);
    if (diagnostic) model.diagnostics.push(diagnostic);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }
}, 60000);

it('restore refuses a forged clearance, containment or band violation, with no code and with each emitter message', async () => {
  const base = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  for (const [name, item] of Object.entries(breaks)) {
    for (const [emitter, diagnostic] of [['none', undefined], ...Object.entries(codes)] as const) {
      const model = deep(base);
      item.apply(model); refreeze(model);
      if (diagnostic) model.diagnostics.push(diagnostic);
      expect(() => restoreLayoutModel(JSON.stringify(model)), `${name} with ${emitter}`).toThrow(item.message);
    }
  }
}, 60000);

it('restore refuses a geometry break beside a centring item that the code excuses, and passes the centring item alone', async () => {
  const model = centre(flanks(lanes(rows(await placed(withoutJointOrder(yaml))))));
  const slide = (m: LayoutModel): void => {
    m.nodes.b!.bounds!.x -= 5;
    for (const port of m.nodes.b!.ports) { port.anchor!.x -= 5; if (port.pill) port.pill.bounds.x -= 5; }
    for (const label of m.labels) if (label.owner.kind === 'node' && label.owner.id === 'b' && label.bounds) label.bounds.x -= 5;
  };
  for (const [emitter, diagnostic] of Object.entries(codes)) {
    const centred = deep(model);
    slide(centred);
    expect(() => restoreLayoutModel(JSON.stringify(centred)), 'no code').toThrow(/Centring invariant violated/);
    centred.diagnostics.push(diagnostic);
    const kept = restoreLayoutModel(JSON.stringify(centred));
    expect(kept.diagnostics.filter(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED'), emitter).toHaveLength(1);
    // The same file with a node moved onto its sibling: the exempt item passes, the break does not.
    const broken = deep(centred);
    moveNode(broken, 'spare', -(broken.nodes.spare!.bounds!.x - broken.nodes.b!.bounds!.x) + 10, 0);
    expect(() => restoreLayoutModel(JSON.stringify(broken)), emitter).toThrow(/violate clearance/);
  }
}, 60000);
