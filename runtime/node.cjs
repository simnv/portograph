'use strict';
const Worker = require('web-worker');
const workerUrl = require.resolve('elkjs/lib/elk-worker.min.js');

/** Resolve the worker relative to this installed module, independent of the caller's cwd. */
exports.createNodeElkFactory = function createNodeElkFactory() {
  return () => {
    const { createWorkerElkAttempt } = require('./portograph.umd.cjs');
    return createWorkerElkAttempt(new Worker(workerUrl));
  };
};
