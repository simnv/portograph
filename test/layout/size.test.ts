import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parse/index.js';
import { resolve } from '../../src/resolve/index.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { resolveNodeIcon } from '../../src/profiles/network/icons.js';
import { measureNodeContent, sizeNodes } from '../../src/layout/size.js';

function sized(nodes: string, links = '[]') {
  return sizeNodes(sidesOne(resolve(parse(`portograph: 2
groups: {g: {tier: 0}, lower: {tier: 1}}
nodes: ${nodes}
links: ${links}`))));
}

describe('measured node size', () => {
  it('fits EAC-01 lateral pills and its provider port from the actual golden', () => {
    const model = sidesOne(resolve(parse(readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8'))));
    const original = JSON.stringify(model.document);
    expect(sizeNodes(model)).toBe(model);
    expect(model.stage).toBe('size');
    expect(model.nodes['EAC-01']?.sidePitch).toEqual({ bottom: 12, right: 12, top: 14, left: 14 });
    expect(model.nodes['EAC-01']?.size?.height).toBe(76);
    expect(model.nodes['EAC-01']?.size?.width).toBeGreaterThanOrEqual(50);
    expect(model.nodes['EAC-01']?.sizeFloor?.height).toBeLessThan(76);
    expect(model.nodes['TBR-001']?.size?.height).toBe(132);
    expect(model.nodes['EBR-01']?.sidePitch?.right).toBe(14);
    expect(model.nodes['EBR-01']?.ports[0]?.side).toBeUndefined();
    expect(JSON.stringify(model.document)).toBe(original);
    expect(Object.values(model.nodes).every(node => node.bounds === undefined && node.ports.every(port => port.anchor === undefined && port.pill === undefined))).toBe(true);
    expect(model.links.every(link => link.path === undefined)).toBe(true);
  });

  it('fits a portless 40-character label through real font metrics', () => {
    const node = sized(`{a: {group: g, label: ${'W'.repeat(40)}}}`).nodes.a!;
    expect(node.size?.width).toBeGreaterThan(350);
    expect(node.size?.width).toBeGreaterThanOrEqual(node.contentSize!.width);
    expect(node.ports).toEqual([]);
  });

  it('includes multiline descriptions, explicit icons and gaps in content floors', () => {
    const nodes = sized(`{a: {group: g, label: A, description: "one\\ntwo\\nthree", icon: router}, b: {group: g, label: A, description: one, icon: router}, c: {group: g, label: A, description: "one\\ntwo\\nthree"}}`).nodes;
    expect(nodes.a?.contentSize?.height).toBe(78);
    expect(nodes.a?.size?.height).toBe(78);
    expect(nodes.a!.contentSize!.height - nodes.b!.contentSize!.height).toBe(18);
    expect(nodes.a!.contentSize!.height - nodes.c!.contentSize!.height).toBe(16);
  });

  it('reserves an asymmetric content inset for inward pill protrusion', () => {
    const model = sized(`{a: {group: g, label: Content, ports: [{name: "${'W'.repeat(40)}", side: left}]}}`);
    const node = model.nodes.a!;
    expect(node.contentInsets?.left).toBeGreaterThan(150);
    expect(node.contentInsets?.right).toBe(10);
    expect(node.contentSize!.width).toBeGreaterThan(190);
    expect(node.size!.width).toBeGreaterThanOrEqual(node.contentSize!.width);
    expect(node.sidePitch?.left).toBe(14);
    const measured = measureNodeContent(model.document.nodes.a!, model.document, node.contentInsets);
    expect(measured.blocks).toEqual([expect.objectContaining({ kind: 'node', text: 'Content', lines: ['Content'], fontSize: 9, fontWeight: 700, lineHeight: 11 })]);
    expect(measured.width).toBe(node.contentSize!.width);
  });

  it('honors author size as a floor and never shrinks a previous measured size', () => {
    const model = sized('{a: {group: g, label: A, size: {width: 300, height: 120}}}');
    expect(model.nodes.a?.size).toEqual({ width: 300, height: 120 });
    model.nodes.a!.size = { width: 400, height: 140 };
    sizeNodes(model);
    expect(model.nodes.a?.size).toEqual({ width: 400, height: 140 });
    expect(model.document.nodes.a?.size).toEqual({ width: 300, height: 120 });
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('long names protrude normally without expanding %s pitch', side => {
    const model = sized(`{a: {group: g, label: "", ports: [{name: "${'W'.repeat(40)}", side: ${side}}, {name: p, side: ${side}}, {name: q, side: ${side}}, {name: r, side: ${side}}]}}`);
    const node = model.nodes.a!;
    expect(node.sidePitch?.[side]).toBe(14);
    expect(side === 'left' || side === 'right' ? node.size?.height : node.size?.width).toBe(76);
    expect(side === 'left' || side === 'right' ? node.size?.width : node.size?.height).toBeGreaterThan(160);
  });

  it('reserves capacity for same-tier undecided named ports', () => {
    const model = sized('{a: {group: g, label: "", ports: [p, p, p, p]}, b: {group: g}}', '[[a.p#1, b], [a.p#2, b], [a.p#3, b], [a.p#4, b]]');
    expect(model.nodes.a?.ports.every(port => port.side === undefined && port.sizingSide === 'right')).toBe(true);
    expect(model.nodes.a?.size).toEqual({ width: 50, height: 76 });
    expect(model.nodes.b?.size?.height).toBe(68);
  });

  it('sizes expanded anonymous ports from the layout inventory, leaving pills invisible', () => {
    const model = sized('{a: {group: g}, b: {group: g}, c: {group: g}, d: {group: g}, target: {group: lower, label: ""}}', '[[g, lower]]');
    expect(model.document.nodes.target?.ports).toEqual([]);
    expect(model.nodes.target?.ports).toHaveLength(4);
    expect(model.nodes.target?.size).toEqual({ width: 68, height: 35 });
    expect(model.nodes.target?.sidePitch?.top).toBe(12);
    expect(model.nodes.target?.ports.every(port => port.pill === undefined)).toBe(true);
  });

  it('reserves class-default icons, allows explicit overrides and suppresses an empty icon', () => {
    const nodes = sized('{a: {group: g, class: router, label: A}, b: {group: g, class: router, label: A, icon: ""}, c: {group: g, class: custom, label: A, icon: custom}, d: {group: g, class: custom, label: A}}').nodes;
    expect(nodes.a!.contentSize!.height - nodes.b!.contentSize!.height).toBe(16);
    expect(nodes.c?.contentSize).toEqual(nodes.a?.contentSize);
    expect(nodes.d?.contentSize).toEqual(nodes.b?.contentSize);
    expect(resolveNodeIcon({ class: 'provider' })).toBe('cloud');
    expect(resolveNodeIcon({ class: 'rr' })).toBe('server');
    expect(resolveNodeIcon({ class: 'provider', icon: 'custom' })).toBe('custom');
    expect(resolveNodeIcon({ class: 'provider', icon: '' })).toBeUndefined();
    expect(resolveNodeIcon({ class: 'constructor' })).toBeUndefined();
    // The four network roles must be separable without colour, so their glyphs differ where the
    // target does. The icon box is a fixed 12 x 12 whatever the glyph, so this moves no geometry.
    expect(resolveNodeIcon({ class: 'router' })).toBe('router');
    expect(resolveNodeIcon({ class: 'tbr' })).toBe('switch');
    expect(new Set(['provider', 'router', 'tbr', 'rr'].map(value => resolveNodeIcon({ class: value }))).size).toBe(4);
    const glyphs = sized('{a: {group: g, class: router, label: A}, b: {group: g, class: tbr, label: A}}').nodes;
    expect(glyphs.b!.contentSize).toEqual(glyphs.a!.contentSize);
  });
});
