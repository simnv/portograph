import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { AlignmentTarget, LayoutPort } from '../../src/model/layout.js';
import { alignmentTargetsFault, declinedTargets, sameDeclines, targetTap, writeAlignmentTargets } from '../../src/layout/alignment-targets.js';
import type { TargetNotes } from '../../src/layout/alignment-targets.js';
import { centre, centreDraft, createCentreBudget, publishedCentreViolations } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { centringFeeds } from '../../src/layout/read/feeds.js';
import { rebuildRegions } from '../../src/layout/regions.js';
import { findPort } from '../../src/layout/row-paths.js';
import { portId } from '../../src/layout/skeleton-graph.js';
import { orderedNodeIds } from '../../src/model/model.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { rows } from '../../src/layout/rows.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';
// The group lift (ticket 08) is off in these tests: every lift trial on these sheets is declined, but each trial is one more whole run,
// and the tests count the alignment declines of one run. `lift.test.ts` tests the lift.

/**
 * Architecture-2 ticket 66: the alignment-target record. A centring step that would keep the geometry it found for its vertical tally keeps it only
 * when every overlay link its own geometry draws straight stays straight; otherwise it declines the targets with the reason, and the decline is final
 * for the placement attempt. The record lives from 7c to publication (ADR-0027, `RECORD_STAGES`).
 *
 * Under the seat invariant of ADR-0027 the guard stores no decline, and these tests do not cover it end to end:
 * 1. Corpus scan (452 synthetic sheets): the keep branch runs on 29; 210 verdicts are `kept`, 2 are an overlay-straight refusal in a replay
 *    (a-corridor-moves-after-the-grid-settles, a-refused-close-up-of-card-nodes-keeps-the-node-labels-in-order); no sheet stores the decline.
 * 2. On this sheet, forced through the model API to stand two or three owed verticals (bodies of 536 to 1026 px, past the cap), the step moves
 *    nothing, as a seat that stands keeps its body; with one target open it seats another pair, as many verticals, so the keep branch does not run.
 * 3. The keep branch runs only for a step that loses a vertical it found, and under the invariant a step does not lose one that stands.
 * The tests below pin what stands now; the decline the record tests read is written by the record's own writer (`writeAlignmentTargets`).
 */
const NAME = 'a-kept-vertical-leaves-a-straight-overlay-straight';
const source = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (text: string): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, testLiftOff: true });
/** Runs `work` with a tap on the record's events, and returns them with its result. */
async function tapped<T>(work: () => Promise<T>): Promise<{ result: T; verdicts: [string, string][] }> {
  const verdicts: [string, string][] = [];
  const sink = targetTap.sink;
  targetTap.sink = (name, value) => { verdicts.push([name, value]); };
  try { return { result: await work(), verdicts }; } finally { if (sink === undefined) delete targetTap.sink; else targetTap.sink = sink; }
}
/** The model 7f publishes, with its record, as its draft stands at the end of the rule (stage `bundles`; the rule then marks it `bands`). */
const atDrop = (verdicts: [string, string][]): LayoutModel => JSON.parse(verdicts.filter(([name]) => name === 'alignmentTargets').at(-1)![1]) as LayoutModel;
/** The declines of a guard. A `cap` entry is the last seat's (ADR-0027), decided again by the next step: no guard wrote it. */
const declined = (model: LayoutModel): { face: string; entry: AlignmentTarget }[] =>
  Object.entries(model.alignmentTargets!).flatMap(([face, list]) => list.filter(entry => entry.state === 'declined' && entry.reason !== 'cap').map(entry => ({ face, entry })));
/** The overlay link between the two nodes, by its ends (link ids follow the document order). */
const overlay = (model: LayoutModel, one: string, two: string) => model.links.find(link => link.layer === 'overlay'
  && [link.attachments!.from.node, link.attachments!.to.node].sort().join(' ') === [one, two].sort().join(' '))!;
const UPPER = 'f2', LOWER = 'b-s2', HOLD = 'b-r1';
/**
 * Writes, through the record's own writer, the decline the guard wrote before the seat invariant: the target of `f2` under `b-r1`, declined
 * `overlay-straight` by the overlay `f2 -> b-s2`. The feed is the one the step reads (`centringFeeds`, tier 0 under the authority of tier 1).
 */
function writtenDecline(model: LayoutModel, pass = 1): { model: LayoutModel; entry: AlignmentTarget; face: string } {
  const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
  const feed = centringFeeds(copy, 0, 1).find(item => item.child.ref.node === UPPER && item.parent.ref.node === HOLD)!;
  const key = portId(feed.child.ref), link = overlay(copy, UPPER, LOWER);
  const notes: TargetNotes = { seats: new Map([[key, feed]]), wanted: new Map([[key, feed.x]]), grown: new Map(), start: new Map(),
    declined: new Map([[key, { reason: 'overlay-straight', by: link.id }]]), seated: new Map() };
  writeAlignmentTargets(copy, [UPPER], notes, pass);
  const face = `${UPPER}|${feed.child.side}`;
  return { model: copy, entry: copy.alignmentTargets![face]!.find(item => item.port === key)!, face };
}
/**
 * The model at the output of 7c, with `f2` forced (through the geometry API the step reads, no record edit) to stand the three owed verticals
 * under `c-r1`, `a-r1` and `b-r1`: a body past the alignment cap, standing every vertical the keep branch would keep.
 */
async function forcedThreeVerticals(text: string): Promise<LayoutModel> {
  const model = JSON.parse(JSON.stringify(centre(flanks(lanes(rows(await placed(text))))))) as LayoutModel;
  const f2 = model.nodes[UPPER]!;
  const farX = (port: LayoutPort): { node: string; x: number } | undefined => {
    const link = model.links.find(item => item.layer === 'routed' && item.attachments && [item.attachments.from, item.attachments.to].some(end => portId(end) === portId(port.ref)));
    const other = link && [link.attachments!.from, link.attachments!.to].find(end => portId(end) !== portId(port.ref))!;
    return other && { node: other.node, x: findPort(model, other)!.anchor!.x };
  };
  // Each port under a feed goes to the x of its feed; the ports between and beside them keep their pitch to the nearest one.
  const knots = ['c-r1', 'a-r1', HOLD].map(node => { const port = f2.ports.find(item => farX(item)?.node === node)!; return [port.anchor!.x, farX(port)!.x] as const; });
  for (const port of f2.ports) {
    const x = port.anchor!.x, first = knots[0]!, last = knots.at(-1)!;
    if (x <= first[0]) port.anchor!.x = first[1] + x - first[0];
    else if (x >= last[0]) port.anchor!.x = last[1] + x - last[0];
    else { const at = knots.findIndex(([k]) => k >= x); const [x0, y0] = knots[at - 1]!, [x1, y1] = knots[at]!; port.anchor!.x = y0 + (x - x0) * (y1 - y0) / (x1 - x0); }
  }
  const xs = f2.ports.map(port => port.anchor!.x), low = Math.min(...xs) - 20, high = Math.max(...xs) + 20;
  f2.bounds = { ...f2.bounds!, x: low, width: high - low };
  f2.size = { width: high - low, height: f2.bounds.height };
  const feeds = model.groups[model.document.nodes[UPPER]!.group]!;
  const left = Math.min(feeds.bounds!.x, low - 20), right = Math.max(feeds.bounds!.x + feeds.bounds!.width, high + 20);
  feeds.bounds = { ...feeds.bounds!, x: left, width: right - left };
  rebuildNodeGeometry(model, orderedNodeIds(model.document), 'current');
  rebuildRegions(model);
  return model;
}

describe('a kept vertical leaves a straight overlay straight (architecture-2 ticket 66)', () => {
  const text = source(NAME);
  it('stores no guard decline end to end, and publishes the record with the layout (ADR-0027)', async () => {
    const { result: model, verdicts } = await tapped(() => run(text));
    // Before the seat invariant the step of `feeds` lost the vertical under `b-r1` from 7e on, the guard declined it `overlay-straight`, and the
    // overlay stood straight. Now `f2` stands both owed verticals (the named trade of ticket 02: the overlay to `b-s2` bends).
    expect(declined(atDrop(verdicts))).toEqual([]);
    expect(overlay(model, UPPER, LOWER)).toBeDefined();
    // The record lives to publication (ADR-0027, `RECORD_STAGES`): the published layout carries it, and it is no fault there.
    // (Before ADR-0027 the route rule dropped it, and this test held that the published layout did not carry it.)
    expect(model.alignmentTargets).toBeDefined();
    expect(alignmentTargetsFault(model)).toBeUndefined();
  }, 120000);
  it('stores no guard decline on reversed links and reversed nodes (R3)', async () => {
    const texts = [text, reversed(text, 'links'), reversed(text, 'nodes')];
    expect(new Set(texts).size).toBe(3);
    // The stages before the centring read the input order (ELK), so the three runs start the centring from different geometry. On each, no
    // guard decline is stored. (Before the seat invariant this test held that the overlay stood straight on each, and that any decline was
    // `overlay-straight` by it on the bottom face of `f2`.)
    for (const one of texts) {
      const { verdicts } = await tapped(() => run(one));
      expect(declined(atDrop(verdicts))).toEqual([]);
    }
  }, 360000);
  it('the step stands a forced body that stands its verticals: the keep branch does not run', async () => {
    const model = await forcedThreeVerticals(text);
    const before = JSON.stringify(Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id, node.bounds])));
    const { verdicts } = await tapped(async () => { centreDraft(model, createCentreBudget()); return undefined; });
    // A seat that stands keeps its body (ADR-0027, clause 4): nothing moves, and no step loses a vertical, so no keep is tried or declined.
    expect(JSON.stringify(Object.fromEntries(Object.entries(model.nodes).map(([id, node]) => [id, node.bounds])))).toBe(before);
    expect(verdicts.filter(([name]) => name === 'keptBranch')).toEqual([]);
    expect(declined(model)).toEqual([]);
  }, 120000);
  it('keeps a written decline: a later write of the same face does not drop it (final for the attempt)', async () => {
    const model = centre(flanks(lanes(rows(await placed(text)))));
    const { model: written, entry, face } = writtenDecline(model);
    expect([face, entry.state, entry.reason, entry.by]).toEqual([`${UPPER}|bottom`, 'declined', 'overlay-straight', overlay(written, UPPER, LOWER).id]);
    // A later step that wants the same target and declines nothing writes the face again: the decline stays, with the pass that wrote it.
    const feed = centringFeeds(written, 0, 1).find(item => portId(item.child.ref) === entry.port)!;
    writeAlignmentTargets(written, [UPPER], { seats: new Map([[entry.port, feed]]), wanted: new Map([[entry.port, feed.x]]), grown: new Map(), start: new Map(), declined: new Map(), seated: new Map() }, 2);
    expect(written.alignmentTargets![face]!.find(item => item.port === entry.port)).toEqual(entry);
    // A step that does not want the target at all keeps it too.
    writeAlignmentTargets(written, [UPPER], { seats: new Map(), wanted: new Map(), grown: new Map(), start: new Map(), declined: new Map(), seated: new Map() }, 3);
    expect(written.alignmentTargets![face]!.find(item => item.port === entry.port)).toEqual(entry);
    // The tally reads it.
    expect(declinedTargets(written, [UPPER], 'overlay-straight')).toEqual(new Set([entry.port]));
  }, 120000);
  it('names a decline its replay writes that the record lacks (alignment-targets-differ)', async () => {
    const { verdicts } = await tapped(() => run(text));
    const { model, entry } = writtenDecline(atDrop(verdicts));
    // A stored decline the replay does not write again is no finding (the writer keeps a decline): read as the producer's own check reads it.
    expect(publishedCentreViolations(model, true).filter(item => item.startsWith('alignment-targets-differ'))).toEqual([]);
    const kept: AlignmentTarget = { port: entry.port, link: entry.link, far: entry.far, owes: entry.owes, state: 'kept', pass: 1 };
    // A decline the replay writes that the stored face lacks is the finding; one it writes again equal is the same decision, and `kept` or
    // `grown` (history a later move leaves behind) are not compared.
    expect(sameDeclines([kept], [entry])).toBe(false);
    expect(sameDeclines([], [entry])).toBe(false);
    expect(sameDeclines([entry], [{ ...entry, pass: 0 }])).toBe(true);
    expect(sameDeclines([{ ...entry, by: 'link-0' }], [entry])).toBe(false);
    expect(sameDeclines([kept], [{ ...kept, state: 'grown', extent: { low: -10, high: 10 } }])).toBe(true);
    expect(sameDeclines(undefined, undefined)).toBe(true);
  }, 120000);
  it('refuses a record at a stage it does not live at, and a guard decline before the output of 7f', async () => {
    const { verdicts } = await tapped(() => run(text));
    const { model: draft } = writtenDecline(atDrop(verdicts));
    // The draft of 7f stands at `bundles` until the rule ends; what it publishes stands at `bands`, and there a decline is the record's own.
    expect(alignmentTargetsFault({ ...draft, stage: 'bands' })).toBeUndefined();
    expect(alignmentTargetsFault(draft)).toMatch(/a decline at stage bundles, before 7f/);
    // The record lives from the centre rule's output to publication (ADR-0027): a record before the centre rule is no record of anything.
    // (Before ADR-0027 this read a record at stage route, which the route rule dropped.)
    expect(alignmentTargetsFault({ ...draft, stage: 'flanks' })).toMatch(/a record at stage flanks/);
    // From the output of 7f to publication the record carries its declines (a routed layout too).
    for (const stage of ['route', 'link-labels', 'validate', 'emit'] as const) expect(alignmentTargetsFault({ ...draft, stage })).toBeUndefined();
    const { alignmentTargets: _record, ...bare } = draft;
    void _record;
    expect(alignmentTargetsFault({ ...bare, stage: 'flanks' } as LayoutModel)).toBeUndefined();
  }, 120000);
  it('declines nothing on an absent record, and the producer names it', async () => {
    const { verdicts } = await tapped(() => run(text));
    const model = atDrop(verdicts);
    delete model.alignmentTargets;
    expect(declinedTargets(model, Object.keys(model.nodes)).size).toBe(0);
    expect(alignmentTargetsFault(model)).toBeUndefined();
    // A hand-made centre transaction leaves no record: a later run of the passes records none and says so.
    const bare = centre(flanks(lanes(rows(await placed(text)))));
    const { alignmentTargets: _record, ...rest } = bare;
    void _record;
    const later = JSON.parse(JSON.stringify({ ...rest, stage: 'bars' })) as LayoutModel;
    centreDraft(later, createCentreBudget());
    expect(later.alignmentTargets).toBeUndefined();
    expect(later.diagnostics.filter(item => item.code === 'ALIGNMENT_TARGETS_UNDECIDED')).toHaveLength(1);
  }, 120000);
});

describe('the shape of the alignment-target record', () => {
  it('refuses a forged cap entry: a cap decline is by the node of its face (ADR-0027)', async () => {
    const model = centre(flanks(lanes(rows(await placed(source(NAME))))));
    const caps = Object.entries(model.alignmentTargets!).flatMap(([face, list]) => list.filter(entry => entry.reason === 'cap').map(entry => ({ face, entry })));
    expect(caps.length).toBeGreaterThan(0);
    // A cap decline lives from the centre rule on, and the next step decides it again; the replay does not compare it (`sameDeclines`).
    expect(alignmentTargetsFault(model)).toBeUndefined();
    const { face, entry } = caps[0]!;
    const other = Object.keys(model.nodes).find(id => id !== entry.by)!;
    const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
    copy.alignmentTargets![face]!.find(item => item.port === entry.port)!.by = other;
    expect(alignmentTargetsFault(copy)).toBe(`${face} entry ${model.alignmentTargets![face]!.indexOf(entry)}: a cap decline by ${other}, not by ${entry.by}`);
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/alignment target record is forged/);
  }, 120000);
  it('refuses each malformed form, and the publication refuses a forged record', async () => {
    const model = centre(flanks(lanes(rows(await placed(source(NAME))))));
    expect(model.alignmentTargets).toBeDefined();
    expect(alignmentTargetsFault(model)).toBeUndefined();
    const faces = Object.entries(model.alignmentTargets!).filter(([, list]) => list.length > 0);
    expect(faces.length).toBeGreaterThan(0);
    const [face, list] = faces[0]!;
    const forge = (edit: (record: Record<string, AlignmentTarget[]>, entries: AlignmentTarget[]) => void, stage = model.stage): string | undefined => {
      const copy = { ...JSON.parse(JSON.stringify(model)) as LayoutModel, stage };
      edit(copy.alignmentTargets!, copy.alignmentTargets![face]!);
      return alignmentTargetsFault(copy);
    };
    expect(forge(record => { record['no-such-node|top'] = []; })).toMatch(/no node face/);
    expect(forge((_, entries) => { entries[0]!.port = 'port:["nowhere",true,null,9]'; })).toMatch(/no port on the face/);
    expect(forge((_, entries) => { entries[0]!.link = 'no-such-link'; })).toMatch(/does not end at/);
    expect(forge((_, entries) => { entries[0]!.far = entries[0]!.far.startsWith('lane:') ? 'lane:no-such-lane' : entries[0]!.port; })).toMatch(/far end|no lane/);
    expect(forge((_, entries) => { (entries[0] as { owes: string }).owes = 'some'; })).toMatch(/owes/);
    expect(forge((_, entries) => { (entries[0] as { state: string }).state = 'maybe'; delete entries[0]!.extent; })).toMatch(/state/);
    expect(forge((_, entries) => { entries[0]!.state = 'declined'; delete entries[0]!.extent; }, 'bands')).toMatch(/without its reason/);
    expect(forge((_, entries) => { entries[0]!.state = 'grown'; delete entries[0]!.extent; })).toMatch(/without its extent/);
    expect(forge((_, entries) => { entries.push({ ...entries[0]! }); })).toMatch(/out of port-key order or repeated/);
    expect(forge((_, entries) => { entries[0]!.pass = -1; })).toMatch(/pass/);
    if (list.length > 1) expect(forge((_, entries) => { entries.reverse(); })).toMatch(/out of port-key order/);
    const copy = JSON.parse(JSON.stringify(model)) as LayoutModel;
    copy.alignmentTargets!['no-such-node|top'] = [];
    expect(() => restoreLayoutModel(JSON.stringify(copy))).toThrow(/alignment target record is forged/);
  }, 120000);
});
