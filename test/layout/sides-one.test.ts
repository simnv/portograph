import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';

function fixture(links: string[], ports = '[p]') {
  return resolve(parse(`portograph: 2
groups: {upper: {tier: 10}, middle: {tier: 80}, lower: {tier: 100}, west: {align: left, of: middle}, east: {align: right, of: middle}}
nodes:
  a: {group: middle, ports: ${ports}}
  up: {group: upper}
  down: {group: lower}
  leftward: {group: west}
  rightward: {group: east}
  sibling: {group: middle}
links: [${links.join(', ')}]`));
}

describe('phase-one sides', () => {
  it('infers the actual golden tier and flank sides without deciding same-tier ports', () => {
    const model = resolve(parse(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8')));
    const authored = JSON.stringify(model.document);
    const identities = Object.values(model.nodes).flatMap(node => node.ports.map(port => ({ ...port.ref })));
    expect(sidesOne(model)).toBe(model);
    expect(model.stage).toBe('sides-one');
    expect(model.nodes['EAC-01']?.ports.map(port => port.side)).toEqual(['top', 'left', 'left', 'left', 'left']);
    expect(model.nodes['EAC-02']?.ports.map(port => port.side)).toEqual(['top', 'right', 'right', 'right', 'right']);
    expect(model.nodes['TBR-001']?.ports.map(port => port.side)).toEqual(Array(8).fill('right'));
    expect(model.nodes['TBR-002']?.ports.map(port => port.side)).toEqual(Array(8).fill('left'));
    expect(model.nodes['EBR-01']?.ports.map(port => port.side)).toEqual([undefined, undefined, 'left', 'left', 'left', 'left', 'bottom', 'bottom']);
    expect(model.nodes['EBB-01']?.ports.map(port => port.side)).toEqual(['top', 'top', 'top']);
    expect(JSON.stringify(model.document)).toBe(authored);
    expect(Object.values(model.nodes).flatMap(node => node.ports.map(port => port.ref))).toEqual(identities);
    expect(model.links.every(link => link.path === undefined)).toBe(true);
    expect(Object.values(model.nodes).every(node => node.bounds === undefined)).toBe(true);
  });

  it.each([
    [['[a.p, up]', '[a.p, down]', '[a.p, down]'], 'bottom'],
    [['[a.p, down]', '[a.p, up]', '[a.p, up]'], 'top'],
    [['[a.p, up]', '[a.p, down]'], 'bottom'],
    [['[a.p, up]', '[a.p, rightward]'], 'right'],
    [['[a.p, up]', '[a.p, leftward]'], 'top'],
    [['[a.p, leftward]', '[a.p, leftward]', '[a.p, rightward]'], 'left'],
  ])('counts links rather than distinct peers: %j', (links, side) => {
    expect(sidesOne(fixture(links)).nodes.a?.ports[0]?.side).toBe(side);
  });

  it('commits a guaranteed mixed-peer winner but defers a possible lateral majority', () => {
    const safe = sidesOne(fixture(['[a.p, down]', '[a.p, down]', '[a.p, sibling]', '[a.p, sibling]']));
    expect(safe.nodes.a?.ports[0]?.side).toBe('bottom');
    const changing = sidesOne(fixture(['[a.p, down]', '[a.p, sibling]', '[a.p, sibling]']));
    expect(changing.nodes.a?.ports[0]?.side).toBeUndefined();
    expect(changing.nodes.a?.ports[0]?.sizingSide).toBe('right');
    const knownLateral = sidesOne(fixture(['[a.p, down]', '[a.p, down]', '[a.p, rightward]', '[a.p, sibling]', '[a.p, sibling]']));
    expect(knownLateral.nodes.a?.ports[0]?.side).toBeUndefined();
  });

  it('preserves explicit side and order even for an unused port', () => {
    const model = sidesOne(fixture(['[a.p, down]'], '[{name: p, side: top, order: 9}, {name: spare, side: left, order: 2}]'));
    expect(model.nodes.a?.ports.map(port => [port.side, port.authorOrder])).toEqual([['top', 9], ['left', 2]]);
    expect(model.nodes.a?.ports[1]?.unused).toBe(true);
  });

  it('allocates unused ports after linked capacity, using declaration order and stable direction ties', () => {
    const model = sidesOne(fixture(['[a.p, down]'], '[spare, p, spare, spare, spare]'));
    expect(model.nodes.a?.ports.map(port => port.side)).toEqual(['right', 'bottom', 'top', 'left', 'bottom']);
    expect(model.nodes.a?.ports.map(port => port.unused === true)).toEqual([true, false, true, true, true]);
    expect(model.nodes.a?.ports.map(port => [port.ref.name, port.ref.ordinal])).toEqual([['spare', 1], ['p', 1], ['spare', 2], ['spare', 3], ['spare', 4]]);
  });

  it('keeps numeric same-tier declaration order for predicted capacity, without assigning sides', () => {
    const model = sidesOne(resolve(parse(`portograph: 2
groups: {20: {tier: 0}, 3: {tier: 0}}
nodes: {40: {group: "20"}, 7: {group: "20"}, 2: {group: "3"}}
links: [["40", "7"], ["7", "2"]]`)));
    expect(model.nodes['40']?.ports[0]).toMatchObject({ sizingSide: 'right' });
    expect(model.nodes['7']?.ports.map(port => port.sizingSide)).toEqual(['left', 'right']);
    expect(model.nodes['2']?.ports[0]?.sizingSide).toBe('left');
    expect(Object.values(model.nodes).flatMap(node => node.ports).every(port => port.side === undefined)).toBe(true);
  });

  it('uses expanded concrete attachments and anonymous inventory for group endpoints', () => {
    const model = sidesOne(resolve(parse(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes: {a: {group: upper}, b: {group: upper}, c: {group: lower}, d: {group: lower}}
links: [[upper, lower, {route: group-link}]]`)));
    expect(model.document.nodes.a?.ports).toEqual([]);
    expect(model.nodes.a?.ports.map(port => port.side)).toEqual(['bottom', 'bottom']);
    expect(model.nodes.d?.ports.map(port => port.side)).toEqual(['top', 'top']);
    expect(model.links[0]?.from).toEqual({ group: 'upper' });
  });
});
