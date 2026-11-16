import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { reserveLinkLabelRoom, type LinkLabelShortfall } from '../../src/layout/bands.js';
import { rowRoomShortOf } from '../../src/layout/label-room-guard.js';
import { checkReadCaches, readCacheCounts } from '../../src/model/read-cache.js';
import type { LayoutModel } from '../../src/model/layout.js';
import { createAttempt } from './phase-two-fixture.js';
import { createAvoidAttempt } from '../route/fixture.js';

// The memo of the row reading (dense-16x9 ticket 21): its key is the whole model text, the complete input of the reading.
const fixture = readFileSync(new URL('../../goldens/synthetic/a-same-row-link-label-keeps-a-straight-overlay-straight.yaml', import.meta.url), 'utf8');
const laidOut = async (): Promise<LayoutModel> => structuredClone(await layout(parse(fixture), { createElkAttempt: createAttempt, createRouteAttempt: createAvoidAttempt }));
const counts = (): { hits: number; misses: number; checked: number } => readCacheCounts().rowRoomReading ?? { hits: 0, misses: 0, checked: 0 };
/** The reading without the memo: the producer's row reading on a copy. */
const fresh = (model: LayoutModel): string[] => {
  const shortfalls: LinkLabelShortfall[] = [];
  reserveLinkLabelRoom(structuredClone(model), shortfalls, undefined, 'rows');
  return [...new Set(shortfalls.filter(item => item.axis === 'row' || item.axis === 'row window').map(item => item.link))];
};

it('reads a model text once, and answers what the reading answers', async () => {
  const model = await laidOut();
  const before = counts();
  const first = rowRoomShortOf(model);
  expect(counts().misses).toBe(before.misses + 1);
  // The same text, in another object with the same document: a hit.
  expect(rowRoomShortOf({ ...structuredClone({ ...model, document: undefined }), document: model.document } as LayoutModel)).toEqual(first);
  expect(counts().hits).toBe(before.hits + 1);
  expect(first).toEqual(fresh(model));
  // A model whose rows are short answers the same through the memo as without it.
  const shrunk = structuredClone({ ...model, document: undefined }) as unknown as LayoutModel, node = shrunk.nodes.target!, dx = -60;
  shrunk.document = model.document;
  node.bounds!.x += dx;
  for (const port of node.ports) {
    if (port.anchor) port.anchor.x += dx;
    if (port.pill) port.pill.bounds.x += dx;
  }
  const short = rowRoomShortOf(shrunk);
  expect(short).toEqual(fresh(shrunk));
  expect(short!.length).toBeGreaterThan(0);
});

it('misses on a change of any field the reading reads, and on another document', async () => {
  const model = await laidOut();
  rowRoomShortOf(model);
  const changed: string[] = [];
  for (const key of Object.keys(model).filter(key => key !== 'document')) {
    const value = (model as unknown as Record<string, unknown>)[key];
    const copy = structuredClone({ ...model, document: undefined }) as unknown as Record<string, unknown>;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') copy[key] = typeof value === 'string' ? `${value}-probe` : typeof value === 'number' ? value + 1 : !value;
    else if (Array.isArray(value)) {
      // An empty list or a list of scalars changes by one more item; a list of objects by a field on its first item.
      const list = copy[key] as unknown[];
      if (list.length && typeof list[0] === 'object' && list[0] !== null) (list[0] as Record<string, unknown>).probe = 1; else list.push(list.length ? list[0] : {});
    } else if (value !== null && typeof value === 'object') (copy[key] as Record<string, unknown>).probe = 1;
    else continue;
    copy.document = model.document;
    const before = counts().misses;
    // The miss is counted before the reading runs; a field made unreadable may make the reading throw.
    try { rowRoomShortOf(copy as unknown as LayoutModel); } catch { /* the reading of a malformed copy */ }
    if (counts().misses === before + 1) changed.push(key);
  }
  expect(changed).toEqual(Object.keys(model).filter(key => key !== 'document' && (model as unknown as Record<string, unknown>)[key] !== undefined));
  // The same text under another document object is another memo: a miss.
  const before = counts().misses;
  rowRoomShortOf({ ...model, document: structuredClone(model.document) });
  expect(counts().misses).toBe(before + 1);
});

it('reads the rows again on every hit under the cache check', async () => {
  const model = await laidOut();
  rowRoomShortOf(model);
  const before = counts().checked;
  await checkReadCaches(async () => { rowRoomShortOf(model); });
  expect(counts().checked).toBe(before + 1);
});
