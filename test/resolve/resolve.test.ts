import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse, parseWithDiagnostics } from '../../src/parse/index.js';
import { resolve, ResolveError } from '../../src/resolve/index.js';

function input(links: string[]) {
  return parse(`portograph: 2
groups:
  upper: { tier: 0 }
  lower: { tier: 1 }
nodes:
  a: { group: upper }
  b: { group: upper }
  c: { group: lower }
  d: { group: lower }
links:
${links.map(link => `  - ${link}`).join('\n')}
`);
}

describe('semantic resolution', () => {
  it('resolves the actual golden parse output to five bundles and no aggregation', () => {
    const parsed = parse(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8'));
    const model = resolve(parsed);
    expect(model.stage).toBe('resolve');
    expect(model.document).toEqual(parsed);
    expect(model.bundles.map(bundle => bundle.members.length).sort((a, b) => b - a)).toEqual([4, 4, 4, 4, 2]);
    expect(model.bundles.flatMap(bundle => bundle.members)).toHaveLength(18);
    expect(model.groupLinks).toEqual([]);
    expect(model.links.map(link => link.sourceIndex)).toEqual(parsed.links.map((_, i) => i));
    expect(model.links.every(link => link.family === 'routed' && link.layer === 'routed')).toBe(true);
    expect(model.links.every(link => link.path === undefined && link.stubCandidate === undefined)).toBe(true);
    expect(model.nodes['EBR-01']?.ports.map(port => port.ref)).toEqual(parsed.nodes['EBR-01']?.ports.map(port => ({ node: 'EBR-01', ...port })));
    expect(model.nodes['EBR-01']).not.toHaveProperty('bounds');
    expect(model.groups['tbr-left']?.tier).toBe(1);
    expect(model.groups['tbr-right']?.tier).toBe(1);
  });

  it('retains a complete 2×2 aggregation of overlay members on the overlay layer', () => {
    const doc = input(['[a, c, {class: flow}]', '[d, a, {class: flow}]', '[b, c, {class: flow}]', '[b, d, {class: flow}]']);
    const model = resolve(doc);
    expect(model.groupLinks).toHaveLength(1);
    expect(model.groupLinks[0]).toMatchObject({ groups: ['upper', 'lower'], members: ['link-1', 'link-2', 'link-3', 'link-4'], layer: 'overlay' });
    expect(model.groupLinks[0]?.owner).toEqual({ kind: 'group-link', id: model.groupLinks[0]?.id });
    expect(model.links.every(link => link.family === 'overlay' && link.layer === 'overlay' && link.technique === 'overlay')).toBe(true);
    expect(model.links.every(link => link.groupLink === model.groupLinks[0]?.id)).toBe(true);
    expect(model.links.map(link => link.from)).toEqual(doc.links.map(link => link.from));
    expect(model.diagnostics).toContainEqual(expect.objectContaining({ stage: 'model', severity: 'warning', code: 'ROUTE_UNSUPPORTED' }));
  });

  it('routes the members of a complete 2×2 aggregation of routed links with a warning in M1', () => {
    const model = resolve(input(['[a, c]', '[d, a]', '[b, c]', '[b, d]']));
    expect(model.groupLinks).toHaveLength(1);
    expect(model.groupLinks[0]).toMatchObject({ groups: ['upper', 'lower'], layer: 'routed' });
    expect(model.links.every(link => link.family === 'routed' && link.layer === 'routed' && link.technique === 'orthogonal')).toBe(true);
    expect(model.diagnostics).toContainEqual(expect.objectContaining({ stage: 'model', severity: 'warning', code: 'ROUTE_UNSUPPORTED' }));
  });

  it.each([
    ['missing one', ['[a, c, {class: flow}]', '[a, d, {class: flow}]', '[b, c, {class: flow}]']],
    ['duplicate coverage', ['[a, c, {class: flow}]', '[a, d, {class: flow}]', '[b, c, {class: flow}]', '[a, c, {class: flow}]']],
    ['different classes in one family', ['[a, c, {class: flow}]', '[a, d, {class: flow}]', '[b, c, {class: flow}]', '[b, d, {class: sync}]']],
    ['different families', ['[a, c, {class: flow}]', '[a, d, {class: flow}]', '[b, c, {class: flow}]', '[b, d, {class: physical}]']],
    ['explicit override', ['[a, c, {class: flow}]', '[a, d, {class: flow}]', '[b, c, {class: flow}]', '[b, d, {class: flow, route: overlay}]']],
  ])('does not aggregate %s', (_name, links) => {
    expect(resolve(input(links)).groupLinks).toEqual([]);
  });

  it('does not aggregate a single link between singleton groups', () => {
    const doc = input(['[a, c]']);
    delete doc.nodes.b;
    delete doc.nodes.d;
    const model = resolve(doc);
    expect(model.groupLinks).toEqual([]);
    expect(model.bundles).toEqual([]);
  });

  it('uses class families and leaves geometry-dependent defaults undecided', () => {
    const model = resolve(input(['[a, c]', '[a, d, {class: custom}]', '[b, c, {class: physical}]', '[b, d, {class: flow}]', '[b, d, {class: sync}]']));
    expect(model.links.map(link => link.family)).toEqual(['routed', 'routed', 'routed', 'overlay', 'overlay']);
    expect(model.links.map(link => link.layer)).toEqual(['routed', 'routed', 'routed', 'overlay', 'overlay']);
    expect(model.links.map(link => link.technique)).toEqual([undefined, undefined, undefined, 'overlay', 'overlay']);
    expect(model.bundles).toEqual([]);
  });

  it('bundles unordered node pairs across routed classes in author link order', () => {
    const model = resolve(input(['[c, a, {class: dotted}]', '[a, c, {class: dashed}]', '[a, c, {class: flow}]']));
    expect(model.bundles).toHaveLength(1);
    expect(model.bundles[0]).toMatchObject({ nodes: ['a', 'c'], members: ['link-1', 'link-2'] });
    expect(model.links.map(link => link.technique)).toEqual(['bundle', 'bundle', 'overlay']);
  });

  it.each(['orthogonal', 'straight'] as const)('keeps explicit %s out of bundle routing', route => {
    const model = resolve(input([`[a, c, {route: ${route}, class: flow}]`, '[a, c]', '[c, a]']));
    expect(model.links[0]).toMatchObject({ technique: route, family: 'overlay', layer: 'routed' });
    expect(model.links[0]).not.toHaveProperty('bundle');
    expect(model.bundles[0]?.members).toEqual(['link-2', 'link-3']);
  });

  it('preserves explicit overlay and bundle overrides across class family defaults', () => {
    const model = resolve(input(['[a, c, {route: overlay}]', '[a, c, {route: bundle, class: flow}]', '[c, a]']));
    expect(model.links[0]).toMatchObject({ family: 'routed', layer: 'overlay', technique: 'overlay' });
    expect(model.links[0]).not.toHaveProperty('bundle');
    expect(model.links[1]).toMatchObject({ family: 'overlay', layer: 'routed', technique: 'bundle' });
    expect(model.bundles[0]?.members).toEqual(['link-2', 'link-3']);
  });

  it('records a stub request and routes the member with its M1 warning', () => {
    const model = resolve(input(['[a, c, {class: flow, route: stub}]', '[c, a]']));
    expect(model.links[0]).toMatchObject({ family: 'overlay', layer: 'routed', technique: 'bundle' });
    expect(model.document.links[0]?.route).toBe('stub');
    expect(model.links[0]).not.toHaveProperty('stubCandidate');
    expect(model.bundles[0]?.members).toEqual(['link-1', 'link-2']);
    expect(model.diagnostics).toContainEqual(expect.objectContaining({ stage: 'model', severity: 'warning', code: 'ROUTE_UNSUPPORTED' }));
  });

  it('selects merge before family defaults and validates its final bundle membership', () => {
    const model = resolve(input(['[a, c, {class: flow, route: merge}]', '[c, a]']));
    expect(model.links[0]).toMatchObject({ family: 'overlay', layer: 'routed', technique: 'merge', bundle: model.bundles[0]?.id });
    expect(model.bundles[0]?.members).toEqual(['link-1', 'link-2']);
  });

  it.each([{ others: [] }, { others: ['[c, a, {route: straight}]'] }, { others: ['[c, a, {class: flow}]'] }])('rejects merge without two eligible routed members: %j', ({ others }) => {
    expect(() => resolve(input(['[a, c, {route: merge}]', ...others]))).toThrow(/merge.*bundle/i);
  });

  it('expands explicit group links into real anonymous ports while retaining author data', () => {
    const doc = input(['[a, c]', '[upper, lower, {route: group-link, class: flow, label: all, weight: 2}]']);
    const model = resolve(doc);
    const members = model.links.filter(link => link.sourceIndex === 1);
    expect(members).toHaveLength(4);
    expect(members.map(link => [link.attachments?.from.node, link.attachments?.to.node])).toEqual([['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd']]);
    expect(members.every(link => link.from.group === 'upper' && link.to.group === 'lower')).toBe(true);
    // `class: flow` is the overlay family, and `route: group-link` is an aggregation, not a layer.
    expect(members.every(link => link.family === 'overlay' && link.layer === 'overlay' && link.technique === 'overlay')).toBe(true);
    expect(model.groupLinks[0]?.layer).toBe('overlay');
    for (const link of members) {
      for (const end of [link.attachments!.from, link.attachments!.to]) {
        expect(end.anonymous).toBe(true);
        expect(model.nodes[end.node]?.ports.filter(port => JSON.stringify(port.ref) === JSON.stringify(end))).toHaveLength(1);
      }
    }
    expect(model.nodes.a?.ports.map(port => port.ref.ordinal)).toEqual([1, 2, 3]);
    expect(model.groupLinks[0]?.members).toEqual(members.map(link => link.id));
    expect(model.document).toEqual(doc);
    expect(doc.nodes.a?.ports).toHaveLength(1);
    expect(new Set(model.links.map(link => link.id)).size).toBe(model.links.length);
  });

  // Q30 sequences bundles after aggregation, so a routed group-link member that also stands between
  // a bundled node pair is rewritten from the M1 `orthogonal` fallback to `bundle`. The layer rule
  // of stress ticket 23 does not touch that: a member keeps its family's layer, and a routed one is
  // still offered to `groupBundles`. This is the only assertion that holds the two rules together.
  it('lets bundling rewrite the technique of a routed group-link member', () => {
    const model = resolve(input(['[a, c]', '[upper, lower, {route: group-link}]']));
    expect(model.groupLinks[0]?.layer).toBe('routed');
    const shared = model.links.find(link => link.groupLink !== undefined
      && link.attachments?.from.node === 'a' && link.attachments.to.node === 'c')!;
    expect(shared).toMatchObject({ layer: 'routed', technique: 'bundle', groupLink: model.groupLinks[0]?.id, bundle: model.bundles[0]?.id });
    expect(model.bundles[0]?.members).toEqual(['link-1', shared.id]);
    // Every other member of the same aggregation keeps the fallback, so the rewrite is per link.
    expect(model.links.filter(link => link.groupLink !== undefined && link.id !== shared.id)
      .every(link => link.technique === 'orthogonal' && link.bundle === undefined)).toBe(true);
    // The same shape on the overlay family bundles nothing: `groupBundles` skips a non-routed layer.
    const overlay = resolve(input(['[a, c, {class: flow}]', '[upper, lower, {route: group-link, class: flow}]']));
    expect(overlay.bundles).toEqual([]);
    expect(overlay.links.every(link => link.layer === 'overlay' && link.technique === 'overlay')).toBe(true);
  });

  it('expands group endpoints in integer-like author declaration order', () => {
    const doc = parse(`portograph: 2
groups: {20: {tier: 0}, 3: {tier: 1}}
nodes: {40: {group: "20"}, 7: {group: "20"}, 50: {group: "3"}, 2: {group: "3"}}
links: [["20", "3", {route: group-link}]]`);
    const model = resolve(doc);
    expect(model.groupLinks[0]?.groups).toEqual(['20', '3']);
    expect(model.links.map(link => [link.attachments?.from.node, link.attachments?.to.node])).toEqual([['40', '50'], ['40', '2'], ['7', '50'], ['7', '2']]);
    expect(resolve(doc)).toEqual(model);
  });

  it('expands a mixed group/port endpoint without inventing GroupLink membership', () => {
    const model = resolve(input(['[upper, c]']));
    expect(model.links.map(link => link.attachments?.from.node)).toEqual(['a', 'b']);
    expect(model.links.map(link => link.attachments?.to)).toEqual([{ node: 'c', anonymous: true, ordinal: 1 }, { node: 'c', anonymous: true, ordinal: 1 }]);
    expect(model.groupLinks).toEqual([]);
    expect(model.links.every(link => link.layer === 'routed' && link.technique === 'orthogonal')).toBe(true);
    expect(model.diagnostics).toContainEqual(expect.objectContaining({ code: 'GROUP_ENDPOINT_EXPANDED', severity: 'warning', stage: 'model' }));
  });

  it('rejects empty expansion and explicit group-link without two distinct multi-node groups', () => {
    const singleton = input(['[upper, lower, {route: group-link}]']);
    delete singleton.nodes.b;
    expect(() => resolve(singleton)).toThrow(/group-link.*two.*nodes/i);
    expect(() => resolve(input(['[upper, upper, {route: group-link}]']))).toThrow(/distinct/i);
    const empty = input(['[upper, c]']);
    delete empty.nodes.a;
    delete empty.nodes.b;
    expect(() => resolve(empty)).toThrow(/empty group/i);
  });

  it('exposes model errors and incoming diagnostics through ResolveError', () => {
    const prior = { stage: 'parse' as const, severity: 'warning' as const, code: 'PRIOR', message: 'Earlier warning' };
    try {
      resolve(input(['[a, c, {route: merge}]']), { diagnostics: [prior] });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ResolveError);
      if (!(error instanceof ResolveError)) throw error;
      expect(error.diagnostics).toContainEqual(prior);
      expect(error.diagnostics).toContainEqual(expect.objectContaining({ stage: 'model', severity: 'error', code: 'MERGE_REQUIRES_BUNDLE', owners: [{ kind: 'link', id: 'link-1' }] }));
    }
  });

  it('does not duplicate the parser warning for an explicit M1 fallback', () => {
    const parsed = parseWithDiagnostics('portograph: 2\ngroups: {g: {tier: 0}}\nnodes: {a: {group: g}, b: {group: g}}\nlinks: [[a, b, {route: stub}]]');
    if (!parsed.ok) throw new Error('Fixture did not parse');
    const model = resolve(parsed.document, { diagnostics: parsed.diagnostics });
    expect(model.diagnostics.filter(diagnostic => diagnostic.code === 'ROUTE_UNSUPPORTED')).toHaveLength(1);
    expect(model.links[0]?.technique).toBe('orthogonal');
  });

  // ADR-0006: the expanded port and link counts bound work, exactly as the authored counts do.
  // Beyond them resolution warns and continues best effort; neither one refuses the document.
  it('warns about the expanded port count and still expands, without mutating authored ports', () => {
    const doc = input(Array.from({ length: 11 }, () => '[upper, lower, {route: group-link}]'));
    const model = resolve(doc);
    expect(model.diagnostics.filter(item => item.code === 'PORT_LIMIT').map(item => [item.severity, item.owners]))
      .toContainEqual(['warning', [{ kind: 'node', id: 'a' }]]);
    expect(model.diagnostics.some(item => item.code === 'PORT_LIMIT' && /22 ports after expansion/.test(item.message))).toBe(true);
    expect(doc.nodes.a?.ports).toEqual([]);
    expect(model.nodes.a!.ports.length).toBe(22);
  });

  it('warns about the expanded link count after repeated group-to-port expansion', () => {
    const doc = parse(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes: {a: {group: upper}, b: {group: upper}, c: {group: lower, ports: [p]}, d: {group: lower}}
links:
${Array.from({ length: 21 }, () => '  - [upper, c.p]').join('\n')}`);
    const model = resolve(doc);
    expect(model.diagnostics.filter(item => item.code === 'LINK_LIMIT'))
      .toEqual([{ stage: 'model', severity: 'warning', code: 'LINK_LIMIT', owners: [],
        message: 'Expanded links (42) exceed 10 times the node count; continuing best effort' }]);
    expect(model.links.length).toBe(42);
  });

  it('keeps parser diagnostics outside the author document and owns the copied diagnostics', () => {
    const parsed = parseWithDiagnostics('portograph: 2\ngroups: {g: {}}\nnodes: {a: {group: g}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Fixture did not parse');
    const model = resolve(parsed.document, { diagnostics: parsed.diagnostics });
    expect(model.diagnostics).toEqual(parsed.diagnostics);
    expect(model.document).toEqual(parsed.document);
    model.diagnostics[0]!.message = 'Changed';
    expect(parsed.diagnostics[0]?.message).not.toBe('Changed');
  });

  it('keeps explicit port identity, author side/order and author metadata independent of layout mutations', () => {
    const doc = parse(`portograph: 2
title: Authored
css: '.custom { stroke: red; }'
overlays: {flow: hidden}
groups: {upper: {tier: 0, label: Upper, layout: {spacing: 10}}, lower: {tier: 1}}
nodes:
  a: {group: upper, label: A, description: Description, icon: router, size: {width: 80, height: 40}, ports: [{name: p, side: bottom, order: 4}, {name: p, side: top, order: 1}]}
  c: {group: lower, ports: [q, q]}
links:
  - [a.p#2, c.q#1, {class: physical, label: Named, weight: 2}]
  - [a.p#1, c.q#2]`);
    const original = JSON.stringify(doc);
    const model = resolve(doc);
    expect(model.document).toEqual(doc);
    expect(model.nodes.a?.ports.map(port => [port.ref, port.side, port.authorOrder])).toEqual([
      [{ node: 'a', name: 'p', ordinal: 1 }, 'bottom', 4],
      [{ node: 'a', name: 'p', ordinal: 2 }, 'top', 1],
    ]);
    expect(model.links[0]?.attachments?.from).toEqual({ node: 'a', name: 'p', ordinal: 2 });
    model.links[0]!.attachments!.from.ordinal = 9;
    model.nodes.a!.ports[0]!.authorOrder = 9;
    model.document.title = 'Changed';
    expect(JSON.stringify(doc)).toBe(original);
    expect(model.links[0]?.from).toEqual({ node: 'a', name: 'p', ordinal: 2 });
    expect(model.document.nodes.a?.ports[0]?.order).toBe(4);
  });

  it('keeps bare singleton group endpoints as routed concrete members', () => {
    const doc = input(['[upper, lower]']);
    delete doc.nodes.b;
    delete doc.nodes.d;
    const model = resolve(doc);
    expect(model.links).toHaveLength(1);
    expect(model.links[0]).toMatchObject({ technique: 'orthogonal', layer: 'routed', attachments: { from: { node: 'a' }, to: { node: 'c' } } });
    expect(model.groupLinks).toEqual([]);
  });

  it('records a bare complete group-to-group link and respects an explicit overlay on that shape', () => {
    const bare = resolve(input(['[upper, lower, {class: flow}]']));
    expect(bare.groupLinks).toHaveLength(1);
    expect(bare.groupLinks[0]?.layer).toBe('overlay');
    expect(bare.links.every(link => link.technique === 'overlay' && link.family === 'overlay' && link.layer === 'overlay')).toBe(true);
    const routed = resolve(input(['[upper, lower, {class: physical}]']));
    expect(routed.groupLinks[0]?.layer).toBe('routed');
    expect(routed.links.every(link => link.technique === 'orthogonal' && link.family === 'routed' && link.layer === 'routed')).toBe(true);
    const overlay = resolve(input(['[upper, lower, {route: overlay}]']));
    expect(overlay.groupLinks).toEqual([]);
    expect(overlay.links).toHaveLength(4);
    expect(overlay.links.every(link => link.technique === 'overlay' && link.layer === 'overlay')).toBe(true);
  });

  it('keeps inferred and explicit GroupLink records in originating link order', () => {
    const doc = parse(`portograph: 2
groups: {g1: {tier: 0}, g2: {tier: 1}, g3: {tier: 2}}
nodes: {a: {group: g1}, b: {group: g1}, c: {group: g2}, d: {group: g2}, e: {group: g3}, f: {group: g3}}
links: [[a, c], [a, d], [b, c], [b, d], [g2, g3, {route: group-link}]]`);
    const model = resolve(doc);
    expect(model.groupLinks.map(link => link.groups)).toEqual([['g1', 'g2'], ['g2', 'g3']]);
  });

  it('does not aggregate a complete subset when another overridden member joins the group pair', () => {
    const model = resolve(input(['[a, c]', '[a, d]', '[b, c]', '[b, d]', '[a, c, {route: straight}]']));
    expect(model.groupLinks).toEqual([]);
    expect(model.bundles).toEqual([]);
    expect(model.links[4]?.technique).toBe('straight');
  });

  it('resolves an empty diagram without inventing layout geometry', () => {
    const model = resolve(parse('portograph: 2\ngroups: {}\nnodes: {}\nlinks: []'));
    expect(model.stage).toBe('resolve');
    expect(model.links).toEqual([]);
    expect(model.bundles).toEqual([]);
    expect(model.groupLinks).toEqual([]);
    expect(model.runtime).toEqual({ stages: [] });
    expect(model.tierBands).toEqual([]);
    expect(model.regions).toEqual([]);
    expect(model).not.toHaveProperty('canvas');
  });

  it('rejects an unsupported profile instead of guessing its families', () => {
    const doc = input(['[a, c]']);
    doc.profile = 'architecture';
    expect(() => resolve(doc)).toThrow(/does not support profile architecture/);
  });

  it('warns when one authored group link creates distinct links sharing a concrete port', () => {
    const parsed = parseWithDiagnostics(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes: {a: {group: upper}, b: {group: upper}, c: {group: lower, ports: [p]}}
links: [[upper, c.p]]`);
    if (!parsed.ok) throw new Error('Fixture did not parse');
    expect(parsed.diagnostics.filter(d => d.code === 'SHARED_PORT')).toEqual([]);
    const model = resolve(parsed.document, { diagnostics: parsed.diagnostics });
    const warnings = model.diagnostics.filter(d => d.code === 'SHARED_PORT');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ stage: 'model', severity: 'warning' });
    expect(warnings[0]?.owners).toEqual(expect.arrayContaining(model.links.map(link => link.owner)));
    expect(model.diagnostics.some(d => d.code === 'HIGH_DEGREE')).toBe(false);
  });

  it('warns at 70 distinct expanded links on a node within both expansion caps', () => {
    const parsed = parseWithDiagnostics(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes: {a: {group: upper}, b: {group: upper}, c: {group: upper}, d: {group: upper}, e: {group: upper}, target: {group: lower, ports: [p]}, spare: {group: lower}}
links:
${Array.from({ length: 14 }, () => '  - [upper, target.p]').join('\n')}`);
    if (!parsed.ok) throw new Error('Fixture did not parse');
    expect(parsed.diagnostics.some(d => d.code === 'HIGH_DEGREE')).toBe(false);
    const model = resolve(parsed.document, { diagnostics: parsed.diagnostics });
    expect(model.links).toHaveLength(70);
    expect(model.nodes.a?.ports).toHaveLength(14);
    expect(model.diagnostics.filter(d => d.code === 'HIGH_DEGREE')).toEqual([
      expect.objectContaining({ stage: 'model', severity: 'warning', owners: [{ kind: 'node', id: 'target' }] }),
    ]);
    expect(model.diagnostics.filter(d => d.code === 'SHARED_PORT')).toEqual(parsed.diagnostics.filter(d => d.code === 'SHARED_PORT'));
  });

  it('retains parser usage warnings without duplicating them and reconstructs them for direct resolve', () => {
    const parsed = parseWithDiagnostics(`portograph: 2
groups: {g: {tier: 0}}
nodes: {a: {group: g, ports: [p]}, b: {group: g, ports: [p]}, c: {group: g}, d: {group: g}, e: {group: g}, f: {group: g}, spare: {group: g}}
links:
${Array.from({ length: 65 }, () => '  - [a.p, b.p]').join('\n')}`);
    if (!parsed.ok) throw new Error('Fixture did not parse');
    const withDiagnostics = resolve(parsed.document, { diagnostics: parsed.diagnostics });
    expect(withDiagnostics.diagnostics).toEqual(parsed.diagnostics);
    const direct = resolve(parsed.document);
    expect(direct.diagnostics.filter(d => d.code === 'HIGH_DEGREE')).toHaveLength(2);
    expect(direct.diagnostics.filter(d => d.code === 'SHARED_PORT')).toHaveLength(2);
  });

  it('counts a self-link only once per concrete port and node', () => {
    const parsed = parse(`portograph: 2
groups: {g: {tier: 0}}
nodes: {a: {group: g, ports: [p]}}
links: [[a.p, a.p]]`);
    expect(resolve(parsed).diagnostics.filter(d => d.code === 'SHARED_PORT')).toEqual([]);
  });

  it('deduplicates shared-port warnings by concrete port rather than only its node', () => {
    const parsed = parseWithDiagnostics(`portograph: 2
groups: {upper: {tier: 0}, lower: {tier: 1}}
nodes: {a: {group: upper}, b: {group: upper}, target: {group: lower, ports: [p, p]}}
links: [[a, target.p#1], [b, target.p#1], [upper, target.p#2]]`);
    if (!parsed.ok) throw new Error('Fixture did not parse');
    expect(parsed.diagnostics.filter(d => d.code === 'SHARED_PORT')).toHaveLength(1);
    const model = resolve(parsed.document, { diagnostics: parsed.diagnostics });
    const warnings = model.diagnostics.filter(d => d.code === 'SHARED_PORT');
    expect(warnings).toHaveLength(2);
    expect(warnings).toContainEqual(parsed.diagnostics.find(d => d.code === 'SHARED_PORT'));
    expect(warnings[1]?.owners).toEqual(expect.arrayContaining([{ kind: 'link', id: 'link-3-1' }, { kind: 'link', id: 'link-3-2' }]));
  });

  it.each([
    '[upper, c]',
    '[upper, lower]',
    '[upper, lower, {route: group-link}]',
    '[upper, c, {route: stub}]',
  ])('uses existing member owners for resolver-created expansion/fallback warnings: %s', link => {
    const model = resolve(input([link]));
    const warnings = model.diagnostics.filter(d => d.code === 'GROUP_ENDPOINT_EXPANDED' || d.code === 'ROUTE_UNSUPPORTED');
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning.owners).toEqual(model.links.map(member => member.owner));
    }
  });
});
