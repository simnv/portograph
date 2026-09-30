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
    expect(bus).toMatchObject({ id: 'mesh-bus-1', class: 'sync', row: 'row', layer: 'overlay', nodes: ['n1', 'n2', 'n3', 'n4', 'n5'] });
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

  it('splits a mesh across two groups into two buses with the cross links plain', () => {
    const left = ['a1', 'a2', 'a3'], right = ['b1', 'b2', 'b3'];
    const links = [...pairs(left), ...pairs(right), ...left.flatMap(a => right.map(b => `{ from: ${a}, to: ${b}, class: sync }`))];
    const nodes = [...left.map(id => `  ${id}: { group: west }`), ...right.map(id => `  ${id}: { group: east }`)].join('\n');
    const model = resolve(parse(doc('  west: { tier: 0 }\n  east: { tier: 0 }', nodes, links)));
    expect(model.meshBuses!.map(bus => [bus.row, bus.nodes.length, bus.members.length])).toEqual([['west', 3, 3], ['east', 3, 3]]);
    expect(model.links.filter(link => link.meshBus === undefined)).toHaveLength(9);
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
});
