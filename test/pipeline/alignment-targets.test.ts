import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import type { AlignmentTarget } from '../../src/model/layout.js';
import { alignmentTargetsFault, declinedTargets, sameDeclines, targetTap } from '../../src/layout/alignment-targets.js';
import { centre, centreDraft, createCentreBudget, publishedCentreViolations } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { rows } from '../../src/layout/rows.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';
import { reversed } from '../../scripts/r3-lib.mjs';
// The group lift (ticket 08) is off in these tests: it moves a group of their sheets (a group fed from directly above rises to a level side
// entry beside its feeder), which changes the subject they pin. `lift.test.ts` tests the lift, and the corpus gate measures it on every sheet.

/**
 * Architecture-2 ticket 66: the alignment-target record. A centring step that would keep the geometry it found for its vertical tally keeps it only
 * when every overlay link its own geometry draws straight stays straight; otherwise it declines the targets with the reason, and the decline is final
 * for the placement attempt. The record lives from 7c to the end of 7f, and the published layout does not carry it.
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
const declined = (model: LayoutModel): { face: string; entry: AlignmentTarget }[] =>
  Object.entries(model.alignmentTargets!).flatMap(([face, list]) => list.filter(entry => entry.state === 'declined').map(entry => ({ face, entry })));
/** The overlay link between the two nodes, by its ends (link ids follow the document order). */
const overlay = (model: LayoutModel, one: string, two: string) => model.links.find(link => link.layer === 'overlay'
  && [link.attachments!.from.node, link.attachments!.to.node].sort().join(' ') === [one, two].sort().join(' '))!;
const UPPER = 'f2', LOWER = 'b-s2';

describe('a kept vertical leaves a straight overlay straight (architecture-2 ticket 66)', () => {
  const text = source(NAME);
  it('keeps the overlay one segment and declines the target overlay-straight by it', async () => {
    const { result: model, verdicts } = await tapped(() => run(text));
    const link = overlay(model, UPPER, LOWER);
    expect(link.path!.segments).toHaveLength(1);
    const found = declined(atDrop(verdicts));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(({ entry }) => entry.reason === 'overlay-straight' && entry.by === link.id)).toBe(true);
    // The published layout does not carry the record.
    expect('alignmentTargets' in model).toBe(false);
    expect(JSON.stringify(model)).not.toContain('alignmentTargets');
  }, 120000);
  it('keeps the overlay straight on reversed links and reversed nodes, and declines only for it (R3)', async () => {
    const texts = [text, reversed(text, 'links'), reversed(text, 'nodes')];
    expect(new Set(texts).size).toBe(3);
    // The stages before the centring read the input order (ELK), so the three runs start the centring from different geometry: on reversed nodes the
    // step of `feeds` never wants the keep. What the rule decides is the same on each: the overlay stands straight, and a decline, where one is
    // written, is `overlay-straight` by that overlay on the bottom face of `f2`. The link ids follow the document order, so links are found by their ends.
    for (const one of texts) {
      const { result: model, verdicts } = await tapped(() => run(one));
      const link = overlay(model, UPPER, LOWER);
      expect(link.path!.segments).toHaveLength(1);
      for (const { face, entry } of declined(atDrop(verdicts))) expect([face, entry.reason, entry.by]).toEqual([`${UPPER}|bottom`, 'overlay-straight', link.id]);
    }
  }, 360000);
  it('declines once: no later pass or replay tries the keep for a declined target', async () => {
    const { verdicts } = await tapped(() => run(text));
    const tries = verdicts.filter(([name]) => name === 'keptBranch').map(([, value]) => value);
    // A check before the first pass replays the step on a copy and declines there; the producer declines in its pass, and from then on the tally
    // does not count the target (the record), so nothing tries the keep again, the publication replays after 7f included.
    const producer = tries.filter(value => value.startsWith('feeds pass '));
    expect(producer).toHaveLength(1);
    expect(producer[0]).toMatch(/overlay-straight/);
    expect(tries.at(-1)).toBe(producer[0]);
  }, 120000);
  it('names a decline its replay writes that the record lacks (alignment-targets-differ)', async () => {
    const { verdicts } = await tapped(() => run(text));
    const model = atDrop(verdicts);
    // The declined target is a held cross chord's port, which the publication excuses (any angle): read as the producer's own check reads it (`ahead`).
    expect(publishedCentreViolations(model, true).filter(item => item.startsWith('alignment-targets-differ'))).toEqual([]);
    const { entry } = declined(model)[0]!;
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
  it('refuses a record at a stage it does not live at, and a decline before the output of 7f', async () => {
    const { verdicts } = await tapped(() => run(text));
    const draft = atDrop(verdicts);
    // The draft of 7f stands at `bundles` until the rule ends; what it publishes stands at `bands`, and there a decline is the record's own.
    expect(alignmentTargetsFault({ ...draft, stage: 'bands' })).toBeUndefined();
    expect(alignmentTargetsFault(draft)).toMatch(/a decline at stage bundles, before 7f/);
    expect(alignmentTargetsFault({ ...draft, stage: 'route' })).toMatch(/a record at stage route/);
    const { alignmentTargets: _record, ...bare } = draft;
    void _record;
    expect(alignmentTargetsFault({ ...bare, stage: 'route' } as LayoutModel)).toBeUndefined();
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
