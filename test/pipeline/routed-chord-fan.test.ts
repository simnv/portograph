import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { bands, bars, bundles, centre, flanks, lanes, layout, parse, rows, score } from '../../src/index.js';
import { declinedFanDiagnostics, FAN_PITCH_CAP, fanRoundHolds, measureFans } from '../../src/layout/fan-spread.js';
import { chordKind, isRoutedChord } from '../../src/layout/frame-paths.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { intersection, samePoint, segmentDistance } from '../../src/score/geometry.js';
import { linkStrokeWidth } from '../../src/theme/geometry.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

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

  it('drops a fan re-run that loses a frame chord, and keeps one that only loses a cross-frame chord', async () => {
    const before = await run();
    const lose = (kind: 'frame' | 'cross'): LayoutModel => {
      const copy = structuredClone(before) as LayoutModel;
      const link = copy.links.find(item => chordKind(copy, item) === kind && isRoutedChord(copy, item))!;
      link.technique = 'orthogonal'; delete link.path;
      return copy;
    };
    expect(fanRoundHolds(before, before)).toBe(true);
    expect(fanRoundHolds(before, lose('cross'))).toBe(true);
    expect(fanRoundHolds(before, lose('frame'))).toBe(false);
  }, 60000);
});
