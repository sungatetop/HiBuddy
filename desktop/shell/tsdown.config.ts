import { defineConfig } from 'tsdown'

/** Electron main-process bundle: one self-contained ESM file (no runtime deps). */
export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  // Electron resolves 'electron' at runtime; never bundle it (tsdown 0.23: deps.neverBundle replaces deprecated external).
  deps: { neverBundle: [/^electron$/] },
})
