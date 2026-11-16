import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * A seat that a later rule withdraws names the alignment it opens (ADR-0027 with `layout.moveBeforeGrow`, dense-16x9 ticket 02; ticket 75).
 * While a seat stands, its body pulls only through its kept feeds, so a feed it left out is not open; when a rule withdraws the seat, the
 * replay reads every feed again. Where the centre step recorded a stall, the open alignments are named again on the record the rule publishes,
 * so the record and its replay read one seat record (R1).
 *
 * The sheet is test data, not a golden: `target` is seated on `b` and `c` at 7c, the inverted bundle from `source` doubles the pitch of the
 * face at 7e and 7f, the seat falls, and the left-out feed of `f2` is open (the layout removes link-5, ticket 19).
 */
const SHEET = `portograph: 2
profile: network
layout: { moveBeforeGrow: true, feedOrder: false, farEndPull: false }
groups:
  upper: { tier: 0 }
  lower: { tier: 1 }
nodes:
  source:
    group: upper
    ports:
      - { name: p, side: bottom, order: 1 }
      - { name: p, side: bottom, order: 2 }
      - { name: p, side: bottom, order: 3 }
  pad: { group: upper, label: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx }
  rB: { group: upper, ports: [{ name: q, side: bottom }] }
  f2: { group: upper }
  target:
    group: lower
    ports:
      - { name: b, side: top, order: 0 }
      - { name: c, side: top, order: 0 }
      - { name: p, side: top, order: 1 }
      - { name: p, side: top, order: 2 }
      - { name: p, side: top, order: 3 }
links:
  - [source.p#1, target.p#2, { route: bundle }]
  - [source.p#2, target.p#1, { route: bundle }]
  - [source.p#3, target.p#3, { route: bundle }]
  - [rB.q, target.b]
  - [f2, target.c]
`;

describe('a withdrawn seat names the alignment it opens', () => {
  it('publishes with the seat withdrawn, names the opened link open, and restores', async () => {
    const model = await layout(parse(SHEET), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.alignmentSeats?.['target']).toBeUndefined();
    const open = model.diagnostics.filter(item => item.code === 'CENTRE_ALIGNMENT_OPEN').flatMap(item => (item.owners ?? []).flatMap(owner => owner.kind === 'link' ? [owner.id] : []));
    expect(open).toContain('link-5');
    expect(() => restoreLayoutModel(JSON.stringify(model))).not.toThrow();
  }, 120000);
});
