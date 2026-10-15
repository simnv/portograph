'use strict';
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const Worker = require('web-worker');
const workerUrl = require.resolve('elkjs/lib/elk-worker.min.js');

/** Resolve the worker relative to this installed module, independent of the caller's cwd. */
exports.createNodeElkFactory = function createNodeElkFactory() {
  return () => {
    const { createWorkerElkAttempt } = require('./portograph.umd.cjs');
    return createWorkerElkAttempt(new Worker(workerUrl));
  };
};

/**
 * One real ELK worker kept for all the attempts of one command, with `warm()` to start it early and `close()` to end it (`createWarmElk`).
 * A timed-out or failed attempt drops the worker and the next attempt starts a new one.
 */
exports.createNodeWarmElk = function createNodeWarmElk() {
  const { createWarmElk } = require('./portograph.umd.cjs');
  return createWarmElk(() => new Worker(workerUrl));
};

/**
 * Create the stage-8 router factory for Node. The worker asset ships beside this file; libavoid's
 * Node entry and its sibling WASM are resolved from the installed package, never from the caller's
 * working directory and never through an unexported deep subpath.
 */
exports.createNodeRouteFactory = function createNodeRouteFactory() {
  const { createRouteFactory } = require('./portograph.umd.cjs');
  const avoidEntry = require.resolve('libavoid-js');
  const assets = {
    workerUrl: join(__dirname, 'portograph-avoid-worker.mjs'),
    moduleUrl: pathToFileURL(avoidEntry).href,
    wasmUrl: join(dirname(avoidEntry), 'libavoid.wasm'),
  };
  for (const name of ['workerUrl', 'wasmUrl']) {
    if (!existsSync(assets[name])) throw new Error(`portograph router asset is missing: ${assets[name]}`);
  }
  return createRouteFactory({ ...assets, workerUrl: pathToFileURL(assets.workerUrl).href },
    url => new Worker(url, { type: 'module' }));
};
