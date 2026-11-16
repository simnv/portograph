import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutLink, LayoutModel, PathSegment } from '../../src/index.js';
import { judgeTrial } from '../../src/layout/side-judge.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Dense-16x9 review 06c-1, finding 1 (second half): the side round's judge refuses a trial whose routed result adds a finding of an error gate that the routed
 * baseline lacks. A preference step never buys a bend with a gate failure; the judge reads the scorer's own gates, no clearance rule of its own. On the
 * outside sheet the old judge kept a trial with two fewer bent links that added three G6 findings next to two hinted chords.
 */
const text = readFileSync(new URL('../../goldens/synthetic/two-sibling-frames-mirror-a-linked-pair.yaml', import.meta.url), 'utf8');
const options = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
const between = (model: LayoutModel, a: string, b: string): LayoutLink =>
  model.links.find(link => link.attachments !== undefined && [link.attachments.from.node, link.attachments.to.node].sort().join() === [a, b].sort().join())!;
const g6 = (model: LayoutModel): number => score(model).snapshot.gates.G6.violations.length;

describe('the side judge reads the error gates of the routed trial', () => {
  it('refuses a trial that gains a straight link but adds a G6 finding; the same gain without the finding is kept', async () => {
    const clean = await layout(parse(text), options);
    expect(g6(clean)).toBe(0);
    // The baseline: the feed of w1 takes a jog (two bends), all else as published.
    const hinted = between(clean, 'wt', 'w1'), base = structuredClone(clean) as LayoutModel;
    const seg = between(base, 'wt', 'w1').path!.segments[0]!, ym = (seg.from.y + seg.to.y) / 2;
    const jog = (from: PathSegment['from'], to: PathSegment['to']): PathSegment => ({ owner: seg.owner, from, to });
    const jogged = between(base, 'wt', 'w1');
    jogged.path = { ...jogged.path!, fixed: false,
      segments: [jog(seg.from, { x: seg.from.x, y: ym }), jog({ x: seg.from.x, y: ym }, { x: seg.from.x + 40, y: ym }), jog({ x: seg.from.x + 40, y: ym }, { x: seg.to.x + 40, y: seg.to.y }), jog({ x: seg.to.x + 40, y: seg.to.y }, seg.to)] };
    const input = (routedTrial: LayoutModel) => ({ routedBase: base, routedTrial, kept7e: clean, trial7e: clean, hinted: new Map([[hinted.id, 0]]) });
    // The trial as published: the hinted link is straight again, fewer bent links, no gate finding the baseline lacks.
    expect(judgeTrial(input(clean))).toMatchObject({ kept: true });
    // The same gain, with the feed of w2 moved to run 4 px beside the straight feed of w1: G6 names the pair, and the trial is refused for it.
    const crowded = structuredClone(clean) as LayoutModel;
    const one = between(crowded, 'wt', 'w1').path!.segments[0]!, other = between(crowded, 'wt', 'w2');
    other.path = { ...other.path!, segments: [{ ...other.path!.segments[0]!, from: { x: one.from.x + 4, y: one.from.y }, to: { x: one.to.x + 4, y: one.to.y } }] };
    expect(g6(crowded)).toBeGreaterThan(0);
    const verdict = judgeTrial(input(crowded));
    expect(verdict.kept).toBe(false);
    expect(verdict.reason).toMatch(/error-gate findings the baseline does not have \(.*G6\|parallel-clearance/);
  }, 60000);
});
