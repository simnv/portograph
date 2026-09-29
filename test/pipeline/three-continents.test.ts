import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const source = readFileSync(new URL('../../goldens/synthetic/three-continents.yaml', import.meta.url), 'utf8');
const run = (text: string) => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const holds = (outer: Rect, inner: Rect): boolean => outer.x <= inner.x + 1e-6 && right(outer) >= right(inner) - 1e-6 && outer.y <= inner.y + 1e-6 && bottom(outer) >= bottom(inner) - 1e-6;
const frameOf = (model: LayoutModel, id: string) => model.frames!.find(frame => frame.id === id)!;

describe('three continents (canton-groups ticket 58, fixture 10)', () => {
  it('three canton frames a band gap apart, clients under their own canton, top row keeps its order and spacing', async () => {
    const model = await run(source);
    expect(model.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    const cantons = ['a', 'b', 'c'].map(id => frameOf(model, id));
    for (const canton of cantons) expect(canton.kind).toBe('canton');
    const ordered = [...cantons].sort((left, next) => left.box.x - next.box.x);
    for (let i = 1; i < ordered.length; i++) {
      expect(Math.abs(ordered[i]!.box.x - right(ordered[i - 1]!.box) - bandGap(model)), `gap ${i}`).toBeLessThan(1e-6);
    }
    for (const canton of ['a', 'b', 'c']) {
      for (const tier of [3, 4]) {
        const client = frameOf(model, `cl-${canton}${tier}`);
        expect(client.parent).toBe(canton);
        expect(holds(frameOf(model, canton).box, client.box), `cl-${canton}${tier} inside ${canton}`).toBe(true);
      }
    }
    expect(frameOf(model, 'zone-a1').parent).toBe('loc-a1');
    expect(score(model).snapshot.gates.G9.passed).toBe(true);

    // The same input without the canton keys.
    const lines = source.split('\n').filter(line => !/^ {2}[abc]: \{ label: Canton/.test(line));
    const stripped = await run(lines.map(line => line.replace(/ canton: [abc],/, '')).join('\n'));
    expect(stripped.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(stripped.frames!.some(frame => frame.kind === 'canton')).toBe(false);
    // Measured: the top row keeps its spacing but shifts as a whole (133.3 px on this input), because its partners, the tier-2
    // locations, stand at other x with a canton around them (ticket 58, "Comments"). The row is not re-ordered or re-spaced.
    const tops = Object.keys(stripped.nodes).filter(id => /^t[123]-/.test(id));
    const shifts = tops.map(id => model.nodes[id]!.bounds!.x - stripped.nodes[id]!.bounds!.x);
    expect(tops.length).toBe(10);
    for (const shift of shifts) expect(Math.abs(shift - shifts[0]!), 'the top row moves as a whole').toBeLessThanOrEqual(0.5);
  }, 120000);
});
