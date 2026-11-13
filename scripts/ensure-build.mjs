/**
 * Build-stamp helper for gate scripts (`corpus:run`, `sweep:run`, `r3:run`).
 *
 * Computes a sha256 digest of all build inputs (`src/**`, `runtime/**`, `package.json`,
 * `package-lock.json`, `tsconfig.json`, `vite.config.ts`, and `process.version`). If every
 * required `dist/` artifact exists and `dist/.build-stamp.json` matches the digest, exits 0
 * quietly; otherwise runs `vite build --logLevel error`, verifies outputs exist, and writes
 * `dist/.build-stamp.json` atomically.
 *
 * Usage: node scripts/ensure-build.mjs [--check-only] [--root <dir>]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STAMP_REL_PATH = 'dist/.build-stamp.json';
export const INPUT_DIRS = ['src', 'runtime'];
export const INPUT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];
export const REQUIRED_ARTIFACTS = [
  'dist/portograph.js',
  'dist/portograph.umd.cjs',
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.d.cts',
  'dist/node.cjs',
  'dist/warm-elk.cjs',
  'dist/portograph-avoid-worker.mjs',
];

/** Recursively collect file paths under `directory`, relative to `root` with `/` separators. */
function walkFiles(root, directory, out) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

/** Sorted list of relative build-input paths under `root`. */
export function collectInputFiles(root = ROOT) {
  const files = [...INPUT_FILES];
  for (const dir of INPUT_DIRS) walkFiles(root, join(root, dir), files);
  return [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Deterministic sha256 digest over all build inputs and `nodeVersion`. */
export function computeBuildDigest(root = ROOT, nodeVersion = process.version) {
  const hash = createHash('sha256');
  hash.update('node\0');
  hash.update(nodeVersion);
  hash.update('\0');
  for (const rel of collectInputFiles(root)) {
    const full = join(root, rel);
    hash.update(rel);
    hash.update('\0');
    if (existsSync(full) && statSync(full).isFile()) {
      hash.update('1\0');
      hash.update(readFileSync(full));
      hash.update('\0');
    } else {
      hash.update('0\0');
    }
  }
  return hash.digest('hex');
}

/** Return the subset of `artifacts` that are missing (or not files) under `root`. */
export function missingArtifacts(root = ROOT, artifacts = REQUIRED_ARTIFACTS) {
  return artifacts.filter((rel) => {
    const full = join(root, rel);
    return !existsSync(full) || !statSync(full).isFile();
  });
}

/** True when every required artifact exists under `root`. */
export function artifactsExist(root = ROOT, artifacts = REQUIRED_ARTIFACTS) {
  return missingArtifacts(root, artifacts).length === 0;
}

/** Read and validate `dist/.build-stamp.json` under `root`, or return undefined. */
export function readBuildStamp(root = ROOT) {
  const stampPath = join(root, STAMP_REL_PATH);
  if (!existsSync(stampPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.digest === 'string') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Atomically write `dist/.build-stamp.json` under `root`. */
export function writeBuildStamp(root = ROOT, digest, nodeVersion = process.version) {
  const stampPath = join(root, STAMP_REL_PATH);
  mkdirSync(dirname(stampPath), { recursive: true });
  const tmpPath = `${stampPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify({ digest, node: nodeVersion }, null, 2)}\n`);
  renameSync(tmpPath, stampPath);
}

/** Check whether `dist/` artifacts and `.build-stamp.json` match the current input digest. */
export function isBuildUpToDate(root = ROOT, { nodeVersion = process.version, artifacts = REQUIRED_ARTIFACTS } = {}) {
  const digest = computeBuildDigest(root, nodeVersion);
  const stamp = readBuildStamp(root);
  const upToDate = stamp?.digest === digest && artifactsExist(root, artifacts);
  return { upToDate, digest };
}

/** Walk up from `root` to locate `node_modules/vite/bin/vite.js`, or return undefined. */
function findViteScript(root) {
  let current = resolve(root);
  for (;;) {
    const candidate = join(current, 'node_modules', 'vite', 'bin', 'vite.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Run `vite build --logLevel error` in `root` with inherited stdio. */
export function runViteBuild(root = ROOT) {
  const viteScript = findViteScript(root);
  const result = viteScript !== undefined
    ? spawnSync(process.execPath, [viteScript, 'build', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' })
    : spawnSync('vite', ['build', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`vite build failed with exit ${result.status ?? result.signal ?? 'unknown'}`);
}

/**
 * Ensure `dist/` is built for the current inputs.
 * Skips building when the stamp and all required artifacts match.
 */
export function ensureBuild({
  root = ROOT,
  checkOnly = false,
  build = () => runViteBuild(root),
  nodeVersion = process.version,
  artifacts = REQUIRED_ARTIFACTS,
} = {}) {
  const { upToDate, digest } = isBuildUpToDate(root, { nodeVersion, artifacts });
  if (upToDate) return { built: false, upToDate: true, digest };
  if (checkOnly) return { built: false, upToDate: false, digest };
  build(root);
  const missing = missingArtifacts(root, artifacts);
  if (missing.length > 0) {
    throw new Error(`build finished but missing expected artifacts: ${missing.join(', ')}`);
  }
  writeBuildStamp(root, digest, nodeVersion);
  return { built: true, upToDate: false, digest };
}

function parseCliArgs(argv) {
  let checkOnly = false;
  let root = ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check-only') {
      checkOnly = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) throw new Error('usage: node scripts/ensure-build.mjs [--check-only] [--root <dir>]');
      root = resolve(value);
    } else {
      throw new Error('usage: node scripts/ensure-build.mjs [--check-only] [--root <dir>]');
    }
  }
  return { checkOnly, root };
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isEntrypoint) {
  try {
    const { checkOnly, root } = parseCliArgs(process.argv.slice(2));
    const result = ensureBuild({ root, checkOnly });
    if (checkOnly && !result.upToDate) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`ensure-build: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
