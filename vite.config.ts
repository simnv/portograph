import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

// Library build: one entry, ES + UMD, declarations from tsconfig.json (src only).
// The CLI in bin/ is plain JavaScript and loads the ES build at run time.
export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.json' }), {
    name: 'elk-worker-assets',
    generateBundle() {
      const require = createRequire(import.meta.url);
      for (const [fileName, source] of [
        ['portograph-elk-worker.js', require.resolve('elkjs/lib/elk-worker.min.js')],
        ['node.cjs', new URL('./runtime/node.cjs', import.meta.url)],
        ['node.d.cts', new URL('./runtime/node.d.cts', import.meta.url)],
      ] as const) this.emitFile({ type: 'asset', fileName, source: readFileSync(source, 'utf8') });
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
