import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { centreDraft, createCentreBudget } from '../../src/layout/centre.js';
import { flanks } from '../../src/layout/flanks.js';
import { lanes } from '../../src/layout/lanes.js';
import { withLayoutMutation } from '../../src/layout/mutation.js';
import { rows } from '../../src/layout/rows.js';
import { OVERLAY_WINDOW_TAKEN, placeOverlayFree, sheetGains, windowsHold } from '../../src/layout/overlay-place.js';
import { overlayBlockers, overlayPath } from '../../src/layout/overlay-paths.js';
import { CHORD_WINDOW_TRIALS, EVENT_TRIALS, chordWindows, drawn, overlayCrossings, pickTarget, portKey, type Drawn } from '../../src/layout/overlay-window.js';
import { PLACEMENT_EPS } from '../../src/layout/tolerance.js';
import { createAttempt, placed } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const run = (name: string) => layout(parse(fixture(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const centreX = (box: Rect): number => box.x + box.width / 2;
const right = (box: Rect): number => box.x + box.width;
const bentTo = (model: LayoutModel, group: string): string[] => model.links
  .filter(link => link.layer === 'overlay' && model.document.nodes[link.attachments!.to.node]!.group.startsWith(group) && overlayPath(model, link).segments.length > 1)
  .map(link => link.id);
const groupOf = (model: LayoutModel, id: string) => Object.values(model.groups).find(group => group.id === id || group.id === `${id}#0`)!;
const bounds = (model: LayoutModel): string => JSON.stringify(Object.values(model.groups).map(group => group.bounds));

const crossingsOf = (model: LayoutModel): number => {
  const blockers = overlayBlockers(model), paths: Drawn[] = [];
  for (const link of model.links) {
    if (link.layer !== 'overlay' || link.meshBus !== undefined || !link.attachments) continue;
    const { segments } = overlayPath(model, link, blockers);
    paths.push(drawn([segments[0]!.from, ...segments.map(segment => segment.to)], [portKey(link.attachments.from), portKey(link.attachments.to)]));
  }
  return overlayCrossings(paths);
};

const CANTON = 'stacked-free-members-clear-each-others-chords', PLAIN = 'stacked-free-groups-clear-each-others-chords';

// Ranked-groups ticket 143 (decisions-log Q112): a free group or a free canton member stands where its overlay chords are straight.
describe('overlay window rule (ticket 143)', () => {
  // On the mean of the partners four chords to `lower-clients` cross the row of `upper-clients`.
  it('a free canton member stands where the chords to it are straight, not at the mean of its partners', async () => {
    const model = await run(CANTON);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(bentTo(model, 'lower-clients').length).toBeLessThanOrEqual(1);
    const lower = groupOf(model, 'lower-clients');
    // The mean of the partners is the canton axis, 289.5. Ticket 143 put it at 439.9, the x with the most straight chords; ticket 147 (straight first, then crossings) puts it at 441.9.
    expect(centreX(lower.bounds!)).toBeCloseTo(441.9, 0);
    const note = model.diagnostics.find(item => item.code === OVERLAY_WINDOW_TAKEN)!;
    expect(note.severity).toBe('info');
    expect(note.owners).toEqual([{ kind: 'group', id: lower.id }]);
    expect(note.message).toMatch(/the mean of its partners: \d+ fewer overlay crossings?, \d+ (more|fewer) overlay chords? (is|are) straight\./);
  }, 60000);

  it('the same rule holds for a free group with no canton', async () => {
    const model = await run(PLAIN);
    expect(bentTo(model, 'lower-clients').length).toBeLessThanOrEqual(1);
    const lower = groupOf(model, 'lower-clients');
    expect(Math.abs(centreX(lower.bounds!) - 239.5)).toBeGreaterThan(20);
    expect(centreX(lower.bounds!)).toBeCloseTo(354.1, 0);
  }, 60000);

  // Guards.
  it('the canvas is no wider, the member stays inside its canton, and every gate passes', async () => {
    const model = await run(CANTON);
    expect(model.canvas!.width).toBeCloseTo(580.5, 1);
    const west = deriveFrames(model)!.find(frame => frame.id === 'west')!.box;
    for (const id of ['upper-clients', 'lower-clients']) {
      const box = groupOf(model, id).bounds!;
      expect(box.x).toBeGreaterThanOrEqual(west.x + 20 - 1e-6);
      expect(right(box)).toBeLessThanOrEqual(right(west) - 20 + 1e-6);
    }
    expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
    expect((await run(PLAIN)).canvas!.width).toBeCloseTo(480.5, 1);
  }, 60000);

  // The pass is repeatable: a second run reads the geometry the first one left and moves nothing.
  it('a second run of the pass moves nothing', async () => {
    for (const name of [CANTON, PLAIN]) {
      const model = structuredClone(await run(name)) as LayoutModel;
      // The rule is on: the lower group does not stand at the mean, so the test reads the settled reading and not a model that never moved.
      expect(model.diagnostics.some(item => item.code === OVERLAY_WINDOW_TAKEN), name).toBe(true);
      placeOverlayFree(model);
      const first = bounds(model);
      placeOverlayFree(model);
      expect(bounds(model), name).toBe(first);
    }
  }, 60000);

  // Ticket 143, coordinator measure: a window that straightens the chords it counts and bends one it does not count must be refused.
  // On `three-continents` the first build moved `cl-a4` (one chord gained) and `loc-a1-sw` to `cl-a3-1` bent at 4 turns: 8 bent links and 34 turns
  // on main, 9 and 38 then.
  it('three-continents: the windows never add a bent overlay link or a turn (the whole-sheet guard)', async () => {
    const model = await run('three-continents');
    const overlays = model.links.filter(link => link.layer === 'overlay' && link.meshBus === undefined);
    const turns = overlays.map(link => overlayPath(model, link).segments.length - 1);
    expect(turns.filter(count => count > 0).length).toBeLessThanOrEqual(8);
    expect(turns.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(34);
    expect(crossingsOf(model)).toBeLessThanOrEqual(66);
  }, 120000);

  // Unit: the blocked shifts of one chord and one body, to the epsilon.
  describe('chordWindows', () => {
    const body: Rect = { x: 40, y: 40, width: 20, height: 20 };
    it('a fixed chord and a body that moves: the shifts that put the body on it', () => {
      const [window] = chordWindows({ x: 0, y: 0 }, { x: 100, y: 100 }, 'shape', body);
      expect(Math.abs(window!.low - -20)).toBeLessThan(2 * PLACEMENT_EPS);
      expect(Math.abs(window!.high - 20)).toBeLessThan(2 * PLACEMENT_EPS);
    });
    it('a body that stands and a chord whose upper end moves: the shifts that swing it onto the body', () => {
      const [window] = chordWindows({ x: 0, y: 0 }, { x: 100, y: 100 }, 'from', body);
      expect(Math.abs(window!.low - -50)).toBeLessThan(2 * PLACEMENT_EPS);
      expect(Math.abs(window!.high - 100 / 3)).toBeLessThan(2 * PLACEMENT_EPS);
    });
    it('a chord that does not reach the rows of the body is never blocked', () => {
      expect(chordWindows({ x: 0, y: 0 }, { x: 100, y: 30 }, 'shape', body)).toEqual([]);
      expect(chordWindows({ x: 0, y: 0 }, { x: 100, y: 30 }, 'to', body)).toEqual([]);
    });
    it('a chord that only touches the body edge is not blocked', () => {
      expect(chordWindows({ x: 0, y: 40 }, { x: 100, y: 40 }, 'shape', body)).toEqual([]);
    });
  });

  // Unit: the whole-sheet guard. No more turns, and fewer bent links or as many and fewer crossings; a tie keeps the means.
  describe('sheetGains', () => {
    const before = { bent: 8, turns: 34, crossings: 66 };
    it('keeps the windows that save crossings and bend no more links', () => {
      expect(sheetGains({ bent: 8, turns: 34, crossings: 60 }, before)).toBe(true);
    });
    it('keeps the windows that bend fewer links, even with more crossings (the straight links come first)', () => {
      expect(sheetGains({ bent: 7, turns: 30, crossings: 70 }, before)).toBe(true);
    });
    it('refuses more turns, more bent links, more crossings at the same bent count, and a tie', () => {
      // Three-continents: one link fewer bent, more turns.
      expect(sheetGains({ bent: 7, turns: 38, crossings: 60 }, before)).toBe(false);
      expect(sheetGains({ bent: 9, turns: 34, crossings: 60 }, before)).toBe(false);
      expect(sheetGains({ bent: 8, turns: 34, crossings: 67 }, before)).toBe(false);
      expect(sheetGains(before, before)).toBe(false);
    });
  });

  // Unit: the tier guard. More straight links hold; the same straight links hold with no more crossings; a swap is refused.
  describe('windowsHold', () => {
    const set = (...ids: string[]) => new Set(ids);
    it('holds where the windows bend one straight link and straighten two', () => {
      expect(windowsHold(set('b', 'c', 'd'), set('a', 'b'), () => 35, 34)).toBe(true);
    });
    it('refuses a tie in the straight links where the crossings rise', () => {
      expect(windowsHold(set('a', 'b'), set('a', 'b'), () => 35, 34)).toBe(false);
    });
    it('refuses a swap: as many straight links, one of them not the same', () => {
      expect(windowsHold(set('a', 'c'), set('a', 'b'), () => 10, 34)).toBe(false);
    });
    it('holds a tie with no more crossings, and does not read the crossings when the straight test fails', () => {
      expect(windowsHold(set('a', 'b'), set('a', 'b'), () => 34, 34)).toBe(true);
      expect(windowsHold(set('c', 'd'), set('a', 'b', 'c'), () => { throw new Error('read'); }, 34)).toBe(false);
    });
  });

  // A window is placement's decision: a run without windows, which the early passes and the replays after 7f make, does not undo it.
  it('a run without windows leaves a window-placed group where the windows put it', async () => {
    for (const name of [CANTON, PLAIN]) {
      const model = structuredClone(await run(name)) as LayoutModel;
      const note = model.diagnostics.find(item => item.code === OVERLAY_WINDOW_TAKEN)!;
      const first = bounds(model);
      placeOverlayFree(model, undefined, false);
      expect(bounds(model), name).toBe(first);
      expect(model.diagnostics.some(item => item.code === OVERLAY_WINDOW_TAKEN && item.message === note.message), name).toBe(true);
    }
  }, 60000);

  // Unit: the choice of the candidate, on forged scores (the most straight chords first, then the fewest crossings).
  describe('pickTarget', () => {
    type Row = [straight: number, crossings: number, bendsMean?: boolean];
    const score = (table: Record<number, Row>) => (x: number) => { const [straight, crossings, bendsMean] = table[x]!; return { straight, crossings, bendsMean: bendsMean ?? false }; };
    it('more straight chords win over fewer crossings', () => {
      const pick = pickTarget(100, [140, 60], score({ 100: [2, 5], 140: [3, 9], 60: [2, 1] }));
      expect(pick).toEqual({ target: 140, gained: 1, saved: -4 });
    });
    it('a tie in straight chords goes to the fewest crossings', () => {
      const pick = pickTarget(100, [140, 60], score({ 100: [2, 5], 140: [2, 3], 60: [2, 2] }));
      expect(pick).toEqual({ target: 60, gained: 0, saved: 3 });
    });
    it('a swap is refused: a tie in straight chords that bends a chord straight at the mean takes no crossing gain', () => {
      expect(pickTarget(100, [140], score({ 100: [2, 5], 140: [2, 1, true] })).target).toBe(100);
    });
    it('a tie in both goes to the nearest to the mean, then the smaller x', () => {
      const tie = score({ 100: [2, 5], 130: [2, 3], 110: [2, 3], 90: [2, 3] });
      expect(pickTarget(100, [130, 110, 90], tie).target).toBe(90);
      expect(pickTarget(100, [130, 110], tie).target).toBe(110);
    });
    it('stays at the mean where no candidate is better', () => {
      expect(pickTarget(100, [140, 60], score({ 100: [2, 5], 140: [2, 5], 60: [1, 0] })).target).toBe(100);
    });
    it('passes the best straight count, so a candidate that cannot win is not counted for crossings', () => {
      const asked: [number, number][] = [];
      pickTarget(100, [140, 60], (x, atLeast) => { asked.push([x, atLeast]); return { straight: x === 100 ? 3 : 2, crossings: 1, bendsMean: false }; });
      expect(asked).toEqual([[100, 0], [60, 3], [140, 3]]);
    });
    it('reads at most CHORD_WINDOW_TRIALS candidates and EVENT_TRIALS events, nearest first', () => {
      const candidates = Array.from({ length: CHORD_WINDOW_TRIALS + 5 }, (_, index) => 101 + index);
      const events = Array.from({ length: EVENT_TRIALS + 5 }, (_, index) => 201 + index);
      const seen: number[] = [];
      pickTarget(100, candidates, x => { seen.push(x); return { crossings: 5, straight: 0, bendsMean: false }; }, events);
      expect(seen).toHaveLength(CHORD_WINDOW_TRIALS + EVENT_TRIALS + 1);
      expect(Math.max(...seen)).toBe(200 + EVENT_TRIALS);
    });
  });

  // Ticket 147: the pass reads crossings first. One pass on the draft of the fixture, as `centreDraft` reads it, before 7f and the pack move
  // anything: the shared group stands between the two locations and its links cross no more than on ticket 143's rule (34).
  describe('crossings first (ticket 147)', () => {
    const CROSS = 'a-free-client-group-stands-where-its-overlay-links-cross-least';
    it('one pass: the shared group stands between the locations and the overlay links cross at most 34 times', async () => {
      const model = flanks(lanes(rows(await placed(fixture(CROSS)))));
      const seen: { west: number; east: number; shared: number; crossings: number }[] = [];
      withLayoutMutation(model, 'centre', draft => {
        // `centreDraft` runs the passes of the steps and then the pass with windows, as the pipeline does.
        centreDraft(draft, createCentreBudget());
        seen.push({ west: centreX(draft.groups['west']!.bounds!), east: centreX(draft.groups['east']!.bounds!),
          shared: centreX(draft.groups['shared-clients']!.bounds!), crossings: crossingsOf(draft) });
      });
      const [pass] = seen;
      expect(pass!.shared).toBeGreaterThan(pass!.west);
      expect(pass!.shared).toBeLessThan(pass!.east);
      expect(pass!.crossings).toBeLessThanOrEqual(34);
    }, 60000);
    it('the whole layout has no more crossings than ticket 143 left, and every gate passes', async () => {
      const model = await run(CROSS);
      expect(crossingsOf(model)).toBeLessThanOrEqual(34);
      expect(Object.values(score(model).snapshot.gates).every(gate => gate.passed)).toBe(true);
    }, 60000);
    it('a second run of the pass moves nothing, and a run without windows holds the group', async () => {
      const model = structuredClone(await run(CROSS)) as LayoutModel;
      expect(model.diagnostics.some(item => item.code === OVERLAY_WINDOW_TAKEN)).toBe(true);
      placeOverlayFree(model);
      const first = bounds(model);
      placeOverlayFree(model);
      expect(bounds(model)).toBe(first);
      placeOverlayFree(model, undefined, false);
      expect(bounds(model)).toBe(first);
    }, 60000);
  });
});
