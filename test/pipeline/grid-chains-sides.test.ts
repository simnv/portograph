import { describe, expect, it } from 'vitest';
import { parse } from '../../src/index.js';
import { resolve } from '../../src/internal.js';
import { chainSides, stackChains } from '../../src/layout/grid-chains.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';

// Architecture ticket 23, phases 2 and 3: the stage-2 sides and the stage-3 floors of a chain, read where the group stands as a grid.

const yaml = `
portograph: 2
profile: network
groups:
  top: { tier: 0 }
  farm: { tier: 1, shape: grid }
nodes:
  core: { group: top }
  s1: { group: farm }
  s2: { group: farm, label: A much longer label than the others }
  s3: { group: farm }
links:
  - [core, s1]
  - [s2, s3]
  - [s2, s3]
`;

describe('chain sides and sizes (stage 2 and stage 3)', () => {
  const model = () => resolve(parse(yaml));

  it('chainSides gives bottom to the upper end and top to the lower end', () => {
    const found = model();
    const stack = stackChains(found, 'farm');
    expect('chains' in stack).toBe(true);
    const sides = chainSides(found, 'chains' in stack ? stack.chains : []);
    expect(sides.map(item => [item.ref.node, item.side]).sort()).toEqual([['s2', 'bottom'], ['s2', 'bottom'], ['s3', 'top'], ['s3', 'top']]);
  });

  it('stage 2 fixes the member ports, and the other ports follow the tiers', () => {
    const found = sidesOne(model());
    const sides = (id: string) => found.nodes[id]!.ports.map(port => port.side);
    expect(sides('s2')).toEqual(['bottom', 'bottom']);
    expect(sides('s3')).toEqual(['top', 'top']);
    expect(sides('s1')).toEqual(['top']);
  });

  it('stage 3 gives the chain nodes the widest chain width as a floor', () => {
    const found = sizeNodes(sidesOne(model()));
    const s2 = found.nodes.s2!, s3 = found.nodes.s3!, s1 = found.nodes.s1!;
    expect(s2.size!.width).toBeGreaterThan(s1.size!.width);
    expect(s3.size!.width).toBe(s2.size!.width);
    expect(s3.sizeFloor!.width).toBe(s2.size!.width);
  });
});
