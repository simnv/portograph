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

  it('passes a transited box on the side of the target where it is known, else on the side of the source (7a)', () => {
    const core = { x: 100, y: 0, width: 100, height: 40 };
    expect(corridorSide(core, 120)).toBe('left');
    expect(corridorSide(core, 180)).toBe('right');
    expect(corridorSide(core, 120, 400)).toBe('right');
    expect(corridorSide(core, 180, 0)).toBe('left');
  });
});
