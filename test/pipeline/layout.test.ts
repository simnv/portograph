import { APPROVED_Q } from '../golden-baseline.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommandDeadlineError, createBudget, layout, parseWithDiagnostics, render, restoreFinalLayout, score, serializeLayoutModel } from '../../src/index.js';
import { restoreLayoutModel, UNBOUNDED_BUDGET } from '../../src/internal.js';
import type { GateId, LayoutProgress } from '../../src/index.js';
import type { ElkAttempt, ElkClock } from '../../src/internal.js';
import { skeleton } from '../../src/layout/skeleton.js';
import { ElkDeadlineError } from '../../src/layout/elk-worker.js';
import { sidesOne } from '../../src/layout/sides-one.js';
import { sizeNodes } from '../../src/layout/size.js';
import { resolve } from '../../src/resolve/index.js';
import { parse } from '../../src/parse/index.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const goldenYaml = readFileSync(new URL('../../goldens/m1-sip-edge.yaml', import.meta.url), 'utf8');

const threeTiers = `portograph: 2
groups: {top: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}
nodes:
  a: {group: top, ports: [{name: p, side: bottom}]}
  m: {group: mid, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}
  b: {group: low, ports: [{name: p, side: top}]}
  c: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}
links: [[a.p, b.p], [m.p, c.p], [m.q, c.q]]`;

/**
 * Two tiers with one gap the router really has to answer. Stage 8 claims a gap whose two ends stand
 * on one line and whose corridor is clear, so `threeTiers` never opens a route session; a right
 * port feeding a top port has to turn.
 */
const bendingTiers = `portograph: 2
groups: {top: {tier: 0}, low: {tier: 1}}
nodes:
  a: {group: top, ports: [{name: p, side: right}]}
  z: {group: top}
  b: {group: low, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`;

/** A clock whose `now` the test advances by hand, and which records every deadline asked of it. */
function recordingClock(): { clock: ElkClock; deadlines: number[]; advance: (ms: number) => void; now: () => number } {
  let virtual = 0;
  const deadlines: number[] = [];
  return {
    deadlines,
    advance: (ms) => { virtual += ms; },
    now: () => virtual,
    clock: {
      now: () => virtual,
      // Delegate to a real timer so a genuine stall would still be cut off; the recorded number is
      // the deadline the stage really asked for.
      setTimeout: (callback, delayMs) => { deadlines.push(delayMs); return setTimeout(callback, Math.min(delayMs, 60000)); },
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
    },
  };
}

describe('the shared command budget', () => {
  it('gives a stage the smaller of its policy and the remainder, and never goes negative', () => {
    let now = 1000;
    const budget = createBudget(500, () => now);
    expect(budget.remainingMs()).toBe(500);
    expect(budget.share(10000)).toBe(500);
    expect(budget.share(100)).toBe(100);
    now = 1400;
    expect(budget.remainingMs()).toBe(100);
    expect(budget.share(10000)).toBe(100);
    now = 9999;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.share(10000)).toBe(0);
  });

  it('refuses a budget that is not a positive finite number of milliseconds', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createBudget(value)).toThrow(/positive and finite/);
    }
  });

  it('leaves a library caller without a deadline on its stage policy', () => {
    expect(UNBOUNDED_BUDGET.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(UNBOUNDED_BUDGET.share(10000)).toBe(10000);
  });
});

describe('ELK attempts draw from one remainder', () => {
  it('gives every fallback band what is left, not a fresh policy', async () => {
    const { clock, deadlines, advance, now } = recordingClock();
    const model = sizeNodes(sidesOne(resolve(parse(threeTiers))));
    let attempts = 0;
    // The partitioned run fails after spending 1.5 s; each band then spends 0.5 s.
    const injected = (): ElkAttempt => {
      attempts += 1;
      if (attempts === 1) {
        return { layout: () => { advance(1500); return Promise.reject(new Error('injected partition failure')); }, terminateWorker: () => {} };
      }
      const real = createAttempt();
      return {
        layout: async (graph) => { const result = await real.layout(graph); advance(500); return result; },
        terminateWorker: () => { real.terminateWorker(); },
      };
    };
    await skeleton(model, { createAttempt: injected, clock, layoutBudgetMs: 10000, budget: createBudget(5000, now) });

    expect(model.fallbackUsed).toBe(true);
    expect(attempts).toBe(4); // one partitioned attempt, then one per tier band
    expect(deadlines).toEqual([5000, 3500, 3000, 2500]);
    // Four fresh 10 s policies would have allowed 40 s of work inside a 5 s command.
    expect(Math.max(...deadlines)).toBeLessThanOrEqual(5000);
  }, 60000);

  it('reports a deadline instead of starting a band with no time left', async () => {
    const { clock, advance, now } = recordingClock();
    const model = sizeNodes(sidesOne(resolve(parse(threeTiers))));
    const injected = (): ElkAttempt =>
      ({ layout: () => { advance(900); return Promise.reject(new Error('injected partition failure')); }, terminateWorker: () => {} });
    await expect(skeleton(model, { createAttempt: injected, clock, layoutBudgetMs: 10000, budget: createBudget(800, now) }))
      .rejects.toBeInstanceOf(ElkDeadlineError);
    expect(model.deadlineHit).toBe(true);
    expect(model.diagnostics.some(item => item.code === 'ELK_SKELETON_FAILED')).toBe(true);
  }, 60000);

  it('keeps the full policy when no command budget is supplied', async () => {
    const { clock, deadlines } = recordingClock();
    const model = sizeNodes(sidesOne(resolve(parse(threeTiers))));
    await skeleton(model, { createAttempt, clock, layoutBudgetMs: 7000 });
    expect(deadlines).toEqual([7000]);
  }, 60000);
});

describe('layout(document, options)', () => {
  it('runs stages 1 to 9 on the approved golden and publishes one final model', async () => {
    const parsed = parseWithDiagnostics(goldenYaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const progress: LayoutProgress[] = [];
    const model = await layout(parsed.document, {
      diagnostics: parsed.diagnostics,
      createElkAttempt: createAttempt,
      createRouteAttempt: createAvoidAttempt,
      onProgress: event => progress.push(event),
    });

    expect(model.stage).toBe('link-labels');
    expect(Object.keys(model.nodes)).toHaveLength(12);
    expect(model.links).toHaveLength(26);
    expect(Object.values(model.nodes).reduce((sum, node) => sum + node.ports.length, 0)).toBe(52);
    expect(model.bundles.map(bundle => bundle.members.length).sort()).toEqual([2, 4, 4, 4, 4]);
    expect(model.links.every(link => link.path)).toBe(true);
    expect(model.legend).toBeDefined();

    const report = score(model, { golden: true }).snapshot;
    for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as GateId[]) {
      expect([id, report.gates[id].violations]).toEqual([id, []]);
    }
    expect(report.passed).toBe(true);
    expect(report.metrics.crossings.count).toBe(0);
    expect(report.counters).toMatchObject({ overlaps: 0, labelHits: 0, stubs: 0, fallbackUsed: false, deadlineHit: false });
    expect(report.Q).toBeCloseTo(APPROVED_Q, 12);

    // The published model is frozen and restores byte-equal, so score, render and the layout JSON
    // all describe the same geometry.
    expect(Object.isFrozen(model)).toBe(true);
    expect(restoreLayoutModel(serializeLayoutModel(model))).toEqual(model);
    expect(() => restoreFinalLayout(serializeLayoutModel(model))).not.toThrow();
    expect(render(model)).toBe(render(restoreFinalLayout(serializeLayoutModel(model))));

    expect(progress.map(item => item.stage)).toEqual(['resolve', 'sides-one', 'size', 'skeleton',
      'sides-two', 'rows', 'lanes', 'flanks', 'centre', 'bars', 'bundles', 'bands', 'route', 'link-labels']);
    expect(progress.every(item => item.durationMs >= 0)).toBe(true);
    expect(progress.every(item => item.remainingMs === Number.POSITIVE_INFINITY)).toBe(true);
  }, 120000);

  it('keeps every parse diagnostic, with its source path, in the final model', async () => {
    // `collapsed:` warns with a path, and an omitted tier is inferred with one too.
    const yaml = `portograph: 2
groups: {top: {tier: 0, collapsed: true}, low: {}}
nodes:
  a: {group: top, class: router, ports: [{name: p, side: bottom}]}
  b: {group: low, class: switch, ports: [{name: p, side: top}]}
links: [[a.p, b.p]]`;
    const parsed = parseWithDiagnostics(yaml);
    if (!parsed.ok) throw new Error('fixture must parse');
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    const model = await layout(parsed.document, {
      diagnostics: parsed.diagnostics, createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    });
    for (const diagnostic of parsed.diagnostics) expect(model.diagnostics).toContainEqual(diagnostic);
    // And the authored document itself never receives them.
    expect(JSON.stringify(model.document)).not.toContain('TIER_INFERRED');
  }, 120000);

  it('hands the router what the command has left rather than a fresh stage budget', async () => {
    const { clock, deadlines, advance, now } = recordingClock();
    const parsed = parseWithDiagnostics(bendingTiers);
    if (!parsed.ok) throw new Error('fixture must parse');
    const elk = (): ElkAttempt => {
      const real = createAttempt();
      return {
        layout: async (graph) => { const result = await real.layout(graph); advance(4000); return result; },
        terminateWorker: () => { real.terminateWorker(); },
      };
    };
    await layout(parsed.document, {
      diagnostics: parsed.diagnostics, createElkAttempt: elk, createRouteAttempt: createAvoidAttempt,
      budget: createBudget(20000, now), clock,
    });
    // One ELK attempt at min(10 s policy, 20 s left), then the router at the 16 s that remain.
    expect(deadlines[0]).toBe(10000);
    expect(deadlines.at(-1)).toBe(16000);
  }, 120000);

  it('refuses to start a stage with no budget left', async () => {
    let virtual = 0;
    const parsed = parseWithDiagnostics(threeTiers);
    if (!parsed.ok) throw new Error('fixture must parse');
    const budget = createBudget(10, () => virtual);
    virtual = 100;
    await expect(layout(parsed.document, { diagnostics: parsed.diagnostics, budget }))
      .rejects.toBeInstanceOf(CommandDeadlineError);
  });
});

describe('restoreFinalLayout', () => {
  it('rejects forged geometry CSS before render while preserving allowed author CSS', async () => {
    const css = '.node-body { fill: red; --custom: "text"; -webkit-text-fill-color: blue; }';
    const model = await layout(parse(`${threeTiers}\ncss: ${JSON.stringify(css)}`), {
      createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    });
    const json = serializeLayoutModel(model);
    expect(restoreFinalLayout(json)).toEqual(model);
    expect(render(restoreFinalLayout(json))).toContain(css);
    for (const forgedCss of ['.node-body { stroke-width: 40px !important; }',
      String.raw`.node-body { stroke-\77 idth: 40px !important; }`, '.node-body { fill:', 42]) {
      const forged = JSON.parse(json) as { document: { css: unknown } };
      forged.document.css = forgedCss;
      expect(() => render(restoreFinalLayout(JSON.stringify(forged)))).toThrow(/css/i);
    }
  });

  // An outline paints outside the element's box on ordinary node rectangles, so it covers unrelated
  // geometry and reaches past the canvas, while every gate and the score still measure the bounds
  // the layout published. Neither the authored route nor a hand-written final JSON may publish one.
  it('never publishes an authored outline and refuses a forged one', async () => {
    const authored = '.node-body { outline: 1000px solid #ff0000; fill: #eeeeee; }';
    const parsed = parseWithDiagnostics(`${threeTiers}\ncss: ${JSON.stringify(authored)}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.css).not.toMatch(/outline/i);
    expect(parsed.document.css).toContain('fill: #eeeeee');
    expect(parsed.diagnostics.filter(d => d.code === 'LOCKED_CSS')).toHaveLength(1);

    const model = await layout(parsed.document, {
      diagnostics: parsed.diagnostics, createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    });
    const json = serializeLayoutModel(model);
    // The renderer pins `outline:none` on its own internal mask elements, so the drawing is checked
    // for the authored outline itself rather than for the word.
    const svg = render(restoreFinalLayout(json));
    expect(svg).not.toMatch(/outline\s*:\s*1000px/i);
    expect(svg).not.toContain('solid #ff0000');
    expect(svg).toContain('fill: #eeeeee');

    for (const forgedCss of ['.node-body { outline: 1000px solid #ff0000 !important; }',
      '.node-body { outline-width: 1000px; outline-style: solid; }',
      String.raw`.node-body { outl\69 ne: 1000px solid #ff0000; }`,
      '.node-body { -webkit-outline: 1000px solid #ff0000; }']) {
      const forged = JSON.parse(json) as { document: { css: unknown } };
      forged.document.css = forgedCss;
      expect(() => render(restoreFinalLayout(JSON.stringify(forged)))).toThrow(/css/i);
    }
  }, 120000);

  it('accepts stage 9 output and refuses an unfinished layout', async () => {
    const parsed = parseWithDiagnostics(threeTiers);
    if (!parsed.ok) throw new Error('fixture must parse');
    const model = await layout(parsed.document, {
      diagnostics: parsed.diagnostics, createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt,
    });
    expect(restoreFinalLayout(serializeLayoutModel(model)).stage).toBe('link-labels');

    const unfinished = JSON.parse(serializeLayoutModel(model)) as Record<string, unknown>;
    unfinished.stage = 'route';
    // A model rewound to stage 8 still carries stage-9 labels, which restore rejects on its own;
    // the point here is that neither path lets an unfinished layout reach score or render.
    expect(() => restoreFinalLayout(JSON.stringify(unfinished))).toThrow();

    const noCanvas = JSON.parse(serializeLayoutModel(model)) as Record<string, unknown>;
    delete noCanvas.canvas;
    expect(() => restoreFinalLayout(JSON.stringify(noCanvas))).toThrow();
  }, 120000);
});
