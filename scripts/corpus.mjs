/**
 * The corpus gate: every `goldens/**\/*.yaml` laid out and scored, one TSV line per sheet.
 *
 * Usage: npm run corpus -- <out.tsv>      (builds dist/ first; see docs/gates.md)
 *
 * Columns, after a header line:
 *   file     the sheet, relative to the repository root
 *   Q        the score (printed for the reader; `gate:compare` never judges it)
 *   X        routed crossings that are not faint (all of them on a sheet with no fan family)
 *   Xf       faint crossings: two members of one fan family cross (architecture-2 ticket 40); printed, never judged
 *   W        canvas, `<width>x<height>` in whole pixels
 *   gates    the error-severity gate ids with a violation, comma-separated, or `-`
 *   warn     the warning-severity gate ids with a violation, or `-` (printed, never judged)
 *   routed   routed links without a bend / routed links
 *   fb       FAN_BRANCH_THROUGH_GROUP diagnostics
 *   edge     STRAIGHT_LINK_EDGE diagnostics
 *   ob       overlay links with a bend / overlay links (mesh-bus members excluded)
 *   bends    the bends of every kept link, routed and overlay (`pathBends`: a turn or a reversal; a collinear piece is no bend)
 *   side     SIDE_HINT_TAKEN diagnostics
 *   removed  the links stage 8 removed
 *   labelBorder  the scorer's labelBorderCrossings counter (0 when absent)
 *   track    the scorer's overlayTrackShares counter: run pairs of two overlay paths on one track (0 when absent)
 *   hash     12 hex of sha256 of the layout JSON without runtime stages (what portograph render writes)
 *
 * Every geometry number is the scorer's (`score().snapshot`: `metrics`, `counts`, `counters`,
 * `canvas`, `gates`); this script counts nothing of its own. A sheet that fails to lay out gets the
 * line `<file>\tERROR <message>`; one that passes the per-sheet deadline (`PORTOGRAPH_GATE_DEADLINE`
 * seconds, default 120) gets `<file>\tTIMEOUT after <n> s` and the run goes on.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { COLUMNS, ROOT, elapsed, failure, layoutHash, openPipeline, outputArgument, sheets, withGateLock } from './gate-lib.mjs';

/** One corpus row from a laid-out model and its score snapshot. */
function row(file, model, snapshot, hash) {
  const diagnostics = (code) => model.diagnostics.filter((d) => d.code === code).length;
  const failed = (severity) => Object.keys(snapshot.gates).filter((id) => snapshot.gates[id].severity === severity && snapshot.gates[id].violations.length > 0).join(',') || '-';
  const { routed, overlay } = snapshot.counts;
  const canvas = snapshot.canvas ? `${Math.round(snapshot.canvas.width)}x${Math.round(snapshot.canvas.height)}` : '-';
  return [
    file,
    snapshot.Q.toFixed(4),
    String(snapshot.metrics.crossings.count - (snapshot.metrics.crossings.faint ?? 0)),
    String(snapshot.metrics.crossings.faint ?? 0),
    canvas,
    failed('error'),
    failed('warning'),
    `${routed.links - routed.bent}/${routed.links}`,
    String(diagnostics('FAN_BRANCH_THROUGH_GROUP')),
    String(diagnostics('STRAIGHT_LINK_EDGE')),
    `${overlay.bent}/${overlay.links}`,
    String(routed.turns + overlay.turns),
    String(diagnostics('SIDE_HINT_TAKEN')),
    String(snapshot.counters.removedLinks),
    String(snapshot.counters.labelBorderCrossings ?? 0),
    String(snapshot.counters.overlayTrackShares ?? 0),
    hash,
  ].join('\t');
}

const TIMING_COLUMNS = ['file', 'totalMs', 'parseMs', 'layoutMs', 'scoreMs', 'status'];

async function main(argv) {
  const out = outputArgument(argv, 'npm run corpus -- <out.tsv>');
  const timingsOut = `${out}.timings.tsv`;
  // goldens/synthetic/stage-inputs.yaml is test data, not a sheet (goldens/README.md).
  const files = sheets(join(ROOT, 'goldens')).filter((file) => file !== 'goldens/synthetic/stage-inputs.yaml');
  const start = performance.now();
  const pipeline = await openPipeline();
  writeFileSync(out, `${COLUMNS.join('\t')}\n`);
  writeFileSync(timingsOut, `${TIMING_COLUMNS.join('\t')}\n`);
  const timings = [];
  try {
    for (const [index, file] of files.entries()) {
      process.stderr.write(`corpus: ${index + 1}/${files.length} ${file}\n`);
      let line;
      let parseMs = 0;
      let layoutMs = 0;
      let scoreMs = 0;
      let status = 'ok';
      const sheetStart = performance.now();
      try {
        const text = readFileSync(join(ROOT, file), 'utf8');
        const parseStart = performance.now();
        let parsed;
        try {
          parsed = pipeline.api.parse(text);
        } finally {
          parseMs = performance.now() - parseStart;
        }
        const layoutStart = performance.now();
        let model;
        try {
          model = await pipeline.layout(parsed);
        } finally {
          layoutMs = performance.now() - layoutStart;
        }
        const scoreStart = performance.now();
        let snapshot;
        try {
          snapshot = pipeline.api.score(model).snapshot;
        } finally {
          scoreMs = performance.now() - scoreStart;
        }
        line = row(file, model, snapshot, layoutHash(pipeline.api, model));
      } catch (error) {
        line = `${file}\t${failure(error)}`;
        status = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR';
      }
      const totalMs = performance.now() - sheetStart;
      appendFileSync(out, `${line}\n`);
      appendFileSync(timingsOut, `${[file, totalMs.toFixed(1), parseMs.toFixed(1), layoutMs.toFixed(1), scoreMs.toFixed(1), status].join('\t')}\n`);
      timings.push({ file, totalMs });
    }
  } finally {
    pipeline.close();
  }
  process.stderr.write(`corpus: ${files.length} sheets in ${elapsed(start)} -> ${out}\n`);
  const slowest = [...timings].sort((a, b) => b.totalMs - a.totalMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)).slice(0, 5);
  if (slowest.length > 0) {
    process.stderr.write(`slowest 5: ${slowest.map((entry) => `${entry.file} (${entry.totalMs.toFixed(1)} ms)`).join(', ')}\n`);
  }
}

withGateLock(() => main(process.argv.slice(2))).then(
  () => { process.exitCode = 0; },
  (error) => {
    process.stderr.write(`corpus: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
