import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutLink, LayoutModel } from '../../src/index.js';
import { CommandDeadlineError, ElkDeadlineError, layout, parse } from '../../src/index.js';
import type { SideOffer } from '../../src/layout/side-measure.js';
import { holdColumnAxes, holdMemberWalls, packBesideRows } from '../../src/layout/columns.js';
import { judgeTrial, predictedWorse, predictPublished, trialNotes } from '../../src/layout/side-judge.js';
import { RouteDeadlineError } from '../../src/index.js';
import { portKey } from '../../src/layout/sides-one.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Ticket 133 (docs/design/side-faces.md, Section 19, Q109a): the side round reads the baseline (7f of the kept model) and judges a trial on its
 * routed result. `measureSides` is scripted where a test needs an offer the real measure never makes; `route` is wrapped so a test can give the
 * trial's route the result that a moved body would give (the real 7f never makes these on the small fixtures).
 */
type Script = ((call: number, real: () => SideOffer) => SideOffer) | undefined;
interface State { script: Script; calls: number; tamper: ((routed: LayoutModel, call: number) => LayoutModel) | undefined; routes: number; measured: { base: LayoutModel; kept7e: LayoutModel }[] }
const state: State = { script: undefined, calls: 0, tamper: undefined, routes: 0, measured: [] };
vi.mock('../../src/layout/side-measure.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/layout/side-measure.js')>();
  return { ...real, measureSides: (...args: Parameters<typeof real.measureSides>): SideOffer => {
    const call = ++state.calls;
    state.measured.push({ base: args[0], kept7e: args[1] });
    return state.script ? state.script(call, () => real.measureSides(...args)) : real.measureSides(...args);
  } };
});
vi.mock('../../src/route/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/route/index.js')>();
  return { ...real, route: async (...args: Parameters<typeof real.route>): Promise<LayoutModel> => {
    const call = ++state.routes, routed = await real.route(...args);
    return state.tamper ? state.tamper(routed, call) : routed;
  } };
});

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const PAST_SIBLING = 'an-overlay-leaves-a-lateral-side-past-a-sibling-body';
const SLACK = 'an-overlay-that-7f-straightens-needs-more-than-four-pixels-of-slack';
interface Counted { model: LayoutModel; places: number; labels: string[] }
async function run(name: string, extra: Partial<Parameters<typeof layout>[1]> = {}, script?: Script, tamper?: State['tamper']): Promise<Counted> {
  state.script = script; state.calls = 0; state.tamper = tamper; state.routes = 0; state.measured = [];
  let places = 0;
  const labels: string[] = [];
  const model = await layout(parse(fixture(name)), { createElkAttempt: () => { places++; return createAttempt(); }, createRouteAttempt: createAvoidAttempt,
    testTiming: label => { labels.push(label); }, ...extra });
  return { model, places, labels };
}
const codes = (model: LayoutModel): string[] => model.diagnostics.map(item => item.code);
const withoutNotes = (model: LayoutModel): string => JSON.stringify({ ...model, diagnostics: model.diagnostics.filter(item => !item.code.startsWith('SIDE_')) },
  (key, value: unknown) => key === 'runtime' ? undefined : value);
const overlayOf = (model: LayoutModel): LayoutLink => model.links.find(item => item.layer === 'overlay')!;
/** The link's path with `bends` bends between its two ends: a zigzag (what a body moved onto the segment would leave). */
const bendTo = (routed: LayoutModel, id: string, bends: number): LayoutModel => ({ ...routed, links: routed.links.map(link => {
  if (link.id !== id) return link;
  const from = link.path!.segments[0]!.from, to = link.path!.segments.at(-1)!.to;
  const points = [from];
  for (let i = 0; i < bends; i++) points.push(i % 2 === 0 ? { x: from.x + 30 * (i + 1), y: from.y + (to.y - from.y) * (i + 1) / (bends + 1) } : { x: from.x, y: from.y + (to.y - from.y) * (i + 1) / (bends + 1) });
  points.push(to);
  return { ...link, path: { ...link.path!, segments: points.slice(1).map((point, index) => ({ from: points[index]!, to: point, owner: link.owner })) } };
}) });
const removeLink = (routed: LayoutModel, id: string): LayoutModel => ({ ...routed, links: routed.links.map(link => {
  if (link.id !== id) return link;
  const rest = { ...link };
  delete rest.path;
  return { ...rest, removed: true as const };
}) });
const routedNeighbour = (model: LayoutModel): string => model.links.find(item => item.layer !== 'overlay')!.id;

describe('the side round reads the baseline (Section 19.2)', () => {
  it('a link that publishes straight on the baseline is no candidate, though it needs 8 px of slack at 7e: no trial runs', async () => {
    const { model, places, labels } = await run(SLACK);
    expect(overlayOf(model).path!.segments).toHaveLength(1);
    // Ticket 15, phase 3b: the kept 7f result has no offer and a 7f move was kept, so the unmoved baseline's offer runs as one extra trial; the routed
    // judge refuses it, the kept result stands, and the published link is the same single segment.
    expect(places).toBe(2);
    expect(labels).toContain('rerun-side');
    expect(codes(model).filter(code => code.startsWith('SIDE_'))).toEqual([]);
    // The measure read the baseline. The 7e reading of the same input (what main reads) offers a hint for that link: the slack rule cannot separate them.
    const { base, kept7e } = state.measured[0]!;
    const real = await vi.importActual<typeof import('../../src/layout/side-measure.js')>('../../src/layout/side-measure.js');
    expect(real.measureSides(base, kept7e, new Set()).hints.size).toBe(0);
    expect(real.plannedBends(kept7e, overlayOf(kept7e))).toBeGreaterThan(0);
    expect(real.measureSides(kept7e, kept7e, new Set()).hints.size).toBeGreaterThan(0);
  }, 60000);

  it('reads the baseline once: one trial, one measure after a kept trial', async () => {
    const { model, places, labels } = await run(PAST_SIBLING);
    expect(places).toBe(2);
    expect(state.calls).toBe(1);
    expect(labels.filter(label => label === 'bands-trial')).toHaveLength(1);
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(true);
    expect(codes(model)).toContain('SIDE_HINT_TAKEN');
  }, 60000);
});

describe('the trial is kept only on its routed result (Section 19.4)', () => {
  it('never worse: a hinted straight link that the trial route bends more than the baseline is refused and the baseline publishes', async () => {
    const plain = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const id = overlayOf(plain.model).id;
    const { model, places } = await run(PAST_SIBLING, {}, undefined, (routed, call) => call === 2 ? bendTo(routed, id, 4) : routed);
    expect(places).toBe(2);
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(withoutNotes(model)).toBe(withoutNotes(plain.model));
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('more bends than on the baseline');
    expect(codes(model)).not.toContain('SIDE_HINT_TAKEN');
  }, 60000);

  it('a routed neighbour: the trial gains on the hinted link, but its route adds bends to a neighbour, so the net count does not fall: refused', async () => {
    const plain = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const neighbour = routedNeighbour(plain.model);
    const { model } = await run(PAST_SIBLING, {}, undefined, (routed, call) => call === 2 ? bendTo(routed, neighbour, 4) : routed);
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(withoutNotes(model)).toBe(withoutNotes(plain.model));
    expect(model.diagnostics.find(item => item.code === 'SIDE_HINT_REFUSED')!.message).toContain('no gain');
  }, 60000);

  it('a removed link: a link that the trial route removes and the baseline route keeps refuses the trial', async () => {
    const plain = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const neighbour = routedNeighbour(plain.model);
    const { model } = await run(PAST_SIBLING, {}, undefined, (routed, call) => call === 2 ? removeLink(routed, neighbour) : routed);
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(false);
    expect(withoutNotes(model)).toBe(withoutNotes(plain.model));
    expect(model.diagnostics.find(item => item.code === 'SIDE_HINT_REFUSED')!.message).toContain('removes');
  }, 60000);
});

describe('the trial deadline (Section 19.5, ticket 141)', () => {
  it('a deadline met in the trial\'s placement ends the whole command with CommandDeadlineError', async () => {
    let remaining = 600_000, placements = 0;
    const budget = { remainingMs: () => remaining, share: (stageMs: number) => Math.min(stageMs, remaining) };
    const onProgress = (progress: { stage: string }): void => { if (progress.stage === 'resolve') placements++; if (progress.stage === 'bundles' && placements === 2) remaining = 0; };
    await expect(run(PAST_SIBLING, { budget, onProgress })).rejects.toBeInstanceOf(CommandDeadlineError);
  }, 60000);

  it('an ELK timeout in the side trial\'s placement ends the command: the hints are not refused and no baseline is published', async () => {
    let places = 0;
    const createElkAttempt = () => {
      const real = createAttempt();
      if (++places !== 2) return real;
      return { layout: async () => { real.terminateWorker(); throw new ElkDeadlineError(1); }, terminateWorker: () => real.terminateWorker() };
    };
    await expect(layout(parse(fixture(PAST_SIBLING)), { createElkAttempt, createRouteAttempt: createAvoidAttempt })).rejects.toBeInstanceOf(ElkDeadlineError);
    expect(places).toBe(2);
  }, 60000);

  it('little time left (a fixed 3 s) is not a reason to cut: the layout has the same bytes as with time to spare', async () => {
    const budget = { remainingMs: () => 3000, share: (stageMs: number) => Math.min(stageMs, 3000) };
    const { model } = await run(PAST_SIBLING, { budget }), far = await run(PAST_SIBLING);
    expect(codes(model)).not.toContain('SIDE_ROUND_CUT');
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(true);
    expect(withoutNotes(model)).toBe(withoutNotes(far.model));
  }, 60000);
});

const offerOf = (key: string, side: 'left' | 'right', link: string, bends = 0): SideOffer => ({
  hints: new Map([[key, side]]), promised: new Map([[key, { link, bends, shape: 'straight' as const }]]), capped: false });

describe('the predictor prunes only what it can place again (Section 19.3)', () => {
  const serverKey = (model: LayoutModel): string => portKey(overlayOf(model).attachments!.from);

  it('with a re-run and a round left, a hint predicted worse (newly facing away) is pruned and the rest is placed again', async () => {
    const plain = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const link = overlayOf(plain.model);
    // The server's left face turns away from the client, which stands to the right.
    const { model, labels } = await run(PAST_SIBLING, {}, (call, real) => call === 1 ? offerOf(serverKey(plain.model), 'left', link.id) : real());
    expect(labels.filter(label => label === 'rerun-side')).toHaveLength(2);
    expect(labels.filter(label => label === 'bands-trial')).toHaveLength(1);
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).toContain('prediction');
    expect(model.nodes['server']!.ports.find(port => port.sideHint === true)!.side).toBe('right');
  }, 60000);

  it('with no re-run left, the predictor does not run: the same hint goes to 7f and is refused on its routed result', async () => {
    const plain = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const link = overlayOf(plain.model);
    const { model, labels } = await run(PAST_SIBLING, { testMaxReruns: 1 }, (call, real) => call === 1 ? offerOf(serverKey(plain.model), 'left', link.id) : real());
    expect(labels.filter(label => label === 'rerun-side')).toHaveLength(1);
    expect(labels.filter(label => label === 'bands-trial')).toHaveLength(1);
    const refused = model.diagnostics.filter(item => item.code === 'SIDE_HINT_REFUSED');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.message).not.toContain('prediction');
    expect(model.nodes['server']!.ports.some(port => port.sideHint === true)).toBe(false);
  }, 60000);

  it('moves each trial node by the move 7f gave it, and calls a hint worse only when its planned bends rise over the baseline', async () => {
    const { model: hinted } = await run(PAST_SIBLING);
    const cut = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const { base, kept7e } = state.measured[0] ?? { base: cut.model, kept7e: cut.model };
    const bent = cut.model, straight = hinted;
    const link = overlayOf(bent).id;
    // A hint that is predicted short of its promise, or better than the baseline, is never in the list; only a rise is.
    expect(predictedWorse(bent, bent, [link]).links).toEqual([]);
    expect(predictedWorse(straight, bent, [link]).links).toEqual([]);
    expect(predictedWorse(bent, straight, [link]).links).toEqual([link]);
    // The nodes of the trial stand where the baseline has them when the two 7e models agree.
    const moved = predictPublished(kept7e, kept7e, base);
    for (const [id, node] of Object.entries(moved.nodes)) expect(node.bounds).toEqual(base.nodes[id]!.bounds);
  }, 60000);
});

describe('the batch (Section 19.8)', () => {
  it('one hinted link that gains but stops short is named and keeps the batch; one worse than the baseline refuses it whole', async () => {
    const { model: plain } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const overlay = overlayOf(plain).id, neighbour = routedNeighbour(plain);
    const hinted = new Map([[overlay, 0], [neighbour, 0]]);
    const input = (trial: LayoutModel) => ({ routedBase: plain, routedTrial: trial, kept7e: plain, trial7e: plain, hinted });
    const gained = bendTo(plain, overlay, 1);
    const kept = judgeTrial(input(gained));
    expect(kept.kept).toBe(true);
    expect(kept.short).toEqual([expect.objectContaining({ link: overlay, bends: 1, base: 2, promised: 0 })]);
    expect(trialNotes(plain, gained, kept, hinted.keys()).map(item => item.code)).toEqual(['SIDE_SHAPE_SHORT']);
    const worse = judgeTrial(input(bendTo(gained, neighbour, 1)));
    expect(worse.kept).toBe(false);
    expect(worse.worse).toEqual([neighbour]);
  }, 60000);

  it('names a neighbour without a hint whose bends rose, and a hinted link that crosses more links', async () => {
    const { model: plain } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const overlay = overlayOf(plain).id, neighbour = routedNeighbour(plain);
    const trial = bendTo(bendTo(plain, overlay, 0), neighbour, 1);
    const verdict = judgeTrial({ routedBase: plain, routedTrial: trial, kept7e: plain, trial7e: plain, hinted: new Map([[overlay, 0]]) });
    expect(verdict.kept).toBe(true);
    const notes = trialNotes(plain, trial, verdict, [overlay]);
    expect(notes.map(item => item.code)).toEqual(['SIDE_HINT_BENDS_NEIGHBOUR']);
    expect(notes[0]!.owners).toEqual([{ kind: 'link', id: neighbour }]);
  }, 60000);

  it('reports a hinted link that crosses a link it did not cross on the baseline (no slack)', async () => {
    const { model: plain } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const overlay = overlayOf(plain).id, other = plain.links.find(item => item.id === routedNeighbour(plain))!.path!.segments[0]!;
    const mid = { x: (other.from.x + other.to.x) / 2, y: (other.from.y + other.to.y) / 2 };
    const across = { x: -(other.to.y - other.from.y), y: other.to.x - other.from.x };
    const norm = Math.hypot(across.x, across.y);
    const p = { x: across.x / norm * 15, y: across.y / norm * 15 };
    const trial: LayoutModel = { ...plain, links: plain.links.map(link => link.id !== overlay ? link : { ...link, path: { ...link.path!, segments: [
      { from: { x: mid.x - p.x, y: mid.y - p.y }, to: { x: mid.x + p.x, y: mid.y + p.y }, owner: link.owner }] } }) };
    const verdict = judgeTrial({ routedBase: plain, routedTrial: trial, kept7e: plain, trial7e: plain, hinted: new Map([[overlay, 0]]) });
    expect(trialNotes(plain, trial, verdict, [overlay]).map(item => item.code)).toContain('SIDE_HINT_ADDS_CROSSING');
  }, 60000);
});

describe('the fixed point (Section 19.9, ticket 136): a kept trial publishes a layout the column rules leave alone', () => {
  const settled = (model: LayoutModel): boolean[] => {
    const clone = structuredClone(model) as LayoutModel;
    return [packBesideRows(clone), holdMemberWalls(clone), holdColumnAxes(clone, 0)];
  };
  it('the kept trial of the sibling fixture is a fixed point of the pack, the member walls and the column axes', async () => {
    const { model } = await run(PAST_SIBLING);
    expect(codes(model)).toContain('SIDE_HINT_TAKEN');
    expect(settled(model)).toEqual([false, false, false]);
  }, 60000);
});

describe('the judgment reads more than the counts', () => {
  it('a hinted link that gets worse refuses the trial though two other links go straight (a net gain)', async () => {
    const { model: plain } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const overlay = overlayOf(plain).id, routed = plain.links.filter(item => item.layer !== 'overlay').map(item => item.id);
    expect(routed).toHaveLength(2);
    const base = bendTo(bendTo(plain, routed[0]!, 2), routed[1]!, 2); // bent: two routed links and the overlay link
    const trial = bendTo(plain, overlay, 4); // the routed links go straight, the hinted link gets worse than its 2
    const verdict = judgeTrial({ routedBase: base, routedTrial: trial, kept7e: plain, trial7e: plain, hinted: new Map([[overlay, 0]]) });
    expect(verdict.kept).toBe(false);
    expect(verdict.worse).toEqual([overlay]);
    expect(verdict.reason).toContain('more bends than on the baseline');
  }, 60000);

  it('a hint that already faces away on the baseline is not the trial\'s failure (the awayBefore exclusion)', async () => {
    const { model: plain } = await run(PAST_SIBLING, { testMaxReruns: 0 });
    const key = portKey(overlayOf(plain).attachments!.from);
    const { model: away } = await run(PAST_SIBLING, { testMaxReruns: 0, testSideHints: new Map([[key, 'left' as const]]) });
    const verdict = judgeTrial({ routedBase: away, routedTrial: away, kept7e: away, trial7e: away, hinted: new Map() });
    expect(verdict.away).toEqual([]);
    expect(verdict.reason).toContain('no gain');
  }, 60000);
});

describe('the trial route and the deadline (Section 19.5, ticket 141)', () => {
  it('a route deadline in the trial\'s route ends the whole command with RouteDeadlineError', async () => {
    await expect(run(PAST_SIBLING, {}, undefined, (routed, call) => { if (call === 2) throw new RouteDeadlineError(1); return routed; })).rejects.toBeInstanceOf(RouteDeadlineError);
  }, 60000);

  it('a budget spent after the baseline route ends the command before the trial\'s route starts', async () => {
    let remaining = 600_000;
    const budget = { remainingMs: () => remaining, share: (stageMs: number) => Math.min(stageMs, remaining) };
    const labels: string[] = [];
    await expect(run(PAST_SIBLING, { budget, testTiming: label => { labels.push(label); } }, undefined, (routed, call) => { if (call === 1) remaining = 0; return routed; })).rejects.toBeInstanceOf(CommandDeadlineError);
    expect(labels).not.toContain('route-trial');
  }, 60000);
});
