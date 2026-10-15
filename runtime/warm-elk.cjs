'use strict';
/**
 * One ELK worker for the attempts of one command (internal: `node.cjs` is the only caller, and no package export names this file).
 *
 * Starting a worker costs a script load and a cold engine, and a command asks for several layouts. ELK does keep state between layouts: the identity counter
 * `$H` of the compiled Java, pooled providers and cached processors. portograph reads only the selected geometry of a reply, with a fixed seed, so a warm
 * worker gives the geometry a cold one gives (`test/layout/elk-worker.test.ts` compares them over a mixed history of graphs).
 *
 * One warm worker serves one command at a time: attempts run one after the other, and a second command must make its own. `warm()` starts the worker ahead of
 * the first attempt. A worker is dropped, and the next attempt starts a new one, when an attempt ends while a layout is still running (the deadline of
 * `runElkAttempt` terminates it), when a layout fails, or on `close()`. The state is the factory's own; nothing is shared between two factories.
 *
 * @param {(worker: object) => { layout(graph: object): Promise<object>, terminateWorker(): void }} createWorkerElkAttempt
 * @param {() => object} makeWorker
 */
exports.createWarmElk = function createWarmElk(createWorkerElkAttempt, makeWorker) {
  let shared;
  const open = () => (shared ??= createWorkerElkAttempt(makeWorker()));
  const drop = (worker) => {
    if (shared === worker) shared = undefined;
    worker.terminateWorker();
  };
  return {
    /** The factory to pass as `createElkAttempt`. */
    attempt: () => {
      const worker = open();
      let running = 0;
      return {
        layout(graph) {
          running++;
          return worker.layout(graph).then(
            (result) => { running--; return result; },
            (error) => { running--; drop(worker); throw error; });
        },
        terminateWorker() { if (running > 0) drop(worker); },
      };
    },
    /** Start the worker now, so that it boots while the caller does other work. A failure to start is left for the first attempt to raise. */
    warm() { try { open(); } catch { /* the first attempt raises it */ } },
    /** Terminate the worker, if one is running. */
    close() { if (shared !== undefined) drop(shared); },
  };
};
