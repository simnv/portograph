import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LayoutModel, Rect } from '../../src/index.js';
import { layout, parse, score } from '../../src/index.js';
import { deriveFrames } from '../../src/layout/frames.js';
import { OVERLAY_WINDOW_TAKEN, placeOverlayFree, sheetGains, windowsHold } from '../../src/layout/overlay-place.js';
import { overlayPath } from '../../src/layout/overlay-paths.js';
import { CHORD_WINDOW_TRIALS, chordWindows, pickTarget } from '../../src/layout/overlay-window.js';
import { PLACEMENT_EPS } from '../../src/layout/tolerance.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
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

const CANTON = 'stacked-free-members-clear-each-others-chords', PLAIN = 'stacked-free-groups-clear-each-others-chords';

// Ranked-groups ticket 143 (decisions-log Q112): a free group or a free canton member stands where its overlay chords are straight.
describe('overlay window rule (ticket 143)', () => {
  // On the mean of the partners four chords to `lower-clients` cross the row of `upper-clients`.
  it('a free canton member stands where the chords to it are straight, not at the mean of its partners', async () => {
    const model = await run(CANTON);
    expect(model.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(bentTo(model, 'lower-clients').length).toBeLessThanOrEqual(1);
    const lower = groupOf(model, 'lower-clients');
    // The mean of the partners is the canton axis, 289.5. The best window is 439.9: the nearest x where the most chords are straight.
    expect(centreX(lower.bounds!)).toBeCloseTo(439.9, 0);
    const note = model.diagnostics.find(item => item.code === OVERLAY_WINDOW_TAKEN)!;
    expect(note.severity).toBe('info');
    expect(note.owners).toEqual([{ kind: 'group', id: lower.id }]);
    expect(note.message).toContain('the mean of its partners: 3 more overlay chords are straight');
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

  // Unit: the whole-sheet guard. Fewer bent links and no more turns; the case of three-continents (one link fewer bent, more turns) is refused.
  describe('sheetGains', () => {
    it('keeps the windows that bend fewer links and add no turn', () => {
      expect(sheetGains({ bent: 7, turns: 30 }, { bent: 8, turns: 34 })).toBe(true);
    });
    it('refuses more bent links, or more turns, or no gain', () => {
      expect(sheetGains({ bent: 9, turns: 38 }, { bent: 8, turns: 34 })).toBe(false);
      expect(sheetGains({ bent: 7, turns: 36 }, { bent: 8, turns: 34 })).toBe(false);
      expect(sheetGains({ bent: 8, turns: 30 }, { bent: 8, turns: 34 })).toBe(false);
    });
  });

  // Unit: the tier guard (ticket test 4). The windows hold where they leave more links straight than the means do.
  describe('windowsHold', () => {
    it('holds where the windows bend one straight link and straighten two', () => {
      // Means: a, b straight. Windows: b, c, d straight (a bent, c and d straightened).
      expect(windowsHold(new Set(['b', 'c', 'd']), new Set(['a', 'b']))).toBe(true);
    });
    it('refuses where the windows bend two straight links and straighten one', () => {
      expect(windowsHold(new Set(['c', 'd']), new Set(['a', 'b', 'c']))).toBe(false);
    });
    it('refuses a tie', () => {
      expect(windowsHold(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(false);
    });
  });

  // Unit: the choice of the candidate, on forged straight counts.
  describe('pickTarget', () => {
    it('moves where the window straightens two chords and bends one', () => {
      // At the mean 2 chords are straight. At 140 one of them bends and two others straighten: 3.
      const count = (x: number): number => x === 100 ? 2 : x === 140 ? 3 : 0;
      expect(pickTarget(100, [140, 60], count)).toEqual({ target: 140, gained: 1 });
    });
    it('stays at the mean where the window straightens one chord and bends two', () => {
      const count = (x: number): number => x === 100 ? 2 : x === 140 ? 1 : 0;
      expect(pickTarget(100, [140, 60], count)).toEqual({ target: 100, gained: 0 });
    });
    it('takes the nearest of equal candidates, and the smaller x of two at one distance', () => {
      expect(pickTarget(100, [130, 110, 90], x => x === 100 ? 1 : 2).target).toBe(90);
      expect(pickTarget(100, [130, 110], x => x === 100 ? 1 : 2).target).toBe(110);
    });
    it('reads at most CHORD_WINDOW_TRIALS candidates, nearest first', () => {
      const candidates = Array.from({ length: CHORD_WINDOW_TRIALS + 5 }, (_, index) => 101 + index);
      const seen: number[] = [];
      pickTarget(100, candidates, x => { seen.push(x); return x === 100 ? 0 : 1; });
      expect(seen).toHaveLength(CHORD_WINDOW_TRIALS + 1);
      expect(Math.max(...seen)).toBe(100 + CHORD_WINDOW_TRIALS);
    });
  });
});
