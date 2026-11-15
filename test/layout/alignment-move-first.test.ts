import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { findPort } from '../../src/layout/row-paths.js';
import { createAttempt, placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = readFileSync(new URL('../../goldens/synthetic/a-child-moves-in-row-slack-before-it-grows.yaml', import.meta.url), 'utf8');

it('moves a narrow child under its feed before growing it, and records the kept targets (ADR-0027, R1)', async () => {
  const input = flanks(lanes(rows(await placed(fixture))));
  const model = centre(input);
  for (const id of ['child-a', 'child-b']) {
    expect(model.nodes[id]!.bounds!.width).toBe(input.nodes[id]!.bounds!.width);
    expect(model.alignmentTargets![`${id}|top`]).toEqual([expect.objectContaining({ state: 'kept' })]);
  }
  for (const link of model.links) {
    const from = findPort(model, link.attachments!.from)!, to = findPort(model, link.attachments!.to)!;
    expect(to.anchor!.x).toBeCloseTo(from.anchor!.x, 6);
  }
  expect(model.nodes['parent-a']).toEqual(input.nodes['parent-a']);
  expect(model.nodes['parent-b']).toEqual(input.nodes['parent-b']);
  expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
});

it('keeps all seven vertical links of the ticket-73 nested-stem sheet at the selected cap', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-nested-stem-is-decided-before-its-gap-opens.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(model.links).toHaveLength(7);
  for (const link of model.links) {
    const segments = link.path!.segments, x = segments[0]!.from.x;
    for (const segment of segments) {
      expect(segment.from.x, link.id).toBeCloseTo(x, 6);
      expect(segment.to.x, link.id).toBeCloseTo(x, 6);
    }
  }
  expect(score(model).snapshot.passed).toBe(true);
  expect(model.removedLinks ?? []).toEqual([]);
});
