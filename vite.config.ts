import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';
import { heldLock } from './scripts/test-runner-lib.mjs';

// Tests run only through scripts/test-runner.mjs (host-wide lock, one worker, group kill). A raw
// `npx vitest`, `vitest` or startVitest call loads this config without the held lock and stops here.
if ((process.env.VITEST !== undefined || /node_modules[\\/]vitest[\\/]/.test(process.argv[1] ?? '')) && heldLock() === undefined) {
  throw new Error('vitest runs only through `npm test` (scripts/test-runner.mjs); see docs/gates.md');
}

// Library build: one bundle of everything (`src/internal.ts`), ES + UMD, declarations from
// tsconfig.json (src only). The public entry points `dist/index.js` and `dist/index.cjs` are
// written below as thin re-exports of the names `src/index.ts` lists, so the public surface and the
// internal one share one copy of the code. The CLI in bin/ is plain JavaScript and loads the
// bundle (the internal entry) at run time.
//
// The solvers are dependencies, not part of the bundle: `elkjs`, `libavoid-js` and `web-worker` stay
// external in both formats, and dist/ ships none of their code. The ES bundle imports
// `elkjs/lib/elk-api.js`; the UMD bundle requires it in CommonJS and reads the global `ELK` that
// elkjs's own `lib/elk-api.js` sets in a browser, so a page loads that script first. The ELK worker
// and the libavoid module and WASM are read from the installed packages (`runtime/node.cjs`).
const SOLVERS = /^(elkjs|libavoid-js|web-worker)(\/|$)/;

/** The value names `src/index.ts` exports, read from its plain `export { a, b } from` lines. */
function publicNames(): string[] {
  const text = readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8');
  const names: string[] = [];
  // Every code line must be a plain value export, a type export or a comment; anything else fails the build.
  let inComment = false;
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (inComment) { inComment = !trimmed.includes('*/'); continue; }
    if (trimmed.startsWith('/*')) { inComment = !trimmed.includes('*/'); continue; }
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    if (/^export type [{*] ?.*from '[^']+';$/.test(trimmed)) continue;
    const match = /^export \{([^}]*)\} from '[^']+';$/.exec(trimmed);
    const listed = match?.[1]!.split(',').map(name => name.trim()).filter(Boolean);
    if (listed === undefined || listed.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) {
      throw new Error(`src/index.ts:${index + 1} cannot be read by the build; use one line, \`export { a, b } from './internal.js';\` (no \`as\`, no \`export *\`): ${trimmed}`);
    }
    names.push(...listed);
  }
  return names;
}

const slowFiles = [
  'test/cli/e2e.test.ts',
  'test/layout/regions-review.test.ts',
  'test/pipeline/frame-chord-leg.test.ts',
];

// Files with one test over 15 s in a loaded run (measured 2026-10-25). They run alone, after the default
// project, with a 180 s test timeout; the parallel pool no longer starves them.
const heavyFiles = [
  'test/layout/centre-scale.test.ts',
  'test/layout/constraints.test.ts',
  'test/layout/move-reservations-oracle.test.ts',
  'test/pipeline/canton-close-up.test.ts',
  'test/pipeline/canton-walls.test.ts',
  'test/pipeline/chord-clear.test.ts',
  'test/pipeline/min-separation-writers.test.ts',
  'test/pipeline/overlay-window.test.ts',
  'test/pipeline/placement-attempt.test.ts',
  'test/pipeline/side-round-l.test.ts',
  'test/pipeline/three-continents.test.ts',
  'test/pipeline/unmoved-rebuild.test.ts',
];

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.json' }), {
    // After the declarations are written: give CommonJS callers their own `.d.cts` tree. The one
    // elkjs type the declarations name, `ElkNode`, comes from the installed `elkjs` dependency.
    name: 'package-declarations',
    apply: 'build',
    closeBundle: {
      order: 'post',
      handler() {
        const dist = new URL('./dist/', import.meta.url).pathname;
        const declarations = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
          .flatMap(entry => entry.isDirectory() ? declarations(join(directory, entry.name)) : entry.name.endsWith('.d.ts') ? [join(directory, entry.name)] : []);
        for (const file of declarations(dist)) {
          // A `.d.cts` imports `.cjs` siblings, so TypeScript reads the whole tree as CommonJS.
          writeFileSync(file.replace(/\.d\.ts$/, '.d.cts'), readFileSync(file, 'utf8').replace(/(from\s+'|import\(')(\.{1,2}\/[^']*)\.js'/g, "$1$2.cjs'"));
        }
      },
    },
  }, {
    name: 'runtime-worker-assets',
    generateBundle() {
      // portograph's own runtime files only; the solver workers and the WASM stay in their packages.
      for (const [fileName, source] of [
        ['portograph-avoid-worker.mjs', new URL('./runtime/avoid-worker.mjs', import.meta.url)],
        ['warm-elk.cjs', new URL('./runtime/warm-elk.cjs', import.meta.url)],
        ['node.cjs', new URL('./runtime/node.cjs', import.meta.url)],
        ['node.d.cts', new URL('./runtime/node.d.cts', import.meta.url)],
      ] as const) this.emitFile({ type: 'asset', fileName, source: readFileSync(source, 'utf8') });
      const names = publicNames();
      this.emitFile({ type: 'asset', fileName: 'index.js', source: `export { ${names.join(', ')} } from './portograph.js';\n` });
      this.emitFile({ type: 'asset', fileName: 'index.cjs', source: `'use strict';\nconst api = require('./portograph.umd.cjs');\n${names.map(name => `exports.${name} = api.${name};`).join('\n')}\n` });
    },
  }],
  build: {
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: 'src/internal.ts',
      name: 'portograph',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'portograph.js' : 'portograph.umd.cjs'),
    },
    rolldownOptions: {
      external: id => SOLVERS.test(id),
      output: { globals: { 'elkjs/lib/elk-api.js': 'ELK' } },
    },
  },
  test: {
    environment: 'node',
    // Default 5 s is too close to the slowest untimed tests (1-2.6 s quiet) when agents share the machine.
    // `default` 30 s, `heavy` 180 s, `slow` 600 s per test. A per-test timeout overrides all three; in a `heavy` or
    // `slow` file, do not set one below the project's: the same commit ran 1.5x slower on one CI runner than on the next (PUB-06).
    testTimeout: 30000,
    projects: [
      { extends: true, test: { name: 'default', include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, ...slowFiles, ...heavyFiles] } },
      // Files with a test over 15 s: one at a time, 180 s per test (a test without its own timeout does not fail at 30 s under load).
      { extends: true, test: { name: 'heavy', include: heavyFiles, fileParallelism: false, testTimeout: 180000 } },
      // Files that take minutes alone: run one at a time after the default project, so a loaded run cannot starve them.
      { extends: true, test: { name: 'slow', include: slowFiles, fileParallelism: false, testTimeout: 600000 } },
    ],
  },
});
