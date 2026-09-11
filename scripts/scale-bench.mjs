/**
 * Full-pipeline scale benchmark (ticket 17).
 *
 * It runs the real `portograph render --output` command under the real command deadline, so every
 * measurement covers what a user pays for: parse, resolve, the freeze copies, every region stage,
 * the ELK worker, the libavoid worker, stage 9, the score and the SVG. Nothing is stubbed and
 * nothing sleeps.
 *
 * Per-stage times are read from the command's own progress output, so a run that fails or hits the
 * deadline still reports where its time went and which stage stopped it — which is the point of a
 * scale measurement, not an afterthought.
 *
 * Run with: node scripts/scale-bench.mjs [nodes...]
 * PORTOGRAPH_BENCH_OUT   append one JSON line per case to this path
 * PORTOGRAPH_BENCH_LIMIT command deadline in ms (default 30000, the shipped limit)
 * PORTOGRAPH_BENCH_SHAPE `hub` (default) or `chain`; see `scale-input.mjs`
 */
import { execFile } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateScaleYaml } from './scale-input.mjs';

const run = promisify(execFile);
const sizes = process.argv.slice(2).map(Number).filter(Number.isFinite);
const cases = sizes.length ? sizes : [100, 300, 1000];
const out = process.env.PORTOGRAPH_BENCH_OUT;
const limitMs = Number(process.env.PORTOGRAPH_BENCH_LIMIT ?? 30000);
const shape = process.env.PORTOGRAPH_BENCH_SHAPE ?? 'hub';
const temp = mkdtempSync(path.join(tmpdir(), 'portograph-scale-'));

/** `portograph: <stage> took <n> ms, <m> ms left` — the command's own stderr progress. */
const STAGE = /^portograph: (\S+) took (\d+) ms, (\d+) ms left$/;

function stages(stderr) {
  const result = {};
  for (const line of stderr.split('\n')) {
    const match = STAGE.exec(line.trim());
    if (match) result[match[1]] = Number(match[2]);
  }
  return result;
}

const routed = (model) => model.links.filter((link) => link.path && (link.layer ?? link.family) === 'routed');

try {
  for (const nodes of cases) {
    // The specified 100/300/1000 sizes give each hub three incoming source links.
    // Its 61 access links bring total incidence to the quality spec's degree 64.
    const generated = generateScaleYaml({ nodes, shape, degree: 61 });
    const input = path.join(temp, `scale-${nodes}.yaml`);
    const svg = path.join(temp, `scale-${nodes}.svg`);
    const stem = svg.slice(0, -4);
    writeFileSync(input, generated.yaml);

    const started = process.hrtime.bigint();
    let exit = 0;
    let stderr = '';
    try {
      ({ stderr } = await run(process.execPath, ['bin/portograph.mjs', 'render', input, '--output', svg], {
        maxBuffer: 512 * 1024 * 1024,
        timeout: limitMs + 120000,
        env: { ...process.env, PORTOGRAPH_PROGRESS: '1', PORTOGRAPH_COMMAND_DEADLINE_MS: String(limitMs) },
      }));
    } catch (error) {
      exit = error.code ?? `signal:${error.signal}`;
      stderr = error.stderr ?? String(error);
    }
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

    const record = {
      shape, nodes, authoredLinks: generated.links, exit, commandDeadlineMs: limitMs,
      wallMs: Math.round(wallMs), withinDeadline: wallMs < limitMs,
      warnings: stderr.split('\n').filter((line) => line.includes('warning:')).length,
      stageMs: stages(stderr),
    };
    if (exit === 0 || exit === 1) {
      const model = JSON.parse(readFileSync(`${stem}.layout.json`, 'utf8'));
      const report = JSON.parse(readFileSync(`${stem}.score.json`, 'utf8'));
      const api = await import('../dist/portograph.js');
      // `score()` copies the layout's runtime and never times itself, so scoring and rendering are
      // measured here, outside the snapshot, on the same final model the command published.
      const restored = api.restoreFinalLayout(readFileSync(`${stem}.layout.json`, 'utf8'));
      const scoreStarted = process.hrtime.bigint();
      api.score(restored, { force: true });
      const scoreMs = Number(process.hrtime.bigint() - scoreStarted) / 1e6;
      const renderStarted = process.hrtime.bigint();
      api.render(restored);
      const renderMs = Number(process.hrtime.bigint() - renderStarted) / 1e6;
      Object.assign(record, {
        routedLinks: routed(model).length,
        routedSegments: routed(model).reduce((sum, link) => sum + link.path.segments.length, 0),
        lanes: model.lanes.length, bundles: model.bundles.length, labels: model.labels.length,
        fallbackUsed: model.fallbackUsed === true, deadlineHit: model.deadlineHit === true,
        scoreMs: Math.round(scoreMs), renderMs: Math.round(renderMs),
        svgBytes: statSync(svg).size, layoutBytes: statSync(`${stem}.layout.json`).size,
        Q: report.snapshot.Q, passed: report.snapshot.passed,
        crossings: report.snapshot.metrics.crossings.count,
        failedGates: Object.entries(report.snapshot.gates).filter(([, gate]) => !gate.passed).map(([id]) => id),
      });
    } else {
      record.error = stderr.split('\n').filter((line) => line.includes('error:')).join(' | ').trim();
      record.stoppedAfter = Object.keys(record.stageMs).at(-1) ?? 'parse';
    }
    console.log(JSON.stringify(record));
    if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
