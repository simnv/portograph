import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { orderByCorridors, ROW_ORDER_PERMUTED_NODES, validateRowOrderDecisions } from '../../src/layout/corridor-order.js';
import { corridorSide } from '../../src/layout/lanes.js';
import { readDraft, reseatRow } from '../../src/layout/overlay-order.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/a-row-turns-to-clear-a-corridor.yaml', import.meta.url), 'utf8');
/** The same sheet with every row in its declared order. */
const declared = fixture.replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** Stage 4 only: the skeleton with its row order decisions. */
const skeletonOf = async (yaml: string): Promise<LayoutModel> => {
  const model = sizeNodes(sidesOne(resolve(parse(yaml))));
  await skeleton(model, { createAttempt });
  return model;
};
const bends = (model: LayoutModel): number => { const { routed, overlay } = score(model).snapshot.counts; return routed.turns + overlay.turns; };

describe('the row order counts the corridors through the row (architecture-2 ticket 17)', () => {
  it('turns the two rows whose order the corridors cross, and the sheet gains on crossings, bends and canvas', async () => {
    const [turned, kept] = await Promise.all([run(fixture), run(declared)]);
    expect(turned.groups.top!.rowOrderDecision).toEqual({ rule: 'corridor-crossings', before: ['t0', 't1'], after: ['t1', 't0'] });
    expect(turned.groups.upper!.rowOrderDecision).toEqual({ rule: 'corridor-crossings', before: ['u0', 'u1'], after: ['u1', 'u0'] });
    expect(turned.groups.middle!.rowOrderDecision).toEqual({ rule: 'kept', before: ['m0', 'm1'], after: ['m0', 'm1'] });
    expect(kept.groups.top!.rowOrderDecision).toEqual({ rule: 'author', before: ['t0', 't1'], after: ['t0', 't1'] });
    const [one, two] = [score(turned).snapshot, score(kept).snapshot];
    expect(one.metrics.crossings.count).toBe(1);
    expect(two.metrics.crossings.count).toBe(2);
    expect(bends(turned)).toBeLessThan(bends(kept));
    expect(one.canvas!.width * one.canvas!.height).toBeLessThan(two.canvas!.width * two.canvas!.height);
    expect(Object.values(one.gates).filter(gate => gate.severity === 'error' && gate.violations.length)).toEqual([]);
  }, 120000);

  it('keeps the result when the links are listed the other way round (R3)', async () => {
    const lines = fixture.split('\n'), at = lines.indexOf('links:');
    const reversed = [...lines.slice(0, at + 1), ...lines.slice(at + 1).filter(line => line.trim()).reverse(), ''].join('\n');
    const [one, two] = await Promise.all([run(fixture), run(reversed)]);
    const boxes = (model: LayoutModel) => Object.values(model.nodes).map(node => [node.id, node.bounds]).sort();
    expect(boxes(two)).toEqual(boxes(one));
  }, 120000);

  it('records a decision on every free row and none on a row it does not decide', async () => {
    const model = await skeletonOf(`portograph: 2
groups:
  top: { tier: 0 }
  mid: { tier: 1 }
  low: { tier: 2 }
  side: { align: right, of: mid }
nodes:
  a: { group: top }
  b: { group: top }
  m: { group: mid }
  n: { group: mid }
  s: { group: side }
  x: { group: low }
  y: { group: low }
links: [[a, m], [b, n], [m, x], [n, y], [a, y], [n, s]]`);
    // A row the order decides carries the record, also when it keeps its order; the flanked row and the flank do not.
    expect(model.groups.top!.rowOrderDecision).toBeDefined();
    expect(model.groups.low!.rowOrderDecision).toBeDefined();
    expect(model.groups.mid!.rowOrderDecision).toBeUndefined();
    expect(model.groups.side!.rowOrderDecision).toBeUndefined();
    expect(validateRowOrderDecisions(model)).toEqual([]);
  }, 60000);

  it('validates the row against the record and never searches again (R1, R5)', async () => {
    const model = await skeletonOf(fixture);
    expect(validateRowOrderDecisions(model)).toEqual([]);
    // A forged order: the row stands in an order its record does not name.
    const forged = copy(model);
    forged.groups.top!.rowOrderDecision = { rule: 'corridor-crossings', before: ['t1', 't0'], after: ['t0', 't1'] };
    expect(validateRowOrderDecisions(forged)).toContain('Group top stands in an order its row order decision does not name');
    // `kept` with two different orders, and `author` without the setting.
    const contradicted = copy(model);
    contradicted.groups.upper!.rowOrderDecision = { rule: 'kept', before: ['u0', 'u1'], after: ['u1', 'u0'] };
    contradicted.groups.middle!.rowOrderDecision = { rule: 'author', before: ['m0', 'm1'], after: ['m0', 'm1'] };
    expect(validateRowOrderDecisions(contradicted)).toEqual([
      'The row order decision of upper is kept, and its before and after orders contradict it',
      'The row order decision of middle is author, and the document setting corridorRowOrder contradicts it',
    ]);
    // A record on a node set that is not the row's own.
    const foreign = copy(model);
    foreign.groups.middle!.rowOrderDecision = { rule: 'kept', before: ['m0', 'b0'], after: ['m0', 'b0'] };
    expect(validateRowOrderDecisions(foreign)).toContain('The row order decision of middle names nodes that are not its own');
    // Absent on a free row is an error: the step decides every free row of two or more nodes.
    const absent = copy(model);
    delete absent.groups.base!.rowOrderDecision;
    expect(validateRowOrderDecisions(absent)).toEqual(['Free row base has no row order decision']);
  }, 60000);

  it('judges a long row in its adjacent swaps only, and names the cap', async () => {
    // The base is the anchor tier (the most nodes), so the wide row is a row the sweep orders.
    const nodes = Array.from({ length: ROW_ORDER_PERMUTED_NODES + 1 }, (_, i) => `w${i}`), base = Array.from({ length: nodes.length + 2 }, (_, i) => `z${i}`);
    const model = await skeletonOf(`portograph: 2
groups:
  top: { tier: 0 }
  wide: { tier: 1 }
  low: { tier: 2 }
  base: { tier: 3 }
nodes:
  a: { group: top }
  b: { group: top }
${nodes.map(id => `  ${id}: { group: wide }`).join('\n')}
  x: { group: low }
${base.map(id => `  ${id}: { group: base }`).join('\n')}
links: [${nodes.map(id => `[a, ${id}]`).join(', ')}, [b, x], ${base.map(id => `[x, ${id}]`).join(', ')}]`);
    expect(model.diagnostics.filter(item => item.code === 'ROW_ORDER_SEARCH_CAPPED').map(item => [item.severity, item.message]))
      .toEqual([['info', `The corridor row order judged fewer candidates: row wide has ${nodes.length} nodes, so only its adjacent swaps were judged.`]]);
    expect(validateRowOrderDecisions(model)).toEqual([]);
  }, 60000);

  it('changes nothing in a sheet without a transit link, and records every free row as kept', async () => {
    const model = await skeletonOf(`portograph: 2
groups:
  top: { tier: 0 }
  low: { tier: 1 }
nodes:
  a: { group: top }
  b: { group: top }
  x: { group: low }
  y: { group: low }
links: [[a, y], [b, x]]`);
    const before = copy(model);
    orderByCorridors(model);
    expect(model.groups.top!.rowOrderDecision).toEqual({ rule: 'kept', before: before.groups.top!.rowOrder, after: before.groups.top!.rowOrder });
    expect(Object.values(model.nodes).map(node => node.bounds)).toEqual(Object.values(before.nodes).map(node => node.bounds));
  }, 60000);

  it('reads every transit link as one diagonal under layout.corridorRowOrder: false, as main did', async () => {
    const [on, off] = await Promise.all([skeletonOf(fixture), skeletonOf(declared)]);
    const turned = readDraft(on)!.measureRange(0, 3, true).crossings;
    // The same declared order on both: `on` is turned by the step, so it is put back first.
    for (const [group, order] of [['top', ['t0', 't1']], ['upper', ['u0', 'u1']]] as const) expect(reseatRow(on, on.groups[group]!, [...order], true)).toBe(true);
    // Cut at their corridors and read at their ports, the links of the declared order cross 3 times (the two transit links cross two
    // feeds, and one more pair crosses at a shared node), once with the rows turned; read as diagonals between body centres, once.
    expect(readDraft(on)!.measureRange(0, 3, true).crossings).toBe(3);
    expect(turned).toBe(1);
    expect(readDraft(off)!.measureRange(0, 3, true).crossings).toBe(1);
  }, 60000);

  it('reads each link end at the port sides-two gives it, so links that share a node can cross there (follow-up)', async () => {
    const shared = readFileSync(new URL('../../goldens/synthetic/a-shared-end-reads-its-port-order.yaml', import.meta.url), 'utf8');
    const [model, plain] = await Promise.all([skeletonOf(shared), skeletonOf(shared.replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n'))]);
    expect(model.groups.src!.rowOrderDecision).toEqual({ rule: 'kept', before: ['src0', 'src1'], after: ['src0', 'src1'] });
    const declaredCount = readDraft(model)!.measureRange(0, 2, true).crossings;
    expect(reseatRow(model, model.groups.src!, ['src1', 'src0'], true)).toBe(true);
    const turnedCount = readDraft(model)!.measureRange(0, 2, true).crossings;
    // At the predicted ports the turn gains nothing; at the body centres it showed a gain of one.
    expect(turnedCount).toBeGreaterThanOrEqual(declaredCount);
    expect(declaredCount).toBe(23);
    expect(turnedCount).toBe(23);
    expect(plain.groups.src!.rowOrderDecision!.rule).toBe('author');
  }, 60000);

  it('seats a port on its sizing side where stage 2 left the side open: a bus port shares the face (follow-up review)', async () => {
    const bus = readFileSync(new URL('../../goldens/synthetic/a-bus-leaves-a-title-edge-with-more-legs.yaml', import.meta.url), 'utf8');
    const model = await skeletonOf(bus);
    const [feed, member] = model.nodes.n1!.ports;
    // At stage 4 the mesh-bus port has only its sizing side; the feed from `core` has its side.
    expect([feed!.side, member!.side, member!.sizingSide]).toEqual(['top', undefined, 'top']);
    const draft = readDraft(model)!, centre = model.nodes.n1!.bounds!.x + model.nodes.n1!.bounds!.width / 2, pitch = model.nodes.n1!.sidePitch!.top!;
    // Two ports on the top face, the bus port last (`sortFace`): the feed half a pitch left of the centre, not on it.
    expect(draft.portX(feed!.ref)).toBeCloseTo(centre - pitch / 2, 6);
    expect(draft.portX(member!.ref)).toBeCloseTo(centre + pitch / 2, 6);
  }, 60000);

  it('the overlay order judges the routed crossings at the predicted ports: an authored port order at a shared node (follow-up review)', async () => {
    // `s` takes the feed of `a` on its left port and that of `b` on its right one (authored `order:`). With `mid` turned the feeds
    // cross at `s`. `measure` is what `orderByOverlay` judges a re-order by; at one body centre the two feeds never crossed.
    const yaml = `portograph: 2
groups:
  top: { tier: 0 }
  mid: { tier: 1 }
  low: { tier: 2 }
nodes:
  t0: { group: top, class: server }
  t2: { group: top, class: server }
  a: { group: mid, class: server }
  b: { group: mid, class: server }
  s: { group: low, class: server, ports: [{ name: p1, side: top, order: 1 }, { name: p2, side: top, order: 2 }] }
links:
  - [a, s.p1]
  - [b, s.p2]
  - [t2, a, { route: overlay }]
`;
    const judge = async (sheet: string): Promise<[number, number]> => {
      const model = await skeletonOf(sheet);
      expect(model.groups.mid!.rowOrder).toEqual(['a', 'b']);
      const before = readDraft(model)!.measure(1).crossings;
      expect(reseatRow(model, model.groups.mid!, ['b', 'a'], true)).toBe(true);
      return [before, readDraft(model)!.measure(1).crossings];
    };
    expect(await judge(yaml)).toEqual([0, 1]);
    expect(await judge(yaml.replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n'))).toEqual([0, 0]);
  }, 60000);

  it('passes a transited box on the side of the target where it is known, else on the side of the source (7a)', () => {
    const core = { x: 100, y: 0, width: 100, height: 40 };
    expect(corridorSide(core, 120)).toBe('left');
    expect(corridorSide(core, 180)).toBe('right');
    expect(corridorSide(core, 120, 400)).toBe('right');
    expect(corridorSide(core, 180, 0)).toBe('left');
  });
});

describe('a row pulls a member toward its link\'s far end (architecture-2 ticket 22)', () => {
  const pulled = readFileSync(new URL('../../goldens/synthetic/a-row-member-passes-unlinked-peers-toward-its-far-end.yaml', import.meta.url), 'utf8');

  it('moves lb past the unlinked members to stand next to fe2, and records the order the search left', async () => {
    const model = await skeletonOf(pulled);
    const decision = model.groups.front!.rowOrderDecision!;
    expect(decision.rule).toBe('kept');
    expect(decision.pulledFrom).toEqual(['fe1', 'fe2', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'lb']);
    expect(decision.after).toEqual(['fe1', 'fe2', 'lb', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    expect(validateRowOrderDecisions(model)).toEqual([]);
  }, 60000);

  it('serves the member whose link would bend, and keeps a member whose far node another member feeds (a-row-stretches, user 2026-10-24)', async () => {
    const text = readFileSync(new URL('../../goldens/synthetic/a-row-stretches-a-body-past-its-sibling.yaml', import.meta.url), 'utf8');
    const decision = (await skeletonOf(text)).groups.top!.rowOrderDecision!;
    // n1 is fed by rB and rA, so neither is pulled. s1 will stand past rA once 7c stretches n1 under both, so f1 passes f2 toward it, and
    // then rA: rA moves one slot and still stands over n1, so its three links stay straight (user, 2026-10-24: "move f1 to the right side").
    expect(decision.pulledFrom).toEqual(['rB', 'f1', 'f2', 'rA']);
    expect(decision.after).toEqual(['rB', 'f2', 'rA', 'f1']);
    expect(decision.pulled).toEqual(['f1']);
  }, 60000);

  it('passes a linked peer whose links stay straight one slot away, and never a peer with a link to a band farther off', async () => {
    const text = readFileSync(new URL('../../goldens/synthetic/a-bent-member-passes-a-linked-peer-whose-links-stay-straight.yaml', import.meta.url), 'utf8');
    const model = await skeletonOf(text);
    const decision = model.groups.top!.rowOrderDecision!;
    expect(decision.pulledFrom).toEqual(['f1', 'rA']);
    expect(decision.after).toEqual(['rA', 'f1']);
    expect(decision.pulled).toEqual(['f1']);
    expect(validateRowOrderDecisions(model)).toEqual([]);
    // A link of rA to a band two tier gaps off is no link a chord or a straight drop takes from the row: rA keeps its place.
    const far = text.replace('  low: { tier: 1, label: Low }\n', '  low: { tier: 1, label: Low }\n  far: { tier: 2, label: Far }\n')
      .replace('  s1: { group: low, label: S1 }\n', '  s1: { group: low, label: S1 }\n  z: { group: far, label: Z }\n')
      .replace('- [f1, s1]\n', '- [f1, s1]\n- [rA, z]\n');
    expect(far).toContain('[rA, z]');
    expect((await skeletonOf(far)).groups.top!.rowOrderDecision!.after).toEqual(['f1', 'rA']);
  }, 60000);

  it('pulls nothing when the author keeps the declared order', async () => {
    const model = await skeletonOf(pulled.replace('portograph: 2\n', 'portograph: 2\nlayout: { corridorRowOrder: false }\n'));
    const decision = model.groups.front!.rowOrderDecision!;
    expect(decision.rule).toBe('author');
    expect(decision.pulledFrom).toBeUndefined();
    expect(decision.after.at(-1)).toBe('lb');
  }, 60000);

  it('pulls nothing under its own key, farEndPull: false, and the corridor row order still decides the row', async () => {
    const model = await skeletonOf(pulled.replace('portograph: 2\n', 'portograph: 2\nlayout: { farEndPull: false }\n'));
    const decision = model.groups.front!.rowOrderDecision!;
    expect(decision.rule).toBe('kept');
    expect(decision.pulledFrom).toBeUndefined();
    expect(decision.after.at(-1)).toBe('lb');
    expect(validateRowOrderDecisions(model)).toEqual([]);
    // A pull recorded under the setting is refused.
    const forged = copy(model);
    forged.groups.front!.rowOrderDecision = { ...decision, pulledFrom: [...decision.after], pulled: ['lb'], after: ['fe1', 'fe2', 'lb', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'] };
    forged.groups.front!.rowOrder = forged.groups.front!.rowOrderDecision.after;
    expect(validateRowOrderDecisions(forged)).toContain('The row order decision of front records a far-end pull, and the document setting farEndPull is false');
  }, 60000);

  it('refuses a pull record that moves a linked member past another, or names no move (R5)', async () => {
    const model = await skeletonOf(pulled);
    // The fixture of the linked peer: f1 passes rA, and the record names f1 as the member it served.
    const peer = await skeletonOf(readFileSync(new URL('../../goldens/synthetic/a-bent-member-passes-a-linked-peer-whose-links-stay-straight.yaml', import.meta.url), 'utf8'));
    // A linked member moves one slot: two pulled members never both pass it.
    const twice = copy(model), us = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    twice.groups.front!.rowOrder = ['fe2', 'fe1', 'lb', ...us];
    twice.groups.front!.rowOrderDecision = { ...twice.groups.front!.rowOrderDecision!, pulledFrom: ['fe1', 'lb', 'fe2', ...us], pulled: ['fe1', 'lb'], after: ['fe2', 'fe1', 'lb', ...us] };
    expect(validateRowOrderDecisions(twice)).toContain('The far-end pull of front is recorded on orders it cannot give');
    const once = copy(twice);
    once.groups.front!.rowOrderDecision = { ...once.groups.front!.rowOrderDecision!, pulledFrom: ['fe1', 'fe2', 'lb', ...us] };
    expect(validateRowOrderDecisions(once).filter(error => error.includes('far-end pull'))).toEqual([]);
    const half = copy(peer);
    delete half.groups.top!.rowOrderDecision!.pulled;
    expect(validateRowOrderDecisions(half)).toContain('The far-end pull of top records only one of its order and its members');
    const swapped = copy(model);
    const order = ['fe2', 'fe1', 'lb', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    swapped.groups.front!.rowOrder = order;
    swapped.groups.front!.rowOrderDecision = { ...swapped.groups.front!.rowOrderDecision!, after: order };
    expect(validateRowOrderDecisions(swapped)).toContain('The far-end pull of front is recorded on orders it cannot give');
    const still = copy(model);
    still.groups.front!.rowOrderDecision = { ...still.groups.front!.rowOrderDecision!, pulledFrom: [...still.groups.front!.rowOrderDecision!.after] };
    expect(validateRowOrderDecisions(still)).toContain('The far-end pull of front is recorded on orders it cannot give');
  }, 60000);
});
