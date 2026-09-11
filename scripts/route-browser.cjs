'use strict';
/* global Worker */
// Serve the built assets and route a real diagram in Chrome.
// Run with: npx --yes --package=playwright -c 'node scripts/route-browser.cjs'
const { createServer } = require('node:http');
const { readFileSync, realpathSync, existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cli = process.env.PATH.split(path.delimiter).map(dir => path.join(dir, 'playwright')).find(existsSync);
if (!cli) throw new Error('Run through npx --package=playwright');
const { chromium } = require(path.join(path.dirname(realpathSync(cli)), 'index.js'));
const dist = path.resolve('dist');
const yaml = [
  'portograph: 2',
  'groups: {top: {tier: 0}, mid: {tier: 1}, low: {tier: 2}}',
  'nodes:',
  '  a: {group: top, ports: [{name: p, side: bottom}]}',
  '  m: {group: mid, ports: [{name: p, side: bottom}, {name: q, side: bottom}]}',
  '  b: {group: low, ports: [{name: p, side: top}]}',
  '  c: {group: low, ports: [{name: p, side: top}, {name: q, side: top}]}',
  'links: [[a.p, b.p], [m.p, c.p], [m.q, c.q]]',
].join('\n');

(async () => {
  const server = createServer((req, res) => {
    const scripts = { '/api.js': 'portograph.umd.cjs', '/esm.js': 'portograph.js',
      '/portograph-elk-worker.js': 'portograph-elk-worker.js',
      '/portograph-avoid-worker.mjs': 'portograph-avoid-worker.mjs', '/portograph-avoid.mjs': 'portograph-avoid.mjs' };
    if (req.url === '/portograph-libavoid.wasm') {
      res.setHeader('Content-Type', 'application/wasm');
      return res.end(readFileSync(path.join(dist, 'portograph-libavoid.wasm')));
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (scripts[req.url]) return res.end(readFileSync(path.join(dist, scripts[req.url])));
    if (req.url === '/stall.mjs') return res.end('postMessage({ ready: true }); while (true) {}');
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><meta charset="utf-8"><script src="/api.js"></script>'
        + '<script type="module">import * as esm from "/esm.js"; globalThis.portographEsm = esm;</script>');
    }
    res.writeHead(404); res.end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Browser script error:', error.message));
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => globalThis.portographEsm !== undefined);
    const result = await page.evaluate(async ({ source, golden }) => {
      const placedWith = async api => {
        const model = api.sizeNodes(api.sidesOne(api.resolve(api.parse(source))));
        await api.skeleton(model, { createAttempt: api.createBrowserElkFactory('/portograph-elk-worker.js') });
        return api.bands(api.bundles(api.bars(api.centre(api.flanks(api.lanes(api.rows(api.sidesTwo(model))))))));
      };
      const out = {};
      let created = 0, terminated = 0;
      const counted = api => {
        const factory = api.createBrowserRouteFactory();
        return () => {
          const attempt = factory(); created++;
          const stop = attempt.worker.terminate.bind(attempt.worker);
          attempt.worker.terminate = () => { terminated++; stop(); };
          return attempt;
        };
      };
      for (const [mode, api] of [['UMD', globalThis.portograph], ['ES', globalThis.portographEsm]]) {
        const parsed = api.parseWithDiagnostics(golden);
        if (!parsed.ok) throw new Error('Golden must parse');
        const final = await api.layout(parsed.document, { diagnostics: parsed.diagnostics,
          createElkAttempt: api.createBrowserElkFactory('/portograph-elk-worker.js'),
          createRouteAttempt: api.createBrowserRouteFactory(), budget: api.createBudget(30000) });
        const report = api.score(final).snapshot;
        const restored = api.restoreFinalLayout(api.serializeLayoutModel(final));
        out[mode + 'FullPipeline'] = report.passed && report.metrics.crossings.count === 0
          && final.links.length === 26 && api.render(restored) === api.render(final);
        out[mode + 'Q'] = report.Q;
        const placed = await placedWith(api);
        out[mode + 'Remainder'] = api.routeRemainders(placed);
        // Two diagrams at once share one worker each; each loads its own WASM exactly once.
        const [first, second] = await Promise.all([
          api.route(placed, { createAttempt: counted(api) }),
          api.route(placed, { createAttempt: counted(api) }),
        ]);
        out[mode + 'Passed'] = api.score(first, { golden: true }).snapshot.passed;
        out[mode + 'Stable'] = JSON.stringify(first.links[0].path) === JSON.stringify(second.links[0].path);
        out[mode + 'Segments'] = first.links[0].path.segments.length;
      }
      const api = globalThis.portograph;
      const placed = await placedWith(api);
      const missing = api.createBrowserRouteFactory({ wasmUrl: '/portograph-libavoid.wasm.missing' });
      try { await api.route(placed, { createAttempt: missing, routeBudgetMs: 20000 }); }
      catch (error) { out.missingWasm = !(error instanceof api.RouteDeadlineError) && String(error.message).length > 0; }
      const stall = () => ({ worker: new Worker('/stall.mjs', { type: 'module' }),
        assets: { moduleUrl: '/portograph-avoid.mjs', wasmUrl: '/portograph-libavoid.wasm' } });
      const started = performance.now();
      try { await api.route(placed, { createAttempt: stall, routeBudgetMs: 150 }); }
      catch (error) { out.deadline = error instanceof api.RouteDeadlineError; }
      out.elapsedMs = performance.now() - started;
      out.created = created; out.terminated = terminated;
      return out;
    }, { source: yaml, golden: readFileSync(path.resolve('goldens/m1-sip-edge.yaml'), 'utf8') });
    assert.equal(result.UMDFullPipeline, true); assert.equal(result.ESFullPipeline, true);
    assert.deepEqual(result.UMDRemainder, ['link-1']);
    assert.deepEqual(result.ESRemainder, ['link-1']);
    assert.equal(result.UMDPassed, true); assert.equal(result.ESPassed, true);
    assert.equal(result.UMDStable, true); assert.equal(result.ESStable, true);
    assert.equal(result.UMDSegments, result.ESSegments);
    assert.equal(result.missingWasm, true);
    assert.equal(result.deadline, true);
    assert.ok(result.elapsedMs < 5000, `deadline took ${result.elapsedMs} ms`);
    assert.equal(result.created, 4); assert.equal(result.terminated, 4);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
