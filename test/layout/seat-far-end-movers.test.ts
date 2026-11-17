import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/model/index.js';
import { layout, parse } from '../../src/index.js';
import { SEAT_FAR_END_FIXED } from '../../src/layout/seat-set.js';
import { portKey } from '../../src/layout/sides-one.js';
import { PLACEMENT_EPS, SEAT_STANDS_EPS } from '../../src/layout/tolerance.js';
import { moveTrace } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from './phase-two-fixture.js';
import { withMoveBeforeGrow } from './move-before-grow.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 36a, review 1 finding 2: in 7c no mover takes a far end of a standing seat set along. The movers are found, not listed (the
// pattern of ticket 33): the test wraps the centre rule, records every `moveGroup` of a row that carries a far end while the rule runs, and compares
// the x of every far end where the rule began and where it ends (a node move inside a row, `shiftNode`, is no `moveGroup`). A new 7c mover that does
// not read `seatFarEndRefusal` fails it on these sheets. Coverage evidence on the sheets below, not a proof. The test reads the far ends itself, from
// the ledger, so it reads the same on code without the predicate.
const spans: { before: Map<string, number>; after?: Map<string, number>; sets: string[]; kept?: string[]; holdOff: number }[] = [];
const setRows = (model: LayoutModel): string[] => (model.reservations ?? []).flatMap(entry => entry.kind === 'seatSet' ? [entry.payload.row] : []).sort();
const farEnds = (model: LayoutModel): Map<string, number> => {
  const out = new Map<string, number>();
  for (const entry of model.reservations ?? []) if (entry.kind === 'seatSet') {
    for (const eq of [...entry.payload.seats, ...entry.payload.holds]) out.set(`${entry.payload.row}:${eq.far.node}`, model.nodes[eq.far.node]!.bounds!.x);
  }
  return out;
};
/** The groups that carry a far end of a standing set, read from the ledger. */
const farGroups = (model: LayoutModel): Set<string> => new Set([...farEnds(model).keys()].map(key => model.document.nodes[key.split(':')[1]!]!.group));
/** The largest distance between the two anchors of a hold of a standing set (a hold is read to `SEAT_STANDS_EPS` at stage 6). */
const holdOff = (model: LayoutModel): number => {
  const anchor = (ref: { node: string }) => model.nodes[ref.node]!.ports.find(port => portKey(port.ref) === portKey(ref as never))?.anchor?.x ?? NaN;
  let off = 0;
  for (const entry of model.reservations ?? []) if (entry.kind === 'seatSet') for (const eq of entry.payload.holds) off = Math.max(off, Math.abs(anchor(eq.member) - anchor(eq.far)));
  return off;
};
let inCentre = false;
vi.mock('../../src/layout/centre.js', async original => {
  const actual = await original<typeof import('../../src/layout/centre.js')>();
  return {
    ...actual,
    centre: (model: LayoutModel) => {
      const span: (typeof spans)[number] = { before: farEnds(model), sets: setRows(model), holdOff: holdOff(model) };
      inCentre = true;
      try {
        const out = actual.centre(model);
        // Every far end of a set that stood when the rule began, read where the rule leaves its node (a set it withdrew included).
        span.after = new Map([...span.before.keys()].map(key => [key, out.nodes[key.split(':')[1]!]!.bounds!.x])); span.kept = setRows(out);
        return out;
      } finally {
        inCentre = false;
        spans.push(span);
      }
    },
  };
});

const root = fileURLToPath(new URL('../..', import.meta.url));
const SAME_SETS = 'test/fixtures/staged/a-stagger-gate-compares-placements-that-hold-the-same-seat-sets.yaml';
const SHEETS = [
  SAME_SETS,
  'goldens/synthetic/a-compared-placement-holds-the-seat-sets-the-kept-placement-holds.yaml',
  'goldens/synthetic/a-seated-row-and-the-row-below-stand-together.yaml',
  'goldens/synthetic/a-seated-row-leaves-its-lower-row-one-feed.yaml',
  'goldens/synthetic/a-child-row-stands-under-its-parents-ports.yaml',
  'goldens/synthetic/a-seat-keeps-the-ports-it-stands.yaml',
];

describe('no 7c mover takes a far end of a standing seat set along (dense-16x9 ticket 36a)', () => {
  it('keeps every far end at its stage-6 x and records no move of its row', async () => {
    const moves: string[] = [], limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    moveTrace.hook = (model, group, dx) => {
      if (!inCentre || Math.abs(dx) <= 1e-6 || !farGroups(model).has(group.id)) return;
      const frames = (new Error().stack ?? '').split('\n').slice(2).map(line => /at (?:\S+\.)?(\w+) \(/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
      moves.push(`${group.id} ${frames.slice(0, 4).join('<')}`);
    };
    const named: string[] = [];
    try {
      for (const sheet of SHEETS) {
        const model = await layout(parse(readFileSync(join(root, sheet), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
        named.push(...model.diagnostics.filter(d => d.code === SEAT_FAR_END_FIXED).map(d => d.message));
      }
    } finally {
      delete moveTrace.hook;
      Error.stackTraceLimit = limit;
    }
    const standing = spans.filter(span => span.before.size > 0);
    expect(standing.length, 'the sheets reach 7c with a standing seat set').toBeGreaterThan(0);
    const drifted = standing.flatMap(span => [...span.after!].filter(([key, x]) => span.before.has(key) && Math.abs(x - span.before.get(key)!) > 1e-6)
      .map(([key, x]) => `${key} ${(x - span.before.get(key)!).toFixed(1)}`));
    expect({ moves: [...new Set(moves)], drifted: [...new Set(drifted)] }, 'a 7c mover moved a far end of a standing seat set').toEqual({ moves: [], drifted: [] });
    expect(named.length, 'a refused move is named').toBeGreaterThan(0);
  }, 900000);

  // The state-table row of scope V (docs/design/pipeline.md, 7c): every placement, compared or kept, holds the sets of the kept placement.
  it('holds the same seat sets in every placement the stagger gate compares and in the one it keeps', async () => {
    spans.length = 0;
    const model = await layout(parse(readFileSync(join(root, SAME_SETS), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    // The stage-5 stagger gate decided the upstream row: its trials are compared placements of this command.
    expect(model.groupArrangements?.up, 'stage 5 tried the upstream row').toBeDefined();
    expect(spans.length, 'the gate trials and the kept placement each run 7c').toBeGreaterThan(2);
    const kept = setRows(model);
    expect(kept).toEqual(['core#1']);
    for (const span of spans) expect({ began: span.sets, ended: span.kept }).toEqual({ began: kept, ended: kept });
    expect(model.diagnostics.filter(d => d.code === 'SEAT_SET_WITHDRAWN' || (d.code === 'SEAT_SET_DECLINED' && /withdrawn/.test(d.message))).map(d => d.message)).toEqual([]);
  }, 900000);

  // A hold is a vertical a member stood when stage 6 read it, to SEAT_STANDS_EPS; the publication check of the rows rule reads it so too.
  it('publishes a seat set whose hold stands half a pixel off its far port', async () => {
    spans.length = 0;
    const sheet = 'test/fixtures/staged/a-seat-set-hold-half-a-pixel-off-is-published.yaml';
    await layout(parse(readFileSync(join(root, sheet), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const off = Math.max(...spans.map(span => span.holdOff));
    expect(off).toBeGreaterThan(PLACEMENT_EPS);
    expect(off).toBeLessThanOrEqual(SEAT_STANDS_EPS);
  }, 900000);

  // A set withdrawn after 7c keeps its far ends fixed for the rest of the run: 7c held their rows, and the publication replay of the rule that
  // withdrew it reads them as 7c did. Before, the replay centred the far-end row again and refused the run ("Centring invariant violated").
  it('reads the far ends of a set withdrawn after 7c as fixed in the replays of that run', async () => {
    const sheet = withMoveBeforeGrow(readFileSync(join(root, 'goldens/synthetic/a-flank-bundle-into-a-ranked-group-stays-beside-the-frame.yaml'), 'utf8'));
    const model = await layout(parse(sheet), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(d => d.code === 'SEAT_SET_DECLINED' && d.message.includes('withdrawn at bundles')).length).toBe(1);
  }, 900000);
});
