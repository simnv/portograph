import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import { layout, parse } from '../../src/index.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { findPort } from '../../src/layout/row-paths.js';

/**
 * Architecture 2, ticket 80: a routed link and an overlay link between two nodes that leave facing faces keep one side order at both ends, whatever their authored
 * direction. The fixtures are a pair: the cable and the overlay are written in opposite directions, and the same sheet with both directions reversed. Neither crosses.
 * Held: both ends agree, and the order does not follow the document order of the nodes (R3: the lead end of a set is chosen by content, `visitOrder`).
 * Not held, and not tested: which of the two links stands first follows the stage-4 draft as the lead end reads it, so it can differ with the authored direction of the links;
 * two overlay links between one pair are not a set (`an-overlay-frame-reorder-is-refused-with-six-sync-links` still crosses); reversing `links` lets ELK mirror
 * the other nodes (c1 and c2 swap), so only the pair of the set is compared in that run. The lateral fixture is not reversed by nodes: the order of two nodes in a row is the document's.
 */
const read = (name: string): string => readFileSync(new URL(`../../goldens/${name}.yaml`, import.meta.url), 'utf8');
const run = async (text: string) => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
type Model = Awaited<ReturnType<typeof run>>;
const FIRST = 'synthetic/a-cable-and-an-overlay-between-two-nodes-keep-one-side-order';
const SECOND = `${FIRST}-written-the-other-way`;
const LATERAL = 'synthetic/a-cable-and-an-overlay-between-two-neighbours-keep-one-side-order';
const BGPLAB = 'bgplab/challenge-04-block-fat-fingers';
/** The links of the pair `[a, b]` in engine order along the face of `node` that they leave, by their class and label. */
const faceOrder = (model: Model, pair: [string, string], node: string): string[] => {
  const mine = model.links.filter(link => [link.attachments!.from.node, link.attachments!.to.node].sort().join() === [...pair].sort().join()).map(link => {
    const end = link.attachments!.from.node === node ? link.attachments!.from : link.attachments!.to;
    const port = findPort(model, end)!, source = model.document.links[link.sourceIndex]!;
    return { name: `${source.class ?? 'default'}`, side: port.side, order: port.engineOrder! };
  });
  expect(mine).toHaveLength(2);
  expect(new Set(mine.map(item => item.side)).size).toBe(1);
  return mine.sort((a, b) => a.order - b.order).map(item => item.name);
};
const round = (n: number): number => Math.round(n * 100) / 100;
/** The geometry of a layout without runtime or document order: the node boxes, the canvas and every link by its ends, its class and label, its port sides, slots, orders and path. */
const projection = (model: Model, only?: [string, string]) => {
  const links: [string, unknown][] = [];
  for (const link of model.links) {
    const { from, to } = link.attachments!, source = model.document.links[link.sourceIndex]!, nodes = [from.node, to.node].sort();
    if (only !== undefined && nodes.join() !== [...only].sort().join()) continue;
    const end = (ref: typeof from) => { const port = findPort(model, ref)!; return [ref.node, port.side, round(port.anchor!.x), round(port.anchor!.y), port.engineOrder]; };
    const points = (link.path?.segments ?? []).map(segment => [round(segment.from.x), round(segment.from.y)]);
    if (from.node > to.node) points.reverse();
    links.push([JSON.stringify([nodes, source.class ?? '', source.label ?? '']), { ends: [end(from), end(to)].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)), points }]);
  }
  const boxes = Object.entries(model.nodes).filter(([id]) => only === undefined || only.includes(id))
    .map(([id, node]) => [id, round(node.bounds!.x), round(node.bounds!.y), round(node.bounds!.width), round(node.bounds!.height)]);
  return JSON.stringify({ boxes: boxes.sort(), links: links.sort((a, b) => (a[0] < b[0] ? -1 : 1)), canvas: only === undefined ? model.canvas : null });
};

it.each([FIRST, SECOND])('%s: the cable and the overlay keep one side order at both ends', async name => {
  const model = await run(read(name));
  expect(faceOrder(model, ['rtr', 'peer'], 'rtr')).toEqual(faceOrder(model, ['rtr', 'peer'], 'peer'));
}, 60000);

it('a cable and an overlay between two neighbours keep one side order on the lateral faces', async () => {
  const model = await run(read(LATERAL));
  expect(model.nodes.a!.ports.find(port => port.side === 'right')).toBeDefined();
  expect(faceOrder(model, ['a', 'b'], 'a')).toEqual(faceOrder(model, ['a', 'b'], 'b'));
}, 60000);

it.each([[FIRST, ['rtr', 'peer']], [SECOND, ['rtr', 'peer']], [BGPLAB, ['rtr', 'peer']]] as const)(
  '%s: reversing nodes leaves the layout the same, and reversing links leaves the pair the same', async (name, pair) => {
    const document = parseYaml(read(name)) as { nodes: Record<string, unknown>; links: unknown[] };
    const base = await run(read(name));
    const nodes = await run(stringify({ ...document, nodes: Object.fromEntries(Object.entries(document.nodes).reverse()) }));
    const links = await run(stringify({ ...document, links: [...document.links].reverse() }));
    expect(projection(nodes)).toEqual(projection(base));
    expect(projection(links, [pair[0], pair[1]])).toEqual(projection(base, [pair[0], pair[1]]));
  }, 120000);
