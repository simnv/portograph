import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { drawio, layout, parse } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/** The binding contract of the draw.io export (docs/drawio-binding-contract.md), read from the file the way a dashboard reads it. */

const sheet = (links: string): string => `portograph: 2
meta: {zone: lab, big: 1e9, enabled: true}
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a:
    group: ga
    label: Alpha
    meta: {rack: 7, owner: ops, area: "north & east"}
    ports:
      - {name: p, side: bottom, meta: {vlan: 20, kind: uplink}}
      - {name: q, side: bottom}
  b: {group: gb, ports: [{name: p, side: top}, {name: q, side: top}]}
  c: {group: gb, ports: [{name: p, side: top}]}
links:
${links}
`;

const first = `  - {id: uplink, from: a.p, to: b.p, label: Main, meta: {speed: 10, tag: core}}`;
const second = `  - [a.q, b.q, {label: Spare}]`;
const third = `  - [a.q, c.p]`;

const render = async (text: string): Promise<string> =>
  drawio(await layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));

interface Bound {
  attributes: Record<string, string>;
  body: string;
}

const attributesOf = (tag: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const pair of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) found[pair[1]!] = pair[2]!;
  return found;
};

/** Every `<object>` with its attributes and its inner XML; the export never nests one object in another. */
const objects = (xml: string): Bound[] =>
  [...xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)].map(match => ({ attributes: attributesOf(match[1]!), body: match[2]! }));

const allIds = (xml: string): string[] => [...xml.matchAll(/<(?:object|mxCell)\b[^>]*?\sid="([^"]*)"/g)].map(match => match[1]!);
const ids = (xml: string, prefix: string): string[] => allIds(xml).filter(id => id.startsWith(prefix)).sort();

describe('draw.io binding', () => {
  let xml: string;
  let found: Bound[];
  const kind = (name: string): Bound[] => found.filter(item => item.attributes['pg-kind'] === name);

  it('renders', async () => {
    xml = await render(sheet([first, second, third].join('\n')));
    found = objects(xml);
    expect(found.length).toBeGreaterThan(5);
  }, 60000);

  it('wraps every object in a matching close tag', () => {
    expect([...xml.matchAll(/<object\b/g)]).toHaveLength([...xml.matchAll(/<\/object>/g)].length);
    expect([...xml.matchAll(/<object\b/g)]).toHaveLength(found.length);
  });

  it('gives every cell a unique id', () => {
    const all = allIds(xml);
    expect(all.length).toBeGreaterThan(10);
    expect(new Set(all).size).toBe(all.length);
  });

  it('wraps the root cell with pg-schema and the root meta', () => {
    const root = found.find(item => item.attributes['id'] === '0')!;
    expect(root).toBeDefined();
    expect(root.attributes).toMatchObject({ 'pg-schema': '1', zone: 'lab', big: '1000000000', enabled: 'true' });
    expect(root.body.trim()).toBe('<mxCell/>');
    expect(xml).toMatch(/<object id="0"[^>]*pg-schema="1"[^>]*><mxCell\/><\/object>/);
  });

  it('wraps a node with pg-kind, pg-id and its meta, around one inner mxCell without an id', () => {
    const node = kind('node').find(item => item.attributes['pg-id'] === 'a')!;
    expect(node).toBeDefined();
    expect(node.attributes).toMatchObject({ 'pg-kind': 'node', 'pg-id': 'a', rack: '7', owner: 'ops', area: 'north &amp; east' });
    expect(node.attributes['id']).toBeTruthy();
    expect([...node.body.matchAll(/<mxCell\b/g)]).toHaveLength(1);
    expect(/<mxCell\b[^>]*\sid=/.test(node.body)).toBe(false);
    expect(node.body).toMatch(/\bvertex="1"/);
  });

  it('binds a node without meta to pg-kind and pg-id only', () => {
    const node = kind('node').find(item => item.attributes['pg-id'] === 'b')!;
    expect(Object.keys(node.attributes).filter(key => !['id', 'label'].includes(key)).sort()).toEqual(['pg-id', 'pg-kind']);
  });

  it('binds a port to its node and name, with the id node:port', () => {
    const port = kind('port').find(item => item.attributes['pg-id'] === 'a:p')!;
    expect(port).toBeDefined();
    expect(port.attributes).toMatchObject({ 'pg-kind': 'port', 'pg-node': 'a', 'pg-port': 'p', 'pg-id': 'a:p', vlan: '20', kind: 'uplink' });
    expect([...port.body.matchAll(/<mxCell\b/g)]).toHaveLength(1);
    expect(kind('port').map(item => item.attributes['pg-id']).sort()).toEqual(['a:p', 'a:q', 'b:p', 'b:q', 'c:p']);
  });

  it('binds a link to its ends in YAML direction, and names its cell pg-link~<id>', () => {
    const uplink = kind('link').find(item => item.attributes['pg-id'] === 'uplink')!;
    expect(uplink).toBeDefined();
    expect(uplink.attributes).toMatchObject({ id: 'pg-link~uplink', 'pg-from': 'a:p', 'pg-to': 'b:p', speed: '10', tag: 'core' });
    expect(uplink.body).toMatch(/\bedge="1"/);
    const derived = kind('link').find(item => item.attributes['pg-id'] === 'a:q--c:p')!;
    expect(derived.attributes).toMatchObject({ id: 'pg-link~a:q--c:p', 'pg-from': 'a:q', 'pg-to': 'c:p' });
  });

  it('writes pg-run and pg-runs only on a link that has more than one run', () => {
    for (const item of kind('link')) {
      const multi = 'pg-runs' in item.attributes;
      expect('pg-run' in item.attributes).toBe(multi);
      if (multi) expect(Number(item.attributes['pg-runs'])).toBeGreaterThan(1);
      else expect(item.attributes['id']).toBe(`pg-link~${item.attributes['pg-id']}`);
    }
  });

  it('carries the text of a link label on the link object itself', () => {
    const labelOf = (id: string): string | undefined => kind('link').find(item => item.attributes['pg-id'] === id)!.attributes['label'];
    expect(labelOf('uplink')).toContain('Main');
    expect(labelOf('a:q--b:q')).toContain('Spare');
    expect(labelOf('a:q--c:p')).toBe('');
  });

  it('writes the meta keys sorted, after the pg- keys', () => {
    const uplink = kind('link').find(item => item.attributes['pg-id'] === 'uplink')!;
    const keys = Object.keys(uplink.attributes);
    expect(keys.slice(-2)).toEqual(['speed', 'tag']);
    const root = found.find(item => item.attributes['id'] === '0')!;
    expect(Object.keys(root.attributes)).toEqual(['id', 'label', 'pg-schema', 'big', 'enabled', 'zone']);
    const node = kind('node').find(item => item.attributes['pg-id'] === 'a')!;
    expect(Object.keys(node.attributes).slice(-3)).toEqual(['area', 'owner', 'rack']);
  });

  it('keeps the link ids and their labels when the links swap places in the YAML (acceptance)', async () => {
    const swapped = await render(sheet([third, second, first].join('\n')));
    expect(ids(xml, 'pg-link~')).toEqual(['pg-link~a:q--b:q', 'pg-link~a:q--c:p', 'pg-link~uplink']);
    expect(ids(swapped, 'pg-link~')).toEqual(ids(xml, 'pg-link~'));
    expect(ids(swapped, 'pg-linkLabel~')).toEqual(ids(xml, 'pg-linkLabel~'));
    const bindings = (text: string) => objects(text).filter(item => item.attributes['pg-kind'] === 'link')
      .map(item => [item.attributes['pg-id'], item.attributes['pg-from'], item.attributes['pg-to'], item.attributes['label']].join(' ')).sort();
    expect(bindings(swapped)).toEqual(bindings(xml));
  }, 60000);

  it('keeps the id of a separate link label cell when the links swap places (acceptance)', async () => {
    // A counted merge label stands in its own cell, because a bundle owns it and no connector carries it.
    const merge = (links: string): string => `portograph: 2
groups: {ga: {tier: 0}, gb: {tier: 1}}
nodes:
  a: {group: ga, ports: [{name: p, side: bottom, order: 0}, {name: q, side: bottom, order: 0}, {name: r, side: bottom, order: 0}]}
  b: {group: gb, ports: [{name: p, side: top, order: 0}, {name: q, side: top, order: 0}, {name: r, side: top, order: 0}]}
links: ${links}
`;
    const one = await render(merge('[{from: a.p, to: b.p, route: merge, label: M}, {from: b.q, to: a.q, route: merge, label: N}, [a.r, b.r]]'));
    const two = await render(merge('[[a.r, b.r], {from: b.q, to: a.q, route: merge, label: N}, {from: a.p, to: b.p, route: merge, label: M}]'));
    expect(ids(one, 'pg-linkLabel~').length).toBeGreaterThanOrEqual(1);
    expect(ids(two, 'pg-linkLabel~')).toEqual(ids(one, 'pg-linkLabel~'));
    expect(ids(two, 'pg-link~')).toEqual(ids(one, 'pg-link~'));
    expect(ids(one, 'pg-link~')).toEqual(['pg-link~a:p--b:p', 'pg-link~a:r--b:r', 'pg-link~b:q--a:q']);
  }, 60000);

  it('names its link on a label cell of its own, and hangs the label on a run of that link', async () => {
    const xml = await render(readFileSync(new URL('../../goldens/synthetic/a-label-on-a-direct-line-runs-along-it.yaml', import.meta.url), 'utf8'));
    const bound = objects(xml);
    const labels = bound.filter(item => item.attributes['pg-kind'] === 'link-label');
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      const of = label.attributes['pg-of']!;
      expect(label.attributes.id).toBe(`pg-linkLabel~${of}`);
      const runs = bound.filter(item => item.attributes['pg-kind'] === 'link' && item.attributes['pg-id'] === of);
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.map(run => run.attributes.id)).toContain(attributesOf(/<mxCell\b([^>]*)/.exec(label.body)![1]!).parent);
    }
  }, 60000);

  it('binds the synthetic fixture: root meta, parallel links, and a reorder that moves no link id', async () => {
    const yaml = readFileSync(new URL('../../goldens/synthetic/drawio-binding-metadata.yaml', import.meta.url), 'utf8');
    const xml = await render(yaml);
    const root = objects(xml).find(item => item.attributes.id === '0')!;
    expect(root.attributes).toMatchObject({ 'pg-schema': '1', datasource: 'prometheus', site: 'lab' });
    const links = objects(xml).filter(item => item.attributes['pg-kind'] === 'link');
    expect(links.map(item => item.attributes['pg-id']).sort()).toEqual(
      ['edge--server', 'edge--server@2', 'edge:lan--switch:p3', 'switch:p2--server:nic0', 'uplink']);
    expect(links.find(item => item.attributes['pg-id'] === 'uplink')!.attributes).toMatchObject(
      { 'pg-from': 'router:eth1', 'pg-to': 'switch:p1', capacity: '10000000000' });
    const port = objects(xml).find(item => item.attributes['pg-id'] === 'router:eth1')!;
    expect(port.attributes).toMatchObject({ 'pg-kind': 'port', 'pg-node': 'router', 'pg-port': 'eth1', device: 'eth1.10' });
    // Move the first link to the end: no link moves past a parallel link with its own ends.
    const lines = yaml.split('\n');
    const at = lines.findIndex(line => line.includes('id: uplink'));
    const [moved] = lines.splice(at, 1);
    const end = lines.map(line => line.startsWith('  - ')).lastIndexOf(true);
    lines.splice(end + 1, 0, moved!);
    const reordered = await render(lines.join('\n'));
    expect(ids(reordered, 'pg-link~')).toEqual(ids(xml, 'pg-link~'));
  }, 60000);
});
