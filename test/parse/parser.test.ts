import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parse, parseWithDiagnostics, ParseError } from '../../src/parse/index.js';
import { createLayoutModel, orderedGroupIds, orderedNodeIds } from '../../src/model/index.js';

const source = (value: Record<string, unknown>) => stringify({ portograph: 2, groups: { g: { tier: 0 } }, nodes: { a: { group: 'g', ports: ['p', 'q', 'p'] }, b: { group: 'g', ports: ['p'] } }, ...value });
const codes = (text: string) => parseWithDiagnostics(text).diagnostics.map(d => d.code);

describe('schema normalisation', () => {
  it('matches the independently approved golden exactly', () => {
    const yaml = readFileSync('goldens/m1-sip-edge.yaml', 'utf8');
    expect(parse(yaml)).toEqual(JSON.parse(readFileSync('goldens/m1-sip-edge.expected.json', 'utf8')));
  });

  it('allocates free names and wildcards in link order without changing name-local ordinals', () => {
    const result = parseWithDiagnostics(source({ links: [['a.p#2', 'b.p'], ['a.*', 'b.p'], ['a.p', 'b'], ['a.*', 'b'], ['a.*', 'b']] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.links.map(l => l.from)).toEqual([
      { node: 'a', name: 'p', ordinal: 2 }, { node: 'a', name: 'p', ordinal: 1 },
      { node: 'a', name: 'p', ordinal: 1 }, { node: 'a', name: 'q', ordinal: 1 },
      { node: 'a', anonymous: true, ordinal: 1 },
    ]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'model', severity: 'warning', code: 'SHARED_PORT', path: '$.links[1].to' }),
      expect.objectContaining({ code: 'WILDCARD_ANONYMOUS', path: '$.links[4].from' }),
    ]));
  });

  it('makes compact and structured endpoint forms equivalent, including groups', () => {
    const compact = source({ links: [['a.p#2', 'b.p'], ['a.*', 'b'], ['g', 'g', { route: 'group-link' }]] });
    const structured = source({ links: [
      { from: { node: 'a', port: 'p', ordinal: 2 }, to: { node: 'b', port: 'p' } },
      { from: { node: 'a', port: '*' }, to: { node: 'b' } },
      { from: { group: 'g' }, to: { group: 'g' }, route: 'group-link' },
    ] });
    expect(parse(compact)).toEqual(parse(structured));
  });

  it('preserves side inheritance, author order, size floors, labels and options', () => {
    const doc = parse(source({ title: 'free / text # *', overlays: { flow: 'hidden' }, groups: { g: { tier: 9, shape: 'bar', label: '', class: 'frame', layout: { 'elk.spacing': 40 } } }, nodes: {
      a: { group: 'g', label: '', description: 'Any / text', icon: 'router', size: { width: 80, height: 45 }, ports: { side: 'left', list: ['p', { name: 'p', side: 'bottom', order: -1 }] } },
      b: { group: 'g' },
    }, links: [['a.p#2', 'b', { class: 'flow', route: 'merge', label: 'sync', weight: 2 }]] }));
    expect(doc.nodes.a).toEqual({ group: 'g', label: '', description: 'Any / text', icon: 'router', size: { width: 80, height: 45 }, ports: [{ name: 'p', ordinal: 1, side: 'left' }, { name: 'p', ordinal: 2, side: 'bottom', order: -1 }] });
    expect(doc.links[0]).toMatchObject({ route: 'merge', class: 'flow', label: 'sync', weight: 2 });
    expect(doc.groups.g).toMatchObject({ tier: 0, shape: 'bar', label: '', layout: { 'elk.spacing': 40 } });
    expect(doc.overlays).toEqual({ flow: 'hidden' });
  });

  it('compacts inferred top, sparse explicit ranks, middle and bottom bands', () => {
    const result = parseWithDiagnostics(source({ groups: { mixed: {}, bottom: {}, ex9: { tier: 9 }, top: {}, ex0: { tier: 0 }, tie: { tier: 9 }, middle: {}, flank: { align: 'left', of: 'ex0' } }, nodes: {
      a: { group: 'mixed', class: 'wan' }, b: { group: 'mixed', class: 'core' }, c: { group: 'bottom', class: 'core' }, d: { group: 'top', class: 'provider' },
    } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.fromEntries(Object.entries(result.document.groups).map(([id, g]) => [id, g.tier]))).toEqual({ mixed: 3, bottom: 5, ex9: 2, top: 0, ex0: 1, tie: 2, middle: 4, flank: undefined });
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MIXED_TIER_CLASSES' }), expect.objectContaining({ code: 'TIER_INFERRED', severity: 'info' }), expect.objectContaining({ code: 'EMPTY_TIER' })]));
  });

  it('retains numeric-key declaration order through normalisation and model JSON', () => {
    const doc = parse('portograph: 2\ngroups:\n  10: {}\n  2: {}\nnodes:\n  30: {group: "10"}\n  3: {group: "10"}\n  20: {group: "2"}\n');
    expect(orderedGroupIds(doc)).toEqual(['10', '2']);
    expect(orderedNodeIds(doc)).toEqual(['30', '3', '20']);
    expect(doc.groups['10']?.tier).toBe(0);
    expect(doc.groups['2']?.tier).toBe(1);
    const model = createLayoutModel(JSON.parse(JSON.stringify(doc)));
    expect(model.groups['10']?.nodes).toEqual(['30', '3']);
  });

  it('accepts zero links, YAML aliases, and own identifiers named constructor', () => {
    const doc = parse('portograph: 2\ngroups: {constructor: {tier: 0}}\nnodes:\n  a: &node {group: constructor, ports: [constructor]}\n  b: *node\nlinks: [[a.constructor, b.constructor]]\n');
    expect(Object.getPrototypeOf(doc.groups)).toBe(Object.prototype);
    expect(doc.links[0]?.from).toEqual({ node: 'a', name: 'constructor', ordinal: 1 });
    expect(parse(source({ links: [] })).links).toEqual([]);
  });

  it('exposes warnings without adding authored keys and errors without accidental exceptions', () => {
    const warnings: string[] = [];
    const doc = parse(source({ groups: { g: { collapsed: true } } }), { onDiagnostic: d => warnings.push(d.code) });
    expect(warnings).toContain('COLLAPSED_UNSUPPORTED');
    expect(doc.groups.g).not.toHaveProperty('collapsed');
    expect(doc).not.toHaveProperty('diagnostics');
    expect(() => parse('[')).toThrow(ParseError);
  });
});

describe('parse diagnostics', () => {
  it.each([
    ['VERSION', { portograph: undefined }], ['VERSION', { portograph: 1 }],
    ['BAD_IDENTIFIER', { nodes: { '__proto__': null, 'bad.id': { group: 'g' } } }],
    ['NAMESPACE_COLLISION', { nodes: { g: { group: 'g' } } }],
    ['NODE_GROUP_REQUIRED', { nodes: { a: {} } }],
    ['UNKNOWN_REFERENCE', { nodes: { a: { group: 'missing' } } }],
    ['TIER_ALIGN_CONFLICT', { groups: { g: { tier: 0, align: 'left', of: 'h' }, h: {} } }],
    ['FLANK_OF_REQUIRED', { groups: { g: { align: 'left' } } }],
    ['OF_WITHOUT_ALIGN', { groups: { g: { of: 'g' } } }],
    ['FLANK_OF_TIER', { groups: { g: { align: 'left', of: 'g' } } }],
    ['FLANK_OF_TIER', { groups: { g: { align: 'left', of: 'h' }, h: { align: 'right', of: 'g' } } }],
    ['DUPLICATE_FLANK', { groups: { g: {}, l: { align: 'left', of: 'g' }, l2: { align: 'left', of: 'g' } } }],
    ['LINK_ENDPOINTS', { links: [['a']] }],
    ['UNKNOWN_REFERENCE', { links: [['a.nope', 'b']] }],
    ['UNKNOWN_REFERENCE', { links: [['a.p#3', 'b']] }],
    ['UNKNOWN_REFERENCE', { links: [['missing', 'b']] }],
    ['BAD_ENDPOINT', { links: [[{ node: 'a', ordinal: 1 }, 'b']] }],
    ['BAD_ENDPOINT', { links: [[{ group: 'g', node: 'a' }, 'b']] }],
    ['BAD_ENDPOINT', { links: [['a.p#0', 'b']] }],
    ['GROUP_LINK_ENDPOINTS', { links: [['a', 'b', { route: 'group-link' }]] }],
    ['UNSUPPORTED_PROFILE', { profile: 'architecture' }],
    ['UNSUPPORTED_SHAPE', { groups: { g: { shape: 'grid' } } }],
    ['UNKNOWN_KEY', { groups: { g: { tiers: 2 } } }],
  ])('%s: %j', (code, value) => {
    const result = parseWithDiagnostics(source(value));
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code, severity: 'error', stage: 'parse', path: expect.any(String) })]));
  });

  it.each([
    { groups: null }, { nodes: [] }, { links: {} }, { title: 3 }, { css: false }, { profile: 1 },
    { groups: { g: null } }, { groups: { g: { tier: -1 } } }, { groups: { g: { tier: 1.5 } } },
    { groups: { g: { align: 'up' } } }, { groups: { g: { collapsed: 'yes' } } },
    { groups: { g: { layout: { x: [] } } } }, { nodes: { a: false } }, { nodes: { a: { group: 'g', ports: null } } },
    { nodes: { a: { group: 'g', ports: [2] } } }, { nodes: { a: { group: 'g', ports: [{ name: 'p', side: 'up' }] } } },
    { nodes: { a: { group: 'g', ports: [{ name: 'p', order: 0.5 }] } } }, { nodes: { a: { group: 'g', ports: [{ name: 'p', class: 3 }] } } },
    { nodes: { a: { group: 'g', ports: { side: 'left' } } } }, { nodes: { a: { group: 'g', size: { width: -1, height: 2 } } } },
    { overlays: { flow: 'other' } }, { links: [[null, 'b']] }, { links: [['a', 'b', null]] },
    { links: [['a', 'b', { route: 'other' }]] }, { links: [['a', 'b', { weight: Infinity }]] },
  ])('rejects malformed shapes: %j', value => {
    const result = parseWithDiagnostics(source(value));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(d => d.severity === 'error')).toBe(true);
  });

  it.each(['[', '', 'null', 'groups: {}', 'portograph: 2\nportograph: 2', 'portograph: 2\ngroups: {__proto__: {}}\nnodes: {}', '? [x, y]\n: value', 'portograph: 2\ngroups: {g: {}}\nnodes: {}\n---\na: b'])('diagnoses malformed YAML/root safely: %s', text => {
    expect(parseWithDiagnostics(text).ok).toBe(false);
  });

  it('filters locked CSS declarations even with case, whitespace, comments and escapes', () => {
    const result = parseWithDiagnostics(source({ css: '.x { FONT-SIZE : 40px; stroke-WIDTH: 9; /* a */ transform: rotate(1deg); font: 20px serif; font-\\73 ize: 30px; fill: red; stroke-dasharray: 2 3; opacity: .5; }' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.css).not.toMatch(/40px|30px|rotate|20px|stroke-WIDTH/);
    expect(result.document.css).toContain('fill: red');
    expect(result.document.css).toContain('stroke-dasharray: 2 3');
    expect(result.diagnostics.filter(d => d.code === 'LOCKED_CSS')).toHaveLength(5);
    expect(codes(source({ css: '.x { fill:' }))).toContain('INVALID_CSS');
  });

  it.each([
    '-webkit-transform-origin', '-moz-transform-origin', '-ms-transform-origin', '-o-transform-origin',
    '-webkit-transform-box', '-WEBKIT-TRANSFORM-ORIGIN', '-webkit-trans\\66 orm-origin',
    '-\\77 ebkit-transform-origin', '-webkit-transform', '-moz-transform',
  ])('filters locked vendor aliases after decoding: %s', property => {
    const result = parseWithDiagnostics(source({ css: `.x { ${property}: 100px; fill: red; stroke: blue; opacity: .5; }` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.css).not.toContain('100px');
    expect(result.document.css).toContain('fill: red; stroke: blue; opacity: .5;');
    expect(result.diagnostics.filter(d => d.code === 'LOCKED_CSS')).toHaveLength(1);
  });

  // Ticket 16 found these while transplanting the theme: each one draws measured text or a measured
  // element somewhere other than where the gates cleared it, without naming a locked property.
  it.each([
    ['text-transform', 'uppercase'], ['font-stretch', 'ultra-expanded'], ['font-variant', 'small-caps'],
    ['font-size-adjust', '2'], ['word-spacing', '20px'], ['writing-mode', 'vertical-rl'],
    ['text-anchor', 'start'], ['dominant-baseline', 'hanging'], ['baseline-shift', '40px'],
    ['dx', '60px'], ['dy', '60px'], ['marker-end', 'url(#m)'], ['vector-effect', 'non-scaling-stroke'],
    ['offset-distance', '40%'], ['zoom', '3'], ['-webkit-text-size-adjust', '300%'],
    // Found by the ticket-16 adversarial review: paint that leaves the measured box, protection
    // that the overlay layer depends on, and the remaining text-metric properties.
    ['filter', 'drop-shadow(100px 0px 0px black)'], ['mask', 'none'], ['clip-path', 'none'],
    ['text-shadow', '80px 0 red'], ['backdrop-filter', 'blur(9px)'], ['box-shadow', '70px 0 red'],
    ['font-style', 'italic'], ['font-kerning', 'none'], ['font-variant-ligatures', 'none'],
    ['font-variant-numeric', 'tabular-nums'], ['font-variant-east-asian', 'full-width'],
    ['font-variant-position', 'super'], ['font-language-override', '"TRK"'],
    ['mask-image', 'none'], ['mask-type', 'alpha'], ['stroke-miterlimit', '200'],
  ])('locks the text and placement property %s, which would move measured geometry', (property, value) => {
    const result = parseWithDiagnostics(source({ css: `.x { ${property}: ${value}; fill: red; stroke: blue; opacity: .5; }` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.css).not.toContain(value);
    expect(result.document.css).toContain('fill: red; stroke: blue; opacity: .5;');
    expect(result.diagnostics.filter(d => d.code === 'LOCKED_CSS')).toHaveLength(1);
  });

  // The final whole-branch review found ordinary node rectangles accepting `outline: 1000px solid
  // red`. An outline is painted outside the element's box, after the shape and independently of
  // `stroke`, so it covers unrelated geometry and reaches past the canvas every gate measured.
  it.each([
    ['outline', '1000px solid red'], ['outline-width', '1000px'], ['outline-style', 'solid'],
    ['outline-color', '#00ff00'], ['outline-offset', '1000px'],
    ['OUTLINE', '1000px solid red'], ['Outline-Offset', '1000px'],
    ['-webkit-outline', '1000px solid red'], ['-moz-outline-style', 'solid'],
    ['-ms-outline-width', '1000px'], ['-o-outline-color', '#00ff00'],
    ['outl\\69 ne', '1000px solid red'], ['outline-\\6f ffset', '1000px'],
    ['-\\77 ebkit-outline', '1000px solid red'],
  ])('locks the outline property %s, which paints outside the measured box', (property, value) => {
    const result = parseWithDiagnostics(source({ css: `.x { ${property}: ${value}; fill: red; stroke: blue; opacity: .5; }` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exact, because an escaped name survives a `/outline/` search even when the declaration does.
    expect(result.document.css).toBe('.x { fill: red; stroke: blue; opacity: .5; }');
    expect(result.diagnostics.filter(d => d.code === 'LOCKED_CSS')).toHaveLength(1);
  });

  it.each(['\t', '\n', '\r', '\r\n', '\f'])('filters whitespace-terminated CSS property escapes: %j', whitespace => {
    const result = parseWithDiagnostics(source({ css: `.x { font-\\73${whitespace}ize: 30px; \\66${whitespace}ill: red; }` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.css).not.toContain('30px');
    expect(result.document.css).toContain('ill: red');
    expect(result.diagnostics.filter(d => d.code === 'LOCKED_CSS')).toHaveLength(1);
    expect(result.diagnostics.some(d => d.code === 'INVALID_CSS')).toBe(false);
  });

  // The outline lock names properties, not substrings. An allowed declaration may still consume a
  // custom property through `var()`, but every declaration that could turn one into outline paint
  // is locked, and an unrelated vendor property that merely spells "outline" paints nothing
  // outside the box.
  it('keeps custom and unrelated declarations whose names contain outline', () => {
    const css = '.x { --outline: 1000px solid red; --outline-width: 40px; -webkit-text-stroke-color: red; fill: blue; }';
    const result = parseWithDiagnostics(source({ css }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.css).toBe(css);
    expect(result.diagnostics.some(d => d.code === 'LOCKED_CSS')).toBe(false);
  });

  it('keeps escaped backslashes and unlocked vendor declarations intact', () => {
    const css = '.x { --literal: "\\\\73"; -webkit-text-fill-color: red; fill: blue; }';
    const result = parseWithDiagnostics(source({ css }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.css).toBe(css);
    expect(result.diagnostics.some(d => d.code === 'LOCKED_CSS')).toBe(false);
  });

  it('warns on M1 stub and group-link overrides without resolving their technique', () => {
    expect(codes(source({ links: [['a', 'b', { route: 'stub' }], ['g', 'g', { route: 'group-link' }]] }))).toEqual(expect.arrayContaining(['ROUTE_UNSUPPORTED']));
  });

  it('enforces ADR resource bounds, with force overriding only the node ceiling', () => {
    const nodes = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`n${i}`, { group: 'g' }]));
    expect(codes(source({ nodes }))).toContain('NODE_LIMIT');
    const forced = parseWithDiagnostics(source({ nodes }), { force: true });
    expect(forced.ok).toBe(true);
    expect(forced.diagnostics.some(d => d.code === 'LARGE_DIAGRAM')).toBe(true);
    expect(codes(source({ links: Array.from({ length: 21 }, () => ['a.p', 'b.p']) }))).toContain('LINK_LIMIT');
    expect(codes(source({ nodes: { a: { group: 'g', ports: Array(21).fill('p') } } }))).toContain('PORT_LIMIT');
    const degreeNodes = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i}`, { group: 'g', ports: ['p'] }]));
    expect(codes(source({ nodes: degreeNodes, links: Array.from({ length: 65 }, () => ['n0.p', 'n1.p']) }))).toContain('HIGH_DEGREE');
    expect(codes(source({ links: Array.from({ length: 21 }, () => ['a', 'b']) }))).toContain('PORT_LIMIT');
  });

  it('keeps a port class as authored tokens and rejects a non-string one at the port path', () => {
    const ok = parseWithDiagnostics(source({ nodes: { a: { group: 'g', ports: ['p', { name: 'q', class: 'uplink down' }, { name: 'r', side: 'left', class: '' }] } } }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.document.nodes['a']!.ports).toEqual([{ name: 'p', ordinal: 1 }, { name: 'q', ordinal: 1, class: 'uplink down' }, { name: 'r', ordinal: 1, side: 'left', class: '' }]);
    const bad = parseWithDiagnostics(source({ nodes: { a: { group: 'g', ports: { side: 'left', list: [{ name: 'p', class: ['uplink'] }] } } } }));
    expect(bad.diagnostics).toContainEqual(expect.objectContaining({ path: '$.nodes.a.ports.list[0].class', severity: 'error' }));
  });

  it('points shorthand port diagnostics at the authored list', () => {
    const result = parseWithDiagnostics(source({ nodes: { a: { group: 'g', ports: { side: 'left', list: [{ name: 'p', side: 'up' }] } } } }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: '$.nodes.a.ports.list[0].side', severity: 'error' }));
  });

  it('locks CSS transform components and SVG geometry without removing theme declarations', () => {
    const doc = parse(source({ css: '.x { translate: 10px; rotate: 20deg; scale: 2; width: 90px; x: 5px; font-weight: 900; letter-spacing: 8px; font-family: serif; fill-opacity: .4; stroke: blue; stroke-dashoffset: 2; }' }));
    expect(doc.css).not.toMatch(/10px|20deg|scale:|90px|5px|900|8px|serif/);
    expect(doc.css).toContain('fill-opacity: .4');
    expect(doc.css).toContain('stroke: blue');
  });

  it('accepts resource-boundary diagrams and warns without refusing beyond the work bounds', () => {
    const nodes = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`n${i}`, { group: 'g' }]));
    expect(parseWithDiagnostics(source({ nodes })).ok).toBe(true);
    expect(parseWithDiagnostics(source({ nodes: { a: { group: 'g' }, b: { group: 'g' } }, links: Array.from({ length: 20 }, () => ['a', 'b']) })).ok).toBe(true);
    // ADR-0006: links, ports and degree bound work. Beyond them the tool warns and continues best
    // effort, so a large diagram reaches layout instead of being refused at the door.
    const manyLinks = parseWithDiagnostics(source({ links: Array.from({ length: 21 }, () => ['a', 'b']) }));
    expect(manyLinks.ok).toBe(true);
    expect(manyLinks.diagnostics.filter(d => d.code === 'LINK_LIMIT'))
      .toEqual([{ code: 'LINK_LIMIT', path: '$.links', severity: 'warning', stage: 'model',
        message: 'Links (21) exceed 10 times the node count; continuing best effort' }]);
    const manyPorts = parseWithDiagnostics(source({
      nodes: { a: { group: 'g', ports: Array.from({ length: 21 }, (_, i) => `p${i}`) }, b: { group: 'g' } },
    }));
    expect(manyPorts.ok).toBe(true);
    expect(manyPorts.diagnostics.filter(d => d.code === 'PORT_LIMIT').map(d => [d.severity, d.path]))
      .toEqual([['warning', '$.nodes.a.ports']]);
    // Only the node count still refuses, and only without --force.
    const manyNodes = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`n${i}`, { group: 'g' }]));
    expect(parseWithDiagnostics(source({ nodes: manyNodes })).ok).toBe(false);
    expect(codes(source({ nodes: manyNodes }))).toContain('NODE_LIMIT');
    expect(parseWithDiagnostics(source({ nodes: manyNodes }), { force: true }).ok).toBe(true);
  });

  it('resolves YAML merge aliases without adding defaults as document fields', () => {
    const doc = parse('portograph: 2\ngroups: {g: {tier: 0}}\nnodes:\n  a: &base {group: g, ports: [p]}\n  b: {<<: *base, label: Other}\nlinks: [[a.p, b.p]]');
    expect(doc.nodes.b).toEqual({ group: 'g', label: 'Other', ports: [{ name: 'p', ordinal: 1 }] });
  });

  it('reports YAML tag warnings and alias failures deterministically', () => {
    const warning = source({ title: 'tagged' }).replace('title: tagged', 'title: !custom tagged');
    expect(codes(warning)).toContain('YAML_WARNING');
    expect(codes('portograph: 2\ngroups: *missing\nnodes: {}')).toContain('INVALID_YAML');
    const text = source({ links: [['a.p#1', 'b.p#1'], ['a.p#1', 'b.p#1']] });
    expect(parseWithDiagnostics(text)).toEqual(parseWithDiagnostics(text));
    try { parse('['); throw new Error('Expected parse to fail'); } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      if (error instanceof ParseError) expect(error.diagnostics.some(d => d.code === 'INVALID_YAML')).toBe(true);
    }
  });
});
