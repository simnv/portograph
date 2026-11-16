import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { memoAdmission, openAdmissionMemo } from '../../src/layout/admission-memo.js';
import { checkReadCaches, readCacheCounts } from '../../src/model/read-cache.js';
import type { Diagnostic, LayoutLink, LayoutModel } from '../../src/model/layout.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// The memo of the fan and solid-block admission (dense-16x9 ticket 21): its key is the fields each call read, the field names, the members
// and the budget. A stand-in admission reads what a test names and writes as the admission does: member link fields and the diagnostics.

interface Draft { stage: string; runtime: { stages: unknown[] }; blockReservations: { family: string; gap: number }[]; lanes: { x: number }[]; links: LayoutLink[]; diagnostics: Diagnostic[]; document: { links: unknown[] } }
const draftOf = (): Draft => ({
  stage: 'bars', runtime: { stages: [] }, blockReservations: [{ family: 'f', gap: 40 }], lanes: [{ x: 10 }],
  links: [{ id: 'a', technique: 'orthogonal', fanFamily: 'f' }, { id: 'b', technique: 'orthogonal', fanFamily: 'f' }, { id: 'c', technique: 'orthogonal' }] as unknown as LayoutLink[],
  diagnostics: [{ stage: 'placement', severity: 'info', code: 'KEPT', message: 'kept' }], document: { links: [] },
});
let calls = 0;
/** Reads the reservations, the lanes and the links; draws `a` straight with a new path, keeps `b`, and replaces its own note. */
const admit = (draft: LayoutModel, members: readonly LayoutLink[], budget: number): void => {
  calls++;
  const gap = (draft as unknown as Draft).blockReservations[0]!.gap + (draft as unknown as Draft).lanes[0]!.x + budget + draft.links.filter(link => link.technique === 'straight').length;
  const link = members[0]! as unknown as Record<string, unknown>;
  delete link.path;
  link.path = { segments: [{ from: { x: 0, y: 0 }, to: { x: 0, y: gap } }] };
  link.technique = 'straight';
  draft.diagnostics = draft.diagnostics.filter(note => note.code !== 'NOTE');
  draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'NOTE', message: `gap ${gap}` });
};
const run = (draft: Draft, budget = 5, step: typeof admit = admit): void => {
  const model = draft as unknown as LayoutModel;
  memoAdmission(model, model.links.filter(link => link.fanFamily === 'f'), budget, step);
};
const counts = (): { hits: number; misses: number; checked: number } => readCacheCounts().fanAdmission ?? { hits: 0, misses: 0, checked: 0 };
let close: (() => void) | undefined;
beforeEach(() => { close = openAdmissionMemo(); calls = 0; });
afterEach(() => { close?.(); close = undefined; });

it('makes the writes of the first call again for a draft that agrees on every field the call read', () => {
  const one = draftOf(), two = draftOf();
  run(one);
  two.stage = 'bundles'; two.runtime.stages.push({ stage: 'bars' });
  const kept = two.diagnostics[0]!, b = two.links[1]!;
  const before = counts();
  run(two);
  expect(calls).toBe(1);
  expect(counts().hits).toBe(before.hits + 1);
  // The same content, the same field order; a kept entry and an untouched member stay the same objects, a new value is a new object.
  expect(JSON.stringify(two.links)).toBe(JSON.stringify(one.links));
  expect(JSON.stringify(two.diagnostics)).toBe(JSON.stringify(one.diagnostics));
  expect(two.diagnostics[0]).toBe(kept);
  expect(two.links[1]).toBe(b);
  expect(two.links[0]!.path).not.toBe(one.links[0]!.path);
});

it('misses on a change of each field the call read, of the members, of the budget and of the field names', () => {
  const changes: [string, (draft: Draft) => void][] = [
    ['blockReservations', draft => { draft.blockReservations[0]!.gap = 41; }],
    ['lanes', draft => { draft.lanes[0]!.x = 11; }],
    ['diagnostics', draft => { draft.diagnostics.push({ stage: 'placement', severity: 'info', code: 'OTHER', message: 'other' }); }],
    ['links', draft => { (draft.links[2] as unknown as Record<string, unknown>).technique = 'straight'; }],
    ['member', draft => { (draft.links[1] as unknown as Record<string, unknown>).label = 'x'; }],
    ['field names', draft => { (draft as unknown as Record<string, unknown>).courses = []; }],
  ];
  run(draftOf());
  for (const [name, change] of changes) {
    const draft = draftOf();
    change(draft);
    const before = calls;
    run(draft);
    expect([name, calls]).toEqual([name, before + 1]);
  }
  const before = calls;
  run(draftOf(), 6);
  expect(calls).toBe(before + 1);
  // A field the call did not read changes nothing: a hit.
  const other = draftOf();
  other.stage = 'bands';
  run(other);
  expect(calls).toBe(before + 1);
});

it('stores no call whose writes it cannot make again', () => {
  const elsewhere = (draft: LayoutModel, members: readonly LayoutLink[], budget: number): void => { admit(draft, members, budget); (draft as unknown as Draft).lanes[0]!.x++; };
  const inPlace = (draft: LayoutModel, members: readonly LayoutLink[], budget: number): void => { admit(draft, members, budget); draft.diagnostics[0]!.message = 'changed'; };
  for (const step of [elsewhere, inPlace]) {
    run(draftOf(), 7, step);
    const before = calls;
    run(draftOf(), 7, step);
    expect(calls).toBe(before + 1);
  }
});

it('runs every call outside a command', () => {
  close?.(); close = undefined;
  run(draftOf());
  run(draftOf());
  expect(calls).toBe(2);
});

it('runs the admission again on a copy for a hit under the cache check', async () => {
  run(draftOf());
  const before = counts().checked;
  await checkReadCaches(async () => { run(draftOf()); });
  expect(counts().checked).toBe(before + 1);
  expect(calls).toBe(2);
});

it('lays out a sheet with solid blocks through the memo under the cache check', async () => {
  const yaml = readFileSync(new URL('../../goldens/synthetic/a-solid-block-enters-beside-a-foreign-group.yaml', import.meta.url), 'utf8');
  close?.(); close = undefined;
  const before = counts();
  await layout(parse(yaml), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt, checkCaches: true });
  expect(counts().hits).toBeGreaterThan(before.hits);
  expect(counts().checked - before.checked).toBe(counts().hits - before.hits);
});
