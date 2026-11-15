import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { restoreLayoutModel } from '../../src/internal.js';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { blockedChords, chordKind, chordsHold, chordVerdict, levelChordPartners, levelCrossChord } from '../../src/layout/frame-paths.js';
import { findPort, straightLengthLimit } from '../../src/layout/row-paths.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 ticket 06, slice B: a sibling-frame link is a level cross-frame chord. Two frames of one document tier stand on one sub-tier; a routed link between
 * a `right` face and the `left` face that looks at it is a chord candidate of kind `cross`, with no `2x` length limit, at any angle, judged by the foreign
 * frames and the facing edges like a chord between two tiers. Nothing yet seats the two ends at the facing ends of their rows (slice C); the fixture does.
 */
const NAME = 'two-sibling-frames-face-a-same-tier-pair';
const text = readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const lay = (source: string): Promise<LayoutModel> => layout(parse(source), options);
const pair = (model: LayoutModel): LayoutLink => model.links.find(link => link.attachments !== undefined && link.attachments.from.node === 'w2' && link.attachments.to.node === 'e1')!;
const gates = (model: LayoutModel): string[] => Object.entries(score(model).snapshot.gates).flatMap(([id, gate]) => gate.violations.map(item => `${id}:${item.code}`));
const xy = (link: LayoutLink): number[][] => link.path!.segments.map(item => [item.from.x, item.from.y, item.to.x, item.to.y]);

/** A copy of the model whose nodes are replaced by `nodes` (the links, groups and frames are shared). */
const withNodes = (model: LayoutModel, nodes: LayoutModel['nodes']): LayoutModel => ({ ...model, nodes: { ...model.nodes, ...nodes } });
/** The model with the port of `node` that `link` ends on, changed by `change`. */
function withPort(model: LayoutModel, link: LayoutLink, end: 'from' | 'to', change: (port: LayoutModel['nodes'][string]['ports'][number]) => object): LayoutModel {
  const ref = link.attachments![end], node = model.nodes[ref.node]!;
  const port = findPort(model, ref)!;
  return withNodes(model, { [node.id]: { ...node, ports: node.ports.map(item => item === port ? { ...item, ...change(item) } : item) } });
}

describe('a sibling-frame link is a level cross-frame chord', () => {
  it('draws the pair as one straight segment as long as the straight-link length limit, and every gate holds', async () => {
    const model = await lay(text);
    const link = pair(model), segments = link.path!.segments;
    expect(link.technique).toBe('straight');
    expect(segments).toHaveLength(1);
    expect(segments[0]!.straight).toBe(true);
    expect(segments[0]!.from.y).toBe(segments[0]!.to.y);
    // The old rows rule pinned a level pair only below `straightLengthLimit` (`expectedLevelPath`): this one stands at it.
    const length = Math.hypot(segments[0]!.to.x - segments[0]!.from.x, segments[0]!.to.y - segments[0]!.from.y);
    expect(length).toBeGreaterThanOrEqual(straightLengthLimit([model.nodes['w2']!, model.nodes['e1']!]) - 1e-6);
    expect([findPort(model, link.attachments!.from)!.side, findPort(model, link.attachments!.to)!.side]).toEqual(['right', 'left']);
    expect(model.frozenChords).toContain(link.id);
    expect(gates(model)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
    expect(model.diagnostics.filter(item => item.code === 'ROUTED_CHORD_REFUSED')).toEqual([]);
  }, 60000);

  it('is a `cross` candidate of one sub-tier, and a link inside one frame or between two tiers keeps its kind', async () => {
    const model = await lay(text);
    expect(chordKind(model, pair(model))).toBe('cross');
    expect(levelCrossChord(model, pair(model))).toBe(true);
    // The feed from the source row is a chord between two tiers, not a level one.
    const feed = model.links.find(link => link.attachments!.from.node === 's0' && link.attachments!.to.node === 'w1')!;
    expect(chordKind(model, feed)).toBe('cross');
    expect(levelCrossChord(model, feed)).toBe(false);
  }, 60000);

  it('is no candidate when the two faces look the same way, when the ends stand on two sub-tiers, or when an end stands in a cell that is no row', async () => {
    const model = await lay(text), link = pair(model);
    expect(chordKind(model, link)).toBe('cross');
    const same = withPort(model, link, 'to', () => ({ side: 'right' }));
    expect(chordKind(same, link)).toBeUndefined();
    const top = withPort(model, link, 'to', () => ({ side: 'top' }));
    expect(chordKind(top, link)).toBeUndefined();
    const east = model.groups['east']!;
    const lower = { ...model, groups: { ...model.groups, east: { ...east, tier: east.tier! + 1 } } };
    expect(chordKind(lower, link)).toBeUndefined();
    const document = { ...model.document, groups: { ...model.document.groups, east: { ...model.document.groups['east']!, shape: 'grid' as const } } };
    const grid = { ...model, document };
    expect(chordKind(grid, link)).toBeUndefined();
  }, 60000);

  it('refuses a chord that would leave a port inward (`faces`)', async () => {
    const model = await lay(text), link = pair(model);
    const turned = withPort(withPort(model, link, 'from', () => ({ side: 'left' })), link, 'to', () => ({ side: 'right' }));
    expect(chordKind(turned, link)).toBe('cross');
    expect(chordVerdict(turned, link)).toEqual({ reason: 'faces' });
    expect(chordVerdict(model, link)).toHaveProperty('segment');
  }, 60000);

  it('is one slanted segment when the two ends stand at two heights: the chord keeps no level', async () => {
    const model = await lay(text), link = pair(model);
    const high = findPort(model, link.attachments!.to)!.anchor!.y;
    const slanted = withPort(model, link, 'to', port => ({ anchor: { x: (port as { anchor: { x: number } }).anchor.x, y: high + 8 } }));
    expect(chordKind(slanted, link)).toBe('cross');
    const verdict = chordVerdict(slanted, link);
    expect(verdict).toHaveProperty('segment');
    const segment = (verdict as { segment: { from: { y: number }; to: { y: number } } }).segment;
    expect(segment.to.y - segment.from.y).toBeCloseTo(8, 6);
  }, 60000);

  it('is refused for a body or a foreign frame on the line, with the reason named', async () => {
    const model = await lay(text), link = pair(model);
    const w1 = model.nodes['w1']!, from = findPort(model, link.attachments!.from)!.anchor!;
    const body = withNodes(model, { w1: { ...w1, bounds: { ...w1.bounds!, x: from.x + 30, y: from.y - w1.bounds!.height / 2 } } });
    expect(chordVerdict(body, link)).toEqual({ reason: 'body' });
    const frames = [...(model.frames ?? []), { id: 'foreign', box: { x: from.x + 20, y: from.y - 30, width: 40, height: 60 } }];
    expect(chordVerdict({ ...model, frames } as LayoutModel, link)).toEqual({ reason: 'frame' });
  }, 60000);

  it('is the same layout with the links reversed in the document (R3)', async () => {
    const one = await lay(text), two = await lay(reversed(text, 'links'));
    expect(pair(two).technique).toBe('straight');
    expect(xy(pair(two))).toEqual(xy(pair(one)));
  }, 60000);

  it('stays level when 7f grows the top padding of one frame: the other frame moves with it (slice B review 1)', async () => {
    const model = await lay(readFileSync(new URL('../../goldens/synthetic/a-top-padding-growth-keeps-a-level-sibling-chord-level.yaml', import.meta.url), 'utf8'));
    const link = model.links.find(item => item.attachments !== undefined && [item.attachments.from.node, item.attachments.to.node].sort().join() === 'n5,s')!;
    // The growth this test is about happened: `row` took top padding for the label of n2--n4.
    expect(model.labelPadding?.['row']?.top?.room).toBeGreaterThan(0);
    expect(model.frozenChords).toContain(link.id);
    const segments = link.path!.segments;
    expect(segments).toHaveLength(1);
    expect(segments[0]!.to.y).toBe(segments[0]!.from.y);
    expect(gates(model)).toEqual([]);
  }, 60000);

  it('holds the level relation after the freeze: a move that tilts the chord is refused, a move of both rows is not, and a forged record is refused at restore', async () => {
    const model = await lay(readFileSync(new URL('../../goldens/synthetic/a-top-padding-growth-keeps-a-level-sibling-chord-level.yaml', import.meta.url), 'utf8'));
    const link = model.links.find(item => item.attachments !== undefined && [item.attachments.from.node, item.attachments.to.node].sort().join() === 'n5,s')!;
    expect(model.frozenLevelChords).toEqual([link.id]);
    expect(blockedChords(model)).toEqual([]);
    expect(levelChordPartners(model, model.groups['row']!)).toEqual(['aside']);
    expect(levelChordPartners(model, model.groups['top']!)).toEqual([]);
    const row = model.groups['row']!, aside = model.groups['aside']!;
    const down = (group: typeof row) => ({ group, bounds: { ...group.bounds!, y: group.bounds!.y + 8 } });
    expect(chordsHold(model, [down(aside)], false)).toBe(false);
    expect(chordsHold(model, [down(row)], false)).toBe(false);
    expect(chordsHold(model, [down(row), down(aside)], false)).toBe(true);
    // A record that names a link that holds no level chord is refused (R5): the geometry is read, never the record.
    const forged = JSON.parse(JSON.stringify(model)) as typeof model;
    forged.frozenLevelChords = [model.links.find(item => item.id !== link.id)!.id];
    expect(() => restoreLayoutModel(JSON.stringify(forged))).toThrow(/frozenLevelChords/);
    expect(restoreLayoutModel(JSON.stringify(model)).frozenLevelChords).toEqual([link.id]);
  }, 60000);
});
