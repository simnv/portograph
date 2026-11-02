import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { pathBends } from '../../src/layout/objective.js';
import { createColdAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 14, "bends first": a node grows only as far as the links it keeps straight need. A feed whose alignment the row
 * declines pulls no move and grows no body; a width that keeps every link straight stays.
 *
 * The ticket is open. The wanted assertions are `it.fails` until the rule lands: drop the `.fails` then. The guards of what must not change
 * (a width that keeps links straight; a body the passes stretch past its sibling) are plain tests.
 */
const text = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (yaml: string): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createColdAttempt, createRouteAttempt: createAvoidAttempt });
const linkTo = (model: LayoutModel, node: string, port: string) =>
  model.links.find(link => [link.attachments!.from, link.attachments!.to].some(end => end.node === node && end.name === port))!;
/** The width four top ports need at their pitch: the body grows past it only for an alignment. */
const ownWidth = (model: LayoutModel, node: string): number => {
  const item = model.nodes[node]!, pitch = item.sidePitch!.top!;
  return 20 + pitch * item.ports.filter(port => port.side === 'top').length;
};
/** The same sheet with its links, and when `nodes` its nodes too, declared in the reverse order. The node order is the row order the author wrote. */
function reversed(yaml: string, nodes = false): string {
  const lines = yaml.split('\n'), at = lines.indexOf('nodes:'), links = lines.indexOf('links:');
  const body = (from: number, to: number, flip: boolean) => { const kept = lines.slice(from, to).filter(line => line.trim() !== ''); return flip ? kept.reverse() : kept; };
  return [...lines.slice(0, at + 1), ...body(at + 1, links, nodes), 'links:', ...body(links + 1, lines.length, true), ''].join('\n');
}

describe('a declined feed grows no body', () => {
  for (const name of ['a-declined-feed-grows-no-body', 'a-declined-feed-grows-no-body-mirrored', 'a-declined-feed-grows-no-body-interior']) {
    it.fails(`${name}: the three kept links stand straight and n1 keeps the width its ports need`, async () => {
      const model = await run(text(name));
      for (const port of ['a1', 'a2', 'a3']) expect(pathBends(linkTo(model, 'n1', port))).toBe(0);
      expect(model.nodes['n1']!.bounds!.width).toBeLessThanOrEqual(ownWidth(model, 'n1') + 0.5);
      const declined = linkTo(model, 'n1', 'b').id;
      expect(model.diagnostics.some(d => d.code === 'CENTRE_ALIGNMENT_INFEASIBLE' && d.owners?.some(owner => 'id' in owner && owner.id === declined))).toBe(true);
      expect(model.diagnostics.some(d => d.code === 'PLACEMENT_NON_CONVERGENCE')).toBe(false);
    });
  }

  it('lays the sheet out the same with its links declared in reverse', async () => {
    const [ahead, back] = await Promise.all([run(text('a-declined-feed-grows-no-body')), run(reversed(text('a-declined-feed-grows-no-body')))]);
    for (const id of Object.keys(ahead.nodes)) expect(back.nodes[id]!.bounds).toEqual(ahead.nodes[id]!.bounds);
  });

  it.fails('with its nodes declared in reverse (the rows mirror), n1 still keeps the width its ports need', async () => {
    const model = await run(reversed(text('a-declined-feed-grows-no-body'), true));
    for (const port of ['a1', 'a2', 'a3']) expect(pathBends(linkTo(model, 'n1', port))).toBe(0);
    expect(model.nodes['n1']!.bounds!.width).toBeLessThanOrEqual(ownWidth(model, 'n1') + 0.5);
  });

  it.fails('a shared parent port: a1 stands under it and the declined feed grows no body', async () => {
    const model = await run(text('a-declined-feed-beside-a-shared-port-grows-no-body'));
    const a1 = model.nodes['n1']!.ports.find(port => port.ref.name === 'a1')!, feed = model.nodes['rA']!.ports.find(port => port.ref.name === 'p')!;
    expect(a1.anchor!.x).toBeCloseTo(feed.anchor!.x, 6);
    expect(model.nodes['n1']!.bounds!.width).toBeLessThanOrEqual(ownWidth(model, 'n1') + 0.5);
  });
});

describe('a width that keeps links straight stays', () => {
  it('a body the passes stretch past its sibling keeps its four links straight', async () => {
    // The bound on the rule: here the declined a-ports pull the move, and that pull is what stretches n1 past s1 to rA.
    const model = await run(text('a-row-stretches-a-body-past-its-sibling'));
    for (const port of ['a1', 'a2', 'a3', 'b']) expect(pathBends(linkTo(model, 'n1', port))).toBe(0);
  });

  it('n1 spans both peers and all four links stand straight', async () => {
    const model = await run(text('a-node-spans-both-peers-to-keep-its-links-straight'));
    const links = model.links.filter(link => link.layer === 'routed');
    expect(links).toHaveLength(4);
    for (const link of links) expect(pathBends(link)).toBe(0);
    const ports = model.nodes['n1']!.ports.map(port => port.anchor!.x);
    expect(model.nodes['n1']!.bounds!.width).toBeGreaterThan(Math.max(...ports) - Math.min(...ports));
  });
});
