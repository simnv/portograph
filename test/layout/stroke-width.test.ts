import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { parse, render, score } from '../../src/index.js';
import { DEFAULT_STROKE_WIDTHS, resolve, restoreLayoutModel, sidesOne, sizeNodes } from '../../src/internal.js';
import { linkStrokeWidth, routedStrokeWidth } from '../../src/theme/geometry.js';
import { bands } from '../../src/layout/bands.js';
import { bars } from '../../src/layout/bars.js';
import { bundles } from '../../src/layout/bundles.js';
import { centre } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes, laneWidth } from '../../src/layout/lanes.js';
import { linkLabels } from '../../src/layout/link-labels.js';
import { pitch as memberPitch } from '../../src/layout/bundle-geometry.js';
import { rows } from '../../src/layout/rows.js';
import { PILL_WIRE_GAP, rowGap } from '../../src/layout/sides-two.js';
import { route } from '../../src/route/index.js';
import { validateRoutedPaths } from '../../src/route/validate.js';
import { measurePortPill } from '../../src/text/index.js';
import { placed } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');

const weighted = (weight: string): LayoutModel => resolve(parse([
  'portograph: 2',
  'groups: {top: {tier: 0}, low: {tier: 1}}',
  'nodes:',
  '  a: {group: top, class: router, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}',
  '  b: {group: low, class: router, ports: [{name: p, side: top}, {name: q, side: top}]}',
  'links:',
  `  - [a.p, b.p, {weight: ${weight}}]`,
  `  - [a.q, b.q, {weight: ${weight}}]`,
].join('\n')));

describe('authored weight becomes one effective stroke width', () => {
  it('resolves the multiplier in stage 1, before any path exists', () => {
    const model = weighted('3');
    for (const link of model.links) {
      expect(link.path).toBeUndefined();
      expect(link.strokeWidth).toBe(DEFAULT_STROKE_WIDTHS.path * 3);
      expect(linkStrokeWidth(link)).toBe(4.5);
    }
    expect(routedStrokeWidth(model)).toBe(4.5);
  });

  it('leaves the shared default implicit for weight 1 and for no weight at all', () => {
    for (const model of [weighted('1'), resolve(parse(['portograph: 2', 'groups: {g: {tier: 0}}',
      'nodes: {a: {group: g, ports: [p]}, b: {group: g, ports: [p]}}', 'links: [[a.p, b.p]]'].join('\n')))]) {
      for (const link of model.links) {
        expect(link.strokeWidth).toBeUndefined();
        expect(linkStrokeWidth(link)).toBe(DEFAULT_STROKE_WIDTHS.path);
      }
    }
  });

  it('reserves stroke-aware placement space from the resolved width', () => {
    const wide = sizeNodes(sidesOne(weighted('4'))), narrow = sizeNodes(sidesOne(weighted('1')));
    // Bundle member pitch is the visible gap plus the widest member stroke.
    expect(memberPitch(wide, { id: 'bundle-1', owner: { kind: 'bundle', id: 'bundle-1' }, layer: 'routed',
      nodes: ['a', 'b'], members: wide.links.map(link => link.id) })).toBe(16 + 6);
    expect(memberPitch(narrow, { id: 'bundle-1', owner: { kind: 'bundle', id: 'bundle-1' }, layer: 'routed',
      nodes: ['a', 'b'], members: narrow.links.map(link => link.id) })).toBe(16 + DEFAULT_STROKE_WIDTHS.path);
    // A lane must clear the widest routed stroke it may carry beside a node, once that stroke
    // exceeds the pill-derived floor the lane already reserves.
    const huge = sizeNodes(sidesOne(weighted('12')));
    expect(laneWidth(huge, huge.links[0]!)).toBe(20 + 18 + DEFAULT_STROKE_WIDTHS.node);
    expect(laneWidth(huge, huge.links[0]!)).toBeGreaterThan(laneWidth(narrow, narrow.links[0]!));
    expect(laneWidth(wide, wide.links[0]!)).toBe(laneWidth(narrow, narrow.links[0]!));
  });

  it('carries the same width onto the drawn path, and score reads it', async () => {
    const yaml = ['portograph: 2', 'groups: {top: {tier: 0}, low: {tier: 1}}',
      'nodes:', '  a: {group: top, class: router, ports: [{name: p, side: bottom}]}',
      '  b: {group: low, class: router, ports: [{name: p, side: top}]}',
      'links: [[a.p, b.p, {weight: 2}]]'].join('\n');
    const model = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))))),
      { createAttempt: createAvoidAttempt }));
    const link = model.links[0]!;
    expect(link.strokeWidth).toBe(3);
    expect(link.path!.strokeWidth).toBe(3);
    expect(linkStrokeWidth(link)).toBe(3);
    const report = score(model).snapshot;
    for (const gate of Object.values(report.gates)) expect(gate.violations).toEqual([]);
  }, 60000);

  it('carries the resolved width through real bundle, merge trunk and overlay production', async () => {
    const yaml = ['portograph: 2', 'groups: {top: {tier: 0}, low: {tier: 1}}',
      'nodes:',
      '  a: {group: top, class: router, ports: [{name: p, side: bottom}, {name: q, side: bottom}, {name: f, side: bottom}]}',
      '  b: {group: low, class: router, ports: [{name: p, side: top}, {name: q, side: top}, {name: f, side: top}]}',
      'links:',
      '  - [a.p, b.p, {route: merge, weight: 2}]',
      '  - [a.q, b.q, {route: merge, weight: 2}]',
      '  - [a.f, b.f, {class: flow, weight: 4}]'].join('\n');
    const model = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))))),
      { createAttempt: createAvoidAttempt }));
    // The canonical order (DR-04) lists the authored third link, the flow overlay, first.
    for (const link of model.links.slice(1, 3)) {
      expect([link.id, link.strokeWidth, link.path!.strokeWidth]).toEqual([link.id, 3, 3]);
    }
    const overlay = model.links[0]!;
    expect([overlay.layer, overlay.strokeWidth, overlay.path!.strokeWidth]).toEqual(['overlay', 6, 6]);
    // The trunk one bundle paints for both merged members carries their resolved width too.
    const runs = model.bundles.flatMap(bundle => bundle.mergeRuns ?? []);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect([run.id, run.path.strokeWidth]).toEqual([run.id, 3]);
    for (const gate of Object.values(score(model).snapshot.gates)) expect(gate.violations).toEqual([]);
    // The rendered trunk and the legend samples use the same numbers.
    const svg = render(model);
    expect(svg).toContain('.pg-w-3{stroke-width:3px!important}');
    expect(svg).toContain('.pg-w-6{stroke-width:6px!important}');
    for (const run of runs) {
      const block = svg.slice(svg.indexOf(`data-id="${run.id}"`));
      expect(block.slice(0, block.indexOf('/>'))).toContain('pg-w-3');
    }
  }, 60000);

  it('rejects a path width that contradicts the resolved link width, on restore', async () => {
    const yaml = ['portograph: 2', 'groups: {top: {tier: 0}, low: {tier: 1}}',
      'nodes:', '  a: {group: top, class: router, ports: [{name: p, side: bottom}]}',
      '  b: {group: low, class: router, ports: [{name: p, side: top}]}',
      'links: [[a.p, b.p, {weight: 2}]]'].join('\n');
    const model = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))))),
      { createAttempt: createAvoidAttempt }));
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
    const tamper = (edit: (value: LayoutModel) => void): void => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      edit(copy);
      expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow();
    };
    // The effective width is what placement reserved and the gates measured; a path may restate it
    // but never contradict it, in either direction.
    tamper(copy => { copy.links[0]!.path!.strokeWidth = 0; });
    tamper(copy => { copy.links[0]!.path!.strokeWidth = 30; });
    tamper(copy => { delete copy.links[0]!.path!.strokeWidth; });
    tamper(copy => { copy.links[0]!.strokeWidth = 9; });
    // The path guard itself, isolated from every other validator: each forged width has to be
    // rejected by this check alone, and the expectation may not be read back off the path.
    const rejects = (width: number | undefined): string => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
      if (width === undefined) delete copy.links[0]!.path!.strokeWidth;
      else copy.links[0]!.path!.strokeWidth = width;
      try { validateRoutedPaths(copy, true); return 'accepted'; } catch (error) { return String(error); }
    };
    for (const width of [0, 0.1, 3.0001, 30, undefined]) {
      expect([width, rejects(width)]).toEqual([width, expect.stringContaining('Path width')]);
    }
    expect(() => validateRoutedPaths(model, true)).not.toThrow();
  }, 60000);

  it('keeps every approved golden width implicit, because no golden link is weighted', async () => {
    const model = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(goldenYaml)))))))),
      { createAttempt: createAvoidAttempt }));
    expect(model.document.links.every(link => link.weight === undefined)).toBe(true);
    for (const link of model.links) {
      expect([link.id, link.strokeWidth, link.path!.strokeWidth]).toEqual([link.id, undefined, undefined]);
      expect(linkStrokeWidth(link)).toBe(DEFAULT_STROKE_WIDTHS.path);
    }
    expect(routedStrokeWidth(model)).toBe(DEFAULT_STROKE_WIDTHS.path);
  }, 60000);
});

describe('bar drops stagger on their own width', () => {
  it('keeps two weighted drops the visible clearance apart', async () => {
    const yaml = ['portograph: 2', 'groups: {top: {tier: 0}, low: {tier: 1, shape: bar}}',
      'nodes:',
      '  a: {group: top, class: router, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}',
      '  bar: {group: low, class: router, ports: [{name: p, side: top}, {name: q, side: top}]}',
      'links:',
      '  - [a.p, bar.p, {weight: 2}]',
      '  - [a.q, bar.q, {weight: 2}]'].join('\n');
    const model = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(yaml)))))))),
      { createAttempt: createAvoidAttempt }));
    for (const link of model.links) expect(link.path!.strokeWidth).toBe(3);
    // The staggered stems run parallel, so the pitch has to carry their real 3 px strokes; at the
    // theme default they would have been reserved 1.5 px apart too little and G6 would report it.
    for (const gate of Object.values(score(model).snapshot.gates)) expect(gate.violations).toEqual([]);
  }, 60000);
});

describe('two facing pills keep a visible wire', () => {
  it('reserves the measured pill extents plus the wire gap', async () => {
    const model = sizeNodes(sidesOne(resolve(parse(['portograph: 2', 'groups: {g: {tier: 0}}',
      'nodes:', '  a: {group: g, ports: [{name: "100G", side: right}]}',
      '  b: {group: g, ports: [{name: "100G", side: left}]}',
      'links: [[a.100G, b.100G]]'].join('\n')))));
    const protrusion = measurePortPill('100G').width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2;
    expect(rowGap(model, 'a', 'b')).toBe(2 * protrusion + PILL_WIRE_GAP);
    // Two bare sides keep the ordinary stroke-aware node clearance instead.
    const bare = sizeNodes(sidesOne(resolve(parse(['portograph: 2', 'groups: {g: {tier: 0}}',
      'nodes: {a: {group: g}, b: {group: g}}', 'links: []'].join('\n')))));
    expect(rowGap(bare, 'a', 'b')).toBe(20 + DEFAULT_STROKE_WIDTHS.node);
    // One long pill facing a bare side has nothing to be separated from, so it gets no wire gap.
    const oneSided = sizeNodes(sidesOne(resolve(parse(['portograph: 2', 'groups: {g: {tier: 0}}',
      'nodes:', '  a: {group: g, ports: [{name: VeryLongPortName, side: right}]}',
      '  b: {group: g}', 'links: []'].join('\n')))));
    const long = measurePortPill('VeryLongPortName').width / 2 + DEFAULT_STROKE_WIDTHS.pill / 2;
    expect(rowGap(oneSided, 'a', 'b')).toBe(Math.max(20 + DEFAULT_STROKE_WIDTHS.node, long));
  });

  it('leaves a drawn wire between the golden EBR pair', async () => {
    const model = linkLabels(await route(bands(bundles(bars(centre(flanks(lanes(rows(await placed(goldenYaml)))))))),
      { createAttempt: createAvoidAttempt }));
    const left = model.nodes['EBR-01']!, right = model.nodes['EBR-02']!;
    const leftPill = left.ports.find(port => port.side === 'right')!.pill!.bounds;
    const rightPill = right.ports.find(port => port.side === 'left')!.pill!.bounds;
    const visible = rightPill.x - (leftPill.x + leftPill.width);
    expect(visible).toBeGreaterThanOrEqual(PILL_WIRE_GAP - DEFAULT_STROKE_WIDTHS.pill - 1e-9);
    expect(visible).toBeGreaterThan(1);
    // The link really crosses that gap, so the wire is drawn rather than hidden under the pills.
    // DR-04: EBR-01:100G to EBR-02:100G (main's link-3) is link-7 in the canonical link order.
    const link = model.links.find(item => item.id === 'link-7')!;
    const segment = link.path!.segments[0]!;
    expect(Math.min(segment.from.x, segment.to.x)).toBeLessThanOrEqual(leftPill.x + leftPill.width);
    expect(Math.max(segment.from.x, segment.to.x)).toBeGreaterThanOrEqual(rightPill.x);
  }, 60000);
});
