import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

// Library build: one entry, ES + UMD, declarations from tsconfig.json (src only).
// The CLI in bin/ is plain JavaScript and loads the ES build at run time.
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
      this.emitFile({ type: 'asset', fileName: 'portograph-libavoid.wasm', source: readFileSync(join(avoidDir, 'libavoid.wasm')) });
    },
  }],
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      name: 'portograph',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'portograph.js' : 'portograph.umd.cjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
