// Dense-16x9 ticket 31, review 1: the reviewer's two states, through API that exists at f7832a53 and at the fix (thin adapters).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import * as checks from '../../src/layout/block-checks.js';
import * as decide from '../../src/layout/decide.js';
import { judgedMove } from '../../src/layout/post-freeze-judge.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const yaml = readFileSync(new URL('../../goldens/synthetic/a-centring-step-after-the-freeze-keeps-a-solid-block-on-its-angle.yaml', import.meta.url), 'utf8');
const run = (): Promise<LayoutModel> => layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const shift = (model: LayoutModel, id: string, dx: number): void => {
  const node = model.nodes[id]!;
  node.bounds = { ...node.bounds!, x: node.bounds!.x + dx };
  for (const port of node.ports) if (port.anchor) port.anchor = { ...port.anchor, x: port.anchor.x + dx };
};
/** Adapter: the restore of the chord step's own state where the build has one; f7832a53 restores nothing. */
const saveChordState = (decide as Record<string, unknown>).saveChordState as ((model: LayoutModel, history: Set<string>) => () => void) | undefined
  ?? (() => () => undefined);

describe('review 1 of ticket 31: the reviewer states', () => {
  it('P2(1): a member already off its angle may not be taken further off, nor broken another way', async () => {
    const model = await run();
    const link = model.links.find(item => item.id === 'link-11')!, end = link.attachments!.to;
    let broken: LayoutModel | undefined;
    for (let dx = 1; dx < 300 && broken === undefined; dx++) {
      const state = structuredClone(model);
      shift(state, end.node, dx);
      if (checks.blockReservationsFault(state)?.includes('link-11 lost its reserved angle')) broken = state;
    }
    expect(broken).toBeDefined();
    const worse = structuredClone(broken!);
    shift(worse, end.node, 1);
    expect(checks.blockMoveRefusal(broken!, worse), 'one px further off the angle').toBeDefined();
    const turned = structuredClone(broken!);
    turned.nodes[end.node]!.ports.find(port => port.ref.name === end.name)!.side = 'left';
    expect(checks.blockMoveRefusal(broken!, turned), 'the faces broken too').toBeDefined();
  }, 180000);

  it('P2(2): a refused chord-step round gives back its movers and its growth', async () => {
    const model = structuredClone(await run());
    const mover = model.links.find(item => item.id === 'link-11')!.attachments!.to.node;
    const history = new Set<string>();
    decide.edge(model).grown = 0;
    const value = judgedMove(model, 'step out of chords', () => {
      history.add(`node:${mover}`); decide.edge(model).grown += 40; shift(model, mover, 2000);
      return true;
    }, false, saveChordState(model, history));
    expect(value).toBe(false);
    expect({ grown: decide.edge(model).grown, history: [...history] }).toEqual({ grown: 0, history: [] });
  }, 180000);
});
