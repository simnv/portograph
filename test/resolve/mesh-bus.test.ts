import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const pairs = (nodes: string[], cls = 'sync') => nodes.flatMap((a, i) => nodes.slice(i + 1).map(b => `{ from: ${a}, to: ${b}, class: ${cls} }`));
function doc(groups: string, nodes: string, links: string[]): string {
  return `portograph: 2\ngroups:\n${groups}\nnodes:\n${nodes}\nlinks:\n${links.map(link => `  - ${link}`).join('\n')}\n`;
}
const oneRow = (ids: string[], links: string[], group = '{ tier: 0 }') =>
  doc(`  row: ${group}`, ids.map(id => `  ${id}: { group: row }`).join('\n'), links);
const withPorts = (links: string[]) => doc('  row: { tier: 0 }',
  '  a: { group: row, ports: [{ name: p }, { name: q }] }\n  b: { group: row }\n  c: { group: row }', links);
const codes = (model: ReturnType<typeof resolve>, code: string) => model.diagnostics.filter(d => d.code === code);

describe('mesh bus detection (stage 1)', () => {
  it('collapses a full mesh on one row into one bus with one anonymous port per member', () => {
    const model = resolve(parse(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    expect(model.meshBuses).toHaveLength(1);
    const bus = model.meshBuses![0]!;
    expect(bus).toMatchObject({ id: 'mesh-bus-1', class: 'sync', row: 1, placement: 'in-frame', frames: ['row'], dissolved: [], layer: 'overlay', nodes: ['n1', 'n2', 'n3', 'n4', 'n5'] });
    expect(bus.members).toHaveLength(10);
    for (const id of bus.nodes) {
      const anonymous = model.nodes[id]!.ports.filter(port => port.ref.anonymous);
      // n1 and n5 also keep the port of their routed link to the core.
      expect(anonymous).toHaveLength(id === 'n1' || id === 'n5' ? 2 : 1);
    }
    for (const id of bus.members) {
      const link = model.links.find(l => l.id === id)!;
      expect(link).toMatchObject({ meshBus: 'mesh-bus-1', technique: 'mesh-bus', layer: 'overlay' });
      for (const end of [link.attachments!.from, link.attachments!.to]) expect(end).toEqual(bus.ports[bus.nodes.indexOf(end.node)]);
    }
    expect(codes(model, 'MESH_BUS')).toHaveLength(1);
    expect(codes(model, 'MESH_BUS')[0]!.owners).toHaveLength(10);
    expect(codes(model, 'MESH_BUS_PARTIAL')).toHaveLength(0);
    expect(codes(model, 'SHARED_PORT')).toHaveLength(0);
  });

  it('is deterministic and reproduces itself from its own document', () => {
    const first = resolve(parse(fixture('a-full-mesh-on-one-row-draws-as-one-bus')));
    expect(JSON.stringify(resolve(first.document))).toBe(JSON.stringify(first));
  });

  it('keeps the largest complete part of a partial mesh', () => {
    const model = resolve(parse(fixture('a-partial-mesh-keeps-its-largest-complete-part')));
    const bus = model.meshBuses![0]!;
    expect(bus.nodes).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(bus.members).toHaveLength(6);
    const plain = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined);
    expect(plain).toHaveLength(3);
    expect(plain.every(link => link.technique === 'overlay')).toBe(true);
    const partial = codes(model, 'MESH_BUS_PARTIAL');
    expect(partial).toHaveLength(1);
    expect(partial[0]!.severity).toBe('info');
    expect(partial[0]!.message).toContain('n5');
    expect(partial[0]!.message).toContain('n4-n5');
  });

  it('declines a bus when a member holds two authored ports', () => {
    const model = resolve(parse(withPorts([
      '{ from: a.p, to: b, class: sync }', '{ from: a.q, to: c, class: sync }', '{ from: b, to: c, class: sync }',
    ])));
    expect(model.meshBuses).toBeUndefined();
    const declined = codes(model, 'MESH_BUS_DECLINED');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toContain('named-ports');
    expect(model.links.every(link => link.meshBus === undefined && link.technique === 'overlay')).toBe(true);
  });

  it('takes one shared authored port as the bus port', () => {
    const model = resolve(parse(withPorts([
      '{ from: a.p, to: b, class: sync }', '{ from: a.p, to: c, class: sync }', '{ from: b, to: c, class: sync }',
    ])));
    const bus = model.meshBuses![0]!;
    expect(bus.ports[0]).toMatchObject({ node: 'a', name: 'p' });
    expect(codes(model, 'SHARED_PORT')).toHaveLength(0);
  });

  it('takes a mesh across two groups as one bus, with the group-links dissolved', () => {
    const left = ['a1', 'a2', 'a3'], right = ['b1', 'b2', 'b3'];
    const links = [...pairs(left), ...pairs(right), ...left.flatMap(a => right.map(b => `{ from: ${a}, to: ${b}, class: sync }`))];
    const nodes = [...left.map(id => `  ${id}: { group: west }`), ...right.map(id => `  ${id}: { group: east }`)].join('\n');
    const model = resolve(parse(doc('  west: { tier: 0 }\n  east: { tier: 0 }', nodes, links)));
    expect(model.meshBuses).toHaveLength(1);
    expect(model.meshBuses![0]).toMatchObject({ placement: 'across-frames', frames: ['west', 'east'], dissolved: ['group-link-1'] });
    expect(model.meshBuses![0]!.nodes).toHaveLength(6);
    expect(model.meshBuses![0]!.members).toHaveLength(15);
    expect(model.groupLinks).toEqual([]);
    expect(model.links.every(link => link.groupLink === undefined && link.meshBus === 'mesh-bus-1')).toBe(true);
    expect(codes(model, 'ROUTE_UNSUPPORTED')).toHaveLength(0);
  });

  it('dissolves a group-link the bus takes only part of, and leaves the rest plain', () => {
    // Groups of two with the complete cross set (one group-link of four) and a1-a2: the bus is a1 a2 b1.
    const links = ['a1-a2', 'a1-b1', 'a1-b2', 'a2-b1', 'a2-b2'].map(pair => { const [f, t] = pair.split('-'); return `{ from: ${f}, to: ${t}, class: sync }`; });
    const nodes = ['a1', 'a2'].map(id => `  ${id}: { group: west }`).concat(['b1', 'b2'].map(id => `  ${id}: { group: east }`)).join('\n');
    const model = resolve(parse(doc('  west: { tier: 0 }\n  east: { tier: 0 }', nodes, links)));
    expect(model.meshBuses![0]).toMatchObject({ nodes: ['a1', 'a2', 'b1'], dissolved: ['group-link-1'] });
    expect(model.meshBuses![0]!.members).toHaveLength(3);
    expect(model.groupLinks).toEqual([]);
    expect(model.links.filter(link => link.meshBus === undefined && link.layer === 'overlay')).toHaveLength(2);
    expect(model.links.every(link => link.groupLink === undefined)).toBe(true);
    expect(codes(model, 'MESH_BUS_PARTIAL').some(d => d.message.includes('group-link-1 lost 2 of its 4'))).toBe(true);
  });

  it('reads the fixtures of a mesh across frames, of one-node groups and across cantons', () => {
    const frames = resolve(parse(fixture('a-mesh-across-frames-draws-one-bus')));
    expect(frames.meshBuses).toHaveLength(1);
    expect(frames.meshBuses![0]).toMatchObject({ placement: 'across-frames', dissolved: ['group-link-1', 'group-link-2', 'group-link-3'] });
    expect(frames.meshBuses![0]!.nodes).toHaveLength(6);
    expect(frames.meshBuses![0]!.members).toHaveLength(15);
    expect(frames.groupLinks).toEqual([]);
    expect(codes(frames, 'MESH_BUS')).toHaveLength(1);
    const single = resolve(parse(fixture('a-mesh-of-one-node-groups-draws-one-bus')));
    expect(single.meshBuses![0]).toMatchObject({ placement: 'across-frames' });
    expect(single.meshBuses![0]!.nodes).toHaveLength(3);
    const cantons = resolve(parse(fixture('a-bus-across-cantons-crosses-the-canton-edges')));
    expect(cantons.meshBuses![0]).toMatchObject({ placement: 'across-frames', dissolved: ['group-link-1'] });
    expect(cantons.meshBuses![0]!.members).toHaveLength(6);
  });

  it('gives no bus when every member carries route: overlay', () => {
    const links = pairs(['a', 'b', 'c']).map(link => link.replace(' }', ', route: overlay }'));
    const model = resolve(parse(oneRow(['a', 'b', 'c'], links)));
    expect(model.meshBuses).toBeUndefined();
    expect(model.links.every(link => link.meshBus === undefined)).toBe(true);
  });

  it('declines a grid group with the shape reason', () => {
    const model = resolve(parse(oneRow(['a', 'b', 'c'], pairs(['a', 'b', 'c']), '{ tier: 0, shape: grid }')));
    expect(model.meshBuses).toBeUndefined();
    const declined = codes(model, 'MESH_BUS_DECLINED');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toContain('shape');
  });

  it('declines a second mesh on a row that holds a bus', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const model = resolve(parse(oneRow(ids, [...pairs(ids.slice(0, 3)), ...pairs(ids.slice(3))])));
    expect(model.meshBuses).toHaveLength(1);
    const declined = codes(model, 'MESH_BUS_DECLINED');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toContain('second-mesh');
  });

  it('leaves a pair of nodes as a plain overlay link', () => {
    const model = resolve(parse(oneRow(['a', 'b'], pairs(['a', 'b']))));
    expect(model.meshBuses).toBeUndefined();
    expect(model.links[0]!.technique).toBe('overlay');
  });

  it('reads every maximal clique of the whole graph: a declined clique hides no other', () => {
    const model = resolve(parse(doc('  row: { tier: 0 }',
      '  a: { group: row, ports: [{ name: p }, { name: q }] }\n  b: { group: row }\n  c: { group: row }\n  d: { group: row }\n  e: { group: row }',
      ['{ from: a.p, to: b, class: sync }', '{ from: a.q, to: c, class: sync }', '{ from: a.p, to: d, class: sync }',
        '{ from: b, to: c, class: sync }', '{ from: b, to: d, class: sync }', '{ from: c, to: d, class: sync }',
        '{ from: b, to: e, class: sync }', '{ from: c, to: e, class: sync }'])));
    expect(codes(model, 'MESH_BUS_DECLINED').map(d => d.message).join()).toContain('named-ports');
    expect(model.meshBuses).toHaveLength(1);
    expect(model.meshBuses![0]!.nodes).toEqual(['b', 'c', 'e']);
  });

  it('does not call the plain links of a partial mesh a second mesh', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    const links = pairs(ids).filter(link => !/from: n1, to: n2,|from: n3, to: n4,/.test(link));
    const model = resolve(parse(oneRow(ids, links)));
    expect(model.meshBuses).toHaveLength(1);
    expect(model.meshBuses![0]!.nodes).toHaveLength(4);
    expect(codes(model, 'MESH_BUS_DECLINED')).toHaveLength(0);
    expect(codes(model, 'MESH_BUS_PARTIAL')).toHaveLength(1);
  });

  it('splits a mesh on two sub-tiers by sub-tier and leaves the cross links plain', () => {
    const upper = ['a1', 'a2', 'a3'], lower = ['b1', 'b2', 'b3'];
    const links = [...pairs(upper), ...pairs(lower), ...upper.flatMap(a => lower.map(b => `{ from: ${a}, to: ${b}, class: sync }`))];
    const nodes = [...upper.map(id => `  ${id}: { group: west }`), ...lower.map(id => `  ${id}: { group: east }`)].join('\n');
    const model = resolve(parse(doc('  west: { tier: 0 }\n  east: { tier: 1 }', nodes, links)));
    expect(model.meshBuses!.map(bus => [bus.row, bus.nodes.length, bus.members.length])).toEqual([[0, 3, 3], [1, 3, 3]]);
    const cross = model.links.filter(link => link.meshBus === undefined);
    expect(cross).toHaveLength(9);
    // The cross set is a group-link, and the bus takes none of its members.
    expect(model.groupLinks).toHaveLength(1);
    expect(cross.every(link => link.groupLink === 'group-link-1')).toBe(true);
  });

  it('leaves a routed group-link alone', () => {
    const nodes = ['a1', 'a2', 'b1', 'b2'].map((id, i) => `  ${id}: { group: ${i < 2 ? 'west' : 'east'} }`).join('\n');
    const links = ['a1', 'a2'].flatMap(a => ['b1', 'b2'].map(b => `[${a}, ${b}]`)).concat(['[a1, a2]', '[b1, b2]']);
    const model = resolve(parse(doc('  west: { tier: 0 }\n  east: { tier: 0 }', nodes, links)));
    expect(model.meshBuses).toBeUndefined();
    expect(model.groupLinks).toHaveLength(1);
    expect(model.groupLinks[0]!.layer).toBe('routed');
  });

  it('keys the row of a ranked group by the sub-tier of its cells', () => {
    const ids = ['r1', 'r2', 'r3', 's1', 's2', 's3'];
    const nodes = ['  isp: { group: up }', ...ids.map(id => `  ${id}: { group: g }`)].join('\n');
    const links = ['[isp, r1]', '[isp, r2]', '[isp, r3]', '[r1, s1]', '[r2, s2]', '[r3, s3]', ...pairs(ids.slice(0, 3)), ...pairs(ids.slice(3))];
    const model = resolve(parse(doc('  up: { tier: 0 }\n  g: { tier: 1 }', nodes, links)));
    expect(Object.keys(model.document.frames ?? {})).toEqual(['g']);
    expect(model.meshBuses).toHaveLength(2);
    const [first, second] = model.meshBuses!;
    expect(first!.row).not.toBe(second!.row);
    expect([first!.nodes, second!.nodes]).toEqual([ids.slice(0, 3), ids.slice(3)]);
    expect(first!.placement).toBe('in-frame');
    expect(first!.frames).toHaveLength(1);
  });

  it('names the frames of the fixtures, and resolves each one again to the same model', () => {
    const names = ['a-mesh-across-frames-draws-one-bus', 'a-mesh-of-one-node-groups-draws-one-bus', 'a-bus-across-cantons-crosses-the-canton-edges',
      'a-partial-mesh-keeps-its-largest-complete-part', 'a-full-mesh-on-one-row-draws-as-one-bus'];
    const frames = names.map(name => resolve(parse(fixture(name))).meshBuses![0]!.frames);
    expect(frames).toEqual([['west', 'middle', 'east'], ['west', 'middle', 'east'], ['west-servers', 'east-servers'], ['row'], ['row']]);
    for (const name of names) {
      const first = resolve(parse(fixture(name)));
      expect(JSON.stringify(resolve(first.document))).toBe(JSON.stringify(first));
    }
  });

  it('gives no decline for a 12-node set that misses two disjoint pairs', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${i + 1}`);
    const links = pairs(ids).filter(link => !/from: n1, to: n2,|from: n3, to: n4,/.test(link));
    const model = resolve(parse(oneRow(ids, links)));
    expect(model.meshBuses![0]!.nodes).toHaveLength(10);
    expect(codes(model, 'MESH_BUS_DECLINED')).toHaveLength(0);
  });

  it('declines a triangle of another class through a bus node as a second mesh', () => {
    const model = resolve(parse(oneRow(['a', 'b', 'c', 'd', 'x', 'y'], [...pairs(['a', 'b', 'c', 'd']), ...pairs(['a', 'x', 'y'], 'flow')])));
    expect(model.meshBuses).toHaveLength(1);
    const declined = codes(model, 'MESH_BUS_DECLINED');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toContain('second-mesh');
  });

  it('declines a triangle of the bus class whose outside nodes touch one bus node', () => {
    const model = resolve(parse(oneRow(['a', 'b', 'c', 'd', 'x', 'y'], [...pairs(['a', 'b', 'c', 'd']), ...pairs(['d', 'x', 'y'])])));
    expect(model.meshBuses![0]!.nodes).toEqual(['a', 'b', 'c', 'd']);
    const declined = codes(model, 'MESH_BUS_DECLINED');
    expect(declined).toHaveLength(1);
    expect(declined[0]!.message).toContain('second-mesh');
  });

  it('declines the triangle through the node that touches one bus node in the corridor input without its opt-out', () => {
    const text = fixture('a-corridor-moves-after-the-grid-settles').replaceAll(', route: overlay', '');
    const model = resolve(parse(text));
    expect(model.meshBuses).toHaveLength(2);
    expect(codes(model, 'MESH_BUS_DECLINED').some(d => d.message.includes('second-mesh'))).toBe(true);
  });

  it('stops the clique search and declines, in bounded time, on a row of 40 nodes with a million maximal cliques', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `n${i + 1}`);
    // The complement of a perfect matching has 2^20 maximal cliques.
    const links = pairs(ids).filter(link => { const [, a, b] = /from: n(\d+), to: n(\d+),/.exec(link)!.map(Number); return !(a! % 2 === 1 && b === a! + 1); });
    const started = Date.now();
    const model = resolve(parse(oneRow(ids, links)));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(model.meshBuses).toBeUndefined();
    expect(codes(model, 'MESH_BUS_DECLINED')[0]!.message).toContain('too-many-cliques');
  });
});
