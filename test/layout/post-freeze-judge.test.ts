import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { blockMoveRefusal, blockReservationFaults } from '../../src/layout/block-checks.js';
import { POST_FREEZE_MOVE_REFUSED, judgedMove } from '../../src/layout/post-freeze-judge.js';
import { chordsHold } from '../../src/layout/frame-paths.js';
import { createAttempt, createColdAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 31: every mover after the chord freeze of 7f is judged by one judge, which reads the solid-block reservations. The
// synthetic's own publication is test/pipeline/post-freeze-block-reservations.test.ts.
const yaml = readFileSync(new URL('../../goldens/synthetic/a-centring-step-after-the-freeze-keeps-a-solid-block-on-its-angle.yaml', import.meta.url), 'utf8');
const run = (text: string, cold = false): Promise<LayoutModel> =>
  layout(parse(text), { createElkAttempt: cold ? createColdAttempt : createAttempt, createRouteAttempt: createAvoidAttempt });
const solidMembers = (model: LayoutModel): string[] => (model.fanFamilies ?? []).filter(family => family.kind === 'solid').flatMap(family => family.members.map(member => member.link));
/** Moves one node and its ports by dx, as a mover after the freeze would. */
const shift = (model: LayoutModel, id: string, dx: number): void => {
  const node = model.nodes[id]!;
  node.bounds = { ...node.bounds!, x: node.bounds!.x + dx };
  for (const port of node.ports) if (port.anchor) port.anchor = { ...port.anchor, x: port.anchor.x + dx };
};

describe('a move after the chord freeze keeps every solid-block reservation (dense-16x9 ticket 31)', () => {
  it('refuses a mover that takes a block member off its reservation, gives the state back whole and names it', async () => {
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    const before = JSON.stringify(model);
    // The mover moves one end of the member far aside: the member loses its angle, and the judge refuses the mover.
    const value = judgedMove(model, 'test move', () => { shift(model, mover, 2000); return 'moved'; }, 'refused');
    expect(value).toBe('refused');
    const named = model.diagnostics.filter(item => item.code === POST_FREEZE_MOVE_REFUSED);
    expect(named).toHaveLength(1);
    expect(named[0]!.message).toContain('The test move of 7f is refused');
    expect(named[0]!.owners).toEqual([{ kind: 'link', id: 'link-11' }]);
    // Everything but the note is as it was before the mover.
    expect(JSON.stringify({ ...model, diagnostics: model.diagnostics.filter(item => item.code !== POST_FREEZE_MOVE_REFUSED) })).toBe(before);
    // The same refusal again adds no second note.
    judgedMove(model, 'test move', () => shift(model, mover, 2000), undefined);
    expect(model.diagnostics.filter(item => item.code === POST_FREEZE_MOVE_REFUSED)).toHaveLength(1);
  }, 180000);

  it('keeps a mover that touches no block member, and a mover that moves both rows of the block together', async () => {
    const model = structuredClone(await run(yaml, true));
    const members = new Set(solidMembers(model));
    const ends = new Set(model.links.filter(link => members.has(link.id)).flatMap(link => [link.attachments!.from.node, link.attachments!.to.node]));
    const free = Object.keys(model.nodes).find(id => !ends.has(id))!;
    expect(judgedMove(model, 'free move', () => { shift(model, free, 3); return 'moved'; }, 'refused')).toBe('moved');
    // A translation of every end of the block keeps every angle, gap and pitch it reserved.
    expect(judgedMove(model, 'block move', () => { for (const id of ends) shift(model, id, 1); return 'moved'; }, 'refused')).toBe('moved');
    expect(model.diagnostics.some(item => item.code === POST_FREEZE_MOVE_REFUSED)).toBe(false);
  }, 180000);

  it('reads only what the move touched: a fault the model had already is no refusal, and a model before the freeze is not judged', async () => {
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    shift(model, mover, 2000);
    const faults = blockReservationFaults(model);
    expect(faults.get('link-11')).toContain('lost its reserved angle');
    // The move the judge reads starts from the broken model: it adds no fault, so it is kept.
    expect(blockMoveRefusal(faults, model)).toBeUndefined();
    expect(judgedMove(model, 'later move', () => 'moved', 'refused')).toBe('moved');
    // Before the freeze there is no reservation to keep: the mover runs unjudged.
    const early = structuredClone(model);
    delete early.frozenChords;
    expect(blockReservationFaults(early).size).toBe(0);
    expect(judgedMove(early, 'early move', () => { shift(early, mover, 500); return 'moved'; }, 'refused')).toBe('moved');
  }, 180000);

  it('lets chordsHold keep a move that adds no fault while another fault stands, and refuse one that adds a fault', async () => {
    // The synthetic's failure on main 92b16e7f: a centring step took link-11 off its angle for a moment, and chordsHold then refused every
    // move, the one that brings the member back too, because it read a fault the move had not made.
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    const site = model.groups.site!;
    const siteMove = [{ group: { id: site.id, nodes: [...site.nodes], bounds: site.bounds! }, bounds: { ...site.bounds!, x: site.bounds!.x + 1 } }];
    const memberMove = (dx: number) => [{ group: { nodes: [mover], bounds: model.nodes[mover]!.bounds! }, bounds: { ...model.nodes[mover]!.bounds!, x: model.nodes[mover]!.bounds!.x + dx } }];
    // On the published model: a move of the member's end far aside adds a fault and is refused.
    expect(chordsHold(model, memberMove(2000), false)).toBe(false);
    // With link-11 off its angle already, a move of the site row adds no fault and is kept.
    shift(model, mover, 2000);
    expect(blockReservationFaults(model).has('link-11')).toBe(true);
    expect(chordsHold(model, siteMove, false)).toBe(true);
  }, 180000);
});
