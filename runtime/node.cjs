'use strict';
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const Worker = require('web-worker');

/**
 * The installed file of a solver dependency. The solvers are dependencies of portograph, so this
 * resolves from this module's own location, never from the caller's working directory.
 */
function solverFile(specifier, what) {
  try { return require.resolve(specifier); }
  catch (error) { throw new Error(`portograph ${what} is missing: cannot resolve ${specifier}`, { cause: error }); }
}

/** Create a factory of real Node ELK workers, on the worker file of the installed `elkjs`. */
exports.createNodeElkFactory = function createNodeElkFactory() {
  const workerUrl = solverFile('elkjs/lib/elk-worker.min.js', 'ELK worker');
  return () => {
    const { createWorkerElkAttempt } = require('./portograph.umd.cjs');
    return createWorkerElkAttempt(new Worker(workerUrl));
  };
};

/**
 * Create the router factory for Node. The worker ships beside this file; the libavoid module and its
 * WASM are the Node entry of the installed `libavoid-js` and its sibling `libavoid.wasm`.
 */
exports.createNodeRouteFactory = function createNodeRouteFactory() {
  const { createRouteFactory } = require('./portograph.umd.cjs');
  // libavoid-js exports only its package root; its `node` condition is the Node entry.
  const avoidEntry = solverFile('libavoid-js', 'libavoid module');
  const assets = {
    workerUrl: join(__dirname, 'portograph-avoid-worker.mjs'),
    moduleUrl: pathToFileURL(avoidEntry).href,
    wasmUrl: join(dirname(avoidEntry), 'libavoid.wasm'),
  };
  for (const path of [assets.workerUrl, assets.wasmUrl]) {
    if (!existsSync(path)) throw new Error(`portograph router asset is missing: ${path}`);
  }
  return createRouteFactory({ ...assets, workerUrl: pathToFileURL(assets.workerUrl).href },
    url => new Worker(url, { type: 'module' }));
};
