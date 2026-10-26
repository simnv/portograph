import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { LINK_LABEL_GEOMETRY, haloSize, reservedLinkRuns } from '../../src/layout/link-labels.js';
import { labelBorders, labelRunWindows, windowHolds } from '../../src/layout/run-label-box.js';
import { labelRoomUnsettledFault, reserveLinkLabelRoom, validateGroupLabelBands, type LinkLabelShortfall } from '../../src/layout/bands.js';
import { attemptTimings, resetAttemptTimings } from '../../src/layout/attempt-timings.js';
import { replayRegions, settleRound, type AttemptTraceEvent, type SettleStep } from '../../src/layout/placement-attempt.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { rebuildNodeGeometry } from '../../src/layout/node-geometry.js';
import { measureText } from '../../src/text/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const run = (yaml: string, attemptTrace?: (event: AttemptTraceEvent) => void) =>
  layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, ...(attemptTrace ? { attemptTrace } : {}) });
const name = 'a-label-window-holds-when-a-move-turns-its-line';
const fixture = readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

/** The windows of `id`'s line that its turned label may take: between the drawn borders, clear of the reserved link runs (as 7f and stage 9 read them). */
function lineWindows(model: LayoutModel, id: string): { longest: number; holds: boolean; width: number } {
  const link = model.links.find(item => item.id === id)!;
  const text = model.document.links[link.sourceIndex]!.label!;
  const measured = measureText(text, { fontSize: LINK_LABEL_GEOMETRY.fontSize, weight: LINK_LABEL_GEOMETRY.fontWeight });
  const segments = link.path!.segments;
  expect(segments).toHaveLength(1);
  const windows = labelRunWindows(labelBorders(model), segments[0]!, haloSize(measured).height, reservedLinkRuns(model, id)) ?? [];
  return { longest: Math.max(0, ...windows.map(window => window.to - window.from)), holds: windows.some(window => windowHolds(window, measured.width)), width: measured.width };
}

// Architecture-2 ticket 27: the step over a chord turned link-4's line after the producer reserved its window, and nothing reserved the
// room again, so `validateGroupLabelBands` threw. Every settle round now reserves the room on the geometry it settles.
it('a 7f move that turns a labelled line keeps the window its label holds (ticket 27)', async () => {
  const model = await run(fixture);
  const window = lineWindows(model, 'link-4');
  expect(window.holds).toBe(true);
  expect(window.longest).toBeGreaterThanOrEqual(window.width);
  const label = model.labels.find(item => item.id === 'label:link:link-4')!;
  expect(label.omitted).toBeUndefined();
  expect(label.onLine).toBe(true);
  expect(model.diagnostics.filter(item => item.code === 'LINK_LABEL_ON_BORDER' || item.code === 'LINK_LABEL_ROOM_UNRESERVED')).toEqual([]);
  const report = score(model).snapshot;
  expect(report.counters.labelBorderCrossings).toBeUndefined();
  expect(Object.values(report.gates).filter(gate => gate.severity === 'error' && !gate.passed)).toEqual([]);
  // The reservation is at its fixed point: the validator's replay reserves nothing more (R1).
  const shortfalls: LinkLabelShortfall[] = [];
  expect(reserveLinkLabelRoom(structuredClone(model), shortfalls)).toBe(false);
  expect(shortfalls).toEqual([]);
}, 120000);

// The diagnosis found the throw with g2a and g2b in either order: the order decides which moves happen, not whether the room holds (R3).
it('the window holds with the groups of the lower tier declared the other way round (ticket 27)', async () => {
  const swapped = fixture.replace(/( {2}g2a: .*\n)( {2}g2b: .*\n)/, '$2$1');
  expect(swapped).not.toBe(fixture);
  const model = await run(swapped);
  expect(lineWindows(model, 'link-4').holds).toBe(true);
  expect(reserveLinkLabelRoom(structuredClone(model))).toBe(false);
}, 120000);

// The windows skip a link run that stands too far from the line to cut one (the search is not run): the windows are those without it,
// and a run within reach still cuts (ticket 27 made 7f read the windows in every settle round).
it('a link run beyond the reach of a diagonal label cuts no window, one within it does (ticket 27)', () => {
  const owner = { kind: 'link' as const, id: 'own' };
  const run = { from: { x: 0, y: 0 }, to: { x: 200, y: 150 }, owner };
  const across = 14, clearance = 0.75, h = across / 2;
  const reach = h + LINK_LABEL_GEOMETRY.halo + 1 + clearance;
  const ux = 0.8, uy = 0.6, nx = -uy, ny = ux;
  const alone = labelRunWindows([], run, across)!;
  // A short run across the line's extension, 0.01 px past the reach beyond the end (200, 150): skipped, the windows are those without it.
  const tip = { x: 200 + ux * (reach + 0.01), y: 150 + uy * (reach + 0.01) };
  const past = { segment: { from: { x: tip.x + nx * 5, y: tip.y + ny * 5 }, to: { x: tip.x - nx * 5, y: tip.y - ny * 5 } }, clearance };
  expect(labelRunWindows([], run, across, [past])).toEqual(alone);
  // Beside the middle of the line, parallel to it: 0.01 px past the reach it is skipped; within the label's half height and clearance it cuts.
  const beside = (offset: number) => ({ segment: { from: { x: 80 + nx * offset, y: 60 + ny * offset }, to: { x: 120 + nx * offset, y: 90 + ny * offset } }, clearance });
  expect(labelRunWindows([], run, across, [beside(reach + 0.01)])).toEqual(alone);
  expect(labelRunWindows([], run, across, [beside(h + clearance - 0.1)])!.length).toBe(2);
  const near = { segment: { from: { x: 100, y: 0 }, to: { x: 100, y: 150 } }, clearance };
  expect(labelRunWindows([], run, across, [near])!.length).toBe(2);
});

/** The draft of the fixture's first 7f round after its settle (the state the chord trials are judged against), with g1a slid as the chord step slides it. */
async function movedDraft(): Promise<LayoutModel> {
  let base: LayoutModel | undefined;
  attemptTimings.on = true;
  attemptTimings.hooks.base = draft => { base ??= structuredClone(draft); };
  try { await run(fixture); } finally { attemptTimings.on = false; resetAttemptTimings(); }
  const draft = base!;
  const group = draft.groups.g1a!;
  moveGroup(draft, group, 21.5, 0);
  rebuildNodeGeometry(draft, group.nodes, 'current');
  replayRegions(draft);
  return draft;
}

// Review fixes of ticket 27: the room is the last step of a settle, and the pass bound gives a short room up rather than leave it to a throw (R2, R6).
it('a settle ends on the label room: after the slide the room is reserved and nothing moves after it (ticket 27)', async () => {
  const draft = await movedDraft();
  expect(reserveLinkLabelRoom(structuredClone(draft))).toBe(true);
  const steps: [SettleStep, boolean][] = [];
  settleRound(draft, (step, changed) => { steps.push([step, changed]); });
  expect(steps.at(-1)).toEqual(['room', false]);
  // Every room pass that reserved is followed by the close-up, the keep-out and the room again.
  const reserved = [...steps.entries()].filter(([, [step, changed]]) => step === 'room' && changed).map(([at]) => at);
  expect(reserved.length).toBeGreaterThan(0);
  for (const at of reserved) expect(steps.slice(at + 1, at + 4).map(item => item[0])).toEqual(['close-up', 'keep-out', 'room']);
  expect(reserveLinkLabelRoom(structuredClone(draft))).toBe(false);
  expect(draft.labelRoomUnsettled).toBeUndefined();
}, 120000);

it('at the pass bound a short label room is given up, recorded and named, and the reservation holds (ticket 27)', async () => {
  const draft = await movedDraft();
  settleRound(draft, undefined, 0);
  expect(draft.labelRoomUnsettled).toEqual(['link-4']);
  expect(draft.diagnostics.filter(item => item.code === 'LINK_LABEL_ROOM_UNSETTLED').map(item => item.owners)).toEqual([[{ kind: 'link', id: 'link-4' }]]);
  expect(labelRoomUnsettledFault(draft)).toBeUndefined();
  const replay = structuredClone(draft);
  expect(reserveLinkLabelRoom(replay)).toBe(false);
  expect(replay.diagnostics.some(item => item.code === 'LINK_LABEL_ROOM_UNRESERVED' && JSON.stringify(item.owners) === JSON.stringify([{ kind: 'link', id: 'link-4' }]))).toBe(true);
}, 120000);

it('a forged record of the label rooms given up is refused (ticket 27, R5)', async () => {
  const model = await run(fixture);
  expect(() => validateGroupLabelBands(model)).not.toThrow();
  for (const record of [['nope'], ['link-1'], ['link-4', 'link-4'], ['link-4', 'link-3'], []]) {
    const forged = structuredClone(model);
    forged.labelRoomUnsettled = record;
    expect(labelRoomUnsettledFault(forged)).toBeDefined();
    expect(() => validateGroupLabelBands(forged)).toThrow(/label rooms 7f gave up is forged/);
  }
  const honest = structuredClone(model);
  honest.labelRoomUnsettled = ['link-3', 'link-4'];
  expect(labelRoomUnsettledFault(honest)).toBeUndefined();
}, 120000);

// A canton sheet whose close-up moves: in every round of the trace the label room comes after the last close-up and keep-out.
it('the label room is the last step of every round on a sheet the close-up moves (ticket 27)', async () => {
  const events: AttemptTraceEvent[] = [];
  await run(readFileSync(new URL('../../goldens/synthetic/three-canton-groups-close-up-to-a-band-gap.yaml', import.meta.url), 'utf8'), event => events.push(event));
  const rounds = new Map<string, string[]>();
  for (const { pass } of events) {
    const found = /^ledger:(round-\d+|tail):(room|close-up|keep-out)$/.exec(pass);
    if (found) rounds.set(found[1]!, [...(rounds.get(found[1]!) ?? []), found[2]!]);
  }
  expect(rounds.size).toBeGreaterThan(0);
  expect([...rounds.values()].flat()).toContain('close-up');
  for (const steps of rounds.values()) expect(steps.at(-1)).toBe('room');
}, 120000);
