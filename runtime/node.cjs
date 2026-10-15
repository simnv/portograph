'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const Worker = require('web-worker');
const workerUrl = join(__dirname, 'portograph-elk-worker.js');

/** Resolve the worker relative to this installed module, independent of the caller's cwd. */
exports.createNodeElkFactory = function createNodeElkFactory() {
  if (!existsSync(workerUrl)) throw new Error(`portograph ELK worker asset is missing: ${workerUrl}`);
  return () => {
    const { createWorkerElkAttempt } = require('./portograph.umd.cjs');
    return createWorkerElkAttempt(new Worker(workerUrl));
  };
};

/**
 * Create the router factory for Node. The worker, the libavoid module and its WASM all ship beside
 * this file, so the installed package needs no `elkjs` or `libavoid-js` of its own, and nothing is
 * resolved from the caller's working directory.
 */
exports.createNodeRouteFactory = function createNodeRouteFactory() {
  const { createRouteFactory } = require('./portograph.umd.cjs');
  const avoidEntry = join(__dirname, 'portograph-avoid-node.mjs');
  const assets = {
    workerUrl: join(__dirname, 'portograph-avoid-worker.mjs'),
    moduleUrl: pathToFileURL(avoidEntry).href,
    wasmUrl: join(__dirname, 'portograph-libavoid.wasm'),
  };
  for (const path of [assets.workerUrl, avoidEntry, assets.wasmUrl]) {
    if (!existsSync(path)) throw new Error(`portograph router asset is missing: ${path}`);
  }
  return createRouteFactory({ ...assets, workerUrl: pathToFileURL(assets.workerUrl).href },
    url => new Worker(url, { type: 'module' }));
};
