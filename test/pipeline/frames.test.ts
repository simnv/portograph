import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../src/index.js';
import { layout, parse, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import { withLayoutMutation } from '../../src/layout/mutation.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const bottom = (box: Rect): number => box.y + box.height;
const holds = (outer: Rect, inner: Rect, margin = 0): boolean => outer.x <= inner.x - margin + 1e-6 && outer.y <= inner.y - margin + 1e-6
  && right(outer) >= right(inner) + margin - 1e-6 && bottom(outer) >= bottom(inner) + margin - 1e-6;
const overlaps = (a: Rect, b: Rect): boolean => a.x < right(b) - 1e-6 && b.x < right(a) - 1e-6 && a.y < bottom(b) - 1e-6 && b.y < bottom(a) - 1e-6;

describe('frames', () => {
  it('a frame holds its ranks and carries the one title', async () => {
    const model = await run('a-frame-holds-its-ranks-and-title');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(model.frames).toHaveLength(1);
    const frame = model.frames![0]!;
    expect(frame).toMatchObject({ id: 'site', label: 'Site', cells: ['site#0', 'site#1'] });
    const cells = frame.cells.map(id => model.groups[id]!.bounds!);
    for (const cell of cells) expect(holds(frame.box, cell)).toBe(true);
    // Group padding stands between every node body and the frame edge.
    for (const node of ['gw', 'dist']) expect(holds(frame.box, model.nodes[node]!.bounds!, 20)).toBe(true);
    expect(frame.tier).toBe(model.groups['site#0']!.tier);
    // One title for the frame, inside the frame's label band; no cell owns a band or a label.
    const bands = model.labelBands.filter(band => band.group === 'site' || band.group.startsWith('site#'));
    expect(bands.map(band => band.group)).toEqual(['site']);
    const band = bands[0]!;
    expect(model.frames!.some(item => item.id === band.group)).toBe(true);
    expect(cells.some(cell => holds(cell, band.bounds))).toBe(true);
    const labels = model.labels.filter(label => label.role === 'group' && label.text === 'Site');
    expect(labels).toHaveLength(1);
    expect(holds(band.bounds, labels[0]!.bounds!)).toBe(true);
    expect(holds(frame.box, labels[0]!.bounds!)).toBe(true);
    expect(model.labels.filter(label => label.role === 'group').map(label => label.text).sort()).toEqual(['Site', 'Upstream']);
    // A one-rank group has no frame.
    expect(model.frames!.map(item => item.id)).toEqual(['site']);
  }, 60000);

  it('a child frame stands inside its parent, and the parent grows around it', async () => {
    const model = await run('a-child-frame-stands-inside-its-parent');
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const [parent, child] = [model.frames!.find(item => item.id === 'site')!, model.frames!.find(item => item.id === 'zone')!];
    expect(child).toMatchObject({ parent: 'site', cells: ['zone#1', 'zone#2'] });
    expect(parent.parent).toBeUndefined();
    expect(parent.cells).toEqual(['site#0']);
    for (const id of child.cells) expect(holds(child.box, model.groups[id]!.bounds!)).toBe(true);
    expect(holds(child.box, model.nodes['z1']!.bounds!, 20)).toBe(true);
    expect(holds(parent.box, model.groups['site#0']!.bounds!)).toBe(true);
    expect(holds(parent.box, child.box, 20)).toBe(true);
    expect(model.labels.filter(label => label.role === 'group').map(label => label.text).sort()).toEqual(['Site', 'Upstream', 'Zone']);
    // Each title sits in a band held by one of the frame's OWN cells; the parent's title never
    // lands in a cell of its child frame. Site has one own cell, site#0, at the top edge.
    const band = (id: string) => model.labelBands.find(item => item.group === id)!;
    expect(band('site')).toMatchObject({ host: 'site#0', side: 'top' });
    expect(child.cells).toContain(band('zone').host);
    expect(holds(model.groups['site#0']!.bounds!, band('site').bounds)).toBe(true);
    expect(holds(model.groups[band('zone').host!]!.bounds!, band('zone').bounds)).toBe(true);
    // Neither band lies inside the other frame's cells.
    expect(child.cells.some(id => holds(model.groups[id]!.bounds!, band('site').bounds))).toBe(false);
  }, 60000);

  it('sibling frames share their sub-tiers, and every frame gate holds', async () => {
    const model = await run('sibling-frames-align-their-ranks');
    const [east, west] = [model.frames!.find(item => item.id === 'east')!, model.frames!.find(item => item.id === 'west')!];
    expect(east.cells.map(id => model.groups[id]!.tier)).toEqual(west.cells.map(id => model.groups[id]!.tier));
    expect(new Set(east.cells.map(id => model.groups[id]!.tier)).size).toBe(3);
    expect(overlaps(east.box, west.box)).toBe(false);
    for (const node of Object.values(model.nodes)) {
      const own = node.owner.kind === 'group' && (east.cells.includes(node.owner.id) ? east : west.cells.includes(node.owner.id) ? west : undefined);
      for (const frame of [east, west]) if (frame !== own) expect(overlaps(frame.box, node.bounds!)).toBe(false);
    }
    const report = score(model);
    expect(report.snapshot.gates.G9.violations).toEqual([]);
    expect(report.snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('cells carry no padding between ranks; the frame margin stands only on the frame edge', async () => {
    const model = await run('sibling-frames-align-their-ranks');
    // Rank to rank inside one frame the bodies stand one band gap (60) apart: no padding of the
    // cell above, none of the cell below.
    const body = (id: string) => model.nodes[id]!.bounds!;
    for (const [upper, lower] of [['e-gw', 'e-dist'], ['e-dist', 'e-acc'], ['w-gw', 'w-dist'], ['w-dist', 'w-acc']]) {
      expect(body(lower!).y - bottom(body(upper!))).toBeCloseTo(60, 6);
    }
    // The frame edge stands 20 px from the outermost body; on the title edge it stands the band and
    // its clearance from it.
    for (const [id, nodes] of [['east', ['e-gw', 'e-dist', 'e-acc']], ['west', ['w-gw', 'w-dist', 'w-acc']]] as const) {
      const frame = model.frames!.find(item => item.id === id)!, band = model.labelBands.find(item => item.group === id)!;
      const top = Math.min(...nodes.map(node => body(node).y)), low = Math.max(...nodes.map(node => bottom(body(node))));
      const room = band.bounds.height + band.clearance;
      expect(frame.box.y).toBeCloseTo(top - (band.side === 'top' ? room : 20), 6);
      expect(bottom(frame.box)).toBeCloseTo(low + (band.side === 'bottom' ? room : 20), 6);
      expect(frame.box.x).toBeCloseTo(Math.min(...nodes.map(node => body(node).x)) - 20, 6);
      expect(right(frame.box)).toBeCloseTo(Math.max(...nodes.map(node => right(body(node)))) + 20, 6);
    }
  }, 60000);

  it('every cell of a frame takes the frame column, so a wide rank does not push its sibling off its feed', async () => {
    // East's middle rank is wider than its first, so west's middle rank had a window of
    // right(east#1) + 60 that its feed (the west gateway) could not meet: PLACEMENT_NON_CONVERGENCE
    // and a jog on link-5.
    const model = await run('sibling-frames-align-their-ranks');
    expect(model.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('PLACEMENT_NON_CONVERGENCE');
    for (const link of model.links) expect(link.path!.segments).toHaveLength(1);
    const link = model.links.find(item => item.id === 'link-5')!.path!.segments[0]!;
    expect(link.from.x).toBeCloseTo(link.to.x, 6);
  }, 60000);

  it('a frame joins the linked-group grid as one unit, and its cells are not paired alone', async () => {
    const model = await run('a-frame-shares-the-grid-with-its-linked-group');
    expect(model.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('GROUP_GRID_NON_CONVERGENCE');
    const boxes = ['upstream', 'site#0', 'site#1'].map(id => model.groups[id]!.bounds!);
    // One x-extent for the upstream group and both ranks of the frame.
    for (const box of boxes) {
      expect(box.x).toBeCloseTo(boxes[0]!.x, 6);
      expect(box.width).toBeCloseTo(boxes[0]!.width, 6);
    }
    // The widest node, the second rank's, sets it; the gateway did not move to fill it.
    expect(boxes[0]!.width).toBeGreaterThan(model.nodes['gw']!.bounds!.width + 20);
  }, 60000);

  it('a frame holds a cell the linked-group grid widened', async () => {
    const model = await run('a-frame-holds-a-widened-cell');
    for (const frame of model.frames!) for (const cell of frame.cells) expect(holds(frame.box, model.groups[cell]!.bounds!)).toBe(true);
    const report = score(model);
    expect(report.snapshot.gates.G9.violations).toEqual([]);
    expect(report.snapshot.gates.G9.passed).toBe(true);
  }, 60000);

  it('G9 fails when a foreign node lies inside a frame', async () => {
    const model = await run('a-frame-holds-its-ranks-and-title');
    expect(score(model).snapshot.gates.G9.passed).toBe(true);
    // The published model is frozen; the copy is not. Put the ISP, which no frame owns, on the gateway.
    const broken = structuredClone(model);
    const frame = broken.frames![0]!, gateway = broken.nodes['gw']!.bounds!, isp = broken.nodes['isp']!.bounds!;
    isp.x = gateway.x; isp.y = gateway.y;
    const violations = score(broken).snapshot.gates.G9.violations;
    expect(score(broken).snapshot.gates.G9.passed).toBe(false);
    expect(violations).toContainEqual(expect.objectContaining({ code: 'frame-foreign-node', elements: [frame.id, 'isp'] }));
  }, 60000);

  it('a mutation that leaves the frames off their cells is refused', async () => {
    const model = await placed(fixture('a-frame-holds-its-ranks-and-title'));
    expect(model.frames).toHaveLength(1);
    // An untouched frame list is the re-derivation, so a no-op commit passes.
    expect(() => withLayoutMutation(model, 'rows', () => {})).not.toThrow();
    expect(() => withLayoutMutation(model, 'rows', draft => { draft.frames![0]!.box.width += 5; })).toThrow(/[Ff]rames/);
    expect(() => withLayoutMutation(model, 'rows', draft => { draft.frames = []; })).toThrow(/[Ff]rames/);
  }, 60000);

  it('restores from its own JSON with the frames intact', async () => {
    const model = await run('a-child-frame-stands-inside-its-parent');
    const restored = restoreFinalLayout(serializeLayoutModel(model));
    expect(restored.frames).toEqual(model.frames);
  }, 60000);
});
