import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { COLUMN_AXIS_HELD, COLUMN_SLACK, closeCantons, holdColumnAxes } from '../../src/layout/columns.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { overlayPath } from '../../src/layout/overlay-paths.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { bandGap } from '../../src/layout/skeleton-graph.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { orthogonalLinks } from '../orthogonal-links.js';

const run = (name: string): Promise<LayoutModel> => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false });
const right = (box: Rect): number => box.x + box.width;
const cantonBoxes = (model: LayoutModel): Rect[] => model.frames!.filter(frame => frame.kind === 'canton').map(frame => frame.box).sort((a, b) => a.x - b.x);
const gaps = (model: LayoutModel): number[] => cantonBoxes(model).slice(1).map((box, i) => box.x - right(cantonBoxes(model)[i]!));
const stand = (model: LayoutModel): string => JSON.stringify(Object.values(model.groups).map(group => [group.id, group.bounds?.x]));
const heldOwners = (model: LayoutModel): string[] => model.diagnostics.filter(item => item.code === COLUMN_AXIS_HELD)
  .flatMap(item => (item.owners ?? []).flatMap(owner => 'id' in owner ? [owner.id] : []));
const closeUps = (model: LayoutModel) => model.diagnostics.filter(item => item.code === COLUMN_AXIS_HELD && /cannot close up/.test(item.message));

/** A second pass over the finished layout moves nothing and says nothing new. */
function expectIdempotent(model: LayoutModel): void {
  const copy = structuredClone(model) as LayoutModel, before = stand(copy), warnings = copy.diagnostics.length;
  holdColumnAxes(copy, 0);
  closeCantons(copy);
  expect(stand(copy)).toBe(before);
  expect(copy.diagnostics.length).toBe(warnings);
}

// Ranked-groups ticket 65: the cantons of a merged step close up to a band gap. Each assertion reads the model after the whole layout.
describe('cantons close up to a band gap (ranked-groups ticket 65)', () => {
  it('three cantons stand a band gap apart when the anchor sub-tier stands inside their span', async () => {
    const model = await run('three-canton-groups-close-up-to-a-band-gap');
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(cantonBoxes(model)).toHaveLength(3);
    // Measured before the rule: 100 and 148 px on a canvas 2049.3 px wide.
    // A straight link outranks the band-gap close-up (user, 2026-10-04), so a gap may stay wider than the band gap; a gap narrower than it is always a bug (ticket 17:
    // before the fix the chord step took a slide that left gap 1 23.9 px short, and the close-up could not restore it without bending a straight link).
    for (const [i, gap] of gaps(model).entries()) expect(gap, `gap ${i}`).toBeGreaterThanOrEqual(bandGap(model) - 1e-6);
    // No tier-0 column warns for an overlay link to a canton.
    expect(heldOwners(model).filter(id => id.startsWith('top-'))).toEqual([]);
    // No close-up is refused: with the move that left a gap short refused, the cantons stand a band gap apart (60, 60) and nothing is held open.
    expect(closeUps(model)).toEqual([]);
    expect(model.canvas!.width).toBeLessThan(2049.3 - 100);
    // The block keeps its centre (the partner mean is not a stable target, ticket "Comments"); the tier packed against the canton
    // step, the MPLS row, stands centred on it within one column slack (measured 1.5 px).
    // With the side round on, m1 (in mpls) takes a lateral side (ticket 117, link-4 freed) and 7c drops that link's pull (side-faces.md, Section 7), so the
    // centre is read on the layout with the round off; the gaps above are read on both.
    const plain = await layout(parse(readFileSync(new URL('../../goldens/synthetic/three-canton-groups-close-up-to-a-band-gap.yaml', import.meta.url), 'utf8')),
      { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false, testMaxReruns: 0 });
    const block = (cantonBoxes(plain)[0]!.x + right(cantonBoxes(plain)[2]!)) / 2, mpls = plain.groups['mpls']!.bounds!;
    expect(Math.abs(mpls.x + mpls.width / 2 - block)).toBeLessThan(COLUMN_SLACK);
    expectIdempotent(model);
  }, 120000);

  it('three continents stand a band gap apart, the equality of the earlier lower bound', async () => {
    const model = await run('three-continents');
    // Measured before the rule: 86.4 and 100 px on a canvas 1372.7 px wide.
    for (const [i, gap] of gaps(model).entries()) expect(Math.abs(gap - bandGap(model)), `gap ${i}`).toBeLessThan(1e-6);
    expect(model.canvas!.width).toBeLessThan(1372.7 - 20);
    expectIdempotent(model);
  }, 120000);

  // Review of ticket 65: the fit keeps the pins and the units that reach their feed, and the second pass moves nothing.
  it('cantons held by an overlay link keep their pin and the gates, and a second pass moves nothing', async () => {
    const model = await run('overlay-links-reorder-two-canton-groups');
    expect(score(model).snapshot.gates.G6.passed).toBe(true);
    expectIdempotent(model);
  }, 120000);

  it('a foreign unit beside a canton keeps the room the rows rule reserved, and a second pass moves nothing', async () => {
    const model = await run('a-foreign-unit-between-two-canton-groups');
    expect(score(model).snapshot.gates.G6.passed).toBe(true);
    expectIdempotent(model);
    expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' && item.message.startsWith('The cantons'))).toEqual([]);
  }, 120000);

  // The refused close-up moves the nodes and puts them back: labels in node order and the geometry exact, or publication throws.
  it('a refused close-up leaves the node labels and the geometry whole', async () => {
    // The refused close-up needs the routed links orthogonal; Q108 gives them a chord (ticket 100), so the subject is the orthogonal variant.
    const model = await layout(parse(orthogonalLinks(readFileSync(new URL('../../goldens/synthetic/a-refused-close-up-keeps-the-node-labels-in-order.yaml', import.meta.url), 'utf8'))), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testOverlayCourses: false });
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(closeUps(model).length).toBeGreaterThan(0);
    expect(closeUps(model)[0]!.message).toContain('a straight overlay link would be bent');
    const order = model.labels.filter(label => label.owner.kind === 'node' && label.role === 'node').map(label => (label.owner as { id: string }).id);
    expect(order).toEqual(Object.keys(model.nodes).filter(id => order.includes(id)));
    expectIdempotent(model);
  }, 120000);

  // Review 2: the close-up sites never pull a run that stands packed (one canton, or cantons already a band gap apart).
  it('a second pass returns false and the close-up says nothing on packed runs', async () => {
    for (const name of ['a-canton-band-holds-the-rows-off', 'a-canton-group-swap-is-refused-for-routed-crossings']) {
      const model = await run(name);
      // `closeCantons` leaves a packed run alone (`runApart`). `holdColumnAxes` still pulls the lone column of the first fixture by 7.8 px
      // on the finished layout, as on main (ticket 67, open): a pull after the replays widens the frame by the move and grows the canvas.
      const copy = structuredClone(model) as LayoutModel, before = stand(copy);
      expect(closeCantons(copy), name).toBe(false);
      expect(stand(copy), name).toBe(before);
    }
    for (const name of ['three-canton-groups-close-up-to-a-band-gap', 'a-canton-group-swap-is-refused-for-routed-crossings', 'a-foreign-unit-with-routed-links-to-two-canton-groups']) {
      const model = await run(name);
      expect(model.diagnostics.filter(item => item.code === 'PLACEMENT_NON_CONVERGENCE' && item.message.startsWith('The cantons')), name).toEqual([]);
    }
  }, 120000);

  it('a held lane between two cantons keeps the run where it stands and the warning names the canton', async () => {
    const model = await run('a-held-lane-between-two-cantons-refuses-the-close-up');
    const [west, east] = cantonBoxes(model) as [Rect, Rect];
    expect(model.lanes.some(lane => lane.x > right(west) && lane.x < east.x)).toBe(true);
    // The run stays: the spacing the rows rule left (a band gap and two column slacks) is still there.
    expect(east.x - right(west)).toBeGreaterThan(bandGap(model) + 1);
    const held = closeUps(model);
    expect(held).toHaveLength(1);
    expect(held[0]!.owners).toEqual([{ kind: 'group', id: 'west' }]);
    expect(held[0]!.message).toContain('Canton west');
    expect(held[0]!.message).toContain('stands between two cantons');
    expectIdempotent(model);
  }, 120000);
  // A straight link outranks the band-gap close-up (user, 2026-10-04). Both halves are asserted: the gap stays open, and closing it would really bend the link.
  it('a canton gap stays open when closing it would bend a straight overlay link', async () => {
    const model = await run('a-canton-gap-stays-open-when-closing-it-would-bend-a-straight-link');
    const link = model.links.find(item => item.layer === 'overlay')!;
    expect(overlayPath(model, link).segments).toHaveLength(1);
    const [gap] = gaps(model) as [number];
    expect(gap).toBeGreaterThan(bandGap(model) + 1);
    expect(closeUps(model).map(item => [item.owners![0], /a straight overlay link would be bent/.test(item.message)])).toEqual([[{ kind: 'group', id: 'west' }, true]]);
    // Close the gap on a copy, as the close-up does (the run keeps its centre): the west canton moves right and the east canton left, each by half the excess.
    // The real bend is read on the copy: overlay paths treat node bodies and pills as the obstacles, and the east-most body of the west canton now stands on the chord.
    const closed = structuredClone(model) as LayoutModel, excess = gap - bandGap(closed);
    for (const [id, dx] of [['w-site#0', excess / 2], ['w-lab#0', excess / 2], ['e-site#0', -excess / 2], ['e-lab#0', -excess / 2]] as const) {
      const group = closed.groups[id]!;
      moveGroup(closed, group, dx, 0);
      rebuildNodeGeometry(closed, group.nodes, 'current');
    }
    expect(overlayPath(closed, closed.links.find(item => item.layer === 'overlay')!).segments.length).toBeGreaterThan(1);
  }, 120000);
});
