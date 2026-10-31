import { describe, expect, it } from 'vitest';
import type { Course, LayoutModel, Side, Size } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { movedFloor, pinMovedEnds } from '../../src/pipeline/rounds.js';
import { NO_RESERVATIONS } from '../../src/layout/reservations.js';
import { portKey } from '../../src/layout/sides-one.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// Snack-theme ticket 159 review: the course rounds pin a node whose course ends change faces (`pinMovedEnds`). The pin read one end at a time and
// overwrote the floor of the node, so two ends of one node that change faces in one offer left the node below its content with both on their new faces.
// The card `mid` has two long-named ports on its bottom face; a course offer stands one on the left face and one on the right face.
const SOURCE = `portograph: 2
layout: { nodeContent: card }
groups:
  top: { tier: 0, label: Top }
  bottom: { tier: 1, label: Bottom }
nodes:
  mid: { group: top, class: router, label: Mid, ports: [{ name: GigabitEthernet0-0-0-1, side: bottom }, { name: GigabitEthernet0-0-0-2, side: bottom }] }
  a: { group: bottom, class: router, label: A, ports: [up] }
  b: { group: bottom, class: router, label: B, ports: [up] }
links:
  - [mid.GigabitEthernet0-0-0-1, a.up]
  - [mid.GigabitEthernet0-0-0-2, b.up]
`;

const SMALL: Size = { width: 1, height: 1 };
const fit = (model: LayoutModel) => ({ env: { stage3Sizes: new Map([[model, new Map([['mid', SMALL]])]]) }, s: { kept7e: model, kept: NO_RESERVATIONS } });
/** A course that stands the `mid` end of `link` on `face` and leaves the far end where it is. */
const courseOf = (model: LayoutModel, link: string, face: Side): Course => {
  const item = model.links.find(entry => entry.id === link)!, far = model.nodes[item.attachments!.to.node]!.ports.find(port => portKey(port.ref) === portKey(item.attachments!.to))!;
  return { link, kind: 'perimeter', from: { face }, to: { face: far.side! }, runs: [] } as unknown as Course;
};

describe('the floor of a node whose course ends change faces (snack-theme ticket 159)', () => {
  it('pins the node once on every end the offer moves, never below the content with both ends on their new faces', async () => {
    const model = await layout(parse(SOURCE), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });
    const [one, two] = model.links.map(link => link.id);
    const keys = model.links.map(link => portKey(link.attachments!.from));
    const { env, s } = fit(model);
    const both = movedFloor(env, s, 'mid', new Map<string, Side>([[keys[0]!, 'left'], [keys[1]!, 'right']]))!;
    const last = movedFloor(env, s, 'mid', new Map<string, Side>([[keys[1]!, 'right']]))!;
    expect(both.width, 'the premise: a long pill on each side face makes the card wider than one does').toBeGreaterThan(last.width);
    const floors = new Map<string, Size>();
    pinMovedEnds(env, s, floors, [courseOf(model, one!, 'left'), courseOf(model, two!, 'right')], false);
    expect(floors.get('mid')).toEqual(both);
  }, 60000);

  it('keeps a floor the kept ledger already set when it is the larger', async () => {
    const model = await layout(parse(SOURCE), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testCourses: [] });
    const { env, s } = fit(model), large: Size = { width: 1000, height: 1000 };
    const floors = new Map<string, Size>([['mid', large]]);
    pinMovedEnds(env, s, floors, [courseOf(model, model.links[0]!.id, 'left')], false);
    expect(floors.get('mid')).toEqual(large);
  }, 60000);
});
