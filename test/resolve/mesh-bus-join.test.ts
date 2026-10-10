import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { busSide } from '../../src/layout/bus.js';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';

const arrows = vi.hoisted(() => ({ classes: new Set<string>() }));
vi.mock('../../src/model/classes.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/model/classes.js')>(),
  classDrawsArrowhead: (klass: string) => arrows.classes.has(klass),
}));

const fixture = (name: string) => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const codes = (model: ReturnType<typeof resolve>, code: string) => model.diagnostics.filter(d => d.code === code);
const link = (a: string, b: string, extra = '', cls = 'sync') => `{ from: ${a}, to: ${b}, class: ${cls}${extra} }`;
const within = (ids: string[], edit: (a: string, b: string) => string = link) => ids.flatMap((a, i) => ids.slice(i + 1).map(b => edit(a, b)));
const across = (up: string[], low: string[], edit: (a: string, b: string) => string = link) => up.flatMap(a => low.map(b => edit(a, b)));

interface Row { ids: string[]; node?: ((id: string) => string) | undefined }
/** A document with one group per row, on tiers 0, 1, 2 ... (each row a bus of its own). */
function rows(list: Row[], links: string[]): string {
  const groups = list.map((_, i) => `  r${i}: { tier: ${i} }`).join('\n');
  const nodes = list.flatMap((row, i) => row.ids.map(id => row.node?.(id) ?? `  ${id}: { group: r${i} }`)).join('\n');
  return `portograph: 2\ngroups:\n${groups}\nnodes:\n${nodes}\nlinks:\n${links.map(l => `  - ${l}`).join('\n')}\n`;
}
const UP = ['a1', 'a2', 'a3'], LOW = ['b1', 'b2', 'b3', 'b4'];
const mesh = (cross: string[] = across(UP, LOW), up = UP, low = LOW) => [...within(up), ...within(low), ...cross];
const two = (cross?: string[], nodes?: (id: string) => string) => resolve(parse(rows([{ ids: UP, node: nodes }, { ids: LOW, node: nodes }], mesh(cross))));
const declined = (model: ReturnType<typeof resolve>) => codes(model, 'MESH_BUS_JOIN_DECLINED');

describe('two buses over two rows (stage 1, ticket 94)', () => {
  it('joins the buses of the fixture and moves the cross ends to the bus ports', () => {
    const model = resolve(parse(fixture('a-mesh-over-two-rows-joins-its-bars-with-one-riser')));
    expect(model.meshBuses).toHaveLength(2);
    const [upper, lower] = model.meshBuses!;
    expect([upper!.nodes.length, upper!.placement, lower!.nodes.length, lower!.placement]).toEqual([3, 'across-frames', 5, 'in-frame']);
    expect([upper!.joined, lower!.joined]).toEqual([lower!.id, upper!.id]);
    expect(upper!.cross).toHaveLength(15);
    expect(lower!.cross).toBeUndefined();
    expect(codes(model, 'MESH_BUS_JOIN')).toHaveLength(1);
    expect(codes(model, 'MESH_BUS_JOIN')[0]!.owners).toHaveLength(15);
    expect(declined(model)).toHaveLength(0);
    const cross = model.links.filter(l => upper!.cross!.includes(l.id));
    expect(cross.every(l => l.meshBus === upper!.id && l.technique === 'mesh-bus')).toBe(true);
    expect(cross.some(l => upper!.members.includes(l.id) || lower!.members.includes(l.id))).toBe(false);
    for (const l of cross) for (const end of [l.attachments!.from, l.attachments!.to]) {
      const bus = upper!.nodes.includes(end.node) ? upper! : lower!;
      expect(end).toEqual(bus.ports[bus.nodes.indexOf(end.node)]);
    }
    // A bus node keeps one port of the mesh: the b nodes carried 4 + 3 anonymous ends.
    for (const id of lower!.nodes) expect(model.nodes[id]!.ports.filter(port => port.ref.anonymous)).toHaveLength(id === 'b1' || id === 'b5' ? 2 : 1);
    expect([busSide(model, upper!), busSide(model, lower!)]).toEqual(['bottom', 'top']);
    expect(JSON.stringify(resolve(model.document))).toBe(JSON.stringify(model));
  });

  it('keeps two buses when one cross link has another label, and names it', () => {
    const model = resolve(parse(fixture('a-cross-link-with-another-label-keeps-two-buses')));
    expect(model.meshBuses).toHaveLength(2);
    expect(model.meshBuses!.every(bus => bus.joined === undefined && bus.cross === undefined)).toBe(true);
    expect(codes(model, 'MESH_BUS_JOIN')).toHaveLength(0);
    const backup = model.links.find(l => model.document.links[l.sourceIndex]!.label === 'backup')!;
    const found = declined(model);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.message).toContain('label');
    expect(found[0]!.message).toContain(backup.id);
    expect(found[0]!.owners).toHaveLength(15);
    const cross = model.links.filter(l => l.layer === 'overlay' && l.meshBus === undefined);
    expect(cross).toHaveLength(15);
    expect(cross.every(l => l.technique === 'overlay')).toBe(true);
  });

  it('joins a mesh whose cross links are written from the lower row to the upper row', () => {
    const model = two(across(UP, LOW, (a, b) => link(b, a)));
    expect(model.meshBuses![0]!.joined).toBe('mesh-bus-2');
    expect(model.meshBuses![0]!.cross).toHaveLength(12);
    expect(busSide(model, model.meshBuses![0]!)).toBe('bottom');
    expect(busSide(model, model.meshBuses![1]!)).toBe('top');
  });

  it('is silent about a pair with only a few cross links', () => {
    const model = two(['a1', 'a2'].map(a => link(a, 'b1')));
    expect(model.meshBuses).toHaveLength(2);
    expect(model.meshBuses!.every(bus => bus.joined === undefined)).toBe(true);
    expect(declined(model)).toHaveLength(0);
    expect(codes(model, 'MESH_BUS_JOIN')).toHaveLength(0);
  });

  it('refuses an incomplete set and names the missing pair', () => {
    const model = two(across(UP, LOW).filter(l => !l.startsWith('{ from: a2, to: b3,')));
    expect(model.meshBuses!.every(bus => bus.joined === undefined)).toBe(true);
    expect(declined(model)).toHaveLength(1);
    expect(declined(model)[0]!.message).toContain('incomplete');
    expect(declined(model)[0]!.message).toContain('a2-b3');
  });

  it('names the class of another link that joins the missing pair', () => {
    const model = two(across(UP, LOW, (a, b) => a === 'a2' && b === 'b3' ? link(a, b, '', 'flow') : link(a, b)));
    expect(model.meshBuses).toHaveLength(2);
    expect(model.meshBuses!.every(bus => bus.joined === undefined)).toBe(true);
    const found = declined(model);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('incomplete');
    expect(found[0]!.message).toContain('a2-b3 (a flow link joins it)');
  });

  it('refuses a cross link of another weight', () => {
    const model = two(across(UP, LOW, (a, b) => a === 'a2' && b === 'b3' ? link(a, b, ', weight: 2') : link(a, b)));
    expect(model.meshBuses!.every(bus => bus.joined === undefined)).toBe(true);
    expect(declined(model)[0]!.message).toContain('weight');
  });

  it('refuses a cross end that names a port where the other ends are anonymous', () => {
    const node = (id: string) => id === 'b2' ? `  ${id}: { group: r1, ports: [{ name: p }] }` : `  ${id}: { group: ${id.startsWith('a') ? 'r0' : 'r1'} }`;
    const model = two(across(UP, LOW, (a, b) => a === 'a1' && b === 'b2' ? link(a, 'b2.p') : link(a, b)), node);
    expect(model.meshBuses).toHaveLength(2);
    expect(model.meshBuses!.every(bus => bus.joined === undefined)).toBe(true);
    expect(declined(model)[0]!.message).toContain('port');
    expect(declined(model)[0]!.message).toContain('b2');
  });

  it('refuses a join whose class draws an arrowhead', () => {
    arrows.classes.add('sync');
    try {
      const model = two();
      expect(model.meshBuses).toBeUndefined();
      expect(codes(model, 'MESH_BUS_DECLINED').every(d => d.message.includes('arrow'))).toBe(true);
    } finally { arrows.classes.clear(); }
  });

  it('refuses a join when a bus port states the side that faces away', () => {
    const node = (id: string) => id === 'a1' ? '  a1: { group: r0, ports: [{ name: p, side: top }] }' : `  ${id}: { group: ${id.startsWith('a') ? 'r0' : 'r1'} }`;
    const model = resolve(parse(rows([{ ids: UP, node }, { ids: LOW, node }],
      mesh().map(l => l.replace('from: a1,', 'from: a1.p,')))));
    expect(model.meshBuses).toHaveLength(2);
    expect(model.meshBuses!.every(bus => bus.joined === undefined)).toBe(true);
    expect(declined(model)[0]!.message).toContain('side');
    expect(declined(model)[0]!.message).toContain('a1.p');
  });

  it('reports a row of two nodes and a row of five that link completely, without a join', () => {
    const small = ['s1', 's2'], five = ['f1', 'f2', 'f3', 'f4', 'f5'];
    const model = resolve(parse(rows([{ ids: small }, { ids: five }], [...within(small), ...within(five), ...across(small, five)])));
    expect(model.meshBuses).toHaveLength(1);
    expect(model.meshBuses![0]!.joined).toBeUndefined();
    const found = declined(model);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('small-row');
    expect(found[0]!.owners).toHaveLength(10);
  });
});

describe('a trunk join: three buses or more (stage 1, architecture ticket 21)', () => {
  const MID = ['c1', 'c2', 'c3'], FOUR = ['d1', 'd2', 'd3'];
  const three = (edit?: (a: string, b: string) => string, extra: string[] = [], nodes?: (id: string) => string) => resolve(parse(rows(
    [{ ids: UP, node: nodes }, { ids: MID, node: nodes }, { ids: LOW, node: nodes }],
    [...within(UP, edit), ...within(MID, edit), ...within(LOW, edit), ...across(UP, MID, edit), ...across(MID, LOW, edit), ...across(UP, LOW, edit), ...extra])));

  it('joins three complete rows by one trunk, with the head bus on the uppermost row', () => {
    const model = three();
    const [head, middle, low] = model.meshBuses!;
    expect([head!.mesh, middle!.mesh, low!.mesh]).toEqual([head!.id, head!.id, head!.id]);
    expect(head!.trunk).toEqual({ buses: [head!.id, middle!.id, low!.id], lane: `trunk:${head!.id}` });
    expect(head!.cross).toHaveLength(33);
    expect([middle!.cross, low!.cross, middle!.trunk, low!.trunk, head!.joined, middle!.joined]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(model.meshBuses!.map(bus => bus.meshNodes)).toEqual([10, 10, 10]);
    expect(codes(model, 'MESH_BUS_JOIN')).toHaveLength(1);
    expect(codes(model, 'MESH_BUS_JOIN')[0]!.message).toContain('sync mesh of 10 nodes and 33 cross links');
    expect(declined(model)).toHaveLength(0);
    const cross = model.links.filter(l => head!.cross!.includes(l.id));
    expect(cross.every(l => l.meshBus === head!.id && l.technique === 'mesh-bus')).toBe(true);
    for (const l of cross) for (const end of [l.attachments!.from, l.attachments!.to]) {
      const bus = model.meshBuses!.find(item => item.nodes.includes(end.node))!;
      expect(end).toEqual(bus.ports[bus.nodes.indexOf(end.node)]);
    }
    expect(JSON.stringify(resolve(model.document))).toBe(JSON.stringify(model));
    expect(model.meshBuses!.map(bus => bus.labelled)).toEqual([false, false, undefined]);
  });

  it('joins four rows by one trunk, the head the uppermost', () => {
    const model = resolve(parse(rows([{ ids: UP }, { ids: MID }, { ids: FOUR }, { ids: LOW }],
      [...within(UP), ...within(MID), ...within(FOUR), ...within(LOW), ...across(UP, MID), ...across(UP, FOUR), ...across(UP, LOW), ...across(MID, FOUR), ...across(MID, LOW), ...across(FOUR, LOW)])));
    const head = model.meshBuses![0]!;
    expect(head.trunk!.buses).toHaveLength(4);
    expect(head.cross).toHaveLength(63);
    expect(model.meshBuses!.every(bus => bus.mesh === head.id && bus.meshNodes === 13)).toBe(true);
  });

  it('refuses a part that is not complete with partial-mesh, naming the pair that failed', () => {
    const model = resolve(parse(rows([{ ids: UP }, { ids: MID }, { ids: LOW }],
      [...within(UP), ...within(MID), ...within(LOW), ...across(UP, MID), ...across(MID, LOW), ...across(UP, LOW).slice(1)])));
    expect(model.meshBuses).toHaveLength(3);
    expect(model.meshBuses!.every(bus => bus.mesh === undefined && bus.joined === undefined)).toBe(true);
    const found = declined(model);
    expect(found.filter(d => d.message.includes('partial-mesh'))).toHaveLength(2);
    expect(found.filter(d => d.message.includes('incomplete'))).toHaveLength(1);
    expect(found.find(d => d.message.includes('partial-mesh'))!.message).toContain('mesh-bus-1 and mesh-bus-3');
  });

  it('reads the identity of the whole mesh: a label on a cross link between the outer rows refuses the join', () => {
    const model = three((a, b) => a === 'a1' && b === 'b1' ? link(a, b, ', label: odd') : link(a, b));
    expect(model.meshBuses!.every(bus => bus.mesh === undefined)).toBe(true);
    expect(declined(model).some(d => d.message.includes('label'))).toBe(true);
  });

  it('does not read an authored side on a bus port for a trunk join, and keeps the side for a riser join', () => {
    const node = (id: string) => id === 'a1' ? '  a1: { group: r0, ports: [{ name: p, side: top }] }' : `  ${id}: { group: r${id.startsWith('a') ? 0 : id.startsWith('c') ? 1 : 2} }`;
    const tag = (a: string, b: string) => link(a === 'a1' ? 'a1.p' : a, b === 'a1' ? 'a1.p' : b);
    const model = three(tag, [], node);
    expect(model.meshBuses![0]!.trunk).toBeDefined();
    expect(declined(model)).toHaveLength(0);
  });

  it('leaves a small row beside a three-row mesh alone', () => {
    const small = ['s1', 's2'];
    const model = resolve(parse(rows([{ ids: UP }, { ids: MID }, { ids: LOW }, { ids: small }],
      [...within(UP), ...within(MID), ...within(LOW), ...within(small), ...across(UP, MID), ...across(MID, LOW), ...across(UP, LOW), ...across(LOW, small)])));
    expect(model.meshBuses![0]!.trunk!.buses).toHaveLength(3);
    expect(declined(model).every(d => d.message.includes('small-row'))).toBe(true);
  });
});

describe('review fixes (ticket 94)', () => {
  const port = (id: string) => id === 'a1' ? '  a1: { group: r0, ports: [{ name: p }] }' : `  ${id}: { group: r${id.startsWith('a') ? 0 : 1} }`;
  const meshOn = (extra: string) => rows([{ ids: ['a1', 'a2', 'a3'], node: port }, { ids: ['c1'], node: port }],
    [link('a1.p', 'a2'), link('a1.p', 'a3'), link('a2', 'a3'), extra]);

  it('keeps shared-port for a link of another class on a bus port', () => {
    const model = resolve(parse(meshOn(link('a1.p', 'c1', '', 'flow'))));
    expect(model.meshBuses).toBeUndefined();
    expect(codes(model, 'MESH_BUS_DECLINED')[0]!.message).toContain('shared-port');
  });

  it('keeps shared-port for a same-class link to a node that no bus can hold', () => {
    const model = resolve(parse(meshOn(link('a1.p', 'c1'))));
    expect(model.meshBuses).toBeUndefined();
    expect(codes(model, 'MESH_BUS_DECLINED')[0]!.message).toContain('shared-port');
  });

  it('does not report small-row for a node that a partial mesh left out, and reports the group-link the join splits', () => {
    const b = ['b1', 'b2', 'b3', 'b4'];
    const model = resolve(parse(rows([{ ids: UP }, { ids: [...b, 'b5'] }],
      [...within(UP), ...within(b), link('b1', 'b5'), link('b2', 'b5'), ...across(UP, [...b, 'b5'])])));
    expect(model.meshBuses).toHaveLength(2);
    expect(model.meshBuses![0]!.joined).toBe('mesh-bus-2');
    expect(declined(model).filter(d => d.message.includes('small-row'))).toHaveLength(0);
    expect(codes(model, 'MESH_BUS_PARTIAL').some(d => d.message.includes('lost 12 of its 15') && d.message.includes('join'))).toBe(true);
  });
});

describe('one-row identity (stage 1, ticket 94)', () => {
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const one = (links: string[], node?: (id: string) => string) => resolve(parse(rows([{ ids, node }], links)));
  const plain = (model: ReturnType<typeof resolve>) => model.links.every(l => l.meshBus === undefined && l.technique === 'overlay');

  it('draws plain links for a mesh with a labelled link, and forms no smaller bus', () => {
    const model = resolve(parse(fixture('a-row-mesh-with-another-label-draws-plain-links')));
    expect(model.meshBuses).toBeUndefined();
    const backup = model.links.find(l => model.document.links[l.sourceIndex]!.label === 'backup')!;
    const found = codes(model, 'MESH_BUS_DECLINED');
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('label');
    expect(found[0]!.message).toContain(backup.id);
    expect(model.links.filter(l => l.layer === 'overlay' && l.technique === 'overlay')).toHaveLength(10);
  });

  it('declines a mesh with one link of another weight', () => {
    const model = one(within(ids, (a, b) => a === 'n1' && b === 'n2' ? link(a, b, ', weight: 3') : link(a, b)));
    expect(model.meshBuses).toBeUndefined();
    expect(codes(model, 'MESH_BUS_DECLINED')).toHaveLength(1);
    expect(codes(model, 'MESH_BUS_DECLINED')[0]!.message).toContain('weight');
    expect(plain(model)).toBe(true);
  });

  it('declines a node with some named and some anonymous ends (no bare end moves onto the port)', () => {
    const node = (id: string) => `  ${id}: { group: r0${id === 'n1' ? ', ports: [{ name: p }]' : ''} }`;
    const model = one(within(ids, (a, b) => a === 'n1' && b === 'n2' ? link('n1.p', b) : link(a, b)), node);
    expect(model.meshBuses).toBeUndefined();
    expect(codes(model, 'MESH_BUS_DECLINED')).toHaveLength(1);
    expect(codes(model, 'MESH_BUS_DECLINED')[0]!.message).toContain('port');
    expect(plain(model)).toBe(true);
  });

  it('reads two different named ports as named-ports before identity', () => {
    const node = (id: string) => `  ${id}: { group: r0${id === 'n1' ? ', ports: [{ name: p }, { name: q }]' : ''} }`;
    const model = one(within(ids, (a, b) => a === 'n1' ? link(b === 'n2' ? 'n1.p' : 'n1.q', b) : link(a, b)), node);
    expect(model.meshBuses).toBeUndefined();
    expect(codes(model, 'MESH_BUS_DECLINED').map(d => d.message).join()).toContain('named-ports');
  });

  it('declines a mesh of a class that draws an arrowhead', () => {
    arrows.classes.add('sync');
    try {
      const model = one(within(ids));
      expect(model.meshBuses).toBeUndefined();
      expect(codes(model, 'MESH_BUS_DECLINED')[0]!.message).toContain('arrow');
      expect(plain(model)).toBe(true);
    } finally { arrows.classes.clear(); }
  });
});
