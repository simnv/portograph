import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { layout, parse, render, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import { growthShort } from '../../src/pipeline/index.js';
import { growthChoiceTest, judgeGrowthChoice, MOVE_BEFORE_GROW_CHOICE, MOVE_BEFORE_GROW_TRIAL_SKIPPED, moveBeforeGrowDefaultTest, trialSkippedMessage } from '../../src/layout/read/move-before-grow.js';
import { added, gateFindings } from '../../src/layout/trial-findings.js';
import { pathBends } from '../../src/layout/objective.js';
import type { Diagnostic, LayoutLink, LayoutModel, LayoutNode, LayoutPort, NormalisedDocument, Point } from '../../src/model/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { avoidAssets, createAvoidAttempt, spawnAvoidWorker } from '../route/fixture.js';

/**
 * The guards of the growth choice (dense-16x9 ticket 60, review 1): the judge keeps no run that drops a link (P1) or adds a gate finding by
 * multiplicity (P2); an expired trial decides nothing (P3); the trigger reads the scorer's bends and the run's own placement notes (P4); a trial
 * that decides nothing is named (P5). The default is off until ticket 45, so these tests reach it through the test switch of ticket 56.
 */
const factories = { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt };
afterEach(() => { delete moveBeforeGrowDefaultTest.on; delete growthChoiceTest.beforeTrial; });

const sheet = (path: string): NormalisedDocument => parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const written = (document: NormalisedDocument, on: boolean): NormalisedDocument => ({ ...document, layout: { ...document.layout, moveBeforeGrow: on } });
const json = (model: LayoutModel): LayoutModel => JSON.parse(serializeLayoutModel(model)) as LayoutModel;
/** The saved layout without its runtime and its run record: what a default-mode run and a written run of the same mode share. */
const plainJson = (model: LayoutModel): string => { const copy = json(model); delete copy.moveBeforeGrowRun; copy.runtime = { stages: [] }; return JSON.stringify(copy); };
const LEAF = 'goldens/synthetic/a-leaf-child-and-its-beside-cells-stay-one-row.yaml';
const FIXTURE = 'goldens/synthetic/a-child-under-two-parents-grows-when-the-whole-sheet-is-better.yaml';
const skippedNotes = (model: LayoutModel): Diagnostic[] => model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_TRIAL_SKIPPED);

describe('the guards of the growth choice (dense-16x9 ticket 60, review 1)', () => {
  it('P1: an option-off trial that drops links the option-on run draws is not kept, whatever it saves in bends', async () => {
    // The reviewer's public probe: the off trial's router answers are retraced into a jog, so stage 8 rejects three routes and removes their links.
    moveBeforeGrowDefaultTest.on = true;
    const document = sheet('goldens/synthetic/three-lateral-legs-stay-with-the-router.yaml');
    let trial = false;
    growthChoiceTest.beforeTrial = () => { trial = true; };
    const createRouteAttempt: typeof createAvoidAttempt = () => {
      if (!trial) return createAvoidAttempt();
      const raw = spawnAvoidWorker(avoidAssets.workerUrl);
      type WorkerEvent = { data?: unknown; message?: string };
      const jog = (event: WorkerEvent): WorkerEvent => {
        const data = event.data as { routes?: { connector: string; points: Point[] }[] } | undefined;
        const routes = data?.routes?.map(route => {
          const [s, t, ...rest] = route.points;
          if (t === undefined) return route;
          return { ...route, points: [s!, t, { x: t.x, y: t.y + 40 }, { x: t.x + 30, y: t.y + 40 }, { x: t.x + 30, y: t.y + 20 }, { x: t.x, y: t.y + 20 }, t, ...rest] };
        });
        return routes === undefined ? event : { ...event, data: { ...data, routes } };
      };
      return { assets: avoidAssets, worker: {
        postMessage: (value: unknown) => raw.postMessage(value), terminate: () => raw.terminate(),
        addEventListener: (type: string, listener: (event: WorkerEvent) => void) => raw.addEventListener(type, type === 'message' ? (event: WorkerEvent) => listener(jog(event)) : listener),
        removeEventListener: (type: string, listener: (event: WorkerEvent) => void) => raw.removeEventListener(type, listener),
      } } as ReturnType<typeof createAvoidAttempt>;
    };
    const on = await layout(written(document, true), factories);
    const model = await layout(document, { ...factories, createRouteAttempt });
    expect(trial).toBe(true);
    expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(model.diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_CHOICE)).toEqual([]);
    expect(model.removedLinks ?? []).toEqual(on.removedLinks ?? []);
    expect(plainJson(model)).toBe(plainJson(on));
  }, 240000);

  it('P1: the judge refuses a trial that drops a link even when it is better by the unified order', async () => {
    const on = json(await layout(written(sheet(LEAF), true), factories)), off = json(await layout(written(sheet(LEAF), false), factories));
    expect(judgeGrowthChoice(on, off).keep).toBe('off');
    // The off run without one link the on run draws: fewer bends still, but a different diagram.
    const dropped = JSON.parse(JSON.stringify(off)) as LayoutModel, link = dropped.links.find(item => item.path !== undefined)!;
    link.removed = true; delete link.path; dropped.removedLinks = [...dropped.removedLinks ?? [], link.id];
    expect(judgeGrowthChoice(on, dropped).keep).toBe('on');
  }, 240000);

  it('P2: one port-order inversion against three on the same face is two new findings, and the judge keeps on', async () => {
    // The reviewer's free-port probe: a remote node with three free bottom ports and three routed links to peers below, far ends in order 2,1,3 and 3,2,1.
    const on = json(await layout(written(sheet(LEAF), true), factories)), off = json(await layout(written(sheet(LEAF), false), factories));
    const clean = judgeGrowthChoice(on, off);
    expect(clean.keep).toBe('off');
    // A routed link of the on run is the template of the probe links in both runs (the off run routes none).
    const template = JSON.stringify(on.links.find(item => item.technique === 'orthogonal')!);
    for (const [model, order] of [[on, [1, 0, 2]], [off, [2, 1, 0]]] as const) {
      const base = model.nodes.feed!, edge = JSON.parse(template) as LayoutLink;
      const node = (id: string, x: number, y: number, width: number): LayoutNode => {
        const made = { ...JSON.parse(JSON.stringify(base)) as LayoutNode, id, ports: [], bounds: { x, y, width, height: 50 } };
        model.nodes[id] = made; return made;
      };
      const port = (owner: LayoutNode, x: number, y: number, ordinal: number): LayoutPort => {
        const made = { ...JSON.parse(JSON.stringify(base.ports[0]!)) as LayoutPort, ref: { node: owner.id, anonymous: true, ordinal }, owner: { kind: 'node', id: owner.id }, side: 'bottom', anchor: { x, y }, engineOrder: ordinal - 1 } as LayoutPort;
        owner.ports.push(made); return made;
      };
      const probe = node('probe', 30000, 1000, 160);
      for (let i = 0; i < 3; i++) {
        const x = 30032 + i * 40, farX = 30400 + order[i]! * 160, jogY = 1180 + i * 32;
        const a = port(probe, x, 1050, i + 1), peer = node(`peer${i}`, farX - 30, 1350, 60), b = port(peer, farX, 1350, 1);
        b.side = 'top';
        const owner = { kind: 'link', id: `probe-link-${i}` } as const, points = [a.anchor!, { x, y: jogY }, { x: farX, y: jogY }, b.anchor!];
        model.links.push({ ...edge, id: owner.id, owner, from: a.ref, to: b.ref, attachments: { from: a.ref, to: b.ref },
          path: { owner, layer: 'routed', fixed: false, segments: points.slice(1).map((to, j) => ({ from: points[j]!, to, owner })) } } as LayoutLink);
      }
    }
    const g5 = (model: LayoutModel) => score(model, { force: true }).snapshot.gates.G5!.violations.filter(item => item.elements[0] === 'probe').length;
    expect([g5(on), g5(off)]).toEqual([1, 3]);
    expect(added(gateFindings(off, 'error')!.findings, gateFindings(on, 'error')!.findings)).toEqual(['G5|port-order|probe|bottom probe.#1 > probe.#3', 'G5|port-order|probe|bottom probe.#2 > probe.#3']);
    expect(judgeGrowthChoice(on, off).keep).toBe('on');
  }, 240000);

  it('P2: one authored-order reversal against two on one node (two faces) is a new finding, and the judge keeps on', async () => {
    const on = json(await layout(written(sheet(LEAF), true), factories)), off = json(await layout(written(sheet(LEAF), false), factories));
    for (const [model, reversedSides] of [[on, ['top']], [off, ['top', 'bottom']]] as const) {
      const base = Object.values(model.nodes)[0]!, probe = JSON.parse(JSON.stringify(base)) as LayoutNode;
      probe.id = 'probe'; probe.bounds = { x: 30000, y: 20000, width: 160, height: 70 }; probe.ports = [];
      (probe as unknown as { owner: unknown }).owner = { kind: 'node', id: 'probe' };
      for (const side of ['top', 'bottom'] as const) for (let i = 0; i < 2; i++) {
        const rank = (reversedSides as readonly string[]).includes(side) ? 1 - i : i;
        probe.ports.push({ ...JSON.parse(JSON.stringify(base.ports[0]!)) as LayoutPort, id: `${side}${i}`, side, anchor: { x: 30032 + rank * 50, y: side === 'top' ? 20000 : 20070 }, authorOrder: i } as LayoutPort);
      }
      model.nodes.probe = probe;
    }
    const authored = (model: LayoutModel) => score(model, { force: true }).snapshot.gates.G5!.violations.filter(item => item.code === 'author-port-order' && item.elements[0] === 'probe').length;
    expect([authored(on), authored(off)]).toEqual([1, 2]);
    expect(added(gateFindings(off, 'error')!.findings, gateFindings(on, 'error')!.findings)).toEqual(['G5|author-port-order|probe|bottom']);
    expect(judgeGrowthChoice(on, off).keep).toBe('on');
  }, 240000);

  it('P3: a trial whose budget runs out at its last stage is not judged: the on run publishes, and the skip is named', async () => {
    moveBeforeGrowDefaultTest.on = true;
    const document = sheet(FIXTURE);
    const on = await layout(written(document, true), factories);
    let inside = false, expired = false;
    growthChoiceTest.beforeTrial = () => { inside = true; };
    const model = await layout(document, { ...factories, budget: { remainingMs: () => (expired ? 0 : 1e9), share: ms => (expired ? 0 : ms) },
      onProgress: progress => { if (inside && progress.stage === 'link-labels' && progress.trial === undefined) expired = true; } });
    expect(expired).toBe(true);
    expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    expect(skippedNotes(model).map(note => [note.stage, note.severity, note.message]))
      .toEqual([['placement', 'info', trialSkippedMessage({ code: 'deadline', message: 'the command budget ran out during the trial' })]]);
    const plain = json(model);
    plain.diagnostics = plain.diagnostics.filter(note => note.code !== MOVE_BEFORE_GROW_TRIAL_SKIPPED);
    expect(plainJson(plain)).toBe(plainJson(on));
    expect(restoreFinalLayout(serializeLayoutModel(model)).diagnostics.filter(note => note.code === MOVE_BEFORE_GROW_TRIAL_SKIPPED)).toHaveLength(1);
  }, 240000);

  it('P4: the trigger reads the bends of the scorer, not the segments of a path', async () => {
    const model = json(await layout(written(sheet(LEAF), true), factories));
    const link = model.links.find(item => item.path?.segments.length === 1)!;
    const note: Diagnostic = { stage: 'placement', severity: 'warning', code: 'CENTRE_ALIGNMENT_INFEASIBLE', message: 'probe', owners: [{ kind: 'link', id: link.id }] };
    const variant = (edit: (copy: LayoutModel, copyLink: LayoutLink) => void): LayoutModel => {
      const copy = JSON.parse(JSON.stringify(model)) as LayoutModel, copyLink = copy.links.find(item => item.id === link.id)!;
      copy.diagnostics = [{ ...note }];
      edit(copy, copyLink);
      return copy;
    };
    const split = (copyLink: LayoutLink, dx: number, dy: number): void => {
      const s = copyLink.path!.segments[0]!, mid = { x: (s.from.x + s.to.x) / 2 + dx, y: (s.from.y + s.to.y) / 2 + dy };
      copyLink.path!.segments = [{ ...s, to: mid }, { ...s, from: mid }];
    };
    const straight = variant(() => {}), splitStraight = variant((_, item) => split(item, 0, 0)), bent = variant((_, item) => split(item, 15, 29));
    expect(pathBends(splitStraight.links.find(item => item.id === link.id)!)).toBe(0);
    expect([growthShort(straight), growthShort(splitStraight), growthShort(bent)]).toEqual([false, false, true]);
    // The seat-decline arm requires the stage of its one writer (`seat-set.ts`).
    const seat = (stage: Diagnostic['stage']) => variant(copy => { copy.diagnostics = [{ stage, severity: 'info', code: 'SEAT_SET_DECLINED', message: 'probe' }]; });
    expect([growthShort(seat('placement')), growthShort(seat('final-geometry')), growthShort(seat('parse'))]).toEqual([true, false, false]);
  }, 240000);

  it('P4: a caller\'s note with the seat-decline code fires no trial, at any stage', async () => {
    // The reviewer's public replay: v7-3-0 runs once with the option on; a caller's SEAT_SET_DECLINED made it keep an off trial.
    moveBeforeGrowDefaultTest.on = true;
    const document = sheet('test/fixtures/sweep/v7-3-0.yaml');
    for (const stage of ['parse', 'placement'] as const) {
      let trials = 0;
      growthChoiceTest.beforeTrial = () => { trials++; };
      const model = await layout(document, { ...factories, diagnostics: [{ stage, code: 'SEAT_SET_DECLINED', severity: 'info', message: 'from caller' }] });
      expect([stage, trials]).toEqual([stage, 0]);
      expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    }
  }, 240000);

  it('P5: a worker bug in the option-off trial keeps the on run and is named as a warning', async () => {
    moveBeforeGrowDefaultTest.on = true;
    const document = sheet(FIXTURE);
    const on = await layout(written(document, true), factories);
    let inside = false, worker = 0;
    growthChoiceTest.beforeTrial = () => { inside = true; };
    const createElkAttempt: typeof createAttempt = () => {
      if (!inside) return createAttempt();
      worker++;
      return { terminateWorker() {}, layout() { throw new TypeError('trial worker smoke'); } } as unknown as ReturnType<typeof createAttempt>;
    };
    const model = await layout(document, { ...factories, createElkAttempt });
    expect(worker).toBeGreaterThan(0);
    expect(model.moveBeforeGrowRun).toEqual({ requested: 'default', effective: 'on' });
    const notes = skippedNotes(model);
    expect(notes.map(note => [note.stage, note.severity])).toEqual([['placement', 'warning']]);
    expect(notes[0]!.message).toMatch(/^layout\.moveBeforeGrow is not written and runs on by default; that run left a seat short, but the option-off trial decided nothing \(/);
    expect(render(model)).toBe(render(on));
    // The record check reads the shape of the note: one, at stage placement, info or warning, on an on run only.
    const saved = json(model);
    const forge = (edit: (copy: LayoutModel) => void): string => { const copy = JSON.parse(JSON.stringify(saved)) as LayoutModel; edit(copy); return JSON.stringify(copy); };
    const note = (copy: LayoutModel) => copy.diagnostics.find(item => item.code === MOVE_BEFORE_GROW_TRIAL_SKIPPED)!;
    expect(() => restoreFinalLayout(JSON.stringify(saved))).not.toThrow();
    expect(() => restoreFinalLayout(forge(copy => { copy.diagnostics.push({ ...note(copy) }); }))).toThrow(/more than one skipped-trial note/);
    expect(() => restoreFinalLayout(forge(copy => { note(copy).stage = 'final-geometry'; }))).toThrow(/skipped-trial note has the stage final-geometry/);
    expect(() => restoreFinalLayout(forge(copy => { note(copy).severity = 'error'; }))).toThrow(/skipped-trial note has the stage placement and the severity error/);
    expect(() => restoreFinalLayout(forge(copy => { delete copy.moveBeforeGrowRun; }))).toThrow(/a skipped-trial note without a record/);
  }, 240000);
});

