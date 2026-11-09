import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { centre, flanks, lanes, restoreLayoutModel, rows } from '../../src/internal.js';
import type { Diagnostic, LayoutModel } from '../../src/index.js';
import { alignFlanks } from '../../src/layout/flanks.js';
import { rebuildRegions } from '../../src/layout/regions.js';
import { refitCanvas } from '../../src/layout/link-labels.js';
import { PlacementRefusal } from '../../src/layout/placement-refusal.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';
// The group lift (ticket 08) is off in these tests: with it, `lonely` (no link) rises into band 0 beside `up`, and the forged cases move
// `lonely` inside its tier band of the layout without the lift. `lift.test.ts` tests the lift.

// Ticket DR-01 (audit T-07, M-1): the clearance, containment and band checks of publication hold for every model, whatever diagnostics it
// carries. Only the centring exemption reads PLACEMENT_NON_CONVERGENCE (ADR-0010).
const yaml = readFileSync(new URL('../../goldens/synthetic/a-restored-layout-with-a-non-convergence-code-keeps-every-geometry-check.yaml', import.meta.url), 'utf8');
const deep = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const code = 'PLACEMENT_NON_CONVERGENCE';
const warn = (message: string): Diagnostic => ({ stage: 'placement', severity: 'warning', code, message });
/** The four remaining emitters' messages (flanks.ts now refuses instead) and one forged sentence; the code is what a restore reads. */
const codes: Record<string, Diagnostic> = {
  'bands.ts': warn('Link-label room reservation exhausted the shared eight-pass budget; the geometry kept is still checked by the publication and the final gates.'),
  'placement-attempt.ts': warn('The cantons did not settle a band gap apart in 6 rounds of the close-up and the replay; the geometry kept is still checked by the publication and the final gates.'),
  'centre.ts': warn('Centering exhausted the shared eight-pass budget; unresolved alignments remain for routing and final gates.'),
  'sides-two.ts': warn('The sweep that seats the groups of a tier beside the frames did not settle in 16 rounds; the geometry kept is still checked by the publication and the final gates.'),
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
  const base = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
  expect(base.diagnostics.map(d => d.code)).not.toContain(code);
  for (const diagnostic of [undefined, ...Object.values(codes)]) {
    const model = deep(base);
    if (diagnostic) model.diagnostics.push(diagnostic);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }
}, 60000);

it('restore refuses a forged clearance, containment or band violation, with no code and with each emitter message', async () => {
  const base = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
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
  const centred = deep(model);
  slide(centred);
  let item = '';
  try { restoreLayoutModel(JSON.stringify(centred)); } catch (error) { item = /Centring invariant violated: (\S+):/.exec((error as Error).message)?.[1] ?? ''; }
  expect(item, 'no code').not.toBe('');
  // DR-15 (R5): only a diagnostic that names the item's link as owner, as the centre emitter writes it, excuses the item. The other emitters' codes
  // (which name no link), a forged message and the centre message with no owner excuse nothing; the message text is never read.
  for (const [emitter, diagnostic] of Object.entries(codes)) {
    const refused = deep(centred);
    refused.diagnostics.push({ ...diagnostic, owners: [] });
    expect(() => restoreLayoutModel(JSON.stringify(refused)), emitter).toThrow(/Centring invariant violated/);
  }
  const named = deep(centred);
  named.diagnostics.push({ ...codes['centre.ts']!, owners: [{ kind: 'link', id: item }] });
  const kept = restoreLayoutModel(JSON.stringify(named));
  expect(kept.diagnostics.filter(d => d.code === 'CENTRE_INVARIANT_UNVERIFIED')).toHaveLength(1);
  // The same file with a node moved onto its sibling: the exempt item passes, the break does not.
  const broken = deep(named);
  moveNode(broken, 'spare', -(broken.nodes.spare!.bounds!.x - broken.nodes.b!.bounds!.x) + 10, 0);
  expect(() => restoreLayoutModel(JSON.stringify(broken))).toThrow(/violate clearance/);
}, 60000);

it('flanks refuses a run whose flank growth leaves a band conflict, with a named PlacementRefusal and no diagnostic', async () => {
  // No input reaches the condition today (no corpus or sweep sheet). The draft of the stage is given the conflict that flank growth could leave: a group on its sibling.
  const draft = deep(lanes(rows(await placed(withoutJointOrder(yaml)))));
  moveGroup(draft, 'lonely', -70, 0);
  rebuildRegions(draft);
  let refusal: unknown;
  try { alignFlanks(draft); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(PlacementRefusal);
  expect(refusal).toMatchObject({ code: 'skeleton', stage: 'flanks', message: expect.stringMatching(/Flank growth of .* exceeds the available tier band: /) });
  expect(draft.diagnostics.map(d => d.code)).not.toContain(code);
}, 60000);
