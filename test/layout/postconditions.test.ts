import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, serializeLayoutModel } from '../../src/index.js';
import { ADVISORY_KINDS, advisory, judgePostconditions, postconditionSink, postconditionViolations, type PostconditionKind, type PostconditionViolation } from '../../src/layout/postconditions.js';
import { PostconditionRefusal } from '../../src/layout/placement-refusal.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from './joint-off.js';

const fixture = (name: string): string => withoutJointOrder(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8'));
const run = (name: string): Promise<LayoutModel> => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const copy = (model: LayoutModel): LayoutModel => JSON.parse(serializeLayoutModel(model)) as LayoutModel;

/** Translate one group with its nodes, anchors and pills: a writer that moved it after the reservation. */
function shift(model: LayoutModel, id: string, dx: number, dy: number): void {
  const group = model.groups[id]!;
  group.bounds!.x += dx; group.bounds!.y += dy;
  for (const node of group.nodes.map(item => model.nodes[item]!)) {
    node.bounds!.x += dx; node.bounds!.y += dy;
    for (const port of node.ports) {
      if (port.anchor) { port.anchor.x += dx; port.anchor.y += dy; }
      if (port.pill) { port.pill.bounds.x += dx; port.pill.bounds.y += dy; }
    }
  }
}
const AXIS = [-300, -200, -150, -100, -60, -40, -25, -15, -8, 8, 15, 25, 40, 60, 100, 150, 200, 300];
const STEPS: [number, number][] = [...AXIS.map(dx => [dx, 0] as [number, number]), ...AXIS.map(dy => [0, dy] as [number, number])];
/** The first shift of one group that makes `kind` fire on the net draft. */
function force(model: LayoutModel, kind: PostconditionKind): LayoutModel | undefined {
  for (const id of Object.keys(model.groups).sort()) {
    if (model.groups[id]!.bounds === undefined || model.groups[id]!.nodes.length === 0) continue;
    for (const [dx, dy] of STEPS) {
      const after = copy(model);
      shift(after, id, dx, dy);
      if (postconditionViolations(model, after, 'bands').some(item => item.kind === kind)) return after;
    }
  }
  return undefined;
}
function collect(body: () => void): PostconditionViolation[] {
  const seen: PostconditionViolation[] = [];
  postconditionSink.hook = violation => seen.push(violation);
  try { body(); } finally { delete postconditionSink.hook; }
  return seen;
}

describe('producer postconditions of 7e and 7f (DR-11)', () => {
  it('a laid-out sheet has none, and the sink changes no byte of the layout', async () => {
    const plain = async (): Promise<string> => serializeLayoutModel({ ...(await run('a-hemmed-fan-branch-keeps-its-stem')), runtime: { stages: [] } } as LayoutModel);
    const off = await plain();
    let on = '';
    const seen: PostconditionViolation[] = [];
    postconditionSink.hook = violation => seen.push(violation);
    try { on = await plain(); } finally { delete postconditionSink.hook; }
    expect(on).toBe(off);
    expect(seen).toEqual([]);
  }, 120000);

  // One forced violation per kind: the absolute reading finds it on the net draft and the sink receives it. A refusing kind refuses the
  // transaction whole with a PostconditionRefusal; an advisory kind is reported only.
  it.each([
    ['riserKeepOut', 'a-mesh-over-two-rows-joins-its-bars-with-one-riser', true],
    ['trunkExtension', 'a-trunk-passes-a-row-without-members', true],
    ['laneSide', 'a-riser-beyond-a-labelled-rows-split-moves-with-the-room', true],
    ['frozenChord', 'a-foreign-unit-with-routed-links-to-two-canton-groups', false],
    ['sideAlignment', 'a-far-port-is-centred-under-a-side-lane', true],
    ['spanCorridor', 'a-span-corridor-passes-a-lane-beside-a-unit-it-does-not-move', false],
    ['groupExit', 'a-hemmed-fan-branch-keeps-its-stem', true],
  ] as [PostconditionKind, string, boolean][])('%s: a forced violation on the net draft is found, reported, and refused when the kind refuses', async (kind, name, refuses) => {
    const model = await run(name);
    expect(postconditionViolations(model, model, 'bands')).toEqual([]);
    const after = force(model, kind);
    expect(after, `no shift of a group of ${name} breaks ${kind}`).toBeDefined();
    expect(ADVISORY_KINDS.has(kind)).toBe(!refuses);
    let refusal: unknown;
    const seen = collect(() => { try { judgePostconditions(model, after!, 'bands'); } catch (error) { refusal = error; } });
    expect(seen.some(item => item.kind === kind && item.rule === 'bands')).toBe(true);
    // A forced shift can break more than one kind; an advisory kind refuses only when a refusing kind fires beside it.
    const others = seen.filter(item => !advisory(item));
    if (refuses || others.length) {
      expect(refusal).toBeInstanceOf(PostconditionRefusal);
      expect((refusal as PostconditionRefusal).code).toBe('postcondition');
      expect((refusal as PostconditionRefusal).findings.map(item => item.kind)).toEqual(others.map(item => item.kind));
    } else expect(refusal).toBeUndefined();
  }, 120000);

  it('a stored kind: a node below its floor is a ledger failure', async () => {
    const model = await run('a-span-corridor-passes-a-lane-beside-a-unit-it-does-not-move');
    const after = copy(model), floor = after.reservations!.find(item => item.kind === 'nodeFloor')!, id = (floor.payload as { node: string }).node;
    after.nodes[id]!.size = { width: 1, height: 1 };
    expect(postconditionViolations(model, after, 'bundles').filter(item => item.kind === 'stored').map(item => item.subject)).toContain(`nodeFloor:${floor.id}`);
    expect(() => judgePostconditions(model, after, 'bundles')).toThrow(PostconditionRefusal);
    // A new sideFace failure stays advisory: the round's own `holds` withdraws the 7e trial that shows it.
    expect(advisory({ rule: 'bundles', kind: 'stored', subject: 'sideFace:x', detail: '', ledger: 'sideFace' })).toBe(true);
    expect(advisory({ rule: 'bundles', kind: 'stored', subject: 'nodeFloor:x', detail: '', ledger: 'nodeFloor' })).toBe(false);
  }, 120000);

  it('a missing required exit refuses, with GROUP_EXIT_BLOCKED forged beside it (R5)', async () => {
    const model = await run('a-hemmed-fan-branch-keeps-its-stem');
    const exit = model.groupExits![0]!, after = copy(model);
    after.groupExits = after.groupExits!.filter(item => item.link !== exit.link || item.end !== exit.end);
    after.links.find(link => link.id === exit.link)!.sharedRuns![exit.end]!.pop();
    after.diagnostics.push({ stage: 'placement', severity: 'error', code: 'GROUP_EXIT_BLOCKED', owners: [{ kind: 'link', id: exit.link }], message: 'forged' });
    expect(() => judgePostconditions(model, after, 'bands')).toThrow(/groupExit/);
  }, 120000);

  it('a check that cannot read the draft is a violation of its kind (R6)', async () => {
    const model = await run('a-hemmed-fan-branch-keeps-its-stem');
    const after = copy(model);
    (after as { reservations?: unknown }).reservations = [{ id: 'broken', kind: 'nodeFloor', payload: { node: 'no-such-node' } }];
    const found = postconditionViolations(model, after, 'bands').filter(item => item.kind === 'stored');
    expect(found.length).toBeGreaterThan(0);
  }, 120000);
});
