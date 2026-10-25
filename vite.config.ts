import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative as relativePath } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';
import { heldLock } from './scripts/test-runner-lib.mjs';

// Tests run only through scripts/test-runner.mjs (host-wide lock, one worker, group kill). A raw
// `npx vitest`, `vitest` or startVitest call loads this config without the held lock and stops here.
if ((process.env.VITEST !== undefined || /vitest/.test(process.argv[1] ?? '')) && heldLock() === undefined) {
  throw new Error('vitest runs only through `npm test` (scripts/test-runner.mjs); see docs/agents/gates.md');
}

// Library build: one bundle of everything (`src/internal.ts`), ES + UMD, declarations from
// tsconfig.json (src only). The public entry points `dist/index.js` and `dist/index.cjs` are
// written below as thin re-exports of the names `src/index.ts` lists, so the public surface and the
// internal one share one copy of the code. The CLI in bin/ is plain JavaScript and loads the
// bundle (the internal entry) at run time.

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
// project, with the default timeout; the parallel pool no longer starves them.
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
    // After the declarations are written: make them stand without `elkjs` (a development
    // dependency, bundled into the library) and give CommonJS callers their own `.d.cts` tree.
    name: 'package-declarations',
    apply: 'build',
    closeBundle: {
      order: 'post',
      handler() {
        const dist = new URL('./dist/', import.meta.url).pathname;
        const require = createRequire(import.meta.url);
        // The one elkjs type the declarations name is `ElkNode`; ship elkjs's own declaration file (EPL-2.0 header kept).
        // One line of it fails under `strict` (`T['children'][number]` on an optional list); the fix keeps the type.
        const elkTypes = readFileSync(join(dirname(require.resolve('elkjs/package.json')), 'lib', 'elk-api.d.ts'), 'utf8');
        const fixedElkTypes = elkTypes.replace("(T['children'][number] & ElkNode)[]", "(NonNullable<T['children']>[number] & ElkNode)[]");
        if (fixedElkTypes === elkTypes) throw new Error('elkjs lib/elk-api.d.ts no longer holds the line the build patches; check the installed elkjs');
        writeFileSync(join(dist, 'elk-api.d.ts'), fixedElkTypes);
        const declarations = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
          .flatMap(entry => entry.isDirectory() ? declarations(join(directory, entry.name)) : entry.name.endsWith('.d.ts') ? [join(directory, entry.name)] : []);
        for (const file of declarations(dist)) {
          const relative = join(relativePath(dirname(file), dist), 'elk-api.js');
          const text = readFileSync(file, 'utf8').replaceAll("'elkjs/lib/elk-api.js'", `'${relative.startsWith('.') ? relative : `./${relative}`}'`);
          writeFileSync(file, text);
          // A `.d.cts` imports `.cjs` siblings, so TypeScript reads the whole tree as CommonJS.
          writeFileSync(file.replace(/\.d\.ts$/, '.d.cts'), text.replace(/(from\s+'|import\(')(\.{1,2}\/[^']*)\.js'/g, "$1$2.cjs'"));
        }
      },
    },
  }, {
    name: 'runtime-worker-assets',
    generateBundle() {
      const require = createRequire(import.meta.url);
      // libavoid-js exports only its package root; resolve the installed Node entry and take its
      // siblings. The library bundle itself never resolves that entry.
      const avoidNodeEntry = require.resolve('libavoid-js');
      const avoidDir = dirname(avoidNodeEntry);
      for (const [fileName, source] of [
        ['portograph-elk-worker.js', require.resolve('elkjs/lib/elk-worker.min.js')],
        ['portograph-avoid-worker.mjs', new URL('./runtime/avoid-worker.mjs', import.meta.url)],
        ['portograph-avoid.mjs', join(avoidDir, 'index.js')],
        ['portograph-avoid-node.mjs', join(avoidDir, 'index-node.mjs')],
        ['portograph-libavoid-LICENSE.txt', join(avoidDir, '..', 'LICENSE')],
        ['warm-elk.cjs', new URL('./runtime/warm-elk.cjs', import.meta.url)],
        ['node.cjs', new URL('./runtime/node.cjs', import.meta.url)],
        ['node.d.cts', new URL('./runtime/node.d.cts', import.meta.url)],
      ] as const) this.emitFile({ type: 'asset', fileName, source: readFileSync(source, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/m, '') });
      const names = publicNames();
      this.emitFile({ type: 'asset', fileName: 'index.js', source: `export { ${names.join(', ')} } from './portograph.js';\n` });
      this.emitFile({ type: 'asset', fileName: 'index.cjs', source: `'use strict';\nconst api = require('./portograph.umd.cjs');\n${names.map(name => `exports.${name} = api.${name};`).join('\n')}\n` });
      this.emitFile({ type: 'asset', fileName: 'portograph-libavoid.wasm', source: readFileSync(join(avoidDir, 'libavoid.wasm')) });
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
  },
  test: {
    environment: 'node',
    // Default 5 s is too close to the slowest untimed tests (1-2.6 s quiet) when agents share the machine.
    // Per-test timeouts larger than this stay in force.
    testTimeout: 30000,
    projects: [
      { extends: true, test: { name: 'default', include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, ...slowFiles, ...heavyFiles] } },
      // Files with a test over 15 s: one at a time, same timeout as the default project.
      { extends: true, test: { name: 'heavy', include: heavyFiles, poolOptions: { forks: { singleFork: true }, threads: { singleThread: true } } } },
      // Files that take minutes alone: run one at a time after the default project, so a loaded run cannot starve them.
      { extends: true, test: { name: 'slow', include: slowFiles, poolOptions: { forks: { singleFork: true }, threads: { singleThread: true } }, testTimeout: 600000 } },
    ],
  },
});
