'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve('.');
const temp = mkdtempSync(path.join(tmpdir(), 'portograph-elk-package-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed[0].filename)], { cwd: temp, stdio: 'pipe' });
  const body = `const model = api.sizeNodes(api.sidesOne(api.resolve(api.parse('portograph: 2\\ngroups: {a: {tier: 0}, b: {tier: 1}}\\nnodes: {n: {group: a}, m: {group: b}}\\nlinks: [[n, m]]'))));
    await api.skeleton(model, { createAttempt: createNodeElkFactory() });
    if (model.stage !== 'skeleton' || model.fallbackUsed) throw new Error('Packed Node skeleton failed');
    console.log('packed adapter ' + mode + ' passed');`;
  writeFileSync(path.join(temp, 'consumer.mjs'), `import * as api from 'portograph'; import { createNodeElkFactory } from 'portograph/node'; const mode='ES'; ${body}`);
  writeFileSync(path.join(temp, 'consumer.cjs'), `const api=require('portograph'); const {createNodeElkFactory}=require('portograph/node'); const mode='UMD'; (async()=>{${body}})().catch(error=>{console.error(error);process.exitCode=1;});`);
  for (const file of ['consumer.mjs', 'consumer.cjs']) console.log(execFileSync(process.execPath, [file], { cwd: temp, encoding: 'utf8', timeout: 15000 }).trim());
  writeFileSync(path.join(temp, 'bootstrap.cjs'), `const api = require('portograph'); const Worker = require('web-worker');
    const worker = new Worker('data:application/javascript;base64,' + Buffer.from('throw new Error("injected bootstrap failure")').toString('base64'));
    let stopped=0; const stop=worker.terminate.bind(worker); worker.terminate=()=>{ stopped++; stop(); };
    api.runElkAttempt({id:'root'},()=>api.createWorkerElkAttempt(worker),150).then(()=>{process.exitCode=1;},error=>{
      if (!(error instanceof api.ElkDeadlineError) || stopped !== 1) process.exitCode=1;
      console.log('bootstrap deadline and disposal passed');
    });`);
  const bootstrap = spawnSync(process.execPath, ['bootstrap.cjs'], { cwd: temp, encoding: 'utf8', timeout: 3000 });
  if (bootstrap.status !== 0 || !bootstrap.stderr.includes('injected bootstrap failure')) throw new Error('Expected Node bootstrap failure was not captured');
  console.log(bootstrap.stdout.trim());
  writeFileSync(path.join(temp, 'types.mts'), `import { skeleton, type CreateElkAttempt } from 'portograph';\nimport { createNodeElkFactory } from 'portograph/node';\nconst factory: CreateElkAttempt = createNodeElkFactory();\nvoid skeleton; void factory;\n`);
  writeFileSync(path.join(temp, 'types.cts'), `import adapter = require('portograph/node');\nconst attempt = adapter.createNodeElkFactory()();\nattempt.terminateWorker();\n`);
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'types.mts', 'types.cts'], { cwd: temp, stdio: 'pipe' });
  console.log('packed NodeNext ES and CommonJS adapter declarations passed');
} finally { rmSync(temp, { recursive: true, force: true }); }
