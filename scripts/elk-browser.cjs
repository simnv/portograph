'use strict';
/* global Worker */
// Run with: npx --yes --package=playwright -c 'node scripts/elk-browser.cjs'
const { createServer } = require('node:http');
const { readFileSync, realpathSync, existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cli = process.env.PATH.split(path.delimiter).map(dir => path.join(dir, 'playwright')).find(existsSync);
if (!cli) throw new Error('Run through npx --package=playwright');
const { chromium } = require(path.join(path.dirname(realpathSync(cli)), 'index.js'));
const dist = path.resolve('dist');
// The solver files come from the installed elkjs; the page serves them under their own names, the factory defaults.
const elk = path.dirname(require.resolve('elkjs/package.json'));
(async () => {
  const server = createServer((req, res) => {
    const assets = { '/api.js': path.join(dist, 'portograph.umd.cjs'), '/elk-api.js': path.join(elk, 'lib/elk-api.js'),
      '/elk-worker.min.js': path.join(elk, 'lib/elk-worker.min.js') };
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (assets[req.url]) return res.end(readFileSync(assets[req.url]));
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.url === '/stall.js') return res.end('postMessage({ ready: true }); while (true) {}');
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end('<!doctype html><meta charset="utf-8"><script src="/elk-api.js"></script><script src="/api.js"></script>'); }
    res.writeHead(404); res.end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Browser script error:', error.message));
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const api = globalThis.portograph;
      const graph = { id: 'root', children: [{ id: 'n', width: 50, height: 35 }] };
      let created = 0, terminated = 0;
      const factory = url => () => {
        const worker = new Worker(url); created++;
        const stop = worker.terminate.bind(worker);
        worker.terminate = () => { terminated++; stop(); };
        return api.createWorkerElkAttempt(worker);
      };
      const success = await api.runElkAttempt(graph, factory('/elk-worker.min.js'), 3000);
      const busy = new Worker('/stall.js');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stall worker did not start')), 2000);
        busy.onmessage = event => { if (event.data.ready) { clearTimeout(timer); resolve(); } };
      });
      created++;
      const stop = busy.terminate.bind(busy); busy.terminate = () => { terminated++; stop(); };
      let deadline = false;
      const started = performance.now();
      try { await api.runElkAttempt(graph, () => api.createWorkerElkAttempt(busy), 40); }
      catch (error) { deadline = error instanceof api.ElkDeadlineError; }
      const elapsedMs = performance.now() - started;
      const fallback = await api.runElkAttempt(graph, factory('/elk-worker.min.js'), 3000);
      let bootstrap = false;
      try { await api.runElkAttempt(graph, factory('/missing-worker.js'), 1000); }
      catch (error) { bootstrap = !(error instanceof api.ElkDeadlineError); }
      const model = api.sizeNodes(api.sidesOne(api.resolve(api.parse('portograph: 2\ngroups: {a: {tier: 0}, b: {tier: 1}}\nnodes: {n: {group: a}, m: {group: b}}\nlinks: [[n, m]]'))));
      await api.skeleton(model, { createAttempt: api.createBrowserElkFactory() });
      return { success: success.children[0].width, fallback: fallback.children[0].id,
        deadline, elapsedMs, created, terminated, bootstrap, stage: model.stage,
        bands: model.tierBands.map(band => ({ tier: band.tier, bounds: band.bounds })) };
    });
    assert.equal(result.success, 50); assert.equal(result.fallback, 'n');
    assert.equal(result.deadline, true); assert.ok(result.elapsedMs < 1500);
    assert.equal(result.created, 4); assert.equal(result.terminated, 4);
    assert.equal(result.bootstrap, true); assert.equal(result.stage, 'skeleton');
    assert.ok(result.bands[0].bounds.y + result.bands[0].bounds.height <= result.bands[1].bounds.y);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
