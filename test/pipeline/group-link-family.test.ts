import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, render } from '../../src/index.js';
import { resolve } from '../../src/internal.js';
import type { LayoutModel } from '../../src/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

const doc = fixture('a-group-link-keeps-its-family');

/**
 * Stress ticket 23. `recordAggregations` used to set `layer: 'routed'` on every member of a
 * group-link, so the complete bipartite flow-class set the overlay family exists for was the one
 * set that never reached the overlay layer. Aggregation says how many lines stand for a set; the
 * class still says on which layer they are drawn.
 */
describe('a group-link is drawn on its members\' own family layer', () => {
  it('keeps a complete flow-class set overlay, in the model and in the SVG', async () => {
    const model = await run(doc);
    expect(model.groupLinks).toHaveLength(1);
    const record = model.groupLinks[0]!;
    expect(record).toMatchObject({ groups: ['north', 'south'], layer: 'overlay' });
    expect(record.members).toHaveLength(4);

    const members = model.links.filter(link => link.groupLink === record.id);
    expect(members.map(link => link.id)).toEqual(record.members);
    for (const link of members) {
      expect([link.id, link.family, link.layer, link.technique]).toEqual([link.id, 'overlay', 'overlay', 'overlay']);
    }
    // The routed contrast is the only link the router was given, so the sheet still has both layers.
    const routed = model.links.filter(link => link.layer === 'routed');
    expect(routed.map(link => link.id)).toEqual(['link-5']);

    // What the reader sees: four thin translucent lines under the routed layer, not four orthogonal
    // routed ones. The SVG's overlay layer holds exactly the group-link's members.
    const svg = render(model);
    const overlay = svg.slice(svg.indexOf('class="overlay-links"'), svg.indexOf('class="links"'));
    expect([...overlay.matchAll(/<path class="link-line overlay-line/g)]).toHaveLength(4);
    const routedLayer = svg.slice(svg.indexOf('class="links"'));
    expect([...routedLayer.matchAll(/<path class="link-line /g)]).toHaveLength(1);
  }, 60000);

  it('records the membership a group-link stands for on every overlay member', async () => {
    const model = await run(doc);
    const svg = render(model);
    // The M1 fallback draws the members and keeps the count as a tooltip; that survives the layer.
    expect([...svg.matchAll(/north – south: 4 links/g)]).toHaveLength(4);
  }, 60000);

  it('lets an authored route decide the layer above aggregation, as Q30 orders them', () => {
    // `route: group-link` names an aggregation, not a layer: the class's family still decides.
    const aggregated = resolve(parse(doc.replace('  - [alpha, charlie, { class: sync }]\n'
      + '  - [alpha, delta, { class: sync }]\n  - [bravo, charlie, { class: sync }]\n'
      + '  - [bravo, delta, { class: sync }]', '  - [north, south, { class: sync, route: group-link }]')));
    expect(aggregated.groupLinks).toHaveLength(1);
    expect(aggregated.groupLinks[0]?.layer).toBe('overlay');
    expect(aggregated.links.filter(link => link.groupLink !== undefined)
      .every(link => link.layer === 'overlay' && link.technique === 'overlay')).toBe(true);

    // An authored `route:` on one member refuses the aggregation outright, so the override wins.
    const overridden = resolve(parse(doc.replace('  - [bravo, delta, { class: sync }]',
      '  - [bravo, delta, { class: sync, route: orthogonal }]')));
    expect(overridden.groupLinks).toEqual([]);
    expect(overridden.links.find(link => link.sourceIndex === 3)).toMatchObject({ family: 'overlay', layer: 'routed', technique: 'orthogonal' });
  });
});
