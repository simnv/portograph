import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { measurePortPill } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { gateFailures } from './open-min-separation.js';

// Ticket 156: at 9 px, pill text of about five characters reaches past the 15 px stem. The stem tip moves beyond the text,
// so the run that leaves the tip does not start under it, and G3 passes.
it('a stem tip stands beyond the pill text of its side, and the text meets no run of its link', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-stem-tip-stands-beyond-its-pill-text.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(gateFailures(score(model).snapshot)).toEqual([]);
  const reach = measurePortPill('trunk0').text.width / 2;
  expect(reach, 'the premise: the text reaches within 1 px of the 15 px stem').toBeGreaterThan(14);
  const link = model.links.find(item => item.attachments?.to.node === 'host-1')!;
  const anchor = model.nodes['host-1']!.ports[0]!.anchor!;
  const stem = link.path!.segments.at(-1)!;
  expect(stem.from.x).toBeCloseTo(anchor.x, 6);
  // Half the 1.5 px routed stroke and the 0.25 px entry tolerance beyond the text.
  expect(anchor.y - stem.from.y, 'the last run starts beyond the text').toBeCloseTo(Math.max(15, reach + 0.75 + 0.25), 6);
});

// The review of ticket 156: a pass-by stem reserves its row gap from the same side depth, so its turn clears the pill text and the neighbour.
it('a pass-by stem turns beyond its pill text, and the row gap holds the turn', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-pass-by-stem-turns-beyond-its-pill-text.yaml', import.meta.url), 'utf8');
  const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
  expect(gateFailures(score(model).snapshot)).toEqual([]);
  const reach = measurePortPill('uplink-001').text.width / 2;
  expect(reach, 'the premise: the text reaches past the 15 px stem').toBeGreaterThan(15);
  const anchor = model.nodes['a']!.ports[0]!.anchor!;
  const stem = model.links.find(item => item.attachments?.from.node === 'a')!.path!.segments[0]!;
  expect(stem.from).toEqual(anchor);
  expect(stem.to.x - anchor.x, 'the stem turns beyond the text').toBeCloseTo(reach + 0.75 + 0.25, 6);
});
