import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, restoreFinalLayout } from '../../src/index.js';
import { validateGroupLabelBands } from '../../src/layout/bands.js';
import { GROUP_LABEL_GEOMETRY, titleRoom } from '../../src/layout/title-room.js';
import { pathBends } from '../../src/layout/objective.js';
import { score } from '../../src/score/index.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 54, "titles last": a group title is placed once, at the end of 7f, and yields to every link. It slides to a free
 * span, or stands across the links with its halo and records them (`crossedBy`); no box grows and no link bends for it. The validator and a
 * restore read the record (R1, R5, R6).
 */
const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const right = (box: Rect): number => box.x + box.width;
const title = (model: LayoutModel, id: string) => model.labels.find(label => label.id === `label:group:${id}`)!;
const g3 = (model: LayoutModel): unknown[] => score(model).snapshot.gates.G3?.violations ?? [];
const ends = (model: LayoutModel, ids: readonly string[]): string[] =>
  ids.map(id => model.links.find(link => link.id === id)!.attachments!).map(item => `${item.from.node}>${item.to.node}`).sort();

describe('a group title is placed last and yields to its links (architecture-2 ticket 54)', () => {
  it('stands across the drops with the halo where no span is free; the drops stay straight and G3 passes', async () => {
    const model = await run(fixture('a-group-title-yields-with-a-halo'));
    const access = title(model, 'access');
    expect(access.yield).toBe('halo');
    expect(ends(model, access.crossedBy!)).toEqual(['hub>sw1', 'hub>sw2', 'hub>sw3', 'hub>sw4']);
    for (const id of access.crossedBy!) expect(pathBends(model.links.find(link => link.id === id)!), id).toBe(0);
    // The other titles are clear: `[]`, no yield.
    for (const id of ['core', 'servers']) { expect(title(model, id).crossedBy).toEqual([]); expect(title(model, id).yield).toBeUndefined(); }
    expect(g3(model)).toEqual([]);
    // No box grows for the title: the box is the title room (the stage-5 floor) and no wider than its content asks.
    expect(model.groups.access!.bounds!.width).toBeCloseTo(titleRoom(model.document.groups.access!.label), 6);
  }, 120000);

  it('slides to the free span beside the one drop and records no crossing', async () => {
    const model = await run(fixture('a-group-title-slides-to-a-free-span'));
    const lab = title(model, 'lab'), box = model.groups.lab!.bounds!;
    expect(lab.crossedBy).toEqual([]);
    expect(lab.yield).toBeUndefined();
    const centre = box.x + (box.width - lab.bounds!.width) / 2;
    expect(lab.bounds!.x).toBeLessThan(centre - 1);
    const drop = model.links.find(link => link.attachments!.to.node === 'gw')!;
    expect(pathBends(drop)).toBe(0);
    expect(g3(model)).toEqual([]);
  }, 120000);

  it('a frame title sets its host cell width at stage 5, and 7f widens nothing for it', async () => {
    const yaml = fixture('a-frame-title-sets-its-host-width');
    const stage5 = await placed(yaml);
    const room = titleRoom(stage5.document.frames!.site!.label);
    const before = stage5.groups['site#0']!.bounds!;
    // The premise: the title is wider than the host's body and padding.
    const body = stage5.nodes.gw!.bounds!;
    expect(room).toBeGreaterThan(body.width + 40);
    expect(before.width).toBeGreaterThanOrEqual(room - 1e-6);
    const model = await run(yaml);
    const host = model.groups['site#0']!.bounds!, label = title(model, 'site#0').bounds!;
    expect(host.width).toBeCloseTo(before.width, 6);
    expect(label.x).toBeGreaterThanOrEqual(host.x + GROUP_LABEL_GEOMETRY.horizontalInset - 1e-6);
    expect(right(label)).toBeLessThanOrEqual(right(host) - GROUP_LABEL_GEOMETRY.horizontalInset + 1e-6);
    expect(g3(model)).toEqual([]);
  }, 120000);

  it('lays out the ticket 49 chain, and the validator and a restore read the record (R1)', async () => {
    const model = await run(fixture('a-perimeter-lane-moves-after-the-title-plan'));
    expect(model.labels.filter(label => label.role === 'group').every(label => Array.isArray(label.crossedBy))).toBe(true);
    expect(() => validateGroupLabelBands(structuredClone(model))).not.toThrow();
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it('a restore refuses a forged crossedBy, a title outside its band and a missing record (R5, R6)', async () => {
    const model = await run(fixture('a-group-title-yields-with-a-halo'));
    const json = JSON.stringify(model);
    // The validator names the fault; a restore refuses the model too (the frozen placement hash refuses it first).
    const forged = (edit: (copy: LayoutModel) => void): () => void => {
      const copy = JSON.parse(json) as LayoutModel; edit(copy);
      expect(() => restoreFinalLayout(JSON.stringify(copy))).toThrow();
      return () => validateGroupLabelBands(copy);
    };
    const access = (copy: LayoutModel) => copy.labels.find(label => label.id === 'label:group:access')!;
    expect(forged(copy => { access(copy).crossedBy = access(copy).crossedBy!.slice(1); })).toThrow(/crossedBy/);
    expect(forged(copy => { title(copy, 'core').crossedBy = ['link-1']; })).toThrow(/crossedBy/);
    // A clear title that claims no yield while links cross it is refused too.
    expect(forged(copy => { delete access(copy).yield; })).toThrow(/no yield/);
    expect(forged(copy => { access(copy).bounds!.y += 30; })).toThrow(/outside its band/);
    expect(forged(copy => { delete access(copy).crossedBy; })).toThrow(/no crossing record/);
    expect(forged(copy => { copy.labels = copy.labels.filter(label => label.id !== 'label:group:access'); })).toThrow(/group titles/);
  }, 120000);

  it('a title on text is refused unless its record names it, and G3 hits a horizontal run through a crossed title (review of ticket 54)', async () => {
    const model = await run(fixture('a-group-title-yields-with-a-halo'));
    const access = title(model, 'access'), box = access.bounds!;
    // Text over the title: a description label of a node, as wide as the title.
    const onText = (named: boolean): LayoutModel => {
      const copy = structuredClone(model);
      copy.labels.push({ id: 'label:forged', owner: { kind: 'node', id: 'sw1' }, layer: 'routed', role: 'description', text: 'x', bounds: { ...box } });
      if (named) copy.diagnostics.push({ stage: 'placement', severity: 'warning', code: 'GROUP_TITLE_ON_TEXT', message: 'forged', owners: [{ kind: 'group', id: 'access' }] });
      return copy;
    };
    expect(() => validateGroupLabelBands(onText(false))).toThrow(/stands on label:forged/);
    expect(() => validateGroupLabelBands(onText(true))).not.toThrow(/stands on/);
    // A link the title records may cross it; a horizontal segment of that link drawn through the text is a hit all the same.
    const crossed = model.links.find(link => link.id === access.crossedBy![0])!;
    const copy = structuredClone(model), link = copy.links.find(item => item.id === crossed.id)!, y = box.y + box.height / 2;
    link.path!.segments.push({ from: { x: box.x - 4, y }, to: { x: right(box) + 4, y }, owner: { kind: 'link', id: link.id } });
    expect(g3(model)).toEqual([]);
    expect(g3(copy)).not.toEqual([]);
  }, 120000);

  it('keeps the titles independent of the order of the links and the nodes (R3)', async () => {
    const yaml = fixture('a-group-title-yields-with-a-halo'), base = await run(yaml);
    const [top, rest] = yaml.split('nodes:\n'), [nodes, links] = rest!.split('links:\n');
    const reverse = (block: string): string => `${block.trimEnd().split('\n').reverse().join('\n')}\n`;
    const titles = (model: LayoutModel) => model.labels.filter(label => label.role === 'group')
      .map(label => ({ id: label.id, bounds: label.bounds, yield: label.yield, crossedBy: ends(model, label.crossedBy!) }));
    expect(titles(await run(`${top}nodes:\n${nodes}links:\n${reverse(links!)}`))).toEqual(titles(base));
    // Node order is the row order (a meaningful order): the row mirrors, and the titles stand as before.
    const mirrored = titles(await run(`${top}nodes:\n${reverse(nodes!)}links:\n${links}`));
    expect(mirrored.map(({ id, bounds, yield: kind }) => ({ id, bounds, kind }))).toEqual(titles(base).map(({ id, bounds, yield: kind }) => ({ id, bounds, kind })));
  }, 240000);
});
