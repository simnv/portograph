import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

// Library build: one bundle of everything (`src/internal.ts`), ES + UMD, declarations from
// tsconfig.json (src only). The public entry points `dist/index.js` and `dist/index.cjs` are
// written below as thin re-exports of the names `src/index.ts` lists, so the public surface and the
// internal one share one copy of the code. The CLI in bin/ is plain JavaScript and loads the
// bundle (the internal entry) at run time.

/** The value names `src/index.ts` exports, read from its plain `export { a, b } from` lines. */
function publicNames(): string[] {
  const text = readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8');
  const names: string[] = [];
  for (const match of text.matchAll(/^export \{([^}]*)\} from '[^']+';/gm)) {
    names.push(...match[1]!.split(',').map(name => name.trim()).filter(Boolean));
  }
  return names;
}

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.json' }), {
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
        ['portograph-libavoid-LICENSE.txt', join(avoidDir, '..', 'LICENSE')],
        ['node.cjs', new URL('./runtime/node.cjs', import.meta.url)],
        ['node.d.cts', new URL('./runtime/node.d.cts', import.meta.url)],
      ] as const) this.emitFile({ type: 'asset', fileName, source: readFileSync(source, 'utf8') });
      const names = publicNames();
      this.emitFile({ type: 'asset', fileName: 'index.js', source: `export { ${names.join(', ')} } from './portograph.js';\n` });
      this.emitFile({ type: 'asset', fileName: 'index.cjs', source: `'use strict';\nconst api = require('./portograph.umd.cjs');\n${names.map(name => `exports.${name} = api.${name};`).join('\n')}\n` });
      // The CommonJS types are the same export lines; a `.d.cts` file is what makes TypeScript read them as CommonJS.
      this.emitFile({ type: 'asset', fileName: 'index.d.cts', source: readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'portograph-libavoid.wasm', source: readFileSync(join(avoidDir, 'libavoid.wasm')) });
    },
  }],
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: 'src/internal.ts',
      name: 'portograph',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'portograph.js' : 'portograph.umd.cjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Default 5 s is too close to the slowest untimed tests (1-2.6 s quiet) when agents share the machine.
    // Per-test timeouts larger than this stay in force.
    testTimeout: 30000,
  },
});
