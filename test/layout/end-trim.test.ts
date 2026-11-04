import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { trimBodies, trimmedBody, untrimmedModel } from '../../src/layout/end-trim.js';
import { portEndInsets } from '../../src/layout/port-insets.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 68, the end trim: after the last x move of 7f a body is trimmed to the span of its ports plus its content, never below
 * its stage-3 size. Ports keep their x and no node moves. The record `bodyTrims` holds the bodies and boxes before the trim, and the centring
 * replay of the publication check reads them (R1).
 */
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: { x: number; width: number }): number => box.x + box.width;
const forge = (model: LayoutModel, edit: (copy: LayoutModel) => void): string => {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  edit(copy);
  return JSON.stringify(copy);
};

describe('a stretched body is trimmed to its ports', () => {
  let model: LayoutModel;
  beforeAll(async () => { model = await run(source('a-stretched-body-is-trimmed-to-its-ports')); }, 120000);

  it('records the stretched body of sink-near and trims it to its outer top ports with their insets', () => {
    const was = model.bodyTrims?.nodes['sink-near'];
    expect(was).toBeDefined();
    const node = model.nodes['sink-near']!, body = node.bounds!;
    expect(body.width).toBeLessThan(was!.width / 4);
    const xs = node.ports.filter(port => port.side === 'top').map(port => port.anchor!.x), inset = portEndInsets(node, 'top');
    expect(body.x).toBeCloseTo(Math.min(...xs) - inset.low, 6);
    expect(right(body)).toBeCloseTo(Math.max(...xs) + inset.high, 6);
  });

  it('moves no node and widens no body or box: each trimmed body and box stands inside the one it had, at the same y and height', () => {
    for (const [id, was] of Object.entries(model.bodyTrims!.nodes)) {
      const body = model.nodes[id]!.bounds!;
      expect(body.x).toBeGreaterThanOrEqual(was.x - 1e-6);
      expect(right(body)).toBeLessThanOrEqual(right(was) + 1e-6);
      expect([body.y, body.height]).toEqual([was.y, was.height]);
      for (const port of model.nodes[id]!.ports) expect(port.anchor!.x).toBeGreaterThanOrEqual(body.x - 1e-6);
    }
    expect(Object.keys(model.bodyTrims!.groups)).toContain('near');
    for (const [id, was] of Object.entries(model.bodyTrims!.groups)) {
      const box = model.groups[id]!.bounds!;
      expect(box.x).toBeGreaterThanOrEqual(was.x - 1e-6);
      expect(right(box)).toBeLessThanOrEqual(right(was) + 1e-6);
    }
  });

  it('is a fixed point: the trim of the untrimmed geometry gives the published bodies and boxes again', () => {
    const back = untrimmedModel(model);
    expect(back.bodyTrims).toBeUndefined();
    for (const [id, was] of Object.entries(model.bodyTrims!.nodes)) expect(back.nodes[id]!.bounds).toEqual(was);
    const again = { ...JSON.parse(JSON.stringify(back)) as LayoutModel, freeze: model.freeze! };
    trimBodies(again);
    expect(again.bodyTrims).toEqual(model.bodyTrims);
    for (const id of Object.keys(model.nodes)) expect(again.nodes[id]!.bounds).toEqual(model.nodes[id]!.bounds);
    for (const id of Object.keys(model.groups)) expect(again.groups[id]!.bounds).toEqual(model.groups[id]!.bounds);
  });

  it('round-trips through the restore API with its record', () => {
    expect(restoreLayoutModel(JSON.stringify(model)).bodyTrims).toEqual(model.bodyTrims);
  });

  it('refuses a forged record: a node that is not the trim of its recorded body, a widened box, a record that names no node', () => {
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.nodes['sink-near']!.x -= 400; copy.bodyTrims!.nodes['sink-near']!.width -= 400; })))
      .toThrow(/end trim record is forged: node sink-near/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.groups['near']!.width = 1; })))
      .toThrow(/end trim record is forged: group near/);
    expect(() => restoreLayoutModel(forge(model, copy => { copy.bodyTrims!.nodes = {}; }))).toThrow(/end trim record is forged: malformed/);
  });

  it('gives a body with no room to trim no new body', () => {
    const node = model.nodes['sink-near']!;
    expect(trimmedBody(model, 'sink-near', node.bounds!)).toBeUndefined();
  });
});

describe('the centring replay reads the bodies the producer decided on (R1)', () => {
  // One of the four synthetics the prototype's trim was refused on: with the trimmed siblings the replay kept a target the producer could not keep.
  let model: LayoutModel;
  beforeAll(async () => { model = await run(source('a-stem-of-a-link-that-turns-straight-does-not-block-a-chord')); }, 120000);

  it('publishes trimmed, and its restore reads the record', () => {
    expect(Object.keys(model.bodyTrims?.nodes ?? {}).length).toBeGreaterThan(0);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  });

  it('without the record, the replay reads the trimmed bodies and refuses them', () => {
    expect(() => restoreLayoutModel(forge(model, copy => { delete copy.bodyTrims; }))).toThrow(/Centring invariant violated/);
  });
});

describe('a sheet with nothing to trim', () => {
  it('carries no record (absent = no body trimmed)', async () => {
    const model = await run(source('a-bar-end-keeps-its-corridor'));
    expect(model.bodyTrims).toBeUndefined();
  });
});
