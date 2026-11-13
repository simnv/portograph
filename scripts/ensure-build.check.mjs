/**
 * Unit tests for `scripts/ensure-build.mjs`: stamp creation, cache hit skip, source-change
 * invalidation, missing-output invalidation, and CLI `--check-only`. Run with
 * `node --test scripts/ensure-build.check.mjs`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_ARTIFACTS,
  STAMP_REL_PATH,
  computeBuildDigest,
  ensureBuild,
  isBuildUpToDate,
} from './ensure-build.mjs';

const ENSURE_BUILD = fileURLToPath(new URL('./ensure-build.mjs', import.meta.url));

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pg-ensure-build-'));
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'src', 'nested', 'helper.ts'), 'export const y = 2;\n');
  writeFileSync(join(dir, 'runtime', 'node.cjs'), 'module.exports = {};\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{}}\n');
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {};\n');
  return dir;
}

function writeAllArtifacts(root) {
  for (const rel of REQUIRED_ARTIFACTS) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `// ${rel}\n`);
  }
}

test('creates stamp on initial build and skips on cache hit', () => {
  const root = makeFixtureRepo();
  try {
    let buildCalls = 0;
    const first = ensureBuild({
      root,
      build: () => {
        buildCalls += 1;
        writeAllArtifacts(root);
      },
    });
    assert.equal(buildCalls, 1);
    assert.equal(first.built, true);
    assert.equal(first.upToDate, false);

    const stamp = JSON.parse(readFileSync(join(root, STAMP_REL_PATH), 'utf8'));
    assert.equal(stamp.digest, first.digest);
    assert.equal(stamp.node, process.version);

    const second = ensureBuild({
      root,
      build: () => {
        throw new Error('build should have been skipped on cache hit');
      },
    });
    assert.equal(second.built, false);
    assert.equal(second.upToDate, true);
    assert.equal(second.digest, first.digest);

    const cli = spawnSync(process.execPath, [ENSURE_BUILD, '--check-only', '--root', root], { encoding: 'utf8' });
    assert.equal(cli.status, 0);
    assert.equal(cli.stdout, '');
    assert.equal(cli.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidates when source, runtime, config, path, or node version changes', () => {
  const root = makeFixtureRepo();
  try {
    let buildCalls = 0;
    const fakeBuild = () => {
      buildCalls += 1;
      writeAllArtifacts(root);
    };

    ensureBuild({ root, build: fakeBuild });
    assert.equal(buildCalls, 1);

    // 1. Modify a byte under src/
    writeFileSync(join(root, 'src', 'nested', 'helper.ts'), 'export const y = 3;\n');
    assert.equal(isBuildUpToDate(root).upToDate, false);
    const cli = spawnSync(process.execPath, [ENSURE_BUILD, '--check-only', '--root', root], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    ensureBuild({ root, build: fakeBuild });
    assert.equal(buildCalls, 2);

    // 2. Rename a file with identical bytes (path is part of digest)
    renameSync(join(root, 'src', 'nested', 'helper.ts'), join(root, 'src', 'nested', 'helper2.ts'));
    assert.equal(isBuildUpToDate(root).upToDate, false);
    ensureBuild({ root, build: fakeBuild });
    assert.equal(buildCalls, 3);

    // 3. Modify runtime/
    writeFileSync(join(root, 'runtime', 'node.cjs'), 'module.exports = { v: 2 };\n');
    assert.equal(isBuildUpToDate(root).upToDate, false);
    ensureBuild({ root, build: fakeBuild });
    assert.equal(buildCalls, 4);

    // 4. Modify root build configs
    for (const cfg of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']) {
      writeFileSync(join(root, cfg), `${readFileSync(join(root, cfg), 'utf8')} `);
      assert.equal(isBuildUpToDate(root).upToDate, false, `${cfg} change invalidates stamp`);
      ensureBuild({ root, build: fakeBuild });
    }
    assert.equal(buildCalls, 8);

    // 5. Different Node version changes digest
    const d1 = computeBuildDigest(root, 'v22.0.0');
    const d2 = computeBuildDigest(root, 'v22.1.0');
    assert.notEqual(d1, d2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidates when any required dist artifact is missing or stamp is corrupt', () => {
  const root = makeFixtureRepo();
  try {
    let buildCalls = 0;
    const fakeBuild = () => {
      buildCalls += 1;
      writeAllArtifacts(root);
    };
    ensureBuild({ root, build: fakeBuild });
    assert.equal(buildCalls, 1);

    for (const rel of REQUIRED_ARTIFACTS) {
      unlinkSync(join(root, rel));
      assert.equal(isBuildUpToDate(root).upToDate, false, `missing ${rel} invalidates build`);
      ensureBuild({ root, build: fakeBuild });
    }
    assert.equal(buildCalls, 1 + REQUIRED_ARTIFACTS.length);

    // Corrupt stamp triggers rebuild
    writeFileSync(join(root, STAMP_REL_PATH), '{not json');
    assert.equal(isBuildUpToDate(root).upToDate, false);
    ensureBuild({ root, build: fakeBuild });
    assert.equal(buildCalls, 2 + REQUIRED_ARTIFACTS.length);

    // Build that fails to produce all required outputs throws without stamping
    unlinkSync(join(root, 'dist', 'index.cjs'));
    assert.throws(
      () => ensureBuild({ root, build: () => {} }),
      /missing expected artifacts: dist\/index\.cjs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
