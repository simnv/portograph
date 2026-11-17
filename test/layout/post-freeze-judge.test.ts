import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { BLOCK_ANGLE, BLOCK_TOLERANCE, angleShortfall, blockMoveRefusal, blockReservationFaults } from '../../src/layout/block-checks.js';
import { POST_FREEZE_MOVE_REFUSED, judgedMove } from '../../src/layout/post-freeze-judge.js';
import { chordsHold } from '../../src/layout/frame-paths.js';
import { edge, saveChordState } from '../../src/layout/decide.js';
import { createAttempt, createColdAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Dense-16x9 ticket 31: every mover after the chord freeze of 7f is judged by one judge, which reads the solid-block reservations. The
// synthetic's own publication is test/pipeline/post-freeze-block-reservations.test.ts.
const yaml = readFileSync(new URL('../../goldens/synthetic/a-centring-step-after-the-freeze-keeps-a-solid-block-on-its-angle.yaml', import.meta.url), 'utf8');
const run = (text: string, cold = false): Promise<LayoutModel> =>
  layout(parse(text), { createElkAttempt: cold ? createColdAttempt : createAttempt, createRouteAttempt: createAvoidAttempt });
const solidMembers = (model: LayoutModel): string[] => (model.fanFamilies ?? []).filter(family => family.kind === 'solid').flatMap(family => family.members.map(member => member.link));
/** Moves one node, its ports and their pills by (dx, dy), as a mover after the freeze would. */
const shift = (model: LayoutModel, id: string, dx: number, dy = 0): void => {
  const node = model.nodes[id]!;
  node.bounds = { ...node.bounds!, x: node.bounds!.x + dx, y: node.bounds!.y + dy };
  for (const port of node.ports) {
    if (port.anchor) port.anchor = { x: port.anchor.x + dx, y: port.anchor.y + dy };
    if (port.pill) port.pill = { ...port.pill, bounds: { ...port.pill.bounds, x: port.pill.bounds.x + dx, y: port.pill.bounds.y + dy } };
  }
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

  it('a fault the model had already, which the move leaves as it is, is no refusal, and a model before the freeze is not judged', async () => {
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    shift(model, mover, 2000);
    const faults = blockReservationFaults(model);
    expect(faults.get('link-11')!.map(fault => fault.fault)).toContain('link-11 lost its reserved angle');
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

  it('refuses a move that takes a broken member further from its reservation or breaks it another way, and keeps one that heals it', async () => {
    // Review 1 of ticket 31: the judge read only whether a member had a fault, so a member off its angle could lose more angle, or its faces.
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    const angle = (state: LayoutModel): number => blockReservationFaults(state).get('link-11')?.find(fault => fault.constraint === 'angle')?.short ?? 0;
    // The first step of the member's end that takes it off its angle, and the only fault it has.
    let dx = 1;
    for (const state = structuredClone(model); dx < 300; dx++) { shift(state, mover, 1); if (angle(state) > 0) break; }
    const broken = structuredClone(model);
    shift(broken, mover, dx);
    expect([...blockReservationFaults(broken)].map(([key, faults]) => [key, faults.map(fault => fault.constraint)])).toEqual([['link-11', ['angle']]]);
    // One more pixel aside: the same fault, further off the angle; refused.
    const worse = structuredClone(broken);
    shift(worse, mover, 1);
    expect(angle(worse)).toBeGreaterThan(angle(broken));
    expect(blockMoveRefusal(broken, worse)?.fault).toBe('link-11 lost its reserved angle, further than before the move');
    // The member's lower port turned to a side: a fault of another kind on the same member; refused.
    const turned = structuredClone(broken), end = member.attachments!.to;
    turned.nodes[end.node]!.ports.find(port => port.ref.name === end.name)!.side = 'left';
    expect(blockMoveRefusal(broken, turned)?.fault).toContain('lost its horizontal block faces');
    // A move back toward the angle heals, and a move of nothing stands: both kept.
    const healed = structuredClone(worse);
    shift(healed, mover, -1);
    expect(blockMoveRefusal(worse, healed)).toBeUndefined();
    expect(blockMoveRefusal(broken, structuredClone(broken))).toBeUndefined();
    // The mover that makes it worse is refused whole.
    expect(judgedMove(broken, 'worse move', () => { shift(broken, mover, 1); return 'moved'; }, 'refused')).toBe('refused');
  }, 180000);

  it('gives back the movers and the growth of a refused chord-step round, and keeps the settled trials it read spent', async () => {
    // Review 1 of ticket 31: a refused round gave the model back, but its movers stayed moved and its growth stayed spent.
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    const history = new Set(['node:earlier']), before = JSON.stringify(model);
    edge(model).grown = 0;
    const value = judgedMove(model, 'step out of chords', () => {
      // What a kept chord step writes outside the model before its replay (decide.ts, chord-clear.ts); the replay then breaks link-11.
      history.add(`node:${mover}`); history.add('rank-spent:hub#1:0'); edge(model).grown += 40; shift(model, mover, 2000);
      return true;
    }, false, saveChordState(model, history));
    expect(value).toBe(false);
    expect(JSON.stringify({ ...model, diagnostics: model.diagnostics.filter(item => item.code !== POST_FREEZE_MOVE_REFUSED) })).toBe(before);
    expect(edge(model).grown).toBe(0);
    expect([...history]).toEqual(['node:earlier', 'rank-spent:hub#1:0']);
  }, 180000);

  it('reads a flat block member by its sizes too: the box clearance and the floor angle of its drawn chord (dense-16x9 ticket 04 slice 3)', async () => {
    const flat = structuredClone(await run(readFileSync(new URL('../../goldens/synthetic/a-two-by-seven-block-past-the-cap-stays-straight.yaml', import.meta.url), 'utf8')));
    expect(flat.blockReservations!.map(entry => entry.mode)).toEqual(['flat']);
    expect(blockReservationFaults(flat).size).toBe(0);
    const member = flat.links.find(link => link.id === 'link-1')!, core = member.attachments!.from.node, other = member.attachments!.to.node;
    const away = Math.sign(flat.nodes[other]!.bounds!.x - flat.nodes[core]!.bounds!.x) || 1;
    const short = (state: LayoutModel, constraint: string): number => blockReservationFaults(state).get('link-1')?.find(fault => fault.constraint.startsWith(constraint))?.short ?? 0;
    // The core end 20 px aside: link-1 leaves the core box by the side edge, too near the corner.
    const broken = structuredClone(flat);
    shift(broken, core, -20);
    expect([...blockReservationFaults(broken).keys()]).toEqual(['link-1']);
    expect(short(broken, 'box:')).toBeGreaterThan(0);
    // The pixel that takes the crossing nearer the corner is refused; the move back is kept.
    const nudged = (dx: number): LayoutModel => { const state = structuredClone(broken); shift(state, core, dx); return state; };
    const worse = [nudged(-1), nudged(1)].find(state => short(state, 'box:') > short(broken, 'box:'))!;
    expect(worse).toBeDefined();
    expect(blockMoveRefusal(broken, worse)?.fault).toBe('link-1 lost its reserved box clearance (edge), further than before the move');
    expect(blockMoveRefusal(worse, broken)).toBeUndefined();
    // The other end moved away along its row: the drawn chord flattens past the floor; one more pixel is refused.
    let dx = 1;
    const flatter = structuredClone(flat);
    for (; dx < 5000 && short(flatter, 'angle') === 0; dx++) shift(flatter, other, away, 0);
    expect(short(flatter, 'angle')).toBeGreaterThan(0);
    const flattest = structuredClone(flatter);
    shift(flattest, other, away, 0);
    expect(blockMoveRefusal(flatter, flattest)?.fault).toBe('link-1 lost its reserved angle, further than before the move');
    // The move back heals the angle but takes the side crossing nearer the core box's corner: a fault grows, so it is refused too.
    expect(short(flatter, 'angle')).toBeLessThan(short(flattest, 'angle'));
    expect(blockMoveRefusal(flattest, flatter)?.fault).toBe('link-1 lost its reserved box clearance (edge), further than before the move');
  }, 180000);

  it('lets a step leave a member within BLOCK_TOLERANCE of its angle, and refuses a step that leaves it 0.02 px of height short (the review 1 ruling)', async () => {
    const model = structuredClone(await run(yaml, true));
    const member = model.links.find(link => link.id === 'link-11')!, mover = member.attachments!.to.node;
    const anchor = (ref: NonNullable<typeof member.attachments>['to'], state = model) => state.nodes[ref.node]!.ports.find(port => port.ref.name === ref.name)!.anchor!;
    const from = anchor(member.attachments!.from), to = anchor(member.attachments!.to);
    expect(BLOCK_TOLERANCE).toBe(0.01);
    // The step of the member's lower end, away from its upper end, that leaves the chord `short` px of height short of 34 degrees.
    const away = Math.sign(to.x - from.x) || 1, slope = Math.tan(BLOCK_ANGLE * Math.PI / 180);
    const stepTo = (short: number): number => away * (short - angleShortfall(from, to, BLOCK_ANGLE)) / slope;
    const step = (dx: number) => [{ group: { nodes: [mover], bounds: model.nodes[mover]!.bounds! }, bounds: { ...model.nodes[mover]!.bounds!, x: model.nodes[mover]!.bounds!.x + dx } }];
    // 0.005 px short: inside the tolerance, a residue of the solve; kept. 0.02 px short: past it; refused, by the step judge and the move judge alike.
    expect(chordsHold(model, step(stepTo(0.005)), false)).toBe(true);
    expect(chordsHold(model, step(stepTo(0.02)), false)).toBe(false);
    const off = structuredClone(model);
    shift(off, mover, stepTo(0.02));
    expect(angleShortfall(anchor(member.attachments!.from, off), anchor(member.attachments!.to, off), BLOCK_ANGLE)).toBeCloseTo(0.02, 6);
    expect(blockMoveRefusal(model, off)?.fault).toBe('link-11 lost its reserved angle');
  }, 180000);
});
