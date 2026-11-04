import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { givenBackFault, strandedGrowth } from '../../src/layout/given-back.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 71: a width the centring passes added to align a face's links, and that no kept target or kept chord uses at the end of
 * the centre rule, is given back. The rule judges once at its end (not per pass), stores the record (`givenBack`), and runs the passes once more
 * from its input with it. A node at one end of a transit link gives back only with the other end, so its corridor can follow it in 7f.
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(source(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const bends = (model: LayoutModel): number => { const counts = score(model).snapshot.counts; return (counts.routed?.turns ?? 0) + (counts.overlay?.turns ?? 0); };
const failing = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).filter(([, gate]) => !gate.passed && gate.severity === 'error').map(([id]) => id).sort();
const forge = (model: LayoutModel, edit: (copy: LayoutModel) => void): string => {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  edit(copy);
  return JSON.stringify(copy);
};

describe('a stranded growth is given back', () => {
  let model: LayoutModel;
  beforeAll(async () => { model = await run('a-stranded-growth-is-given-back'); }, 120000);

  it('records srv0 and its three top ports, and srv0 stands at its own width', () => {
    expect(Object.keys(model.givenBack ?? {})).toContain('srv0');
    expect(model.givenBack!['srv0']).toHaveLength(3);
    expect(model.nodes['srv0']!.bounds!.width).toBeLessThan(70);
    // srv1 keeps its growth: two of its links stand vertical (a kept chord).
    expect(model.givenBack!['srv1']).toBeUndefined();
    // isp1 is given back too, but its sibling isp0 stands a target, so the group step keeps isp1's width; the note names it, and srv0 not (R6).
    const kept = model.diagnostics.filter(item => item.code === 'CENTRE_GROWTH_KEPT').map(item => item.message);
    expect(kept).toEqual([expect.stringMatching(/^isp1 gave a growth back, but a sibling/)]);
  });

  it('keeps the bends of main (6) and narrows the canvas (668 px on main)', () => {
    expect(bends(model)).toBe(6);
    expect(model.canvas!.width).toBeLessThan(500);
  });

  it('round-trips through the restore API with its record', () => {
    expect(restoreLayoutModel(JSON.stringify(model)).givenBack).toEqual(model.givenBack);
  });

  it('R5: refuses a record on a model before the centre rule', async () => {
    const early = (await import('../../src/layout/mutation.js')).restoreLayoutModel;
    const placed = JSON.parse(JSON.stringify(model)) as LayoutModel;
    // A shape-valid record on a model whose stage is before 7c: no producer wrote it.
    const before = { ...placed, stage: 'flanks', givenBack: placed.givenBack } as unknown as LayoutModel;
    expect(() => early(JSON.stringify(before))).toThrow();
  });

  it('R5: refuses a prototype key as a node', () => {
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack!['toString'] = ['port:["toString",true,null,1]']; }))).toThrow(/toString is no node/);
  });

  it('R5: refuses a malformed record', () => {
    const forged = /given-back growth record is forged/;
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack = {}; }))).toThrow(forged);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack!['nobody'] = copy.givenBack!['srv0']!; }))).toThrow(/nobody is no node/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack!['srv0'] = []; }))).toThrow(/srv0 gives back no port/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack!['srv0'] = [...copy.givenBack!['srv0']!].reverse(); }))).toThrow(/out of code-unit order/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack!['srv0'] = [copy.givenBack!['srv0']![0]!, copy.givenBack!['srv0']![0]!]; }))).toThrow(/out of code-unit order or repeated/);
    const foreign = model.nodes['srv1']!.ports[0]!;
    expect(() => restoreLayoutModel(forge(model, copy => { copy.givenBack!['srv0'] = [`port:${JSON.stringify([foreign.ref.node, foreign.ref.anonymous === true, foreign.ref.name ?? null, foreign.ref.ordinal])}`]; })))
      .toThrow(/is no port of the node/);
  });
});

describe('the user\'s tier-gap sheet', () => {
  it('srv0 is at most 70 px and the sheet has at most 8 bends (12 on main)', async () => {
    const model = await run('a-tier-gap-plan-orders-every-part');
    expect(model.givenBack?.['srv0']).toBeDefined();
    expect(model.nodes['srv0']!.bounds!.width).toBeLessThanOrEqual(70);
    expect(bends(model)).toBeLessThanOrEqual(8);
  }, 120000);
});

// The three regression classes of the per-step prototype (verdict sideface-fable, section 2): each sheet as main or better.
describe('the three regression classes of a per-step decline', () => {
  it('transit corridor: a-face gives nothing back, as the parent src1 would chase a corridor that follows a narrow snk1 (bends 8, crossings 7)', async () => {
    const model = await run('a-face-aligns-one-port-and-leaves-a-chord-port-in-place');
    expect(model.givenBack).toBeUndefined();
    expect(bends(model)).toBe(8);
    expect(score(model).snapshot.metrics.crossings.count).toBe(7);
  }, 120000);

  it('sibling cascade: a-group-shift gives snk0 back with its partner src1 and keeps bends 5 and G5 alone', async () => {
    const model = await run('a-group-shift-leaves-a-chord-clear-of-a-lane');
    expect(Object.keys(model.givenBack ?? {})).toEqual(['snk0', 'src1']);
    expect(bends(model)).toBe(5);
    expect(failing(model)).toEqual(['G5']);
  }, 120000);

  it('transit corridor: a-shared-end gives nothing back (bends 8, crossings 14)', async () => {
    const model = await run('a-shared-end-reads-its-port-order');
    expect(model.givenBack).toBeUndefined();
    expect(bends(model)).toBe(8);
    expect(score(model).snapshot.metrics.crossings.count).toBe(14);
  }, 120000);

  it('pass order: widened-child-packs-tier and a-hub-tiers-fan keep the growth a later pass completes (bends 2 and 6)', async () => {
    for (const [name, count] of [['widened-child-packs-tier', 2], ['a-hub-tiers-fan-draws-straight-and-crosses-itself', 6]] as const) {
      const model = await run(name);
      expect(model.givenBack, name).toBeUndefined();
      expect(bends(model), name).toBe(count);
    }
  }, 120000);
});

/** A hand-made model at the end of the centre rule: two nodes `a` (tier 1) and `p` (tier 0), one link between their ports, the record given. */
function endOfCentre(options: { kept?: boolean; vertical?: boolean; transit?: boolean; pGrown?: boolean; spread?: boolean }): { model: LayoutModel; input: LayoutModel } {
  const port = (node: string, side: 'top' | 'bottom', x: number): unknown => ({ ref: { node, anonymous: true, ordinal: 1 }, side, anchor: { x, y: 0 } });
  const node = (id: string, width: number, side: 'top' | 'bottom', x: number): unknown => ({ id, bounds: { x: 0, y: 0, width, height: 40 }, ports: [port(id, side, x)] });
  const id = (node: string): string => `port:["${node}",true,null,1]`;
  const entry = (node: string, state: 'kept' | 'grown'): unknown => ({ port: id(node), link: 'l', far: options.transit ? 'lane:t' : id(node === 'a' ? 'p' : 'a'), owes: 'vertical', state, pass: 1,
    ...(state === 'grown' ? { extent: { low: -10, high: 10 } } : {}) });
  const model = {
    nodes: { a: node('a', 200, 'top', 100), p: node('p', options.pGrown ? 200 : 50, 'bottom', options.vertical ? 100 : 20) },
    links: [{ id: 'l', attachments: { from: { node: 'p', anonymous: true, ordinal: 1 }, to: { node: 'a', anonymous: true, ordinal: 1 } } }],
    lanes: options.transit ? [{ id: 't', owner: { kind: 'link', id: 'l' } }] : [],
    alignmentTargets: { 'a|top': [entry('a', options.kept ? 'kept' : 'grown')], ...(options.pGrown ? { 'p|bottom': [entry('p', 'grown')] } : {}) },
    ...(options.spread ? { parentSpreads: { a: {} } } : {}),
  } as unknown as LayoutModel;
  const input = { nodes: { a: node('a', 50, 'top', 20), p: node('p', 50, 'bottom', 20) } } as unknown as LayoutModel;
  return { model, input };
}

describe('the judgement (strandedGrowth)', () => {
  it('gives back a widened body whose targets are grown and none kept', () => {
    const { model, input } = endOfCentre({});
    expect(strandedGrowth(model, input)).toEqual({ a: ['port:["a",true,null,1]'] });
  });
  it('keeps a growth when a target stands, a link stands vertical, or a parent spread grew the body', () => {
    for (const options of [{ kept: true }, { vertical: true }, { spread: true }]) {
      const { model, input } = endOfCentre(options);
      expect(strandedGrowth(model, input), JSON.stringify(options)).toEqual({});
    }
  });
  it('gives back a transit child only with the other end of its transit link', () => {
    const alone = endOfCentre({ transit: true });
    expect(strandedGrowth(alone.model, alone.input)).toEqual({});
    const pair = endOfCentre({ transit: true, pGrown: true });
    expect(Object.keys(strandedGrowth(pair.model, pair.input))).toEqual(['a', 'p']);
  });
  it('R5: the shape check accepts an absent record and refuses a port of another face owner', () => {
    const { model } = endOfCentre({});
    expect(givenBackFault(model)).toBeUndefined();
    model.givenBack = { a: ['port:["p",true,null,1]'] };
    expect(givenBackFault(model)).toMatch(/is no port of the node/);
    model.givenBack = { a: ['port:["a",true,null,1]'] };
    expect(givenBackFault(model)).toBeUndefined();
  });
});
