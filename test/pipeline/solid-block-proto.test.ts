import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse, score } from '../../src/index.js';
import { resolve } from '../../src/resolve/index.js';
import { blockReservationsFault } from '../../src/layout/solid-block-proto.js';
import { admitFanFamilies } from '../../src/layout/fan-admission.js';
import { restoreLayoutModel } from '../../src/layout/mutation.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');
const regular = fixture('a-solid-block-prototype-keeps-all-members-straight');
const canton = fixture('a-two-by-two-solid-block-prototype-inside-a-canton');
const lay = (source: string) => layout(parse(source), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });

describe('ticket 81 solid block prototype', () => {
  it('counts nodes within a canton and supersedes inferred aggregation', () => {
    const model = resolve(parse(canton));
    expect(model.fanFamilies).toHaveLength(1);
    expect(model.fanFamilies![0]!.kind).toBe('solid');
    expect(model.fanFamilies![0]!.members).toHaveLength(4);
    expect(model.groupLinks).toHaveLength(0);
  });
  it('does not extract a biclique from an incomplete cohort or override explicit group-links', () => {
    expect(resolve(parse(canton.replace('  - { from: hub0, to: leaf0 }\n', ''))).fanFamilies).toBeUndefined();
    expect(resolve(parse(canton.replace('from: hub0, to: leaf0', 'from: hub0, to: leaf0, route: orthogonal'))).fanFamilies).toBeUndefined();
  });
  it('keeps all terminal followers straight after block pitch widens their parents', async () => {
    const model = await lay(fixture('a-solid-block-prototype-keeps-terminal-followers-straight'));
    expect(model.blockFollowers).toHaveLength(8);
    expect(score(model).snapshot.counts.routed.turns).toBe(0);
  });
  it('keeps the 4 by 8 block straight at full crossing weight and validates the recorded floor', async () => {
    const model = await lay(regular);
    expect(model.fanAdmissions?.filter(item => item.mode === 'straight')).toHaveLength(32);
    const snapshot = score(model).snapshot;
    expect(snapshot.counts.routed.turns).toBe(0);
    expect(snapshot.metrics.crossings.faint ?? 0).toBe(0);
    expect(snapshot.metrics.crossings.count).toBeGreaterThan(0);
    expect(Object.values(snapshot.gates).filter(gate => gate.severity === 'error' && gate.violations.length)).toEqual([]);
    expect(blockReservationsFault(model)).toBeUndefined();
    expect(blockReservationsFault(restoreLayoutModel(JSON.stringify(model)))).toBeUndefined();
    const offered = structuredClone(model);
    delete offered.frozenChords; delete offered.fanAdmissions;
    admitFanFamilies(offered, offered.links.filter(link => link.solidBlock), 1);
    expect(offered.links.filter(link => link.solidBlock && link.path?.segments.length === 1)).toHaveLength(32);
    const copy = structuredClone(model);
    delete copy.blockReservations;
    expect(blockReservationsFault(copy)).toContain('missing');
    copy.blockReservations = [];
    expect(blockReservationsFault(copy)).toContain('missing');
  }, 120000);
});
