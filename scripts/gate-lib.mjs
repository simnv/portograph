/**
 * What the gate scripts (`corpus.mjs`, `sweep.mjs`, `r3.mjs`) share: the pipeline as the command line runs it.
 *
 * The scripts load the built library in `dist/` and the solver workers, the way `bin/compute.mjs`
 * does, so a gate measures what `portograph render` produces. One warm ELK worker serves every
 * sheet; the router starts a worker per session and ends it with the session. `npm run corpus` and
 * `npm run sweep` build `dist/` before they run, so the measurement is never of a stale build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { heldLock } from './test-runner-lib.mjs';

const require = createRequire(import.meta.url);

/** The columns of a corpus TSV, in order; `corpus.mjs` writes them and `gate-compare.mjs` reads them. */
export const COLUMNS = ['file', 'Q', 'X', 'Xf', 'W', 'gates', 'warn', 'routed', 'fb', 'edge', 'ob', 'bends', 'side', 'removed', 'labelBorder', 'track', 'fallback', 'choice', 'hash'];
/**
 * The columns of a corpus TSV written before `fallback` (dense-16x9 ticket 56). `gate:branch` reuses such a base: the fallback of a default-on
 * sheet is new in the head, so a missing base column reads as 0.
 */
export const COLUMNS_BEFORE_FALLBACK = COLUMNS.filter((column) => column !== 'fallback' && column !== 'choice');
/**
 * The columns of a corpus TSV written before `choice` (dense-16x9 ticket 60). `gate:branch` reuses such a base too: `gate:compare` compares only
 * the columns both files have, and a choice is no worse row by itself.
 */
export const COLUMNS_BEFORE_CHOICE = COLUMNS.filter((column) => column !== 'choice');
/**
 * The sheets that may fall back to the option-off run of `layout.moveBeforeGrow` (dense-16x9 ticket 56), each with its reason: a corpus sheet by
 * its path, a sweep sheet by its name. A sheet that falls back and is not listed fails the gate on every path (`unlistedFallback`), so a new class
 * of failure shows up. None today.
 */
export const FALLBACK_SHEETS = new Map();

/**
 * Whether `value`, the fallback of `sheet` (the corpus `fallback` cell, or the refusal code of a sweep `fallback=` field), is a fallback that
 * `FALLBACK_SHEETS` does not list (review 1 of ticket 56). The one rule of every path: a corpus row changed, recovered from an error or only in
 * the head, and a sweep row. Absent, `0` and an empty field are no fallback.
 */
export function unlistedFallback(sheet, value) {
  return value !== undefined && value !== '' && value !== '0' && !FALLBACK_SHEETS.has(sheet);
}

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
  const elkWorkerUrl = require.resolve('elkjs/lib/elk-worker.min.js');
  const newElk = () => {
    const warm = require('../dist/warm-elk.cjs').createWarmElk(api.createWorkerElkAttempt, () => new Worker(elkWorkerUrl));
    warm.warm();
    return warm;
  };
  let elk = newElk();
  const newRouter = () => {
    const warm = api.createWarmRouteFactory(require('../dist/node.cjs').createNodeRouteFactory());
    warm.warm();
    return warm;
  };
  let router = newRouter();
  const deadline = deadlineMs();
  return {
    api,
    /** Lays one document out; rejects with a `TimeoutError` after the per-sheet deadline, then runs on with fresh ELK and route workers. */
    async layout(document) {
      const checkCachesEnv = process.env.PORTOGRAPH_CHECK_CACHES;
      const checkCaches = checkCachesEnv === 'sampled' ? 'sampled'
        : (checkCachesEnv === '1' || checkCachesEnv === 'true' || checkCachesEnv === 'all') ? true
        : undefined;
      const running = api.layout(document, {
        createElkAttempt: () => elk.attempt(),
        createRouteAttempt: router.attempt,
        ...(checkCaches !== undefined ? { checkCaches } : {}),
      });
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
          router.close();
          router = newRouter();
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => { elk.close(); router.close(); },
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
 * scripts `corpus`, `sweep`, `r3` and `gate:branch`). Without the lock it refuses, so no heavy run
 * bypasses the one-heavy-job rule.
 */
export async function withGateLock(work) {
  if (heldLock() === undefined) throw new Error('run this through its npm script (npm run corpus, sweep, r3 or gate:branch); it takes the host-wide lock');
  return work();
}

/** A corpus TSV that cannot be read: `gate:compare` and `gate:pairs` print it and exit 2. */
export class CorpusTsvError extends Error {}

/**
 * `{ columns, rows: Map<file, { cells } | { error }> }` from one corpus TSV, or a `CorpusTsvError`. The one reader of the gate scripts: a file in
 * an older column format (`COLUMNS_BEFORE_FALLBACK`, `COLUMNS_BEFORE_CHOICE`) reads with the columns it has.
 */
export function readCorpusTsv(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CorpusTsvError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const columns = (lines[0] ?? '').split('\t');
  if (columns[0] !== 'file' || columns.some((column) => !COLUMNS.includes(column))) {
    throw new CorpusTsvError(`${path}:1: not a corpus header (expected ${COLUMNS.join(', ')})`);
  }
  const rows = new Map();
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split('\t');
    const file = fields[0];
    if (file === undefined || file === '') throw new CorpusTsvError(`${path}:${index + 2}: no file`);
    if (rows.has(file)) throw new CorpusTsvError(`${path}:${index + 2}: ${file} appears twice`);
    if (/^(ERROR|TIMEOUT)/.test(fields[1] ?? '')) {
      rows.set(file, { error: fields.slice(1).join(' ') });
      continue;
    }
    if (fields.length !== columns.length) throw new CorpusTsvError(`${path}:${index + 2}: ${fields.length} fields, header has ${columns.length}`);
    const cells = Object.fromEntries(columns.map((column, position) => [column, fields[position]]));
    if ('fallback' in cells && !/^[01]$/.test(cells.fallback)) throw new CorpusTsvError(`${path}:${index + 2}: fallback is not 0 or 1: ${cells.fallback}`);
    if ('choice' in cells && !/^[01]$/.test(cells.choice)) throw new CorpusTsvError(`${path}:${index + 2}: choice is not 0 or 1: ${cells.choice}`);
    for (const column of ['bends', 'removed', 'X', 'Xf', 'labelBorder', 'track']) {
      if (column in cells && !/^\d+$/.test(cells[column])) throw new CorpusTsvError(`${path}:${index + 2}: ${column} is not a count: ${cells[column]}`);
    }
    if ('W' in cells && cells.W !== '-' && !/^\d+x\d+$/.test(cells.W)) throw new CorpusTsvError(`${path}:${index + 2}: W is not <width>x<height> or -: ${cells.W}`);
    rows.set(file, { cells });
  }
  return { columns, rows };
}

/** The gate ids of a `gates` cell, and the area of a `W` cell (`<width>x<height>`). */
export const gateSet = (text) => new Set(text === '-' ? [] : text.split(','));
export const area = (text) => text.split('x').reduce((product, side) => product * Number(side), 1);


/**
 * The worse flags of one sheet whose base and head both lay out, in judgement order (bends, removed, gates, crossings, canvas, labelBorder,
 * track, fallback); a missing column is never judged. The one judgement of `gate:compare` and `gate:pairs`.
 */
export function worseFlags(base, head, file) {
  const worse = [];
  const both = (column) => column in base && column in head;
  if (both('bends') && Number(head.bends) > Number(base.bends)) worse.push('bends');
  if (both('removed') && Number(head.removed) > Number(base.removed)) worse.push('removed');
  if (both('gates') && [...gateSet(head.gates)].some((id) => !gateSet(base.gates).has(id))) worse.push('gates');
  if (both('X') && Number(head.X) > Number(base.X)) worse.push('crossings');
  if (both('W') && head.W !== '-' && base.W !== '-' && area(head.W) > area(base.W)) worse.push('canvas');
  if (both('labelBorder') && Number(head.labelBorder) > Number(base.labelBorder)) worse.push('labelBorder');
  if (both('track') && Number(head.track) > Number(base.track)) worse.push('track');
  if (unlistedFallback(file, head.fallback)) worse.push('fallback');
  return worse;
}
