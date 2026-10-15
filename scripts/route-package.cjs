'use strict';
// Pack, install and exercise the stage-8 router from an unrelated working directory, on this Node
// and on the supported floor (Node 22.0). Run with: node scripts/route-package.cjs
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve('.');
const temp = mkdtempSync(path.join(tmpdir(), 'portograph-route-package-'));
let floor;
try {
  floor = execFileSync('npx', ['--yes', '--package=node@22.0.0', 'node', '-p', 'process.execPath'],
    { encoding: 'utf8', timeout: 300000 }).trim();
} catch (error) {
  throw new Error(`Node 22.0 floor runtime is unavailable: ${error.message}`);
}
if (!existsSync(floor)) throw new Error(`Node 22.0 floor runtime is unavailable at ${floor}`);

const yaml = [
  'portograph: 2',
  'groups: {top: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}',
  'nodes:',
  '  a: {group: top, ports: [{name: p, side: bottom}]}',
  '  m: {group: mid, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}',
  '  b: {group: low, ports: [{name: p, side: top}]}',
  '  c: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}',
  'links: [[a.p, b.p], [m.p, c.p], [m.q, c.q]]',
].join('\\n');

const golden = readFileSync(path.join(root, 'goldens/m1-sip-edge.yaml'), 'utf8');
const body = `
  const parsed = api.parseWithDiagnostics(${JSON.stringify(golden)});
  if (!parsed.ok) throw new Error('Golden failed to parse');
  const final = await api.layout(parsed.document, { diagnostics: parsed.diagnostics,
    createElkAttempt: createNodeElkFactory(), createRouteAttempt: createNodeRouteFactory(),
    budget: api.createBudget(30000) });
  const finalReport = api.score(final).snapshot;
  if (!finalReport.passed || finalReport.metrics.crossings.count !== 0 || final.links.length !== 26) throw new Error('Packed pipeline golden failed');
  const restored = api.restoreFinalLayout(api.serializeLayoutModel(final));
  if (api.render(restored) !== api.render(final)) throw new Error('Packed final JSON rendering differs');
  console.log('packed full pipeline ' + mode + ' Q=' + finalReport.Q);
  const model = api.sizeNodes(api.sidesOne(api.resolve(api.parse('${yaml}'))));
  await api.skeleton(model, { createAttempt: createNodeElkFactory() });
  const placed = api.bands(api.bundles(api.bars(api.centre(api.flanks(api.lanes(api.rows(api.sidesTwo(model))))))));
  if (JSON.stringify(api.routeRemainders(placed)) !== '["link-1"]') throw new Error('Unexpected remainder');

  let created = 0, terminated = 0;
  const factory = () => {
    const attempt = createNodeRouteFactory()();
    created++;
    const stop = attempt.worker.terminate.bind(attempt.worker);
    attempt.worker.terminate = () => { terminated++; stop(); };
    return attempt;
  };
  // Two diagrams at once: each worker loads its own WASM, and one initialization promise per pair.
  const [first, second] = await Promise.all([api.route(placed, { createAttempt: factory }), api.route(placed, { createAttempt: factory })]);
  const report = api.score(first, { golden: true }).snapshot;
  if (!report.passed || report.metrics.crossings.count !== 0) throw new Error('Packed route failed its gates');
  if (JSON.stringify(first.links[0].path) !== JSON.stringify(second.links[0].path)) throw new Error('Concurrent routes differ');
  if (created !== 2 || terminated !== 2) throw new Error('Router workers were not disposed: ' + created + '/' + terminated);

  const Worker = require('web-worker');
  const missing = api.createRouteFactory({ workerUrl: attemptAssets.workerUrl, moduleUrl: attemptAssets.moduleUrl,
    wasmUrl: attemptAssets.wasmUrl + '.missing' }, url => new Worker(url, { type: 'module' }));
  let failure;
  try { await api.route(placed, { createAttempt: missing, routeBudgetMs: 20000 }); }
  catch (error) { failure = error; }
  if (!failure || failure instanceof api.RouteDeadlineError) throw new Error('A missing WASM asset must fail before the deadline');

  let stalled;
  const stall = () => ({ worker: new Worker('data:text/javascript,while(true){}', { type: 'module' }), assets: attemptAssets });
  try { await api.route(placed, { createAttempt: stall, routeBudgetMs: 200 }); }
  catch (error) { stalled = error; }
  if (!(stalled instanceof api.RouteDeadlineError)) throw new Error('A worker that never replies must hit the deadline');
  console.log('packed router ' + mode + ' passed on ' + process.version);
`;
// The worker asset ships beside the installed adapter; resolving it here also proves it shipped.
const assets = `const attemptAssets = (() => {
  const dist = require('node:path').dirname(require.resolve('portograph/node'));
  const workerUrl = require('node:url').pathToFileURL(require('node:path').join(dist, 'portograph-avoid-worker.mjs')).href;
  const attempt = createNodeRouteFactory()();
  attempt.worker.terminate();
  return { workerUrl, moduleUrl: attempt.assets.moduleUrl, wasmUrl: attempt.assets.wasmUrl };
})();`;

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed[0].filename)], { cwd: temp, stdio: 'pipe' });
  writeFileSync(path.join(temp, 'consumer.mjs'), `import * as api from 'portograph/internal';
import { createNodeElkFactory, createNodeRouteFactory } from 'portograph/node';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mode = 'ES';
${assets}
${body}`);
  writeFileSync(path.join(temp, 'consumer.cjs'), `const api = require('portograph/internal');
const { createNodeElkFactory, createNodeRouteFactory } = require('portograph/node');
const mode = 'UMD';
${assets}
(async () => {${body}})().catch(error => { console.error(error); process.exitCode = 1; });`);
  for (const runtime of [process.execPath, floor]) {
    for (const file of ['consumer.mjs', 'consumer.cjs']) {
      console.log(execFileSync(runtime, [file], { cwd: temp, encoding: 'utf8', timeout: 120000 }).trim());
    }
  }
  const input = path.join(temp, 'golden.yaml');
  writeFileSync(input, golden);
  for (const runtime of [process.execPath, floor]) {
    const installedCli = path.join(temp, 'node_modules/portograph/bin/portograph.mjs');
    const output = path.join(temp, 'golden.svg');
    execFileSync(runtime, [installedCli, 'render', input, '--output', output], { cwd: temp, stdio: 'pipe', timeout: 40000 });
    const model = path.join(temp, 'golden.layout.json');
    const restoredSvg = execFileSync(runtime, [installedCli, 'render', model], { cwd: temp, encoding: 'utf8', timeout: 40000 });
    if (restoredSvg.trimEnd() !== readFileSync(output, 'utf8').trimEnd()) throw new Error('Packed CLI JSON renderer differs');
    console.log('packed CLI YAML / final JSON passed on ' + execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim());
  }
  writeFileSync(path.join(temp, 'types.mts'), `import { route, type CreateRouteAttempt, type RouteOptions } from 'portograph/internal';\nimport { createNodeRouteFactory } from 'portograph/node';\nconst factory: CreateRouteAttempt = createNodeRouteFactory();\nconst options: RouteOptions = { createAttempt: factory, routeBudgetMs: 30000 };\nvoid route; void options;\n`);
  writeFileSync(path.join(temp, 'types.cts'), `import adapter = require('portograph/node');\nconst attempt = adapter.createNodeRouteFactory()();\nattempt.worker.terminate();\n`);
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'types.mts', 'types.cts'], { cwd: temp, stdio: 'pipe' });
  console.log('packed NodeNext ES and CommonJS router declarations passed');
} finally { rmSync(temp, { recursive: true, force: true }); }
