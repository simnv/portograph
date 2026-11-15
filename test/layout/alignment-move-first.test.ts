import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { centre, seatCandidates } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { rows } from '../../src/layout/rows.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { findPort } from '../../src/layout/row-paths.js';
import { standsBySeatMove } from '../../src/layout/alignment-targets.js';
import type { LayoutModel, LayoutNode } from '../../src/model/layout.js';
import { reversed } from '../../scripts/r3-lib.mjs';
import { createAttempt, placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// ADR-0027, dense-16x9 ticket 02: the seat moves a body inside the slack of its row before it grows the body.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-child-moves-in-row-slack-before-it-grows.yaml', import.meta.url), 'utf8');
const centred = async (yaml: string): Promise<{ input: LayoutModel; model: LayoutModel }> => {
  const input = flanks(lanes(rows(await placed(yaml))));
  return { input, model: centre(input) };
};

describe('the seat of a node (ADR-0027)', () => {
  it('slides each narrow child under its feed inside its row and keeps its width; the records hold the seat and the kept target (R1)', async () => {
    const { input, model } = await centred(fixture);
    for (const id of ['child-a', 'child-b']) {
      expect(model.nodes[id]!.bounds!.width, id).toBe(input.nodes[id]!.bounds!.width);
      expect(model.alignmentTargets![`${id}|top`], id).toEqual([expect.objectContaining({ state: 'kept' })]);
      const seat = model.alignmentSeats![id]!;
      expect(Math.abs(seat.dx), id).toBeGreaterThan(1);
      expect(seat.width, id).toBe(seat.from);
      expect(seat.ports, id).toEqual([`port:${JSON.stringify([id, false, 'up', 1])}`]);
    }
    for (const link of model.links) {
      const from = findPort(model, link.attachments!.from)!, to = findPort(model, link.attachments!.to)!;
      expect(to.anchor!.x, link.id).toBeCloseTo(from.anchor!.x, 6);
      expect(standsBySeatMove(model, link), link.id).toBe(true);
    }
    expect(model.nodes['parent-a']!.bounds!.width).toBe(input.nodes['parent-a']!.bounds!.width);
    expect(model.nodes['parent-b']!.bounds!.width).toBe(input.nodes['parent-b']!.bounds!.width);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  });

  it('lays the sheet out the same with its links reversed, and seats both children with its nodes reversed (R3)', async () => {
    const { model } = await centred(fixture);
    const { model: links } = await centred(reversed(fixture, 'links'));
    for (const id of Object.keys(model.nodes)) expect(links.nodes[id]!.bounds, id).toEqual(model.nodes[id]!.bounds);
    expect(links.alignmentSeats).toEqual(model.alignmentSeats);
    // The order of `nodes` is author input (`autoArrange: false` keeps it as the row order): the parents swap, and each child still slides under its own.
    const { model: nodes } = await centred(reversed(fixture, 'nodes'));
    expect(Object.keys(nodes.alignmentSeats!).sort()).toEqual(['child-a', 'child-b']);
    for (const link of nodes.links) {
      const from = findPort(nodes, link.attachments!.from)!, to = findPort(nodes, link.attachments!.to)!;
      expect(to.anchor!.x, link.id).toBeCloseTo(from.anchor!.x, 6);
    }
  });

  it('refuses a forged seat record at restore: a port the node lacks, a width past the cap, a narrowed body, a record of the wrong stage (R5)', async () => {
    const { model } = await centred(fixture);
    const forge = (change: (seat: NonNullable<LayoutModel['alignmentSeats']>) => void): string => {
      const copy = structuredClone(model);
      change(copy.alignmentSeats!);
      return JSON.stringify(copy);
    };
    expect(() => restoreLayoutModel(forge(seats => { seats['child-a']!.ports = ['port:["child-a",false,"down",1]']; }))).toThrow(/alignment seat record is forged/);
    expect(() => restoreLayoutModel(forge(seats => { seats['child-a']!.width = 50 * seats['child-a']!.from; }))).toThrow(/alignment seat record is forged/);
    expect(() => restoreLayoutModel(forge(seats => { seats['child-a']!.width = seats['child-a']!.from - 5; }))).toThrow(/alignment seat record is forged/);
    expect(() => restoreLayoutModel(forge(seats => { seats['no-such-node'] = { ...seats['child-a']! }; }))).toThrow(/alignment seat record is forged/);
    // Absent is undecided and `{}` is decided, no seat: both restore.
    expect(() => restoreLayoutModel(forge(seats => { for (const key of Object.keys(seats)) delete seats[key]; }))).not.toThrow();
    const absent = structuredClone(model);
    delete absent.alignmentSeats;
    expect(() => restoreLayoutModel(JSON.stringify(absent))).not.toThrow();
  });

  it('ranks the seats: the most owed verticals, then the most targets, then the least growth, then the least slide, a move before a growth in place', () => {
    const node = { id: 'n', bounds: { x: 300, y: 0, width: 60, height: 40 }, sidePitch: { top: 16, bottom: 16 }, contentInsets: { top: 10, right: 10, bottom: 10, left: 10 },
      ports: [0, 1].map(index => ({ ref: { node: 'n', anonymous: true, index: index + 1 }, side: 'top', engineOrder: index, anchor: { x: 320 + 16 * index, y: 0 } })) } as unknown as LayoutNode;
    const open = { low: -Infinity, high: Infinity };
    const bounds = { siblings: open, window: open, stops: open };
    const target = (index: number, x: number, owes = true) => ({ key: `t${index}`, side: 'top' as const, index, x, owes });
    // Two targets 200 px apart: the body grows to hold both; the in-place growth comes after the move and grow.
    const both = seatCandidates(node, [target(0, 100), target(1, 300)], bounds, true, () => true);
    expect(both[0]).toMatchObject({ keys: ['t0', 't1'], inPlace: false });
    expect(both[0]!.growth).toBeLessThan(both.find(item => item.keys.length === 2 && item.inPlace)!.growth);
    // A single target the body can reach by a slide is stood with no growth.
    const one = seatCandidates(node, [target(0, 400)], bounds, true, () => true)[0]!;
    expect(one).toMatchObject({ keys: ['t0'], growth: 0, inPlace: false });
    expect(one.dx).toBeGreaterThan(0);
    // A body that may not move takes only a seat with no slide.
    expect(seatCandidates(node, [target(0, 400)], bounds, false, () => true).every(item => Math.abs(item.dx) === 0)).toBe(true);
    // An owed vertical ranks before a target that owes none.
    const owed = seatCandidates(node, [target(0, 100, false), target(1, 1000)], bounds, true, (_window, width) => width <= 300)[0]!;
    expect(owed.keys).toEqual(['t1']);
    // A seat past the cap is no candidate.
    expect(seatCandidates(node, [target(0, 100), target(1, 300)], bounds, true, () => false).some(item => item.growth > 0)).toBe(false);
  });

  // At cap 4 both sheets failed the publication replay: a lane moved after the 7c producer (a transit lane that follows its child, a perimeter
  // course lane measured again), and the replay read another feed. At cap 5 both publish; the tests keep them publishing.
  it.each(['a-corridor-moves-after-the-grid-settles', 'a-lifted-group-takes-its-feed-on-its-side'])('publishes %s: the replay reads the seat the producer made', async name => {
    const yaml = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(model.removedLinks ?? []).toEqual([]);
  }, 300000);

  it('keeps all seven vertical links of the ticket-73 nested-stem sheet', async () => {
    const yaml = readFileSync(new URL('../../goldens/synthetic/a-nested-stem-is-decided-before-its-gap-opens.yaml', import.meta.url), 'utf8');
    const model = await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
    expect(model.links).toHaveLength(7);
    for (const link of model.links) {
      const segments = link.path!.segments, x = segments[0]!.from.x;
      for (const segment of segments) {
        expect(segment.from.x, link.id).toBeCloseTo(x, 6);
        expect(segment.to.x, link.id).toBeCloseTo(x, 6);
      }
    }
    expect(score(model).snapshot.passed).toBe(true);
    expect(model.removedLinks ?? []).toEqual([]);
  });
});
