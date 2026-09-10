import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

// Library build: one entry, ES + UMD, declarations from tsconfig.json (src only).
// The CLI in bin/ is plain JavaScript and loads the ES build at run time.
export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.json' })],
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
