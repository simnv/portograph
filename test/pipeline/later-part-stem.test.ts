import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { layout, parse } from '../../src/index.js';
import { createRouteFactory, type RouteWorker } from '../../src/route/worker.js';
import { createAttempt } from '../layout/phase-two-fixture.js';
import { avoidAssets, spawnAvoidWorker } from '../route/fixture.js';

const fixture = (name: string): string => readFileSync(new URL(`../../goldens/synthetic/${name}.yaml`, import.meta.url), 'utf8');

interface Request { id: string; shapes: { id: string }[]; connectors: { id: string }[] }

/** A route factory that records every request the router receives. */
function recording(requests: Request[]) {
  return createRouteFactory(avoidAssets, (url): RouteWorker => {
    const worker = spawnAvoidWorker(url);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: unknown): void => {
      const batch = (message as { batch?: Request }).batch;
      if (batch) requests.push({ id: batch.id, shapes: batch.shapes, connectors: batch.connectors });
      post(message);
    };
    return worker;
  });
}

describe('an ownership batch split into parts', () => {
  it('keeps the stems of the later parts as obstacles for the earlier parts', async () => {
    const requests: Request[] = [];
    const model = await layout(parse(fixture('a-later-part-keeps-its-stem-reserved')),
      { createElkAttempt: createAttempt, createRouteAttempt: recording(requests) });
    expect(model.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const linkOf = (connector: { id: string }): string => connector.id.split('#')[0]!;
    const groups = new Map<string, Request[]>();
    for (const request of requests) {
      const match = /^(.*)\.(\d+)$/.exec(request.id);
      if (match) groups.set(match[1]!, [...groups.get(match[1]!) ?? [], request]);
    }
    // The fixture must split at least one batch, or the test says nothing.
    expect([...groups.values()].some(parts => parts.length > 1)).toBe(true);
    for (const parts of groups.values()) {
      for (const [index, part] of parts.entries()) {
        const seen = new Set(part.shapes.map(shape => shape.id));
        for (const later of parts.slice(index + 1)) {
          for (const connector of later.connectors) {
            const stem = [...seen].some(id => new RegExp(`^stem:\\d+:${linkOf(connector)}$`).test(id));
            expect(stem, `${part.id} holds the stem of ${linkOf(connector)}`).toBe(true);
          }
        }
      }
    }
  }, 60000);
});
