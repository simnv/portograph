/**
 * What the gate scripts (`corpus.mjs`, `sweep.mjs`) share: the pipeline as the command line runs it.
 *
 * The scripts load the built library in `dist/` and its packaged workers, the way `bin/compute.mjs`
 * does, so a gate measures what `portograph render` produces. One warm ELK worker serves every
 * sheet; the router starts a worker per session and ends it with the session. `npm run corpus` and
 * `npm run sweep` build `dist/` before they run, so the measurement is never of a stale build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { heldLock } from './test-runner-lib.mjs';

const require = createRequire(import.meta.url);

/** The columns of a corpus TSV, in order; `corpus.mjs` writes them and `gate-compare.mjs` reads them. */
export const COLUMNS = ['file', 'Q', 'X', 'W', 'gates', 'warn', 'routed', 'fb', 'edge', 'ob', 'bends', 'side', 'removed', 'labelBorder', 'track', 'hash'];

/** The repository root, as a path. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Open the pipeline. The result has `layout(document)`, which lays one parsed document out with the
 * CLI's factories and the per-sheet deadline, the library `api` (parse, score, ...) and `close()`, which ends
 * the ELK worker so the process can exit.
 */
export async function openPipeline() {
  const dist = new URL('../dist/', import.meta.url);
  const entry = new URL('portograph.js', dist);
  if (!existsSync(fileURLToPath(entry))) throw new Error('dist/ is missing; run `npm run build` first');
  const api = await import(entry.href);
  const Worker = require('web-worker');
  const elkWorkerUrl = fileURLToPath(new URL('portograph-elk-worker.js', dist));
  const newElk = () => {
    const warm = require('../dist/warm-elk.cjs').createWarmElk(api.createWorkerElkAttempt, () => new Worker(elkWorkerUrl));
    warm.warm();
    return warm;
  };
  let elk = newElk();
  const router = require('../dist/node.cjs').createNodeRouteFactory();
  const deadline = deadlineMs();
  return {
    api,
    /** Lays one document out; rejects with a `TimeoutError` after the per-sheet deadline, then runs on with a fresh ELK worker. */
    async layout(document) {
      const running = api.layout(document, { createElkAttempt: () => elk.attempt(), createRouteAttempt: router });
      running.catch(() => {}); // a layout that outlives its deadline must not become an unhandled rejection
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`TIMEOUT after ${deadline / 1000} s`);
          error.name = 'TimeoutError';
          reject(error);
        }, deadline);
      });
      try {
        return await Promise.race([running, expired]);
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          elk.close();
          elk = newElk();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => elk.close(),
  };
}

/** The per-sheet deadline in milliseconds: `PORTOGRAPH_GATE_DEADLINE` seconds, default 120. */
export function deadlineMs() {
  const seconds = Number(process.env.PORTOGRAPH_GATE_DEADLINE ?? 120);
  if (!(seconds > 0)) throw new Error('PORTOGRAPH_GATE_DEADLINE must be a positive number of seconds');
  return seconds * 1000;
}

/** The one-line row text of a failed sheet: `TIMEOUT after N s` for a deadline, else `ERROR <first line>`. */
export function failure(error) {
  if (error instanceof Error && error.name === 'TimeoutError') return error.message;
  return `ERROR ${(error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 120)}`;
}

/** Every `*.yaml` under `directory` (recursive), as paths relative to the repository root with `/` separators, sorted. */
export function sheets(directory) {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => relative(ROOT, join(directory, name)).split(sep).join('/'))
    .sort();
}

/** The one output path argument of a gate script, or a usage error. */
export function outputArgument(argv, usage) {
  const [out, ...rest] = argv;
  if (out === undefined || out.startsWith('-') || rest.length > 0) throw new Error(`usage: ${usage}`);
  return out;
}

/** Seconds elapsed since `start` (a `performance.now()` value), to one decimal. */
export function elapsed(start) {
  return `${((performance.now() - start) / 1000).toFixed(1)} s`;
}

/** A short (12 hex) sha256 of the layout JSON the CLI publishes without `--timings` (the runtime stages left out). */
export function layoutHash(api, model) {
  const json = `${api.serializeLayoutModel({ ...model, runtime: { stages: [] } })}\n`;
  return createHash('sha256').update(json).digest('hex').slice(0, 12);
}

/**
 * Run `work` inside a job that holds the host-wide lock (`scripts/with-lock.mjs`, set up by the npm
 * scripts `corpus`, `sweep` and `gate:branch`). Without the lock it refuses, so no heavy run
 * bypasses the one-heavy-job rule.
 */
export async function withGateLock(work) {
  if (heldLock() === undefined) throw new Error('run this through its npm script (npm run corpus, sweep or gate:branch); it takes the host-wide lock');
  return work();
}
