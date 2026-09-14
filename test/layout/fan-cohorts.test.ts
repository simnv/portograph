import { describe, expect, it } from 'vitest';
import type { LayoutModel, PathSegment } from '../../src/index.js';
import { fanCohorts, fanPitch, fanRows, junctionId, treeCohorts } from '../../src/layout/bundle-geometry.js';
import { placed } from './phase-two-fixture.js';

const fan = `
portograph: 2
groups: {up: {tier: 0}, down: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  c1: {group: down, ports: [{name: p, side: top}]}
  c2: {group: down, ports: [{name: p, side: top}]}
  c3: {group: down, ports: [{name: p, side: top}]}
links: [[a.p, c1.p], [a.p, c2.p], [a.p, c3.p]]
`;

/** A straight downward path of `length` px from `a.p`, owned by `owner`. */
function straightPath(model: LayoutModel, length: number, shared: boolean): PathSegment[] {
  const port = model.nodes['a']!.ports[0]!, anchor = port.anchor!;
  const owner = shared ? { kind: 'shared-stem' as const, id: junctionId(port, 0) } : { kind: 'link' as const, id: 'link-1' };
  return [{ from: { ...anchor }, to: { x: anchor.x, y: anchor.y + length }, owner }];
}

describe('ticket 36: which fixed member joins a fan tree', () => {
  it('admits a split path at the threshold and rejects one a hair below it', async () => {
    const base = JSON.parse(JSON.stringify(await placed(fan))) as LayoutModel;
    const port = base.nodes['a']!.ports[0]!;
    // The admission threshold: the last peel row plus one pitch.
    const threshold = fanRows(base, port, base.links)[base.links.length - 2]! + fanPitch(base.links);
    for (const [run, expected] of [[threshold, ['link-1', 'link-2', 'link-3']], [threshold - 0.01, ['link-2', 'link-3']]] as const) {
      const model = JSON.parse(JSON.stringify(base)) as LayoutModel;
      model.links[0]!.path = { owner: model.links[0]!.owner, layer: 'routed', fixed: true, segments: straightPath(model, run, true) };
      expect(treeCohorts(model)[0]!.links.map(link => link.id), `run ${run}`).toEqual(expected);
    }
  }, 60000);

  it('excludes a fixed path that no producer split, however long its straight run', async () => {
    const model = JSON.parse(JSON.stringify(await placed(fan))) as LayoutModel;
    const port = model.nodes['a']!.ports[0]!;
    const rows = fanRows(model, port, model.links);
    model.links[0]!.path = { owner: model.links[0]!.owner, layer: 'routed', fixed: true, segments: straightPath(model, rows[model.links.length]! + 100, false) };
    const cohorts = treeCohorts(model);
    expect(cohorts[0]!.links.map(link => link.id)).toEqual(['link-2', 'link-3']);
  }, 60000);

  it('reports an excluded fixed member, whose own stem still covers the tree root (ticket 37)', async () => {
    const model = JSON.parse(JSON.stringify(await placed(fan))) as LayoutModel;
    const port = model.nodes['a']!.ports[0]!;
    model.links[0]!.path = { owner: model.links[0]!.owner, layer: 'routed', fixed: true, segments: straightPath(model, fanRows(model, port, model.links)[0]!, true) };
    const { cohorts, excluded } = fanCohorts(model);
    expect(cohorts[0]!.links.map(link => link.id)).toEqual(['link-2', 'link-3']);
    expect(excluded.map(item => item.link.id)).toEqual(['link-1']);
  }, 60000);

  it('keeps an unsplit fixed member out of a bundle cohort as well', async () => {
    const model = JSON.parse(JSON.stringify(await placed(fan))) as LayoutModel;
    model.links[0]!.path = { owner: model.links[0]!.owner, layer: 'routed', fixed: true, segments: straightPath(model, 400, false) };
    model.links[1]!.bundle = 'bundle-1';
    model.links[2]!.bundle = 'bundle-1';
    const cohort = treeCohorts(model).find(item => item.links.length >= 2)!;
    expect(cohort.links.map(link => link.id)).toEqual(['link-2', 'link-3']);
  }, 60000);
});

it('ticket 36: a short fixed member does not block a longer one from the straight-leaf slot', async () => {
  const four = fan.replace('  c3: {group: down, ports: [{name: p, side: top}]}',
    '  c3: {group: down, ports: [{name: p, side: top}]}\n  c4: {group: down, ports: [{name: p, side: top}]}')
    .replace('links: [[a.p, c1.p], [a.p, c2.p], [a.p, c3.p]]', 'links: [[a.p, c1.p], [a.p, c2.p], [a.p, c3.p], [a.p, c4.p]]');
  const base = JSON.parse(JSON.stringify(await placed(four))) as LayoutModel;
  const port = base.nodes['a']!.ports[0]!;
  const long = fanRows(base, port, base.links.slice(1))[base.links.length - 3]! + fanPitch(base.links) + 50;
  const model = JSON.parse(JSON.stringify(base)) as LayoutModel;
  // link-1 is fixed and far too short; link-2 is fixed and long enough. The cohort must take link-2.
  model.links[0]!.path = { owner: model.links[0]!.owner, layer: 'routed', fixed: true, segments: straightPath(model, 15, true) };
  model.links[1]!.path = { owner: model.links[1]!.owner, layer: 'routed', fixed: true, segments: straightPath(model, long, true) };
  const { cohorts, excluded } = fanCohorts(model);
  expect(cohorts[0]!.links.map(link => link.id)).toEqual(['link-2', 'link-3', 'link-4']);
  expect(excluded.map(item => item.link.id)).toEqual(['link-1']);
}, 60000);
