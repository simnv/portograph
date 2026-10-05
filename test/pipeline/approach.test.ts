import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, LayoutPort } from '../../src/index.js';
import { approachPoint, endPort } from '../../src/layout/approach.js';
import { measureCourses } from '../../src/layout/course-measure.js';
import { findPort } from '../../src/layout/row-paths.js';
import { measurePortPill } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** Architecture ticket 15, phase 6: approach at a shared port. */
const NAME = 'a-port-with-two-peers-in-two-directions-takes-a-side-per-link';
const run = (options: { testCourses?: never[] } = {}): Promise<LayoutModel> => layout(parse(readFileSync(new URL(`../../goldens/synthetic/${NAME}.yaml`, import.meta.url), 'utf8')),
  { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...options });
const link = (model: LayoutModel, n: number): LayoutLink => model.links.find(item => item.id === `link-${n}`)!;

describe('the approach point on a pill (ticket 15, phase 6)', () => {
  const port = (side: LayoutPort['side']): LayoutPort => ({ ref: { node: 'n', name: 'trunk', ordinal: 1 }, side, anchor: { x: 100, y: 50 } } as LayoutPort);
  const pill = measurePortPill('trunk');

  it('a pill on a right face is met on its top or bottom edge, in the middle of its outer half', () => {
    expect(approachPoint(port('right'), 'top')).toEqual({ x: 100 + pill.width / 4, y: 50 - pill.height / 2 });
    expect(approachPoint(port('right'), 'bottom')).toEqual({ x: 100 + pill.width / 4, y: 50 + pill.height / 2 });
    expect(approachPoint(port('left'), 'top')).toEqual({ x: 100 - pill.width / 4, y: 50 - pill.height / 2 });
  });

  it('a pill on a bottom face is met on its left or right edge', () => {
    expect(approachPoint(port('bottom'), 'left')).toEqual({ x: 100 - pill.height / 2, y: 50 + pill.width / 4 });
    expect(approachPoint(port('top'), 'right')).toEqual({ x: 100 + pill.height / 2, y: 50 - pill.width / 4 });
  });

  it('an approach on the port axis, and an anonymous port, have no approach point', () => {
    expect(approachPoint(port('right'), 'left')).toBeUndefined();
    expect(approachPoint({ ...port('right'), ref: { node: 'n', anonymous: true, ordinal: 1 } } as LayoutPort, 'top')).toBeUndefined();
  });
});

describe('the uplink of the shared-port sheet meets the trunk pill from above (hand-solve 12)', () => {
  it('the uplink drops onto the pill top in two turns, its jog stands in the tier gap, and every gate holds', async () => {
    const model = await run();
    const up = link(model, 1), trunk = findPort(model, up.attachments!.to)!, point = endPort(model, up, 'to')!;
    expect(trunk.side).toBe('right');
    expect(point.side).toBe('top');
    const segments = up.path!.segments;
    expect(segments).toHaveLength(3);
    // The path ends on the pill's top edge, inside the pill's span, and arrives going down.
    expect(segments.at(-1)!.to).toEqual(point.anchor);
    expect(trunk.pill!.bounds.y).toBeCloseTo(point.anchor!.y, 6);
    expect(point.anchor!.x).toBeGreaterThan(trunk.pill!.bounds.x);
    expect(point.anchor!.x).toBeLessThan(trunk.pill!.bounds.x + trunk.pill!.bounds.width);
    expect(segments.at(-1)!.from.x).toBeCloseTo(segments.at(-1)!.to.x, 6);
    // P8: the one horizontal run stands in the tier gap between the WAN frame and the Site frame, not in the WAN padding.
    const wan = model.groups.wan!.bounds!, site = model.groups.site!.bounds!;
    const jog = segments[1]!.from.y;
    expect(jog).toBeGreaterThan(wan.y + wan.height);
    expect(jog).toBeLessThan(site.y);
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
  }, 60000);

  it('the port keeps one side and one pill; the firewall link keeps the face and carries no approach and no shared stem', async () => {
    const model = await run();
    expect(link(model, 2).approach).toBeUndefined();
    expect(model.junctions).toHaveLength(0);
    expect(model.nodes.sw!.ports.filter(port => port.pill !== undefined)).toHaveLength(1);
    const face = link(model, 2).path!.segments.at(-1)!;
    expect(face.to).toEqual(findPort(model, link(model, 2).attachments!.to)!.anchor);
  }, 60000);

  it('the course is taken as promised: 2 turns published, COURSE_SHAPE_LOST reads 0, SHARED_PORT stays a warning', async () => {
    const model = await run();
    expect(model.diagnostics.some(item => item.code === 'COURSE_SHAPE_LOST')).toBe(false);
    expect(model.diagnostics.find(item => item.code === 'SHARED_PORT')?.severity).toBe('warning');
    expect(model.diagnostics.some(item => item.code === 'COURSE_TAKEN' && (item.owners?.[0] as { id?: string } | undefined)?.id === 'link-1')).toBe(true);
  }, 60000);

  it('without the course round the sheet is as before: the uplink enters the right face in three turns', async () => {
    const model = await run({ testCourses: [] });
    expect(link(model, 1).approach).toBeUndefined();
    expect(link(model, 1).path!.segments).toHaveLength(4);
    expect(model.junctions).toHaveLength(1);
  }, 60000);
});

describe('the offer of an approach (ticket 15, phase 6 review)', () => {
  const offered = (model: LayoutModel): string[] => measureCourses(model, model).courses.filter(course => course.kind === 'shared-port').map(course => course.link);
  const plain = async (): Promise<LayoutModel> => structuredClone(await run({ testCourses: [] })) as LayoutModel;

  it('the sheet as it stands offers the uplink an approach', async () => {
    expect(offered(await plain())).toEqual(['link-1']);
  }, 60000);

  it('two uplinks from above at one pill are offered no approach: they would meet it at one point', async () => {
    const model = await plain();
    const second = structuredClone(link(model, 1));
    second.id = 'link-9'; second.sourceIndex = 9;
    model.links.push(second);
    expect(offered(model)).toEqual([]);
  }, 60000);

  it('a port with another port nearer the approach side is offered none: only the end port of its face takes it', async () => {
    const model = await plain();
    const sw = model.nodes.sw!, trunk = sw.ports.find(port => port.ref.name === 'trunk')!;
    sw.ports.push({ ...structuredClone(trunk), ref: { node: 'sw', name: 'mgmt', ordinal: 2 }, anchor: { x: trunk.anchor!.x, y: trunk.anchor!.y - 14 } });
    expect(offered(model)).toEqual([]);
    // A port on the far side of the trunk does not stand in the way.
    sw.ports.pop();
    sw.ports.push({ ...structuredClone(trunk), ref: { node: 'sw', name: 'mgmt', ordinal: 2 }, anchor: { x: trunk.anchor!.x, y: trunk.anchor!.y + 14 } });
    expect(offered(model)).toEqual(['link-1']);
  }, 60000);
});
