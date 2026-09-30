import { expect, it } from 'vitest';
import { portId } from '../../src/layout/skeleton-graph.js';
it('portId equals the JSON of its tuple', () => {
  const nodes = ['a', 'n"x', 'é', 'a\\b', 'tab\t', ' ', '\ud800', '', 'node:1 ~', '~', '!', '#', '[', ']', '\u007f'];
  for (const node of nodes) for (const anonymous of [true, false, undefined]) for (const name of [undefined, null, ...nodes]) for (const ordinal of [0, -0, 1, 1.5, -2, 1e21, NaN, Infinity, undefined as unknown as number])
    expect(portId({ node, anonymous, name, ordinal } as never)).toBe(`port:${JSON.stringify([node, anonymous === true, name ?? null, ordinal])}`);
});
