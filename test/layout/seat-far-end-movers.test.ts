import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/model/index.js';
import { layout, parse } from '../../src/index.js';
import { SEAT_SET_WITHDRAWN, SEAT_WALL_COLUMN } from '../../src/layout/seat-set.js';
import { overlayFreeGroups } from '../../src/layout/columns.js';
import { portKey } from '../../src/layout/sides-one.js';
import { SEAT_STANDS_EPS } from '../../src/layout/tolerance.js';
import { seatSetFault } from '../../src/layout/reservations.js';
import { moveTrace } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from './phase-two-fixture.js';
import { withMoveBeforeGrow } from './move-before-grow.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 36a, ruling 3 on review 1 finding 2: in 7c a far end of a standing seat set moves only with its set, as a whole, inside the
// set's room. The movers are found, not listed (the pattern of ticket 33): the test wraps the centre rule and records every `moveGroup` of a row that
// carries a far end while the rule runs, with whether a judge is on its call stack (a top-level function of `src/` that calls `seatFarEndRange`,
// `farEndRange`, `farEndRangeOutside` or `holdFarEnds`). It also reads the far ports of every set that stood when the rule began: a set still
// standing keeps their offsets, and no set is withdrawn on the wall of its frame column. The overlay window moves only the groups
// `overlayFreeGroups` lists, and its guard reads the range; the test checks that the list holds no far-end row when the rule begins and ends. A new
// 7c mover that does not read the range fails it on these sheets. Coverage evidence on the sheets below, not a proof. The test reads the far ends
// itself, from the ledger.
const spans: { before: Map<string, Map<string, number>>; after?: Map<string, Map<string, number>>; sets: string[]; kept?: string[]; walls: string[]; free: string[] }[] = [];
const setRows = (model: LayoutModel): string[] => (model.reservations ?? []).flatMap(entry => entry.kind === 'seatSet' ? [entry.payload.row] : []).sort();
/** The x of each far port of each standing set, by row. */
const farPorts = (model: LayoutModel): Map<string, Map<string, number>> => {
  const out = new Map<string, Map<string, number>>();
  for (const entry of model.reservations ?? []) if (entry.kind === 'seatSet') {
    out.set(entry.payload.row, new Map([...entry.payload.seats, ...entry.payload.holds].map(eq => [portKey(eq.far), model.nodes[eq.far.node]!.ports.find(port => portKey(port.ref) === portKey(eq.far))!.anchor!.x])));
  }
  return out;
};
/** The groups that carry a far end of a standing set, read from the ledger. */
const farGroups = (model: LayoutModel): Set<string> => new Set((model.reservations ?? []).flatMap(entry => entry.kind === 'seatSet'
  ? [...entry.payload.seats, ...entry.payload.holds].map(eq => model.document.nodes[eq.far.node]!.group) : []));
const walled = (model: LayoutModel): string[] => model.diagnostics.filter(d => d.code === SEAT_SET_WITHDRAWN && d.message.includes(SEAT_WALL_COLUMN)).map(d => d.message);
/** The far-end rows the overlay window would take as free. */
const freeFar = (model: LayoutModel): string[] => { const far = farGroups(model); return [...overlayFreeGroups(model, model.anchorTier)].filter(id => far.has(id)).sort(); };
const root0 = fileURLToPath(new URL('../..', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).sort().flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []; });
/** The top-level functions of `src/` that read the far-end range, read as the box writer lint reads its call sites. */
function judges(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(join(root0, 'src'))) {
    let fn = '';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const head = /^(?:export )?(?:async )?function\*? ?(\w+)/.exec(line) ?? /^(?:export )?const (\w+)\s*(?::[^=]*)?=/.exec(line);
      if (head) fn = head[1]!;
      if (/\b(seatFarEndRange|farEndRange|farEndRangeOutside|holdFarEnds)\(/.test(line) && !/function (seatFarEndRange|farEndRange|farEndRangeOutside|holdFarEnds)\(/.test(line)) found.add(fn);
    }
  }
  return found;
}
let inCentre = false;
vi.mock('../../src/layout/centre.js', async original => {
  const actual = await original<typeof import('../../src/layout/centre.js')>();
  return {
    ...actual,
    centre: (model: LayoutModel) => {
      const span: (typeof spans)[number] = { before: farPorts(model), sets: setRows(model), walls: [], free: freeFar(model) };
      inCentre = true;
      try {
        const out = actual.centre(model);
        span.after = farPorts(out); span.kept = setRows(out); span.walls = walled(out); span.free.push(...freeFar(out));
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
  it('moves a far-end row only under a judge, keeps the offsets of the far ports of every set, and withdraws none on the column wall', async () => {
    const judged = judges();
    expect([...judged]).toEqual(expect.arrayContaining(['centreGroupStep', 'settleRows', 'packClear', 'standNearFeed', 'spreadParent', 'place', 'stepOverChords']));
    const moves = new Map<string, boolean>(), limit = Error.stackTraceLimit;
    Error.stackTraceLimit = Infinity;
    moveTrace.hook = (model, group, dx) => {
      if (!inCentre || Math.abs(dx) <= 1e-6 || !farGroups(model).has(group.id)) return;
      const frames = (new Error().stack ?? '').split('\n').slice(2).map(line => /at (?:\S+\.)?(\w+) \(/.exec(line)?.[1]).filter((name): name is string => name !== undefined);
      const key = `${group.id} ${frames.slice(0, 3).join('<')}`;
      moves.set(key, (moves.get(key) ?? false) || !frames.some(name => judged.has(name)));
    };
    spans.length = 0;
    try {
      for (const sheet of SHEETS) await layout(parse(readFileSync(join(root, sheet), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    } finally {
      delete moveTrace.hook;
      Error.stackTraceLimit = limit;
    }
    const standing = spans.filter(span => span.before.size > 0);
    expect(standing.length, 'the sheets reach 7c with a standing seat set').toBeGreaterThan(0);
    expect(moves.size, 'the sheets move a far-end row in 7c').toBeGreaterThan(0);
    const unjudged = [...moves].filter(([, open]) => open).map(([key]) => key);
    // A set that stands at the end of the rule keeps the offsets of its far ports: they moved as one.
    const torn = standing.flatMap(span => [...span.after!].filter(([row]) => span.before.has(row)).flatMap(([row, now]) => {
      const was = span.before.get(row)!, shifts = [...now].map(([key, x]) => x - was.get(key)!);
      return shifts.every(shift => Math.abs(shift - shifts[0]!) <= 1e-6) ? [] : [`${row} ${shifts.map(shift => shift.toFixed(1)).join(',')}`];
    }));
    expect({ unjudged, torn, walls: standing.flatMap(span => span.walls), free: standing.flatMap(span => span.free) }).toEqual({ unjudged: [], torn: [], walls: [], free: [] });
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

  // A hold is a vertical a member stood when stage 6 read it, to SEAT_STANDS_EPS; the publication check of the rows rule reads it so too. The sheet
  // that stood a hold half a pixel off now completes: the far ends move with their set, so its verticals stand exact. The reading itself is checked
  // on a published set: an equation read as a hold, its member moved by d with the seat x stage 6 would have recorded, stands for d up to
  // SEAT_STANDS_EPS and no further.
  it('completes the sheet that stood a hold half a pixel off, and reads a hold to SEAT_STANDS_EPS', async () => {
    const sheet = 'test/fixtures/staged/a-seat-set-hold-half-a-pixel-off-is-published.yaml';
    await expect(layout(parse(readFileSync(join(root, sheet), 'utf8')), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt })).resolves.toBeDefined();
    // A hold is a link the rows rule reads through a member's top or bottom face that is no feed (`equationKind`): here c1 of site#1 feeds z1
    // in the row below. The test records it as a hold of site#1 as stage 6 would have, then moves its far port by d, with the boundary offset
    // stage 6 would have recorded (z1 sorts after the parents, so the origin of the set stays).
    const child = readFileSync(join(root, 'goldens/synthetic/a-child-row-stands-under-its-parents-ports.yaml'), 'utf8');
    const text = child.replace('\nlinks:', '\n  z1: { group: site, ports: [{ name: u, side: top }] }\nlinks:') + '\n  - { from: c1.b, to: z1.u }\n';
    const model = await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const side = model.links.find(link => link.attachments?.from.node === 'c1' && link.attachments.to.node === 'z1')!;
    const entry = (model.reservations ?? []).find(item => item.kind === 'seatSet' && item.payload.order.includes('c1'));
    expect(entry, 'the sheet publishes the set of the row of c1').toBeDefined();
    expect(entry!.kind === 'seatSet' && entry!.payload.order.includes('z1'), 'z1 stands in another row').toBe(false);
    const anchor = (m: LayoutModel, ref: { node: string }) => m.nodes[ref.node]!.ports.find(port => portKey(port.ref) === portKey(ref as never))!.anchor!.x;
    const skewed = (d: number): string | undefined => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel, item = copy.reservations!.find(one => one.id === entry!.id)!;
      if (item.kind !== 'seatSet') throw new Error('not a seat set');
      const p = item.payload, member = side.attachments!.from, far = side.attachments!.to, origin = anchor(copy, p.boundary[0]!.port);
      p.holds = [...p.holds, { link: side.id, member, far, memberOffset: anchor(copy, member) - copy.nodes.c1!.bounds!.x, farOffset: anchor(copy, far) - copy.nodes.z1!.bounds!.x }];
      p.boundary = [...p.boundary, { port: far, x: anchor(copy, far) - origin + d }].sort((a, b) => portKey(a.port).localeCompare(portKey(b.port)));
      expect(portKey(p.boundary[0]!.port), 'the origin stays').not.toBe(portKey(far));
      const port = copy.nodes.z1!.ports.find(one => portKey(one.ref) === portKey(far))!;
      port.anchor = { ...port.anchor!, x: port.anchor!.x + d };
      return seatSetFault(item, copy);
    };
    expect(skewed(0)).toBeUndefined();
    expect(skewed(SEAT_STANDS_EPS - 0.1)).toBeUndefined();
    expect(skewed(SEAT_STANDS_EPS + 0.1)).toMatch(/no longer stands vertical/);
  }, 900000);

  // The step over chords (7f) moves a far-end row only inside its set's room, and a step whose settled copy withdraws a set on the column wall,
  // where the copy without it keeps the set, does not stand (`chordDecision`). Before, a step of a far-end row on this sheet left a row 28 px out of
  // its column at the replay, and the kept placement declined that set by the wall.
  it('keeps every set of a placement off the column wall through the step over chords', async () => {
    const sheet = readFileSync(join(root, 'goldens/synthetic/four-locations-each-with-a-zone.yaml'), 'utf8');
    const model = await layout(withMoveBeforeGrow(parse(sheet)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const declined = (model.reservations ?? []).flatMap(entry => entry.kind === 'seatSetDeclined' ? [`${entry.payload.row}: ${entry.payload.why}`] : []);
    expect(declined.filter(item => item.includes(SEAT_WALL_COLUMN))).toEqual([]);
    expect(model.diagnostics.filter(d => d.code === 'SEAT_FAR_END_CLAMPED' && d.message.startsWith('the step over chords')).length).toBeGreaterThan(0);
  }, 900000);

  // A set withdrawn after 7c keeps its far ends fixed for the rest of the run: 7c held their rows, and the publication replay of the rule that
  // withdrew it reads them as 7c did. Before, the replay centred the far-end row again and refused the run ("Centring invariant violated").
  it('reads the far ends of a set withdrawn after 7c as fixed in the replays of that run', async () => {
    const sheet = readFileSync(join(root, 'goldens/synthetic/a-flank-bundle-into-a-ranked-group-stays-beside-the-frame.yaml'), 'utf8');
    const model = await layout(withMoveBeforeGrow(parse(sheet)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(d => d.code === 'SEAT_SET_DECLINED' && d.message.includes('withdrawn at bundles')).length).toBe(1);
  }, 900000);
});
