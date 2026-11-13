import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import type { LayoutModel } from '../../src/index.js';
import { centre, flanks, lanes, restoreLayoutModel, rows } from '../../src/internal.js';
import {
  CENTRE_ALIGNMENT_OPEN,
  centreReadCounters,
  centreViolations,
  flagUnverifiedCentring,
  nameOpenCentring,
  resetCentreReadCounters,
} from '../../src/layout/centre.js';
import { moveGroup } from '../../src/layout/skeleton-geometry.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const synthetic = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

const runSynthetic = (name: string): Promise<LayoutModel> =>
  layout(parse(synthetic(name)), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('deferring redundant centre-flag reads in 7f and lazy sharedNodes copy', () => {
  beforeEach(() => {
    resetCentreReadCounters();
  });

  it('flagUnverifiedCentring skips recordOpen only when deferNames is true and CENTRE_ALIGNMENT_OPEN is already recorded', async () => {
    const base = await placedOffFeed();
    resetCentreReadCounters();

    const deferredWithRecord = JSON.parse(JSON.stringify(base)) as LayoutModel;
    deferredWithRecord.diagnostics.push({
      stage: 'placement',
      severity: 'warning',
      code: CENTRE_ALIGNMENT_OPEN,
      message: 'stalled',
      owners: [],
    });
    flagUnverifiedCentring(deferredWithRecord, true);
    expect(centreReadCounters.flagSkipped).toBe(1);
    expect(centreReadCounters.flagChecked).toBe(0);
    expect(deferredWithRecord.diagnostics.find(d => d.code === CENTRE_ALIGNMENT_OPEN)?.owners).toEqual([]);

    const immediateWithRecord = JSON.parse(JSON.stringify(deferredWithRecord)) as LayoutModel;
    flagUnverifiedCentring(immediateWithRecord, false);
    expect(centreReadCounters.flagChecked).toBe(1);
    expect(immediateWithRecord.diagnostics.find(d => d.code === CENTRE_ALIGNMENT_OPEN)?.owners).toEqual([{ kind: 'link', id: 'link-1' }]);

    // Without CENTRE_ALIGNMENT_OPEN, the else-if branch still checks centreViolations even when deferNames is true.
    const withoutRecord = JSON.parse(JSON.stringify(base)) as LayoutModel;
    flagUnverifiedCentring(withoutRecord, true);
    expect(centreReadCounters.flagChecked).toBe(2);
    expect(withoutRecord.diagnostics.find(d => d.code === CENTRE_ALIGNMENT_OPEN)?.owners).toEqual([{ kind: 'link', id: 'link-1' }]);
  }, 60000);

  it('skips redundant centre-flag reads inside 7f on a stalled layout and keeps final CENTRE_ALIGNMENT_OPEN owners identical', async () => {
    const model = await runSynthetic('a-chord-and-a-lane-share-a-middle-tier');
    expect(centreReadCounters.flagSkipped).toBeGreaterThan(0);

    const open = model.diagnostics.find(d => d.stage === 'placement' && d.code === CENTRE_ALIGNMENT_OPEN);
    expect(open).toBeDefined();
    expect(open?.owners).toEqual([{ kind: 'link', id: 'link-5' }]);

    // Re-running nameOpenCentring on a clone produces the exact same owners, and restore validates cleanly.
    const rechecked = JSON.parse(JSON.stringify(model)) as LayoutModel;
    nameOpenCentring(rechecked);
    expect(rechecked.diagnostics.find(d => d.stage === 'placement' && d.code === CENTRE_ALIGNMENT_OPEN)?.owners).toEqual(open?.owners);
    expect(restoreLayoutModel(JSON.stringify(model))).toEqual(model);
  }, 60000);

  it('records cacheHits in readCentreViolations without altering results', async () => {
    const model = await placedOffFeed();
    resetCentreReadCounters();
    const first = centreViolations(model, true);
    expect(first.length).toBeGreaterThan(0);
    expect(centreReadCounters.cacheHits).toBe(0);

    const second = centreViolations(model, true);
    expect(second).toEqual(first);
    expect(centreReadCounters.cacheHits).toBe(1);
  }, 60000);
});

async function placedOffFeed(): Promise<LayoutModel> {
  const { placed } = await import('./phase-two-fixture.js');
  const sheet = `portograph: 2
groups: {up: {tier: 0}, down: {tier: 1}}
nodes:
  a: {group: up, ports: [{name: p, side: bottom}]}
  c: {group: down, ports: [{name: p, side: top}]}
links: [[a.p, c.p]]`;
  const model = JSON.parse(JSON.stringify(centre(flanks(lanes(rows(await placed(sheet))))))) as LayoutModel;
  moveGroup(model, model.groups.down!, 40, 0);
  return model;
}
