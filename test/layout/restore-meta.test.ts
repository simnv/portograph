import { describe, expect, it } from 'vitest';
import { layout, parse, restoreFinalLayout, serializeLayoutModel } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Field ticket 07, review 1. Every `meta` map of a saved document obeys the rules of the YAML reader (`documentMetaFault`, R1): restore refuses a
 * key the draw.io writer would put into an attribute name as invalid XML, with the field path, whatever kind of thing owns the map. One sheet
 * carries meta on each owner kind: the root, a plain group, a flank, a canton, a member, a child group, a node, a port and a link.
 */
const sheet = `portograph: 2
meta: { site: lab }
groups:
  west: { label: West, meta: { map: west-map } }
  upstream: { tier: 0, label: Upstream, meta: { map: upstream-map } }
  site: { tier: 1, canton: west, label: Site, meta: { map: site-map } }
  clients: { tier: 2, canton: west, label: Clients }
  pod-1: { parent: site, label: "Pod 1", meta: { map: pod-1-map } }
  annex: { align: right, of: upstream, label: Annex, meta: { map: annex-map } }
nodes:
  isp: { group: upstream, class: provider, label: ISP, meta: { host: isp }, ports: [{ name: p, meta: { device: eth0 } }] }
  ext: { group: annex, class: server, label: Extra }
  gw: { group: site, class: router, label: Gateway }
  srv: { group: pod-1, class: server, label: Server }
  cl: { group: clients, class: server, label: Client }
links:
  - { from: isp.p, to: gw, meta: { capacity: 10 } }
  - [gw, srv]
  - { from: srv, to: cl, class: flow }
`;

type Doc = { meta?: object; groups: Record<string, { meta?: object }>; frames: Record<string, { meta?: object }>; nodes: Record<string, { meta?: object; ports: { meta?: object }[] }>; links: { meta?: object }[] };
type Saved = { document: Doc };

let memo: Promise<string> | undefined;
const saved = (): Promise<string> => memo ??= layout(parse(sheet), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }).then(serializeLayoutModel);
const edited = async (change: (document: Doc) => void): Promise<string> => {
  const model = JSON.parse(await saved()) as Saved;
  change(model.document);
  return JSON.stringify(model);
};

describe('restore refuses a meta map that the YAML reader would refuse (field ticket 07, review 1)', () => {
  it('restores the sheet as saved, and the saved document holds a meta map of every owner kind', async () => {
    const model = JSON.parse(await saved()) as Saved;
    expect(model.document.meta).toBeDefined();
    expect(model.document.groups['upstream']!.meta).toBeDefined();
    expect(model.document.groups['annex']!.meta).toBeDefined();
    expect(model.document.frames['west']!.meta).toBeDefined();
    expect(model.document.frames['site']!.meta).toBeDefined();
    expect(model.document.frames['pod-1']!.meta).toBeDefined();
    expect(model.document.nodes['isp']!.meta).toBeDefined();
    expect(model.document.nodes['isp']!.ports[0]!.meta).toBeDefined();
    expect(model.document.links[0]!.meta).toBeDefined();
    expect(() => restoreFinalLayout(JSON.stringify(model))).not.toThrow();
  }, 120000);

  it.each<[string, string, (document: Doc) => void]>([
    ['the root', '$.meta.floor number', document => { document.meta = { 'floor number': 2 }; }],
    ['a plain group', '$.groups.upstream.meta.floor number', document => { document.groups['upstream']!.meta = { 'floor number': 2 }; }],
    ['a flank', '$.groups.annex.meta.floor number', document => { document.groups['annex']!.meta = { 'floor number': 2 }; }],
    ['a canton frame (the reviewer\'s reproduction)', '$.frames.west.meta.floor number', document => { document.frames['west']!.meta = { 'floor number': 2 }; }],
    ['a member frame', '$.frames.site.meta.floor number', document => { document.frames['site']!.meta = { 'floor number': 2 }; }],
    ['a child frame', '$.frames.pod-1.meta.floor number', document => { document.frames['pod-1']!.meta = { 'floor number': 2 }; }],
    ['a node', '$.nodes.isp.meta.floor number', document => { document.nodes['isp']!.meta = { 'floor number': 2 }; }],
    ['a port', '$.nodes.isp.ports[0].meta.floor number', document => { document.nodes['isp']!.ports[0]!.meta = { 'floor number': 2 }; }],
    ['a link', '$.links[0].meta.floor number', document => { document.links[0]!.meta = { 'floor number': 2 }; }],
  ])('refuses a key with a space on %s, with its field path', async (_owner, path, change) => {
    await expect(edited(change).then(restoreFinalLayout)).rejects.toThrow(`Invalid meta at ${path}: BAD_META_KEY`);
  }, 120000);

  it.each<[string, object, string]>([
    ['a reserved key', { 'pg-kind': 'x' }, 'RESERVED_META_KEY'],
    ['a reserved key in another case', { Label: 'x' }, 'RESERVED_META_KEY'],
    ['a key that starts with a digit', { '1st': 1 }, 'BAD_META_KEY'],
    ['a value that is a map', { deep: { a: 1 } }, 'INVALID_TYPE'],
    ['a value that is null', { gone: null }, 'INVALID_TYPE'],
  ])('refuses %s on a frame and on a node with the code of the YAML reader', async (_name, meta, code) => {
    const key = Object.keys(meta)[0]!;
    await expect(edited(document => { document.frames['west']!.meta = meta; }).then(restoreFinalLayout)).rejects.toThrow(`Invalid meta at $.frames.west.meta.${key}: ${code}`);
    await expect(edited(document => { document.nodes['isp']!.meta = meta; }).then(restoreFinalLayout)).rejects.toThrow(`Invalid meta at $.nodes.isp.meta.${key}: ${code}`);
  }, 120000);

  it('refuses a meta that is not a map', async () => {
    await expect(edited(document => { document.groups['upstream']!.meta = ['x']; }).then(restoreFinalLayout)).rejects.toThrow('Invalid meta at $.groups.upstream.meta: INVALID_TYPE');
  }, 120000);
});
