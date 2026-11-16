import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { refuseChordEntries, validateEarlyReservations } from '../../src/layout/reservations.js';
import { resolve } from '../../src/resolve/index.js';
import { fixedPointRefusal, seatsRowsAgainst } from '../../src/layout/frame-paths.js';
import { plannedSegments, tierGapPlan } from '../../src/layout/gap-plan.js';
import { tierGaps } from '../../src/layout/gap-runs.js';
import { chordRowOf } from '../../src/layout/read/stagger.js';
import { parallelClearance } from '../../src/score/gates.js';
import { linkStrokeWidth } from '../../src/theme/geometry.js';
import { findPort } from '../../src/layout/row-paths.js';
import { portStemReach } from '../../src/layout/bands.js';
import { stemDepth } from '../../src/layout/sides-two.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../../src/model/layout.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Dense-16x9 ticket 04, slice 2, review 1: the states the reviewer found, one per finding. */
const golden = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string): Promise<LayoutModel> => layout(parse(golden(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('the stem rule reads the real stem (review 1, finding 1)', () => {
  it('refuses a fan chord that touches the tip of a nested stem deeper than the plain reach', async () => {
    const model = await run('a-nested-tip-row-holds-no-allocated-row');
    // A routed end whose stem nests deeper than the plain reach of its side.
    const found = model.links.flatMap(link => (['from', 'to'] as const).map(end => ({ link, end, port: link.attachments ? findPort(model, link.attachments[end]) : undefined })))
      .find(item => item.port?.side === 'top' && item.port.anchor !== undefined && stemDepth(model, item.port) > portStemReach(model, item.port) + 10)!;
    expect(found).toBeDefined();
    const depth = stemDepth(model, found.port!), { x, y: anchorY } = found.port!.anchor!, y = anchorY - depth;
    // An unrelated fan chord through the stem's tip, 40 px wide: it crosses the leg's line at the tip, so only the real stem refuses it.
    const chord: PathSegment = { straight: true, from: { x: x - 20, y: y - 5 }, to: { x: x + 20, y: y + 5 }, owner: { kind: 'link', id: 'probe' } };
    const other: LayoutLink = { ...found.link };
    delete other.path;
    other.technique = 'orthogonal';
    const probe: LayoutLink = { ...found.link, id: 'probe', owner: { kind: 'link', id: 'probe' }, fanFamily: 'probe-fan', technique: 'straight', path: { ...found.link.path!, owner: { kind: 'link', id: 'probe' }, segments: [chord] } };
    const state = { ...model, links: [other, probe], lanes: [] };
    expect(fixedPointRefusal(state, probe, chord)).toBe('leg');
  });
});

describe('the gap plan protects what the stem rule admits (review 1, finding 2)', () => {
  it('seats a planned row clear of a chord-row chord that the stem rule lets cross the fallback leg', async () => {
    const model = structuredClone(await run('a-member-with-several-links-stands-on-the-near-line'));
    const chord = model.links.find(link => link.attachments?.from.node === 'leaf-1')!;
    const other = model.links.find(link => link.attachments?.from.node === 'hub-1' && link.attachments.to.node === 'store-1')!;
    // A chord of a chord row, no fan member: the plan read only fan chords before the fix.
    expect(chord.fanFamily).toBeUndefined();
    expect(chordRowOf(model, chord)).toBe('leaves');
    const line: PathSegment = { from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, straight: true, owner: chord.owner };
    chord.path!.segments = [line];
    const from = findPort(model, other.attachments!.from)!, to = findPort(model, other.attachments!.to)!;
    from.anchor = { x: 35, y: 0 };
    from.side = 'bottom';
    to.anchor = { x: 20, y: 100 };
    to.side = 'top';
    other.technique = 'orthogonal';
    delete other.path;
    // The chord stays held; the other link falls back, so the plan seats its row.
    model.links = [chord, other];
    model.frozenChords = [chord.id];
    model.lanes = [];
    model.tierBands = [{ tier: 0, bounds: { x: -100, y: -50, width: 300, height: 50 }, groups: [] }, { tier: 1, bounds: { x: -100, y: 100, width: 300, height: 50 }, groups: [] }];
    // The stem rule admits the chord across the fallback leg beyond its stems ...
    expect(seatsRowsAgainst(model, chord)).toBe(true);
    expect(fixedPointRefusal(model, chord, line)).toBeUndefined();
    // ... so the plan of the gap that the chord crosses seats the leg's row clear of it.
    const gap = tierGaps(model).find(item => item.above === 0 && item.below === 1)!;
    const plan = tierGapPlan(model, gap);
    const part = plan.parts.find(item => item.link === other.id)!;
    expect(part).toBeDefined();
    const faults: unknown[] = [];
    for (const [index, segment] of plannedSegments(part, gap).entries()) {
      parallelClearance(model, [{ segment: line, link: chord, index: 0, stroke: linkStrokeWidth(chord) }, { segment, link: other, index, stroke: linkStrokeWidth(other) }], (...args) => faults.push(args));
    }
    expect(faults).toEqual([]);
  });
});

describe('restore reads the refused chords against the freeze (review 1, finding 3)', () => {
  it('refuses a record that names a chord the freeze held', async () => {
    const model = await run('a-solid-block-between-two-ranks-of-one-group');
    const held = model.frozenChords![0]!;
    expect(model.links.find(link => link.id === held)?.path?.segments.length).toBe(1);
    // The entry says 7f refused the chord; the freeze and the geometry say it held.
    expect(() => restoreLayoutModel(JSON.stringify({ ...model, reservations: [...(model.reservations ?? []), ...refuseChordEntries([held], 0)] }))).toThrow(/refused, but the freeze held it/);
    // The entry before the freeze (the 7e replay input) stays valid: the publication step restores it (two-pole-ranks.test.ts).
  });
});

describe('the early restore refuses a refused-chord record (review 2)', () => {
  const source = 'portograph: 2\ngroups: {a: {tier: 0}, b: {tier: 1}}\nnodes: {p: {group: a}, q: {group: b}}\nlinks: [[p,q]]\n';
  // The publication step writes the entries on the kept 7e model only, so a model before `sides-two` has none: the early reader of the table
  // (`RESERVATION_CHECKS`) refuses a malformed entry by its shape and a well-formed one by the kind's one predicate (`refusedChordFailure`).
  const entry = (link: unknown): unknown => ({ ...refuseChordEntries(['x'], 0)[0]!, payload: { link } });
  it.each([
    ['a malformed entry', entry(5), /payload of the wrong shape/],
    ['an unknown id', entry('no-such-link'), /a resolve model carries no refused chord \(no-such-link\)/],
    ['a link id', entry('link-1'), /a resolve model carries no refused chord \(link-1\)/],
  ])('refuses %s', (_name, record, fault) => {
    const resolved = resolve(parse(source));
    const model = { ...resolved, reservations: [...(resolved.reservations ?? []), record] } as unknown as LayoutModel;
    expect(() => validateEarlyReservations(model)).toThrow(fault);
    expect(() => restoreLayoutModel(JSON.stringify(model))).toThrow(fault);
  });
});
