import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { standsBySeatMove } from '../../src/layout/alignment-targets.js';
import { findPort } from '../../src/layout/row-paths.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// ADR-0027, review 1 of dense-16x9 ticket 02: the restore check reads the seat record whole (R1, R5).
const sheet = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const publish = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('the restore check of the seat record (ADR-0027)', () => {
  it('refuses a seat whose kept port stands off its feed, also where the centring replay excuses the link (a held cross chord)', async () => {
    const model = await publish(sheet('a-seat-keeps-the-ports-it-stands'));
    expect(model.document.layout?.moveBeforeGrow).toBe(true);
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
    // snk1 has no seat; its port of link-2 stands far from the feed of link-2.
    expect(model.alignmentSeats!.snk1).toBeUndefined();
    const link = model.links.find(item => item.id === 'link-2')!;
    const end = [link.attachments!.from, link.attachments!.to].find(item => item.node === 'snk1')!;
    const other = [link.attachments!.from, link.attachments!.to].find(item => item.node !== 'snk1')!;
    expect(Math.abs(findPort(model, end)!.anchor!.x - findPort(model, other)!.anchor!.x)).toBeGreaterThan(100);
    const forged = structuredClone(model), width = model.nodes.snk1!.bounds!.width;
    forged.alignmentSeats!.snk1 = { dx: 10, from: width, width, at: 0, ports: [portId(findPort(model, end)!.ref)], pass: 1 };
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/alignment seat record is forged: snk1: the kept port/);
  }, 120000);

  it('refuses a seat record in a model without layout.moveBeforeGrow, and no reader takes a seat from one', async () => {
    const model = await publish(sheet('a-body-grows-no-further-than-the-alignment-cap').replace('layout: { moveBeforeGrow: true', 'layout: { moveBeforeGrow: false'));
    expect(model.alignmentSeats).toBeUndefined();
    const link = model.links.find(item => item.layer === 'routed')!, end = link.attachments!.from, width = model.nodes[end.node]!.bounds!.width;
    const forged = structuredClone(model);
    forged.alignmentSeats = { [end.node]: { dx: 10, from: width, width, at: 0, ports: [portId(findPort(model, end)!.ref)], pass: 1 } };
    expect(standsBySeatMove(forged, link)).toBe(false);
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/alignment seat record is forged: a record without layout.moveBeforeGrow/);
  }, 120000);
});
