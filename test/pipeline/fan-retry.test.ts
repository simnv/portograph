import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutModel } from '../../src/index.js';
import { layout, parse } from '../../src/index.js';
import { titleCrowdedFanMembers } from '../../src/layout/fan-admission.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

/**
 * Architecture-2 ticket 40, review round 1: the refusals of a fan member on a retry of 7f (`placementAttempt`). The fixture's geometry gives
 * none, so the title reader is wrapped: it runs as built unless a test makes it name a member. (The stem refusal at the freeze is tested in
 * fan-family.test.ts on the calls `attemptBody` makes: a wrapped `siblingStemCrowded` does not reach `fan-admission.ts`, which imports
 * `frame-paths.ts` through a cycle.)
 */
vi.mock('../../src/layout/fan-admission.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/layout/fan-admission.js')>();
  return { ...actual, titleCrowdedFanMembers: vi.fn(actual.titleCrowdedFanMembers) };
});

const FIXTURE = 'a-hub-tiers-fan-draws-straight-and-crosses-itself';
const text = readFileSync(new URL(`../../goldens/synthetic/${FIXTURE}.yaml`, import.meta.url), 'utf8');
const lay = (): Promise<LayoutModel> => layout(parse(text), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt });
const key = (model: LayoutModel, id: string): string => {
  const link = model.links.find(item => item.id === id)!;
  return [link.from.node, link.to.node].sort().join('|');
};
const admission = (model: LayoutModel, ends: string) => model.fanAdmissions!.find(item => key(model, item.link) === ends)!;
const straightIds = (model: LayoutModel): string[] => (model.fanAdmissions ?? []).filter(item => item.mode === 'straight').map(item => item.link).sort();

beforeEach(async () => {
  const fan = await vi.importActual<typeof import('../../src/layout/fan-admission.js')>('../../src/layout/fan-admission.js');
  vi.mocked(titleCrowdedFanMembers).mockImplementation(fan.titleCrowdedFanMembers);
});

describe('a fan member refused after its admission names why', () => {
  it('falls back as `title` on a retry of 7f when a placed title still meets it (placementAttempt)', async () => {
    // The title reader names the member from Hub B to D 1 whenever it is straight.
    vi.mocked(titleCrowdedFanMembers).mockImplementation(model => straightIds(model).filter(id => key(model, id) === 'd-1|hub-b'));
    const model = await lay();
    expect(admission(model, 'd-1|hub-b')).toMatchObject({ mode: 'orthogonal', reason: 'title' });
    expect(straightIds(model)).toHaveLength(6);
    expect(model.diagnostics.filter(entry => entry.code === 'FAN_MEMBER_CROWDED')).toEqual([]);
  }, 120000);

  it('keeps the member straight and names it in FAN_MEMBER_CROWDED when the retries run out', async () => {
    // Each attempt names the first straight member in id order: the two retries refuse two, and the third attempt still names one.
    vi.mocked(titleCrowdedFanMembers).mockImplementation(model => straightIds(model).slice(0, 1));
    const model = await lay();
    expect(model.fanAdmissions!.filter(item => item.reason === 'title')).toHaveLength(2);
    const kept = model.diagnostics.filter(entry => entry.code === 'FAN_MEMBER_CROWDED')
      .map(entry => (entry.owners![0] as { id: string }).id).filter(id => straightIds(model).includes(id));
    expect(kept).toHaveLength(1);
    expect(model.diagnostics.some(entry => entry.code === 'FAN_MEMBER_CROWDED' && entry.message.includes(`${kept[0]} (title)`))).toBe(true);
  }, 120000);
});
