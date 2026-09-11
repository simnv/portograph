import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRouteFactory, type RouteWorker } from '../../src/route/worker.js';

const require = createRequire(import.meta.url);
const Worker = require('web-worker') as new (url: string, options?: { type: 'module' }) => RouteWorker;
const avoidEntry = require.resolve('libavoid-js');

/** Source-tree equivalent of `createNodeRouteFactory()`; the packed package test covers that one. */
export const avoidAssets = {
  workerUrl: new URL('../../runtime/avoid-worker.mjs', import.meta.url).href,
  moduleUrl: pathToFileURL(avoidEntry).href,
  wasmUrl: join(dirname(avoidEntry), 'libavoid.wasm'),
};
export const createAvoidAttempt = createRouteFactory(avoidAssets, url => new Worker(url, { type: 'module' }));
export const spawnAvoidWorker = (url: string): RouteWorker => new Worker(url, { type: 'module' });
