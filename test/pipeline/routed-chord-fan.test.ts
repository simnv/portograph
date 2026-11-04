import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, rows } from '../../src/internal.js';
import { declinedFanDiagnostics, FAN_PITCH_CAP, fanRoundChords, fanRoundHolds, measureFans } from '../../src/layout/fan-spread.js';
import { chordClearances, chordKind, isRoutedChord } from '../../src/layout/frame-paths.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { intersection, samePoint, segmentDistance } from '../../src/score/geometry.js';
import { linkStrokeWidth } from '../../src/theme/geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { withoutJointOrder } from '../layout/joint-off.js';

/**
 * Ranked-groups ticket 102 (Q108, docs/design/routed-chords.md, Section 7): a face that takes cross-frame chords spreads its ports, as a face of
 * frame chords does (ticket 89). `measureFans` reads both kinds since ticket 99; this ticket adds the fixture and the tests that pin it.
 */
const FIXTURE = 'a-provider-face-spreads-for-three-routed-chords';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
/** The placement before any fan re-run: every face at the base pitch. */
const atBase = async (yaml = text): Promise<LayoutModel> => bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml))))))));
const crossChords = (model: LayoutModel) => model.links.filter(link => chordKind(model, link) === 'cross');
const topPorts = (model: LayoutModel, node: string) => model.nodes[node]!.ports.filter(port => port.side === 'top').sort((a, b) => a.anchor!.x - b.anchor!.x);

describe('a face that takes cross-frame chords spreads its ports', () => {
  it('asks for a wider pitch on the provider face from the placed cross-frame chords', async () => {
    const model = await atBase();
    expect(crossChords(model)).toHaveLength(3);
    // The candidates are cross-frame chords, and only the offer for them can put a floor on the face.
    expect(crossChords(model).every(link => chordKind(model, link) === 'cross')).toBe(true);
    const measured = measureFans(model);
    expect(measured.declined).toEqual([]);
    expect([...measured.floors]).toEqual([['provider', { top: 16 }]]);
    expect(topPorts(model, 'provider').map(port => port.anchor!.x).map((x, i, xs) => i ? x - xs[i - 1]! : 12).every(step => Math.abs(step - 12) < 1e-6)).toBe(true);
  }, 60000);

  it('draws all three chords straight at the spread pitch, each pair 10 px apart or crossing strictly, and every gate passes', async () => {
    const model = await run();
    const chords = crossChords(model);
    expect(chords).toHaveLength(3);
    for (const link of chords) {
      expect(link.technique, link.id).toBe('straight');
      expect(link.path!.segments, link.id).toHaveLength(1);
      expect(isRoutedChord(model, link), link.id).toBe(true);
    }
    const xs = topPorts(model, 'provider').map(port => port.anchor!.x);
    expect(xs).toHaveLength(3);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(16 - 1e-6);
    expect(model.nodes['provider']!.sidePitch!.top).toBe(16);
    for (const [i, one] of chords.entries()) for (const other of chords.slice(i + 1)) {
      const a = one.path!.segments[0]!, b = other.path!.segments[0]!, point = intersection(a, b);
      const strict = point !== undefined && ![a.from, a.to, b.from, b.to].some(end => samePoint(end, point));
      expect(strict || segmentDistance(a, b) - (linkStrokeWidth(one) + linkStrokeWidth(other)) / 2 >= 10 - 1e-6, `${one.id} ${other.id}`).toBe(true);
    }
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'FAN_SPREAD_DECLINED' || item.code === 'FAN_SPREAD_CUT')).toEqual([]);
    for (const [id, gate] of Object.entries(score(model).snapshot.gates)) expect([id, gate.violations]).toEqual([id, []]);
    // Measured again on the published placement, the face asks for nothing more.
    expect([...measureFans(model).floors]).toEqual([]);
  }, 120000);

  it('keeps the base pitch and names the face when it would need more than the cap (FAN_SPREAD_DECLINED)', async () => {
    // Two location frames far to one side of the provider (700 and 1700 px): the two chords arrive shallow from the same side, so the neighbouring ports
    // would have to stand more than FAN_PITCH_CAP apart. The input is the fixture cut to that shape, and its geometry is forged wide enough that no
    // foreign box or side edge refuses the chords (the fan is measured on chords that can hold alone).
    const cut = text.split('\n').filter(line => !/west-peer|east-peer|location-c|\bc-core|\bc-router/.test(line)).join('\n');
    const model = structuredClone(await atBase(cut));
    const at = (id: string) => model.groups[id]!;
    for (const [frame, dx, wide] of [['location-a', 700, 350], ['location-b', 1700, 500]] as const) for (const cell of [`${frame}#0`, `${frame}#1`]) {
      moveGroup(model, at(cell), dx, 0);
      at(cell).bounds = { ...at(cell).bounds!, x: at(cell).bounds!.x - wide, width: at(cell).bounds!.width + wide };
    }
    const providers = at('providers');
    providers.bounds = { ...providers.bounds!, x: providers.bounds!.x - 450, width: providers.bounds!.width + 900 };
    // The two ports of the provider face stand one base pitch apart, the port of the nearer frame on the left: the chords come from the right and do not cross.
    const [first, second] = topPorts(model, 'provider');
    const left = first!.anchor!.x;
    first!.anchor = { ...first!.anchor!, x: left + 12 };
    second!.anchor = { ...second!.anchor!, x: left };
    model.frames = deriveFrames(model) ?? [];
    expect(crossChords(model)).toHaveLength(2);
    const measured = measureFans(model);
    expect(measured.floors.get('provider')?.top).toBeUndefined();
    expect(measured.declined.map(item => [item.node, item.side])).toEqual([['provider', 'top']]);
    const [note] = declinedFanDiagnostics(measured.declined);
    expect(note!.code).toBe('FAN_SPREAD_DECLINED');
    expect(note!.severity).toBe('warning');
    expect(note!.message).toContain(`${FAN_PITCH_CAP} px`);
    expect(note!.owners!.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  const lose = (model: LayoutModel, id: string): LayoutModel => {
    const copy = structuredClone(model) as LayoutModel;
    const link = copy.links.find(item => item.id === id)!;
    link.technique = 'orthogonal'; delete link.path;
    return copy;
  };

  it('drops a fan re-run that lowers the number of held chords of either kind, and keeps a swap', async () => {
    const before = await run();
    const [first, second] = crossChords(before);
    expect(fanRoundHolds(before, before)).toBe(true);
    expect(fanRoundHolds(before, lose(before, first!.id))).toBe(false);
    // A swap that keeps the count is kept: the re-run may straighten far more links than it swaps.
    expect(fanRoundHolds(lose(before, first!.id), lose(before, second!.id))).toBe(true);
    expect(fanRoundChords(lose(before, first!.id), lose(before, second!.id))).toEqual({ lost: [second!.id], gained: [first!.id] });
  }, 60000);

  it('keeps a re-run that gives up a cross-frame chord only to clear a pair the kept placement holds under the clearance', async () => {
    const after = await run();
    const [a, b, c] = ['link-4', 'link-5', 'link-6'].map(id => after.links.find(item => item.id === id)!);
    expect(crossChords(after).map(link => link.id)).toEqual(expect.arrayContaining(['link-4', 'link-5', 'link-6']));
    // The kept placement: the second chord forged to end 4 px left of the first, on the same row, so that the pair stands under the clearance.
    const before = structuredClone(after) as LayoutModel;
    const one = before.links.find(item => item.id === a!.id)!.path!.segments[0]!;
    const other = before.links.find(item => item.id === b!.id)!.path!.segments[0]!;
    other.to = { ...other.to, x: one.to.x - 4 };
    expect(chordClearances(before).get(`${a!.id}|${b!.id}`)).toBeLessThan(10);
    const cleared = lose(after, c!.id);
    expect(chordClearances(cleared).get(`${a!.id}|${b!.id}`) ?? Infinity).toBeGreaterThanOrEqual(10);
    expect(fanRoundHolds(before, cleared)).toBe(true);
    // Without the pair under the clearance the same loss is dropped.
    expect(fanRoundHolds(after, cleared)).toBe(false);
    // The pair the re-run does not clear keeps the placement it was measured on.
    expect(fanRoundHolds(before, lose(before, c!.id))).toBe(false);
  }, 60000);

  it('keeps all three chords of detoured-stem-checkpoint straight through the fan rounds (Q 0.8140, not 0.7645)', async () => {
    const stem = withoutJointOrder(readFileSync(new URL('../../goldens/synthetic/detoured-stem-checkpoint.yaml', import.meta.url), 'utf8'));
    const model = await layout(parse(stem), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    const straight = model.links.filter(link => link.technique === 'straight' && link.path?.segments.length === 1);
    expect(straight.map(link => link.id).sort()).toEqual(model.links.map(link => link.id).sort());
    expect(score(model).snapshot.Q).toBeGreaterThan(0.8);
    // The dropped re-run is named, never silent: it lost one chord and gained none.
    const note = model.diagnostics.filter(item => item.code === 'FAN_ROUND_DROPPED');
    expect(note).toHaveLength(1);
    expect(note[0]!.severity).toBe('info');
    expect(note[0]!.message).toMatch(/lost 1 held chord .*and gained 0/);
  }, 120000);
});
