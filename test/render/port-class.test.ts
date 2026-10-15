import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics, render } from '../../src/index.js';
import { LEGEND_GEOMETRY, produceLegend } from '../../src/internal.js';
import { pillLabel, scene } from './fixture.js';

function elements(svg: string, name: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  for (const match of svg.matchAll(new RegExp(`<${name}\\b([^>]*?)/?>`, 'g'))) {
    const attributes: Record<string, string> = {};
    for (const pair of match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[pair[1]!] = pair[2]!;
    found.push(attributes);
  }
  return found;
}

const model = () => scene({
  nodes: [{ id: 'a', class: 'router', bounds: { x: 0, y: 0, width: 120, height: 40 } }],
  ports: [
    { node: 'a', name: 'p', side: 'bottom', anchor: { x: 20, y: 40 }, class: 'uplink up' },
    { node: 'a', name: 'q', side: 'bottom', anchor: { x: 60, y: 40 }, class: 'mgmt unused' },
    { node: 'a', name: 'r', side: 'bottom', anchor: { x: 100, y: 40 } }],
  labels: ['p', 'q', 'r'].map((name, index) => pillLabel('a', name, 1, { x: 15 + index * 40, y: 30, width: 10, height: 20 }, -90)),
});

describe('port.class on the drawn port', () => {
  it('appends the port tokens after the node class on the pill, its label and the port group', () => {
    const svg = render(model());
    const ports = elements(svg, 'g').filter(item => item['class']?.split(' ').includes('port'));
    expect(ports.map(item => [item['data-id'], item['class']])).toEqual([
      ['a.p#1', 'port router uplink up'], ['a.q#1', 'port router mgmt unused'], ['a.r#1', 'port router']]);
    const pills = elements(svg, 'rect').filter(item => item['class']?.startsWith('pill'));
    expect(pills.map(item => item['class']!.replace(/ pg-w-[^ ]+/, ''))).toEqual([
      'pill router uplink up', 'pill router mgmt unused', 'pill router']);
    const labels = elements(svg, 'text').filter(item => item['class']?.includes('pill-label'));
    expect(labels.map(item => item['class']!.replace(/ pg-f-[^ ]+/, ''))).toEqual([
      'pill-label router uplink up', 'pill-label router mgmt unused', 'pill-label router']);
  });

  it('strips reserved tokens from a port class like from any author class', () => {
    const item = model();
    item.nodes['a']!.ports[0]!.class = 'pg-mask-hide uplink';
    const svg = render(item);
    expect(svg).not.toContain('pg-mask-hide uplink');
    expect(elements(svg, 'rect').filter(rect => rect['class']?.startsWith('pill'))[0]!['class']).toContain('pill router uplink');
  });

  it('is reachable from a document css rule, after the theme', () => {
    const parsed = parseWithDiagnostics(['portograph: 2', 'css: |', '  .pill.mgmt { fill: #123456; }', 'groups: { g: { tier: 0 } }',
      'nodes: { a: { group: g, ports: [{ name: p, class: mgmt }] } }'].join('\n'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const item = model();
    if (parsed.document.css !== undefined) item.document.css = parsed.document.css;
    const svg = render(item);
    const style = svg.slice(svg.indexOf('<style'), svg.indexOf('</style>'));
    expect(style.lastIndexOf('.pill.mgmt { fill: #123456; }')).toBeGreaterThan(style.lastIndexOf('.pill.mgmt{'));
  });
});

describe('port roles in the drawn legend', () => {
  it('draws a role entry as a pill rectangle with the role class, at the swatch size and the pill radius', () => {
    const item = model();
    produceLegend(item);
    const svg = render(item);
    const entries = elements(svg, 'g').filter(element => element['class']?.startsWith('legend-entry'));
    expect(entries.map(element => [element['data-id'], element['class']])).toEqual([
      ['symbol:router', 'legend-entry legend-symbol router'],
      ['port:uplink', 'legend-entry legend-port uplink'], ['port:mgmt', 'legend-entry legend-port mgmt']]);
    const legend = svg.slice(svg.indexOf('<g class="legend"'));
    const swatches = elements(legend, 'rect').filter(rect => rect['class']?.startsWith('pill'));
    // The accepted pill radius (ticket 34): the swatch is drawn like every pill.
    expect(LEGEND_GEOMETRY.portRadius).toBe(2);
    expect(swatches.map(rect => [rect['class']!.replace(/ pg-w-[^ ]+/, ''), Number(rect['width']), Number(rect['height']), Number(rect['rx'])]))
      .toEqual([['pill uplink', LEGEND_GEOMETRY.portWidth, LEGEND_GEOMETRY.portHeight, LEGEND_GEOMETRY.portRadius],
        ['pill mgmt', LEGEND_GEOMETRY.portWidth, LEGEND_GEOMETRY.portHeight, LEGEND_GEOMETRY.portRadius]]);
    for (const entry of item.legend!.entries.filter(entry => entry.kind === 'port')) {
      const drawn = swatches.find(rect => rect['class']!.includes(entry.key))!;
      expect([Number(drawn['x']), Number(drawn['y'])]).toEqual([entry.swatch.x, entry.swatch.y]);
    }
  });
});
